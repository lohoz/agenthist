import { randomUUID } from "node:crypto";
import { link, mkdir } from "node:fs/promises";
import path from "node:path";

import { agentAdapter } from "../agents/registry.js";
import type { Agent } from "../domain/agent.js";
import type { ArchiveEntry } from "../domain/archive.js";
import type { PreparedPortableSource } from "../domain/conversion.js";
import type { AgentSnapshot, StoredSession } from "../domain/history.js";
import { snapshotRawPath } from "../infrastructure/history-store.js";

export interface ArchiveSourceMaterializer {
  readonly agent: Agent;
  readonly sessions: readonly StoredSession[];
  prepare(sessionRef: string): Promise<PreparedPortableSource>;
}

function baseSession(entry: ArchiveEntry): StoredSession {
  return {
    sessionRef: entry.sessionRef,
    agent: entry.agent,
    nativeId: entry.nativeId,
    title: entry.title,
    context: entry.context,
    model: entry.model,
    provider: entry.provider,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    nativeArchived: entry.nativeArchived,
    library: entry.library,
    conversation: [],
    searchText: [],
    rawFiles: entry.objects.map((binding) => binding.relativePath),
    native: entry.native,
  };
}

async function materializeRawView(
  stateDirectory: string,
  snapshot: AgentSnapshot,
  entries: readonly ArchiveEntry[],
  objects: ReadonlyMap<string, string>,
): Promise<void> {
  const paths = new Map<string, string>();
  for (const entry of entries) {
    for (const binding of entry.objects) {
      const source = objects.get(binding.id);
      if (source === undefined) throw new Error(`archive source object is unavailable: ${entry.sessionRef}`);
      const existing = paths.get(binding.relativePath);
      if (existing !== undefined) {
        if (existing !== source) {
          throw new Error(`archive source path has different objects: ${binding.relativePath}`);
        }
        continue;
      }
      const destination = snapshotRawPath(stateDirectory, snapshot, binding.relativePath);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await link(source, destination);
      paths.set(binding.relativePath, source);
    }
  }
}

export async function createArchiveSourceMaterializer(
  agent: Agent,
  entries: readonly ArchiveEntry[],
  objects: ReadonlyMap<string, string>,
  workspace: string,
): Promise<ArchiveSourceMaterializer> {
  if (entries.length === 0 || entries.some((entry) => entry.agent !== agent)) {
    throw new Error(`archive source materializer received an invalid ${agent} selection`);
  }
  const stateDirectory = path.join(workspace, `source-${agent}`);
  const snapshotId = randomUUID();
  const snapshot: AgentSnapshot = {
    schemaVersion: "agenthist.history-snapshot/v2",
    snapshotId,
    agent,
    scannedAt: new Date().toISOString(),
    sessions: entries.map(baseSession),
    auxiliaryFiles: [...new Set(entries.flatMap((entry) => entry.objects.map((binding) => binding.relativePath)))].sort(),
    warnings: [],
  };
  await materializeRawView(stateDirectory, snapshot, entries, objects);
  const materializer = await agentAdapter(agent).portableSource.create({ stateDirectory, snapshot, entries });
  return {
    agent,
    sessions: materializer.sessions,
    prepare: materializer.prepare,
  };
}
