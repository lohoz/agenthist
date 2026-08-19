import { lstat } from "node:fs/promises";
import path from "node:path";

import { runtimePathContext, type RuntimePathOptions } from "../../infrastructure/runtime-paths.js";

export interface PiSourceOptions extends RuntimePathOptions {
  readonly sessionRoot?: string;
}

export interface PiSource {
  readonly agentDir: string;
  readonly sessionRoot: string;
  readonly sessionRootSource: "explicit" | "environment" | "agent";
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function resolveUserPath(value: string, cwd: string, home: string): string {
  if (value.includes("\0")) throw new Error("Pi session path contains NUL");
  const expanded = value === "~"
    ? home
    : value.startsWith(`~${path.sep}`)
      ? path.join(home, value.slice(2))
      : value;
  if (expanded.startsWith("~")) throw new Error(`unsupported home path: ${value}`);
  return path.resolve(cwd, expanded);
}

export function resolvePiSource(options: PiSourceOptions = {}): PiSource {
  const context = runtimePathContext(options);
  const explicit = nonBlank(options.sessionRoot);
  const environmentSessionRoot = nonBlank(context.environment.PI_CODING_AGENT_SESSION_DIR);
  const environmentAgentDir = nonBlank(context.environment.PI_CODING_AGENT_DIR);
  const agentDir = environmentAgentDir === undefined
    ? path.join(context.home, ".pi", "agent")
    : resolveUserPath(environmentAgentDir, context.cwd, context.home);
  const sessionRoot = explicit !== undefined
    ? resolveUserPath(explicit, context.cwd, context.home)
    : environmentSessionRoot !== undefined
      ? resolveUserPath(environmentSessionRoot, context.cwd, context.home)
      : path.join(agentDir, "sessions");
  return {
    agentDir: path.resolve(agentDir),
    sessionRoot: path.resolve(sessionRoot),
    sessionRootSource: explicit !== undefined ? "explicit" : environmentSessionRoot !== undefined ? "environment" : "agent",
  };
}

export async function requirePiSource(source: PiSource): Promise<void> {
  let info;
  try {
    info = await lstat(source.sessionRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Pi session root does not exist: ${source.sessionRoot}`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Pi session root is not a real directory: ${source.sessionRoot}`);
  }
}
