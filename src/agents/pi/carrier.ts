import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

const MAX_CARRIERS = 100_000;

export interface PiSessionCarrier {
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly mode: number;
  readonly fingerprint: string;
  readonly modifiedAt: string;
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

export async function discoverPiSessions(sessionRoot: string): Promise<PiSessionCarrier[]> {
  const result: PiSessionCarrier[] = [];
  const pending: Array<{ readonly absolute: string; readonly relative: string }> = [
    { absolute: sessionRoot, relative: "" },
  ];
  while (pending.length !== 0) {
    const current = pending.pop()!;
    const info = await lstat(current.absolute);
    if (info.isSymbolicLink()) throw new Error(`Pi history contains a symbolic link: ${current.absolute}`);
    if (info.isDirectory()) {
      const entries = await readdir(current.absolute, { withFileTypes: true });
      entries.sort((left, right) => right.name.localeCompare(left.name));
      for (const entry of entries) {
        const absolute = path.join(current.absolute, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Pi history contains a symbolic link: ${absolute}`);
        if (!entry.isDirectory() && !entry.isFile()) {
          throw new Error(`Pi history contains an unsupported entry: ${absolute}`);
        }
        if (entry.isFile() && !entry.name.endsWith(".jsonl")) continue;
        pending.push({ absolute, relative: path.join(current.relative, entry.name) });
      }
      continue;
    }
    if (!info.isFile() || !current.relative.endsWith(".jsonl")) continue;
    if (info.nlink !== 1) throw new Error(`Pi session carrier has multiple hard links: ${current.absolute}`);
    if (result.length >= MAX_CARRIERS) throw new Error("Pi history exceeds carrier limits");
    result.push({
      sourcePath: current.absolute,
      relativePath: portable(current.relative),
      fileName: path.basename(current.absolute),
      mode: process.platform === "win32" ? 0o600 : info.mode & 0o777,
      fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}:${info.nlink}`,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function samePiInventory(
  left: readonly PiSessionCarrier[],
  right: readonly PiSessionCarrier[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined && item.relativePath === other.relativePath && item.fingerprint === other.fingerprint;
  });
}
