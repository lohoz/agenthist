import { access, stat } from "node:fs/promises";
import path from "node:path";

export interface ExecutableResolutionOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly searchCurrentDirectory?: boolean;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment[name];
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

function windowsExtensions(environment: NodeJS.ProcessEnv): readonly string[] {
  const configured = environmentValue(environment, "PATHEXT", "win32") ?? ".COM;.EXE;.BAT;.CMD";
  return configured.split(";").map((extension) => extension.trim()).filter((extension) => extension !== "");
}

function withWindowsExtensions(
  candidate: string,
  extensions: readonly string[],
): readonly string[] {
  const lower = candidate.toLowerCase();
  if (extensions.some((extension) => lower.endsWith(extension.toLowerCase()))) return [candidate];
  return extensions.map((extension) => `${candidate}${extension}`);
}

function uniqueCandidates(values: readonly string[], platform: NodeJS.Platform): readonly string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function executableCandidates(
  command: string,
  options: ExecutableResolutionOptions = {},
): readonly string[] {
  const platform = options.platform ?? process.platform;
  const implementation = platform === "win32" ? path.win32 : path.posix;
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const searchCurrentDirectory = options.searchCurrentDirectory ?? true;
  const explicit = implementation.isAbsolute(command) || command.includes("/") ||
    platform === "win32" && command.includes("\\");
  const bases = explicit
    ? [implementation.isAbsolute(command) ? command : implementation.resolve(cwd, command)]
    : [
        ...(platform === "win32" && searchCurrentDirectory ? [implementation.resolve(cwd, command)] : []),
        ...(environmentValue(environment, "PATH", platform) ??
          (platform === "win32" ? environmentValue(process.env, "PATH", platform) ?? "" : "/usr/bin:/bin"))
          .split(implementation.delimiter)
          .filter((directory) => searchCurrentDirectory || directory !== "")
          .map((directory) => directory.startsWith('"') && directory.endsWith('"')
            ? directory.slice(1, -1)
            : directory)
          .map((directory) => implementation.resolve(directory === "" ? cwd : directory, command)),
      ];
  const candidates = platform === "win32"
    ? bases.flatMap((candidate) => withWindowsExtensions(candidate, windowsExtensions(environment)))
    : bases;
  return uniqueCandidates(candidates, platform);
}

async function usableExecutable(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, platform === "win32" ? undefined : 1);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExecutable(
  command: string,
  options: ExecutableResolutionOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  for (const candidate of executableCandidates(command, options)) {
    if (await usableExecutable(candidate, platform)) return candidate;
  }
  return undefined;
}
