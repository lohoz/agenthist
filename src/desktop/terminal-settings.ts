import { access, lstat, mkdir, readlink, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import { resolveExecutable } from "../infrastructure/executable.js";
import { applyPosixMode, readStableSmallFile, writeJsonAtomic } from "../infrastructure/files.js";
import { ensurePrivateStateDirectory } from "../infrastructure/state.js";
import type {
  SelectTerminalRequest,
  TerminalCandidateDto,
  TerminalSettingsDto,
  UpdateTerminalArgumentsRequest,
} from "./contracts.js";

const SCHEMA = "agenthist.desktop-terminal/v1";
const MAX_FILE_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const MAX_ARGUMENT_TOTAL_BYTES = 24 * 1024;

interface StoredTerminalSettings {
  readonly schemaVersion: typeof SCHEMA;
  readonly mode: "auto" | "configured";
  readonly executablePath?: string;
  readonly label?: string;
  readonly arguments: readonly string[];
}

export interface TerminalLaunchConfiguration {
  readonly executablePath: string;
  readonly arguments: readonly string[];
}

export interface DesktopTerminalSettingsService {
  inspect(): Promise<TerminalSettingsDto>;
  select(request: SelectTerminalRequest): Promise<TerminalSettingsDto>;
  updateArguments(request: UpdateTerminalArgumentsRequest): Promise<TerminalSettingsDto>;
  resolveLaunchConfiguration(): Promise<TerminalLaunchConfiguration>;
}

export interface DesktopTerminalSettingsOptions {
  readonly stateDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly chooseExecutable: () => Promise<string | undefined>;
}

interface CandidateDefinition {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly string[];
  readonly arguments: readonly string[];
}

const CANDIDATES: readonly CandidateDefinition[] = [
  {
    id: "windows-terminal",
    label: "Windows Terminal",
    commands: ["wt", "WindowsTerminal"],
    arguments: ["-w", "new", "new-tab", "--startingDirectory", "{cwd}", "{command}"],
  },
  {
    id: "wezterm",
    label: "WezTerm",
    commands: ["wezterm-gui", "wezterm"],
    arguments: ["start", "--cwd", "{cwd}", "--", "{command}"],
  },
  {
    id: "alacritty",
    label: "Alacritty",
    commands: ["alacritty"],
    arguments: ["--working-directory", "{cwd}", "-e", "{command}"],
  },
];

const POSIX_CANDIDATES: readonly CandidateDefinition[] = [
  { id: "wezterm", label: "WezTerm", commands: ["wezterm"], arguments: ["start", "--cwd", "{cwd}", "--", "{command}"] },
  { id: "alacritty", label: "Alacritty", commands: ["alacritty"], arguments: ["--working-directory", "{cwd}", "-e", "{command}"] },
  { id: "gnome-terminal", label: "GNOME Terminal", commands: ["gnome-terminal"], arguments: ["--working-directory={cwd}", "--", "{command}"] },
  { id: "konsole", label: "Konsole", commands: ["konsole"], arguments: ["--workdir", "{cwd}", "-e", "{command}"] },
  { id: "x-terminal-emulator", label: "系统终端", commands: ["x-terminal-emulator", "xterm"], arguments: ["-e", "{command}"] },
];

function migratedKnownTerminalArguments(
  executablePath: string,
  arguments_: readonly string[],
): readonly string[] {
  const name = path.win32.basename(executablePath).toLowerCase();
  const isWindowsTerminal = name === "wt.exe" || name === "windowsterminal.exe";
  const isLegacyDirectTemplate = arguments_.length === 2 && arguments_[0] === "{cwd}" &&
    (arguments_[1] === "{command}" || arguments_[1] === "{commandLine}");
  return isWindowsTerminal && isLegacyDirectTemplate
    ? [...CANDIDATES[0]!.arguments]
    : [...arguments_];
}

function settingsPath(stateDirectory: string): string {
  return path.join(stateDirectory, "desktop", "terminal.json");
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}

function validArguments(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGUMENTS) return false;
  let total = 0;
  let commands = 0;
  for (const argument of value) {
    if (typeof argument !== "string" || argument === "" || /[\u0000-\u001f\u007f]/u.test(argument)) return false;
    const bytes = Buffer.byteLength(argument, "utf8");
    if (bytes > MAX_ARGUMENT_BYTES) return false;
    total += bytes;
    if (argument === "{command}" || argument === "{commandLine}") commands++;
  }
  return total <= MAX_ARGUMENT_TOTAL_BYTES && commands === 1;
}

