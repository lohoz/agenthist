import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import type { HistorySourceOptions } from "../application/index.js";
import { AGENTS, isAgent, type Agent } from "../domain/agent.js";
import { applyPosixMode, readStableSmallFile, sameFileStat, writeJsonAtomic } from "../infrastructure/files.js";
import { resolveExecutable } from "../infrastructure/executable.js";
import { ensurePrivateStateDirectory, withStateWriteLock } from "../infrastructure/state.js";

export const DESKTOP_AGENT_SETTINGS_SCHEMA = "agenthist.desktop-agent-settings/v1" as const;

const SETTINGS_FILE = "agents.json";
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 64 * 1024;

export interface DesktopAgentPathSetting {
  readonly historyRoot?: string;
  readonly databasePath?: string;
  readonly executablePath?: string;
}

export interface DesktopAgentPathSettings {
  readonly schemaVersion: typeof DESKTOP_AGENT_SETTINGS_SCHEMA;
  readonly agents: Readonly<Partial<Record<Agent, DesktopAgentPathSetting>>>;
}

export interface AgentConfiguredPathInspection {
  readonly configured: boolean;
  readonly path?: string;
  readonly available: boolean;
  readonly expected: "directory" | "file";
}

export interface AgentExecutableInspection {
  readonly configured: boolean;
  readonly configuredPath?: string;
  readonly resolvedPath?: string;
  readonly available: boolean;
}

export interface AgentSettingsInspection {
  readonly agent: Agent;
  readonly history: AgentConfiguredPathInspection;
  readonly database?: AgentConfiguredPathInspection;
  readonly executable: AgentExecutableInspection;
}

function settingsPath(stateDirectory: string): string {
  return path.join(stateDirectory, "desktop", SETTINGS_FILE);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown !== undefined) throw new Error(`${label} has an unknown field: ${unknown}`);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function absoluteHostPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value === "" || /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || Buffer.from(value, "utf8").toString("utf8") !== value ||
    !path.isAbsolute(value)
  ) throw new Error(`${label} must be an absolute host path`);
  return path.normalize(value);
}

function readAgentSetting(value: unknown, agent: Agent): DesktopAgentPathSetting | undefined {
  const item = objectValue(value, `${agent} desktop Agent settings`);
  exactKeys(item, ["historyRoot", "databasePath", "executablePath"], `${agent} desktop Agent settings`);
  if (item.databasePath !== undefined && agent !== "codex" && agent !== "opencode") {
    throw new Error(`${agent} does not support a desktop database path override`);
  }
  const setting: DesktopAgentPathSetting = {
    ...(item.historyRoot === undefined
      ? {}
      : { historyRoot: absoluteHostPath(item.historyRoot, `${agent} history root`) }),
    ...(item.databasePath === undefined
      ? {}
      : { databasePath: absoluteHostPath(item.databasePath, `${agent} database path`) }),
    ...(item.executablePath === undefined
      ? {}
      : { executablePath: absoluteHostPath(item.executablePath, `${agent} executable path`) }),
  };
  return Object.keys(setting).length === 0 ? undefined : setting;
}

export function validateDesktopAgentPathSettings(value: unknown): DesktopAgentPathSettings {
  const root = objectValue(value, "desktop Agent settings");
  exactKeys(root, ["schemaVersion", "agents"], "desktop Agent settings");
  if (root.schemaVersion !== DESKTOP_AGENT_SETTINGS_SCHEMA) {
    throw new Error("desktop Agent settings schema is unsupported");
  }
  const rawAgents = objectValue(root.agents, "desktop Agent settings agents");
  const unsupported = Object.keys(rawAgents).find((agent) => !isAgent(agent));
  if (unsupported !== undefined) throw new Error(`desktop Agent settings contains an unknown Agent: ${unsupported}`);
  const agents: Partial<Record<Agent, DesktopAgentPathSetting>> = {};
  for (const agent of AGENTS) {
    const raw = rawAgents[agent];
    if (raw === undefined) continue;
    const setting = readAgentSetting(raw, agent);
    if (setting !== undefined) agents[agent] = setting;
  }
  return { schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA, agents };
}

function emptySettings(): DesktopAgentPathSettings {
  return { schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA, agents: {} };
}

