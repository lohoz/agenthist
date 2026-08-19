import { lstat } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { readStableSmallFile } from "../../infrastructure/files.js";
import { runtimePathContext } from "../../infrastructure/runtime-paths.js";

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const PROFILE_NAME = /^[A-Za-z0-9_-]+$/;

export interface CodexSourceOptions {
  readonly codexHome?: string;
  readonly sqliteHome?: string;
  readonly profile?: string;
  readonly cwd?: string;
  readonly home?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CodexSource {
  readonly codexHome: string;
  readonly sqliteHome: string;
  readonly configPath: string;
  readonly profileConfigPath?: string;
  readonly currentProvider: string;
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function resolveUserPath(value: string, base: string, home: string): string {
  let expanded = value;
  if (expanded === "~") {
    expanded = home;
  } else if (expanded.startsWith(`~${path.sep}`)) {
    expanded = path.join(home, expanded.slice(2));
  } else if (expanded.startsWith("~")) {
    throw new Error(`unsupported home path: ${value}`);
  }
  return path.resolve(base, expanded);
}

async function readConfig(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Codex config is not a regular file: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const contents = await readStableSmallFile(filePath, MAX_CONFIG_BYTES);
  let parsed: unknown;
  try {
    parsed = parseToml(contents.toString("utf8"));
  } catch {
    throw new Error(`Codex config is invalid: ${filePath}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Codex config is invalid: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function configuredSQLiteHome(config: Record<string, unknown> | undefined, filePath: string): string | undefined {
  const value = config?.sqlite_home;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Codex sqlite_home is invalid: ${filePath}`);
  }
  return value;
}

function configuredProvider(config: Record<string, unknown> | undefined, filePath: string): string | undefined {
  const value = config?.model_provider;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Codex model_provider is invalid: ${filePath}`);
  }
  return value;
}

export async function resolveCodexSource(options: CodexSourceOptions = {}): Promise<CodexSource> {
  const context = runtimePathContext(options);
  const environment = context.environment;
  const cwd = context.cwd;
  const home = context.home;
  const codexHomeValue = options.codexHome ?? nonBlank(environment.CODEX_HOME) ?? path.join(home, ".codex");
  const codexHome = resolveUserPath(codexHomeValue, cwd, home);
  const configPath = path.join(codexHome, "config.toml");

  let baseConfig: Record<string, unknown> | undefined;
  try {
    baseConfig = await readConfig(configPath);
  } catch (error) {
    if (options.sqliteHome === undefined) {
      throw error;
    }
  }
  let profileConfig: Record<string, unknown> | undefined;
  let profileConfigPath: string | undefined;
  if (options.profile !== undefined) {
    if (!PROFILE_NAME.test(options.profile)) {
      throw new Error("Codex profile name is invalid");
    }
    profileConfigPath = path.join(codexHome, `${options.profile}.config.toml`);
    profileConfig = await readConfig(profileConfigPath);
    if (profileConfig === undefined) {
      throw new Error(`Codex profile does not exist: ${options.profile}`);
    }
  }

  const profileSQLite = profileConfigPath === undefined
    ? undefined
    : configuredSQLiteHome(profileConfig, profileConfigPath);
  const baseSQLite = configuredSQLiteHome(baseConfig, configPath);
  const configured = profileSQLite ?? baseSQLite;
  const configuredPath = profileSQLite === undefined ? configPath : profileConfigPath!;
  const currentProvider = (
    profileConfigPath === undefined ? undefined : configuredProvider(profileConfig, profileConfigPath)
  ) ?? configuredProvider(baseConfig, configPath) ?? "";
  const environmentSQLite = nonBlank(environment.CODEX_SQLITE_HOME);
  const sqliteHome = options.sqliteHome !== undefined
    ? resolveUserPath(options.sqliteHome, cwd, home)
    : configured !== undefined
      ? resolveUserPath(configured, path.dirname(configuredPath), home)
      : environmentSQLite !== undefined
        ? resolveUserPath(environmentSQLite, cwd, home)
        : codexHome;
  return {
    codexHome,
    sqliteHome,
    configPath,
    currentProvider,
    ...(profileConfigPath === undefined ? {} : { profileConfigPath }),
  };
}