function validateStored(value: unknown): StoredTerminalSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, ["schemaVersion", "mode", "executablePath", "label", "arguments"])) {
    throw new Error("stored Desktop terminal settings are invalid");
  }
  const item = value as Partial<StoredTerminalSettings>;
  if (item.schemaVersion !== SCHEMA || item.mode !== "auto" && item.mode !== "configured" ||
    !validArguments(item.arguments) ||
    item.mode === "auto" && (item.executablePath !== undefined || item.label !== undefined) ||
    item.mode === "configured" && (
      typeof item.executablePath !== "string" || !(path.win32.isAbsolute(item.executablePath) || path.posix.isAbsolute(item.executablePath)) ||
      typeof item.label !== "string" || item.label === "" || item.label.length > 128
    )) throw new Error("stored Desktop terminal settings are invalid");
  return {
    schemaVersion: SCHEMA,
    mode: item.mode,
    ...(item.executablePath === undefined ? {} : { executablePath: item.executablePath.startsWith("/") ? path.posix.normalize(item.executablePath) : path.win32.normalize(item.executablePath) }),
    ...(item.label === undefined ? {} : { label: item.label }),
    arguments: [...item.arguments],
  };
}

function defaultStored(): StoredTerminalSettings {
  return {
    schemaVersion: SCHEMA,
    mode: "auto",
    arguments: ["{command}"],
  };
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

function windowsTerminalAlias(file: string, environment: NodeJS.ProcessEnv): boolean {
  const localAppData = environmentValue(environment, "LOCALAPPDATA");
  if (localAppData === undefined || !path.win32.isAbsolute(localAppData)) return false;
  return path.win32.normalize(file).toLowerCase() === path.win32
    .join(path.win32.normalize(localAppData), "Microsoft", "WindowsApps", "wt.exe")
    .toLowerCase();
}

function windowsTerminalPackageLauncher(file: string): boolean {
  return /\\WindowsApps\\Microsoft\.WindowsTerminal_[^\\]+__8wekyb3d8bbwe\\wt\.exe$/iu.test(
    path.win32.normalize(file),
  );
}

async function availableWindowsTerminalAlias(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const localAppData = environmentValue(environment, "LOCALAPPDATA");
  if (localAppData === undefined || !path.win32.isAbsolute(localAppData)) return undefined;
  const alias = path.win32.join(localAppData, "Microsoft", "WindowsApps", "wt.exe");
  try {
    const info = await lstat(alias);
    return info.isDirectory() ? undefined : alias;
  } catch {
    return undefined;
  }
}

async function requireExecutable(
  file: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  if (platform !== "win32") {
    if (!path.posix.isAbsolute(file) || /[\u0000-\u001f\u007f]/u.test(file)) throw new Error("terminal executable path is invalid");
    const resolved = await realpath(file);
    if (!(await lstat(resolved)).isFile()) throw new Error("terminal executable is not a regular file");
    await access(resolved, constants.X_OK);
    return resolved;
  }
  if (!path.win32.isAbsolute(file) || /[\u0000-\u001f\u007f]/u.test(file) ||
    Buffer.byteLength(file, "utf8") > 64 * 1024 || path.extname(file).toLowerCase() !== ".exe") {
    throw new Error("terminal executable path is invalid");
  }
  const normalized = path.win32.normalize(file);
  const info = await lstat(normalized);
  const approvedAlias = platform === "win32" && windowsTerminalAlias(normalized, environment);
  if (approvedAlias && info.isSymbolicLink()) {
    const target = path.win32.normalize(await readlink(normalized));
    if (!path.win32.isAbsolute(target) ||
      !windowsTerminalPackageLauncher(target)) {
      throw new Error("Windows Terminal app alias target is invalid");
    }
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      throw new Error("Windows Terminal app alias target is unavailable");
    }
    // Keep the stable per-user execution alias. A versioned executable inside
    // Program Files\WindowsApps is an implementation detail and may not launch
    // correctly outside its package activation context.
    return normalized;
  }
  if (platform === "win32" && windowsTerminalPackageLauncher(normalized)) {
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Windows Terminal package launcher is unavailable");
    }
    const alias = await availableWindowsTerminalAlias(environment);
    if (alias === undefined) throw new Error("Windows Terminal app execution alias is unavailable");
    return alias;
  }
  if ((!info.isFile() && !approvedAlias) || info.isDirectory() || info.isSymbolicLink() && !approvedAlias) {
    throw new Error("terminal executable is not a regular file or approved Windows app alias");
  }
  return normalized;
}

