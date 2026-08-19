import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export interface DiscoveredCodexRollout {
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly archived: boolean;
  readonly fingerprint: string;
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

export async function requireRealDirectory(directory: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label} does not exist: ${directory}`);
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory: ${directory}`);
  }
}

async function walkRoot(
  codexHome: string,
  root: string,
  archived: boolean,
  warnings: string[],
): Promise<DiscoveredCodexRollout[]> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Codex history root is not a real directory: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: DiscoveredCodexRollout[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(`skipped symbolic link: ${fullPath}`);
      } else if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".jsonl") {
        const info = await lstat(fullPath);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error(`Codex history carrier changed shape: ${fullPath}`);
        }
        result.push({
          sourcePath: fullPath,
          relativePath: portablePath(path.relative(codexHome, fullPath)),
          archived,
          fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}:${info.nlink}`,
        });
      }
    }
  }
  return result;
}

export async function discoverCodexRollouts(
  codexHome: string,
  warnings: string[] = [],
): Promise<readonly DiscoveredCodexRollout[]> {
  const result = [
    ...(await walkRoot(codexHome, path.join(codexHome, "sessions"), false, warnings)),
    ...(await walkRoot(codexHome, path.join(codexHome, "archived_sessions"), true, warnings)),
  ];
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
