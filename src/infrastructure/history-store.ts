import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { Agent } from "../domain/agent.js";
import {
  isHistorySnapshotId,
  readLibraryMetadata,
  type AgentSnapshot,
  type LibraryMetadata,
} from "../domain/history.js";
import { syncDirectory, syncDirectoryTree, writeJsonAtomic } from "./files.js";
import { loadLibraryOverlay } from "./library-store.js";
import { ensurePrivateStateDirectory } from "./state.js";
import { retainedHistorySnapshotIds } from "./transaction-store.js";

export interface SnapshotWorkspace {
  readonly id: string;
  readonly root: string;
  readonly rawRoot: string;
}

export function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  const leftToRight = path.relative(normalizedLeft, normalizedRight);
  const rightToLeft = path.relative(normalizedRight, normalizedLeft);
  return (
    leftToRight === "" ||
    (!leftToRight.startsWith(`..${path.sep}`) && leftToRight !== ".." && !path.isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith(`..${path.sep}`) && rightToLeft !== ".." && !path.isAbsolute(rightToLeft))
  );
}

export async function ensureStateDirectory(stateDirectory: string, sourceRoots: readonly string[]): Promise<void> {
  for (const sourceRoot of sourceRoots) {
    if (pathsOverlap(stateDirectory, sourceRoot)) {
      throw new Error(`state directory overlaps Agent source: ${sourceRoot}`);
    }
  }
  await ensurePrivateStateDirectory(stateDirectory);
}

function agentRoot(stateDirectory: string, agent: Agent): string {
  return path.join(stateDirectory, "history", agent);
}

function snapshotsRoot(stateDirectory: string, agent: Agent): string {
  return path.join(agentRoot(stateDirectory, agent), "snapshots");
}

export async function createSnapshotWorkspace(stateDirectory: string, agent: Agent): Promise<SnapshotWorkspace> {
  const id = randomUUID();
  const root = path.join(snapshotsRoot(stateDirectory, agent), `.prepare-${id}`);
  const rawRoot = path.join(root, "raw");
  await mkdir(rawRoot, { recursive: true, mode: 0o700 });
  return { id, root, rawRoot };
}

export async function discardSnapshot(workspace: SnapshotWorkspace): Promise<void> {
  await rm(workspace.root, { recursive: true, force: true });
}

export async function reuseSnapshotFile(
  stateDirectory: string,
  previous: AgentSnapshot,
  relativePath: string,
  workspace: SnapshotWorkspace,
): Promise<void> {
  const source = snapshotRawPath(stateDirectory, previous, relativePath);
  const destination = path.join(workspace.rawRoot, ...relativePath.split("/"));
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`reusable snapshot file is unavailable: ${relativePath}`);
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await link(source, destination);
}

export async function publishSnapshot(
  stateDirectory: string,
  workspace: SnapshotWorkspace,
  snapshot: AgentSnapshot,
): Promise<readonly string[]> {
  if (snapshot.snapshotId !== workspace.id) {
    throw new Error("snapshot workspace identity mismatch");
  }
  await syncDirectoryTree(workspace.rawRoot);
  await writeJsonAtomic(path.join(workspace.root, "index.json"), snapshot);
  const root = snapshotsRoot(stateDirectory, snapshot.agent);
  const publishedRoot = path.join(root, workspace.id);
  await rename(workspace.root, publishedRoot);
  await syncDirectory(root);
  await writeJsonAtomic(path.join(agentRoot(stateDirectory, snapshot.agent), "head.json"), {
    schemaVersion: "agenthist.history-head/v1",
    snapshotId: workspace.id,
  });
  return pruneHistorySnapshots(stateDirectory, snapshot.agent);
}

function cleanupMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : "unknown snapshot cleanup error";
  return Buffer.byteLength(value, "utf8") <= 4096 ? value : `${value.slice(0, 4093)}...`;
}