function inferredTerminal(file: string): { readonly label: string; readonly arguments: readonly string[] } {
  if (file.startsWith("/")) {
    if (file === "/usr/bin/osascript") return { label: "Terminal.app", arguments: ["{command}"] };
    const candidate = POSIX_CANDIDATES.find((item) => item.commands.includes(path.posix.basename(file)));
    return { label: candidate?.label ?? path.posix.basename(file), arguments: candidate?.arguments ?? ["-e", "{command}"] };
  }
  const name = path.win32.basename(file).toLowerCase();
  if (name === "wt.exe" || name === "windowsterminal.exe") return {
    label: "Windows Terminal",
    arguments: CANDIDATES[0]!.arguments,
  };
  if (name === "wezterm.exe" || name === "wezterm-gui.exe") return {
    label: "WezTerm",
    arguments: CANDIDATES[1]!.arguments,
  };
  if (name === "alacritty.exe") return { label: "Alacritty", arguments: CANDIDATES[2]!.arguments };
  return { label: path.win32.basename(file), arguments: ["{command}"] };
}

export function createDesktopTerminalSettingsService(
  options: DesktopTerminalSettingsOptions,
): DesktopTerminalSettingsService {
  const platform = options.platform ?? process.platform;
  const environment = { ...(options.environment ?? process.env) };
  let writeTail: Promise<void> = Promise.resolve();

  const ensureDirectory = async (): Promise<string> => {
    await ensurePrivateStateDirectory(options.stateDirectory);
    const directory = path.join(options.stateDirectory, "desktop");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Desktop terminal settings directory is not a private real directory");
    }
    await applyPosixMode(directory, 0o700);
    const secured = await lstat(directory);
    if (!secured.isDirectory() || secured.isSymbolicLink() ||
      process.platform !== "win32" && (secured.mode & 0o077) !== 0) {
      throw new Error("Desktop terminal settings directory is not a private real directory");
    }
    return directory;
  };

  const read = async (): Promise<StoredTerminalSettings> => {
    await ensureDirectory();
    try {
      const bytes = await readStableSmallFile(settingsPath(options.stateDirectory), MAX_FILE_BYTES);
      return validateStored(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultStored();
      throw error;
    }
  };

  const write = async (value: StoredTerminalSettings): Promise<StoredTerminalSettings> => {
    const validated = validateStored(value);
    const operation = writeTail.then(async () => {
      await ensureDirectory();
      await writeJsonAtomic(settingsPath(options.stateDirectory), validated);
    });
    writeTail = operation.then(() => undefined, () => undefined);
    await operation;
    return validated;
  };

  const candidates = async (): Promise<TerminalCandidateDto[]> => {
    const result: TerminalCandidateDto[] = [];
    const seen = new Set<string>();
    const definitions = platform === "win32" ? CANDIDATES : platform === "darwin"
      ? [{ id: "macos-terminal", label: "Terminal.app", commands: ["/usr/bin/osascript"], arguments: ["{command}"] }, ...POSIX_CANDIDATES.slice(0, 2)] : POSIX_CANDIDATES;
    for (const definition of definitions) {
      let executablePath: string | undefined;
      for (const command of definition.commands) {
        executablePath = await resolveExecutable(command, {
          cwd: options.stateDirectory,
          environment,
          platform,
          searchCurrentDirectory: false,
        });
        if (executablePath !== undefined) break;
      }
      if (executablePath === undefined && definition.id === "windows-terminal") {
        const alias = await availableWindowsTerminalAlias(environment);
        if (alias !== undefined) {
          try { executablePath = await requireExecutable(alias, platform, environment); } catch {
            // The Windows Terminal app alias is optional.
          }
        }
      }
      if (executablePath === undefined) continue;
      try {
        executablePath = await requireExecutable(executablePath, platform, environment);
      } catch {
        continue;
      }
      const normalized = platform === "win32" ? path.win32.normalize(executablePath) : path.posix.normalize(executablePath);
      const key = platform === "win32" ? normalized.toLowerCase() : normalized;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: definition.id,
        label: definition.label,
        executablePath: normalized,
        arguments: [...definition.arguments],
      });
    }
    return result;
  };

  const resolve = async (stored: StoredTerminalSettings): Promise<{
    readonly launch?: TerminalLaunchConfiguration;
    readonly label: string;
    readonly candidates: readonly TerminalCandidateDto[];
    readonly requiresSetup: boolean;
  }> => {
    const detected = await candidates();
    if (stored.mode === "auto") {
      const first = detected[0];
      return first === undefined
        ? { label: "未检测到终端，请先设置", candidates: detected, requiresSetup: true }
        : {
            launch: { executablePath: first.executablePath, arguments: first.arguments },
            label: `${first.label}（自动）`,
            candidates: detected,
            requiresSetup: false,
          };
    }
    try {
      const executablePath = await requireExecutable(stored.executablePath!, platform, environment);
      return {
        launch: {
          executablePath,
          arguments: migratedKnownTerminalArguments(executablePath, stored.arguments),
        },
        label: stored.label!,
        candidates: detected,
        requiresSetup: false,
      };
    } catch {
      return { label: `${stored.label!}（不可用，请重新设置）`, candidates: detected, requiresSetup: true };
    }
  };

  const dto = async (stored: StoredTerminalSettings): Promise<TerminalSettingsDto> => {
    const effective = await resolve(stored);
    return {
      mode: stored.mode,
      effectiveLabel: effective.label,
      ...(effective.launch === undefined ? {} : { effectiveExecutablePath: effective.launch.executablePath }),
      arguments: [...(effective.launch?.arguments ?? stored.arguments)],
      candidates: effective.candidates,
      requiresSetup: effective.requiresSetup,
    };
  };

  return {
    async inspect() {
      return dto(await read());
    },

    async select(request) {
      if (request === null || typeof request !== "object" || Array.isArray(request) ||
        Object.keys(request).join("") !== "candidateId" || typeof request.candidateId !== "string") {
        throw new Error("terminal selection request is invalid");
      }
      if (request.candidateId === "auto") return dto(await write(defaultStored()));
      if (request.candidateId === "custom") {
        const selected = await options.chooseExecutable();
        if (selected === undefined) return dto(await read());
        const executablePath = await requireExecutable(selected, platform, environment);
        const inferred = inferredTerminal(executablePath);
        return dto(await write({
          schemaVersion: SCHEMA,
          mode: "configured",
          executablePath,
          label: inferred.label,
          arguments: inferred.arguments,
        }));
      }
      const candidate = (await candidates()).find((item) => item.id === request.candidateId);
      if (candidate === undefined) throw new Error("selected terminal is no longer available");
      return dto(await write({
        schemaVersion: SCHEMA,
        mode: "configured",
        executablePath: await requireExecutable(candidate.executablePath, platform, environment),
        label: candidate.label,
        arguments: candidate.arguments,
      }));
    },

    async updateArguments(request) {
      if (request === null || typeof request !== "object" || Array.isArray(request) ||
        Object.keys(request).join("") !== "arguments" || !validArguments(request.arguments)) {
        throw new Error("terminal arguments are invalid");
      }
      const stored = await read();
      const effective = await resolve(stored);
      if (effective.launch === undefined) throw new Error("set a terminal before changing its arguments");
      return dto(await write({
        schemaVersion: SCHEMA,
        mode: "configured",
        executablePath: effective.launch.executablePath,
        label: effective.label.replace(/（自动）$/u, ""),
        arguments: migratedKnownTerminalArguments(effective.launch.executablePath, request.arguments),
      }));
    },

    async resolveLaunchConfiguration() {
      const stored = await read();
      const effective = await resolve(stored);
      if (effective.launch === undefined) throw new Error("terminal executable is unavailable; configure it in settings");
      return effective.launch;
    },
  };
}
