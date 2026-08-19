import { lstat } from "node:fs/promises";
import path from "node:path";

import { runtimePathContext } from "../../infrastructure/runtime-paths.js";

export interface OpenCodeSourceOptions {
  readonly dataRoot?: string;
  readonly databasePath?: string;
  readonly cwd?: string;
  readonly home?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface OpenCodeSource {
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly dataRootSource: "explicit" | "xdg" | "home";
  readonly databaseSource: "explicit" | "environment" | "default";
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function resolvePath(value: string, base: string): string {
  if (value.includes("\0")) throw new Error("OpenCode path contains NUL");
  return path.resolve(base, value);
}

export async function requireOpenCodeSource(source: OpenCodeSource): Promise<void> {
  let root;
  try {
    root = await lstat(source.dataRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`OpenCode data root does not exist: ${source.dataRoot}`);
    }
    throw error;
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`OpenCode data root is not a real directory: ${source.dataRoot}`);
  }
  let database;
  try {
    database = await lstat(source.databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`OpenCode history database does not exist: ${source.databasePath}`);
    }
    throw error;
  }
  if (!database.isFile() || database.isSymbolicLink()) {
    throw new Error(`OpenCode history database is not a regular file: ${source.databasePath}`);
  }
}

export function resolveOpenCodeSource(options: OpenCodeSourceOptions = {}): OpenCodeSource {
  const context = runtimePathContext(options);
  const environment = context.environment;
  const cwd = context.cwd;
  const home = context.home;
  const explicitRoot = nonBlank(options.dataRoot);
  const xdgRoot = nonBlank(environment.XDG_DATA_HOME);
  if (xdgRoot !== undefined && !path.isAbsolute(xdgRoot)) {
    throw new Error("OpenCode XDG_DATA_HOME must be absolute");
  }
  const dataRoot = explicitRoot !== undefined
    ? resolvePath(explicitRoot, cwd)
    : xdgRoot !== undefined
      ? path.join(xdgRoot, "opencode")
      : path.join(home, ".local", "share", "opencode");
  const explicitDatabase = nonBlank(options.databasePath);
  const configuredDatabase = nonBlank(environment.OPENCODE_DB);
  if (configuredDatabase === ":memory:") {
    throw new Error("OpenCode in-memory database has no persistent history");
  }
  const databasePath = explicitDatabase !== undefined
    ? resolvePath(explicitDatabase, cwd)
    : configuredDatabase !== undefined
      ? resolvePath(configuredDatabase, dataRoot)
      : path.join(dataRoot, "opencode.db");
  return {
    dataRoot: path.resolve(dataRoot),
    databasePath: path.resolve(databasePath),
    dataRootSource: explicitRoot !== undefined ? "explicit" : xdgRoot !== undefined ? "xdg" : "home",
    databaseSource: explicitDatabase !== undefined ? "explicit" : configuredDatabase !== undefined ? "environment" : "default",
  };
}
