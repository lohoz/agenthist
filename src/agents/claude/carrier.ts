import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { claudeCheckpointPathName } from "./sidecars/checkpoint.js";
import { canonicalClaudeUuid } from "./identity.js";
import { claudeTaskPathIdentity } from "./sidecars/task.js";

const HISTORY_DIRECTORIES = new Set([
  "projects",
  "file-history",
  "paste-cache",
  "image-cache",
  "tasks",
  "session-env",
  "plans",
  "teams",
  "daemon",
  "jobs",
]);

export type ClaudeCarrierRole =
  | "main"
  | "subagent-transcript"
  | "subagent-metadata"
  | "tool-result"
  | "session-sidecar"
  | "checkpoint-backup"
  | "checkpoint"
  | "task-entry"
  | "task-highwatermark"
  | "auxiliary";

export interface ClaudeCarrier {
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly role: ClaudeCarrierRole;
  readonly projectCarrier?: string;
  readonly sessionCandidate?: string;
  readonly mode: number;
  readonly fingerprint: string;
  readonly modifiedAt: string;
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

function uuid(value: string): string | undefined {
  try { return canonicalClaudeUuid(value); } catch { return undefined; }
}

function classify(
  relativePath: string,
): Omit<ClaudeCarrier, "sourcePath" | "mode" | "fingerprint" | "modifiedAt"> | undefined {
  const parts = relativePath.split("/");
  if (parts.length === 1 && parts[0] === "history.jsonl") {
    return { relativePath, role: "auxiliary" };
  }
  if (parts[0] === "projects" && parts.length >= 3) {
    const projectCarrier = parts[1];
    if (projectCarrier === undefined || projectCarrier === "" || parts[2] === "memory") return undefined;
    if (parts.length === 3 && parts[2]!.endsWith(".jsonl")) {
      const sessionCandidate = uuid(parts[2]!.slice(0, -".jsonl".length));
      if (sessionCandidate !== undefined) {
        return { relativePath, role: "main", projectCarrier, sessionCandidate };
      }
    }
    const sessionCandidate = uuid(parts[2]!);
    if (
      sessionCandidate !== undefined && parts.length === 5 && parts[3] === "tool-results" &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(?:txt|json)$/.test(parts[4]!)
    ) return { relativePath, role: "tool-result", projectCarrier, sessionCandidate };
    if (sessionCandidate !== undefined && parts.length === 5 && parts[3] === "subagents") {
      if (/^agent-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.jsonl$/.test(parts[4]!)) {
        return { relativePath, role: "subagent-transcript", projectCarrier, sessionCandidate };
      }
      if (/^agent-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.meta\.json$/.test(parts[4]!)) {
        return { relativePath, role: "subagent-metadata", projectCarrier, sessionCandidate };
      }
    }
    return sessionCandidate === undefined
      ? { relativePath, role: "auxiliary", projectCarrier }
      : { relativePath, role: "session-sidecar", projectCarrier, sessionCandidate };
  }
  if (parts[0] === "file-history" && parts.length >= 3) {
    const sessionCandidate = uuid(parts[1]!);
    if (sessionCandidate === undefined) return { relativePath, role: "auxiliary" };
    return claudeCheckpointPathName(relativePath, sessionCandidate) === undefined
      ? { relativePath, role: "checkpoint", sessionCandidate }
      : { relativePath, role: "checkpoint-backup", sessionCandidate };
  }
  const task = claudeTaskPathIdentity(relativePath);
  if (task !== undefined) {
    return { relativePath, role: task.role, sessionCandidate: task.sessionId };
  }
  if (parts[0] === "daemon") {
    return parts.length === 2 && parts[1] === "roster.json"
      ? { relativePath, role: "auxiliary" }
      : undefined;
  }
  if (parts[0] === "jobs") {
    return parts.length === 3 && parts[1] !== "" && parts[2] === "state.json"
      ? { relativePath, role: "auxiliary" }
      : undefined;
  }
  return HISTORY_DIRECTORIES.has(parts[0] ?? "") ? { relativePath, role: "auxiliary" } : undefined;
}

function skipDirectory(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return parts[0] === "projects" && parts.length === 3 && parts[2] === "memory";
}

export async function discoverClaudeCarriers(configRoot: string): Promise<ClaudeCarrier[]> {
  const result: ClaudeCarrier[] = [];
  const rootEntries = await readdir(configRoot, { withFileTypes: true });
  rootEntries.sort((left, right) => left.name.localeCompare(right.name));
  const pending: Array<{ readonly absolute: string; readonly relative: string }> = [];
  for (const entry of rootEntries) {
    const absolute = path.join(configRoot, entry.name);
    if (entry.isSymbolicLink()) {
      if (entry.name === "history.jsonl" || HISTORY_DIRECTORIES.has(entry.name)) {
        throw new Error(`Claude Code history contains a symbolic link: ${absolute}`);
      }
      continue;
    }
    if (entry.name === "history.jsonl") {
      if (!entry.isFile()) throw new Error(`Claude Code history carrier has an unsupported shape: ${absolute}`);
      pending.push({ absolute, relative: entry.name });
    } else if (HISTORY_DIRECTORIES.has(entry.name)) {
      if (!entry.isDirectory()) throw new Error(`Claude Code history root has an unsupported shape: ${absolute}`);
      pending.push({ absolute, relative: entry.name });
    }
  }
  while (pending.length !== 0) {
    const current = pending.pop()!;
    const info = await lstat(current.absolute);
    if (info.isSymbolicLink()) throw new Error(`Claude Code history contains a symbolic link: ${current.absolute}`);
    if (info.isDirectory()) {
      if (skipDirectory(portable(current.relative))) continue;
      const entries = await readdir(current.absolute, { withFileTypes: true });
      entries.sort((left, right) => right.name.localeCompare(left.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error(`Claude Code history contains a symbolic link: ${path.join(current.absolute, entry.name)}`);
        if (!entry.isDirectory() && !entry.isFile()) {
          throw new Error(`Claude Code history contains an unsupported entry: ${path.join(current.absolute, entry.name)}`);
        }
        pending.push({ absolute: path.join(current.absolute, entry.name), relative: path.join(current.relative, entry.name) });
      }
      continue;
    }
    if (!info.isFile()) throw new Error(`Claude Code history contains an unsupported entry: ${current.absolute}`);
    const relativePath = portable(current.relative);
    const classified = classify(relativePath);
    // Claude may hard-link a task spool into tool-results, and may hard-link
    // checkpoint backups when copying file history to a fork. Stable copy plus
    // the before/after inventory still prove the captured bytes.
    if (info.nlink !== 1 && classified?.role !== "tool-result" && classified?.role !== "checkpoint-backup") {
      throw new Error(`Claude Code history carrier has multiple hard links: ${current.absolute}`);
    }
    if (classified === undefined) continue;
    result.push({
      ...classified,
      sourcePath: current.absolute,
      mode: process.platform === "win32" ? 0o600 : info.mode & 0o777,
      fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}:${info.nlink}`,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return result;
}

export function sameClaudeInventory(left: readonly ClaudeCarrier[], right: readonly ClaudeCarrier[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined && item.relativePath === other.relativePath && item.role === other.role &&
      item.projectCarrier === other.projectCarrier && item.sessionCandidate === other.sessionCandidate &&
      item.fingerprint === other.fingerprint;
  });
}

export async function hasClaudeMainTranscript(configRoot: string): Promise<boolean> {
  try {
    return (await discoverClaudeCarriers(configRoot)).some((carrier) => carrier.role === "main");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