async function ensureDesktopDirectory(stateDirectory: string): Promise<string> {
  await ensurePrivateStateDirectory(stateDirectory);
  const directory = path.join(stateDirectory, "desktop");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await applyPosixMode(directory, 0o700);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("desktop Agent settings directory is not a private real directory");
  }
  return directory;
}

async function requireSafeSettingsTarget(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("desktop Agent settings target is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function loadUnlocked(stateDirectory: string): Promise<DesktopAgentPathSettings> {
  const file = settingsPath(stateDirectory);
  let bytes: Buffer;
  try {
    bytes = await readStableSmallFile(file, MAX_SETTINGS_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySettings();
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("desktop Agent settings are invalid JSON");
  }
  return validateDesktopAgentPathSettings(value);
}

async function saveUnlocked(
  stateDirectory: string,
  settings: DesktopAgentPathSettings,
): Promise<DesktopAgentPathSettings> {
  await ensureDesktopDirectory(stateDirectory);
  const file = settingsPath(stateDirectory);
  await requireSafeSettingsTarget(file);
  await writeJsonAtomic(file, settings);
  await applyPosixMode(file, 0o600);
  return settings;
}

export function desktopAgentSettingsPath(stateDirectory: string): string {
  return settingsPath(stateDirectory);
}

export async function loadDesktopAgentPathSettings(
  stateDirectory: string,
): Promise<DesktopAgentPathSettings> {
  return loadUnlocked(stateDirectory);
}

export async function saveDesktopAgentPathSettings(
  stateDirectory: string,
  value: DesktopAgentPathSettings,
): Promise<DesktopAgentPathSettings> {
  const settings = validateDesktopAgentPathSettings(value);
  return withStateWriteLock(stateDirectory, () => saveUnlocked(stateDirectory, settings));
}

export async function updateDesktopAgentPathSetting(
  stateDirectory: string,
  agent: Agent,
  value: DesktopAgentPathSetting,
): Promise<DesktopAgentPathSettings> {
  if (!isAgent(agent)) throw new Error("desktop Agent settings update has an invalid Agent");
  const setting = readAgentSetting(value, agent);
  return withStateWriteLock(stateDirectory, async () => {
    const current = await loadUnlocked(stateDirectory);
    const agents: Partial<Record<Agent, DesktopAgentPathSetting>> = { ...current.agents };
    if (setting === undefined) delete agents[agent];
    else agents[agent] = setting;
    return saveUnlocked(stateDirectory, { schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA, agents });
  });
}

export async function clearDesktopAgentPathSetting(
  stateDirectory: string,
  agent: Agent,
): Promise<DesktopAgentPathSettings> {
  if (!isAgent(agent)) throw new Error("desktop Agent settings clear has an invalid Agent");
  return withStateWriteLock(stateDirectory, async () => {
    const current = await loadUnlocked(stateDirectory);
    const agents: Partial<Record<Agent, DesktopAgentPathSetting>> = { ...current.agents };
    delete agents[agent];
    return saveUnlocked(stateDirectory, { schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA, agents });
  });
}

export function applyAgentSettingsToSourceOptions(
  base: HistorySourceOptions,
  value: DesktopAgentPathSettings,
): HistorySourceOptions {
  const settings = validateDesktopAgentPathSettings(value);
  const codex = settings.agents.codex;
  const opencode = settings.agents.opencode;
  const claude = settings.agents.claude;
  const pi = settings.agents.pi;
  return {
    ...base,
    ...(codex === undefined ? {} : {
      codex: {
        ...(base.codex ?? {}),
        ...(codex.historyRoot === undefined ? {} : { codexHome: codex.historyRoot }),
        ...(codex.databasePath === undefined ? {} : { sqliteHome: codex.databasePath }),
      },
    }),
    ...(opencode === undefined ? {} : {
      opencode: {
        ...(base.opencode ?? {}),
        ...(opencode.historyRoot === undefined ? {} : { dataRoot: opencode.historyRoot }),
        ...(opencode.databasePath === undefined ? {} : { databasePath: opencode.databasePath }),
      },
    }),
    ...(claude === undefined ? {} : {
      claude: {
        ...(base.claude ?? {}),
        ...(claude.historyRoot === undefined ? {} : { configRoot: claude.historyRoot }),
      },
    }),
    ...(pi === undefined ? {} : {
      pi: {
        ...(base.pi ?? {}),
        ...(pi.historyRoot === undefined ? {} : { sessionRoot: pi.historyRoot }),
      },
    }),
  };
}

function environmentKey(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== "win32") return Object.hasOwn(environment, name) ? name : undefined;
  return Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

function trustedPathEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  const key = environmentKey(source, "PATH");
  const configured = key === undefined
    ? process.platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin"
    : source[key] ?? "";
  const directories = configured.split(path.delimiter).flatMap((raw): string[] => {
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    return value !== "" && path.isAbsolute(value) ? [path.normalize(value)] : [];
  });
  if (process.platform === "win32") {
    for (const name of Object.keys(environment)) {
      if (name.toLowerCase() === "path") delete environment[name];
    }
  } else {
    delete environment.PATH;
  }
  environment[key ?? "PATH"] = directories.join(path.delimiter);
  return environment;
}

async function requireConfiguredExecutable(file: string, environment: NodeJS.ProcessEnv): Promise<string> {
  let observed: Awaited<ReturnType<typeof lstat>>;
  try {
    observed = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`configured Agent executable does not exist: ${file}`);
    }
    throw error;
  }
  if (!observed.isFile() || observed.isSymbolicLink()) {
    throw new Error(`configured Agent executable is not a real file: ${file}`);
  }
  const resolved = await resolveExecutable(file, {
    environment,
    cwd: path.parse(file).root,
    searchCurrentDirectory: false,
  });
  if (resolved === undefined || path.normalize(resolved) !== path.normalize(file)) {
    throw new Error(`configured Agent executable is not usable: ${file}`);
  }
  const after = await lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || !sameFileStat(observed, after)) {
    throw new Error(`configured Agent executable changed while being resolved: ${file}`);
  }
  return path.normalize(resolved);
}