async function pruneHistorySnapshots(stateDirectory: string, agent: Agent): Promise<readonly string[]> {
  try {
    const root = snapshotsRoot(stateDirectory, agent);
    const retained = new Set(await retainedHistorySnapshotIds(stateDirectory, agent));
    const current = await loadHistoryHead(stateDirectory, agent);
    if (current !== null) retained.add(current);
    const entries = await readdir(root, { withFileTypes: true });
    const obsolete: string[] = [];
    for (const entry of entries) {
      const snapshotId = entry.name.startsWith(".prepare-") ? entry.name.slice(".prepare-".length) : entry.name;
      if (!isHistorySnapshotId(snapshotId)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`unsafe history snapshot entry: ${entry.name}`);
      }
      if (entry.name.startsWith(".prepare-") || !retained.has(snapshotId)) obsolete.push(entry.name);
    }
    for (const name of obsolete) await rm(path.join(root, name), { recursive: true, force: true });
    if (obsolete.length !== 0) await syncDirectory(root);
    return [];
  } catch (error) {
    return [`${agent} obsolete snapshot cleanup was skipped: ${cleanupMessage(error)}`];
  }
}

export async function loadSnapshot(stateDirectory: string, agent: Agent): Promise<AgentSnapshot | undefined> {
  const snapshotId = await loadHistoryHead(stateDirectory, agent);
  if (snapshotId === null) return undefined;
  const bytes = await readFile(path.join(agentRoot(stateDirectory, agent), "snapshots", snapshotId, "index.json"));
  const snapshot = JSON.parse(bytes.toString("utf8")) as AgentSnapshot;
  if (
    snapshot.schemaVersion !== "agenthist.history-snapshot/v2" ||
    snapshot.snapshotId !== snapshotId ||
    snapshot.agent !== agent ||
    !Array.isArray(snapshot.sessions)
  ) {
    throw new Error("invalid history snapshot");
  }
  const overlay = await loadLibraryOverlay(stateDirectory);
  const library = new Map<string, LibraryMetadata>();
  for (const entry of overlay.entries) {
    library.set(entry.sessionRef, {
      name: entry.name,
      tags: [...entry.tags],
      archived: entry.archived,
      deleted: entry.deleted,
    });
  }
  const sessions = snapshot.sessions.map((session) => {
    const captured = readLibraryMetadata(session.library);
    if (
      captured === undefined || session.agent !== agent || !Array.isArray(session.searchText) ||
      session.searchText.some((value: unknown) => typeof value !== "string")
    ) throw new Error("invalid history snapshot");
    return { ...session, library: library.get(session.sessionRef) ?? captured };
  });
  return { ...snapshot, sessions };
}

export async function loadHistoryHead(stateDirectory: string, agent: Agent): Promise<string | null> {
  let headBytes: Buffer;
  try {
    headBytes = await readFile(path.join(agentRoot(stateDirectory, agent), "head.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const head = JSON.parse(headBytes.toString("utf8")) as { schemaVersion?: unknown; snapshotId?: unknown };
  if (
    head.schemaVersion !== "agenthist.history-head/v1" ||
    typeof head.snapshotId !== "string" ||
    !isHistorySnapshotId(head.snapshotId)
  ) {
    throw new Error("invalid history head");
  }
  return head.snapshotId;
}

export async function restoreHistoryHead(
  stateDirectory: string,
  agent: Agent,
  snapshotId: string | null,
): Promise<void> {
  const root = agentRoot(stateDirectory, agent);
  const head = path.join(root, "head.json");
  if (snapshotId === null) {
    await rm(head, { force: true });
  } else {
    if (!isHistorySnapshotId(snapshotId)) throw new Error("invalid history snapshot identity");
    const bytes = await readFile(path.join(root, "snapshots", snapshotId, "index.json"));
    const snapshot = JSON.parse(bytes.toString("utf8")) as AgentSnapshot;
    if (snapshot.schemaVersion !== "agenthist.history-snapshot/v2" || snapshot.snapshotId !== snapshotId || snapshot.agent !== agent) {
      throw new Error("history snapshot cannot be restored");
    }
    await writeJsonAtomic(head, { schemaVersion: "agenthist.history-head/v1", snapshotId });
  }
  try {
    await syncDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function snapshotRawPath(stateDirectory: string, snapshot: AgentSnapshot, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
    throw new Error("invalid snapshot raw path");
  }
  return path.join(agentRoot(stateDirectory, snapshot.agent), "snapshots", snapshot.snapshotId, "raw", relativePath);
}