export async function resolveConfiguredAgentExecutable(
  agent: Agent,
  value: DesktopAgentPathSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (!isAgent(agent)) throw new Error("configured Agent executable has an invalid Agent");
  const settings = validateDesktopAgentPathSettings(value);
  const trusted = trustedPathEnvironment(environment);
  const override = settings.agents[agent]?.executablePath;
  if (override !== undefined) return requireConfiguredExecutable(override, trusted);
  const root = path.parse(process.cwd()).root;
  return resolveExecutable(agent, {
    environment: trusted,
    cwd: root,
    searchCurrentDirectory: false,
  });
}

async function configuredPathInspection(
  configured: string | undefined,
  expected: "directory" | "file",
): Promise<AgentConfiguredPathInspection> {
  if (configured === undefined) return { configured: false, available: false, expected };
  let available = false;
  try {
    const info = await lstat(configured);
    available = !info.isSymbolicLink() && (expected === "directory" ? info.isDirectory() : info.isFile());
  } catch {
    available = false;
  }
  return { configured: true, path: configured, available, expected };
}

export async function inspectAgentSettings(
  value: DesktopAgentPathSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<readonly AgentSettingsInspection[]> {
  const settings = validateDesktopAgentPathSettings(value);
  const result: AgentSettingsInspection[] = [];
  for (const agent of AGENTS) {
    const configured = settings.agents[agent];
    let resolvedPath: string | undefined;
    try {
      resolvedPath = await resolveConfiguredAgentExecutable(agent, settings, environment);
    } catch {
      resolvedPath = undefined;
    }
    const databaseExpected = agent === "codex" ? "directory" as const : "file" as const;
    result.push({
      agent,
      history: await configuredPathInspection(configured?.historyRoot, "directory"),
      ...((agent !== "codex" && agent !== "opencode") ? {} : {
        database: await configuredPathInspection(configured?.databasePath, databaseExpected),
      }),
      executable: {
        configured: configured?.executablePath !== undefined,
        ...(configured?.executablePath === undefined ? {} : { configuredPath: configured.executablePath }),
        ...(resolvedPath === undefined ? {} : { resolvedPath }),
        available: resolvedPath !== undefined,
      },
    });
  }
  return result;
}
