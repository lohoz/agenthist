import path from "node:path";

import type { AgentSnapshot, JsonValue, StoredSession } from "../../domain/history.js";
import { copyStableFile } from "../../infrastructure/files.js";
import {
  createSnapshotWorkspace,
  discardSnapshot,
  ensureStateDirectory,
  loadSnapshot,
  publishSnapshot,
  reuseSnapshotFile,
} from "../../infrastructure/history-store.js";
import { incrementalSourceKey, metadataFingerprint, scanState } from "../incremental-scan.js";
import { discoverPiSessions, samePiInventory, type PiSessionCarrier } from "./carrier.js";
import { canonicalPiSessionId, piSessionRef } from "./identity.js";
import { parsePiSession, type ParsedPiSession } from "./history/session.js";
import { requirePiSource, resolvePiSource, type PiSourceOptions } from "./source.js";

export interface ScanPiOptions extends PiSourceOptions {
  readonly stateDirectory: string;
  readonly importedLibrary?: ReadonlyMap<string, StoredSession["library"]>;
}

export interface ScanPiResult {
  readonly stateDirectory: string;
  readonly snapshot: AgentSnapshot;
}

interface CapturedPiSession {
  readonly carrier: PiSessionCarrier;
  readonly relativePath: string;
  readonly parsed?: ParsedPiSession;
  readonly previous?: StoredSession;
  readonly nativeId: string;
  readonly sessionRef: string;
  readonly parentSession?: string;
  readonly fingerprint: string;
}

function rawRelative(carrier: PiSessionCarrier): string {
  return `pi/${carrier.relativePath}`;
}

function validateParentGraph(captured: readonly CapturedPiSession[]): void {
  const bySourcePath = new Map(captured.map((item) => [path.resolve(item.carrier.sourcePath), item]));
  const complete = new Set<string>();
  const visiting = new Set<string>();
  const visit = (item: CapturedPiSession): void => {
    if (complete.has(item.sessionRef)) return;
    if (visiting.has(item.sessionRef)) {
      throw new Error(`Pi parent session graph contains a cycle: ${item.nativeId}`);
    }
    visiting.add(item.sessionRef);
    const parentPath = item.parentSession;
    const parent = parentPath === undefined ? undefined : bySourcePath.get(path.resolve(parentPath));
    if (parent !== undefined) visit(parent);
    visiting.delete(item.sessionRef);
    complete.add(item.sessionRef);
  };
  for (const item of captured) visit(item);
}

function objectValue(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function cachedParentSession(session: StoredSession): string | undefined {
  const header = objectValue(objectValue(session.native)?.header ?? null);
  return typeof header?.parentSession === "string" ? header.parentSession : undefined;
}

export async function scanPi(options: ScanPiOptions): Promise<ScanPiResult> {
  const source = resolvePiSource(options);
  await requirePiSource(source);
  await ensureStateDirectory(options.stateDirectory, [source.sessionRoot]);
  const before = await discoverPiSessions(source.sessionRoot);
  if (before.length === 0) throw new Error("Pi has no supported persisted sessions");
  const previous = await loadSnapshot(options.stateDirectory, "pi");
  const sourceKey = incrementalSourceKey("pi", [source.sessionRoot]);
  const previousByRaw = previous?.scan?.sourceKey === sourceKey
    ? new Map(previous.sessions.flatMap((session) => session.rawFiles.length === 1 ? [[session.rawFiles[0]!, session]] : []))
    : new Map<string, StoredSession>();
  const previousLibrary = new Map(previous?.sessions.map((session) => [session.sessionRef, session.library]));
  const workspace = await createSnapshotWorkspace(options.stateDirectory, "pi");
  try {
    const captured: CapturedPiSession[] = [];
    const references = new Set<string>();
    const nativeIds = new Set<string>();
    let reusedSessions = 0;
    for (const carrier of before) {
      const relativePath = rawRelative(carrier);
      const fingerprint = metadataFingerprint("pi-session/v1", [relativePath, carrier.fingerprint]);
      const cached = previousByRaw.get(relativePath);
      if (cached?.scan?.fingerprint === fingerprint) {
        await reuseSnapshotFile(options.stateDirectory, previous!, relativePath, workspace);
        const nativeId = canonicalPiSessionId(cached.nativeId);
        const parentSession = cachedParentSession(cached);
        if (nativeIds.has(nativeId)) throw new Error(`Pi session appears more than once: ${nativeId}`);
        nativeIds.add(nativeId);
        if (references.has(cached.sessionRef)) throw new Error(`Pi session identity collides: ${nativeId}`);
        references.add(cached.sessionRef);
        captured.push({
          carrier,
          relativePath,
          previous: cached,
          nativeId,
          sessionRef: cached.sessionRef,
          ...(parentSession === undefined ? {} : { parentSession }),
          fingerprint,
        });
        reusedSessions++;
        continue;
      }
      const destination = path.join(workspace.rawRoot, ...relativePath.split("/"));
      await copyStableFile(carrier.sourcePath, destination);
      const parsed = await parsePiSession(destination, carrier.modifiedAt);
      const nativeId = canonicalPiSessionId(parsed.header.id);
      if (nativeIds.has(nativeId)) throw new Error(`Pi session appears more than once: ${nativeId}`);
      nativeIds.add(nativeId);
      const sessionRef = piSessionRef(nativeId);
      if (references.has(sessionRef)) throw new Error(`Pi session identity collides: ${nativeId}`);
      references.add(sessionRef);
      captured.push({
        carrier,
        relativePath,
        parsed,
        nativeId,
        sessionRef,
        ...(parsed.header.parentSession === undefined ? {} : { parentSession: parsed.header.parentSession }),
        fingerprint,
      });
    }
    const after = await discoverPiSessions(source.sessionRoot);
    if (!samePiInventory(before, after)) throw new Error("Pi history changed while scanning");
    validateParentGraph(captured);

    const bySourcePath = new Map(captured.map((item) => [path.resolve(item.carrier.sourcePath), item]));
    const warnings: string[] = [];
    const sessions = captured.map((item): StoredSession => {
      const parentPath = item.parentSession;
      const parent = parentPath === undefined ? undefined : bySourcePath.get(path.resolve(parentPath));
      const blockers = parentPath !== undefined && parent === undefined ? ["pi.native.parent_session_external"] : [];
      if (parent?.sessionRef === item.sessionRef) throw new Error(`Pi session is its own parent: ${item.nativeId}`);
      if (blockers.length !== 0) {
        warnings.push(`Pi session ${item.nativeId} has native migration blockers: ${blockers.join(", ")}`);
      }
      if (item.previous !== undefined) {
        const native = objectValue(item.previous.native);
        if (native === undefined) throw new Error(`cached Pi session metadata is invalid: ${item.nativeId}`);
        return {
          ...item.previous,
          library: previousLibrary.get(item.sessionRef) ?? options.importedLibrary?.get(item.sessionRef) ?? {
            name: "", tags: [], archived: false, deleted: false,
          },
          rawFiles: [item.relativePath],
          native: {
            ...native,
            relationStatus: blockers.length === 0 ? "verified" : "external_parent",
            parentSessionRef: parent?.sessionRef ?? null,
            migrationBlockers: blockers,
          },
          scan: { fingerprint: item.fingerprint },
        };
      }
      const parsed = item.parsed!;
      return {
        sessionRef: item.sessionRef,
        agent: "pi",
        nativeId: parsed.header.id,
        title: parsed.title,
        context: parsed.header.cwd,
        model: parsed.model,
        provider: parsed.provider,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        nativeArchived: false,
        library: previousLibrary.get(item.sessionRef) ?? options.importedLibrary?.get(item.sessionRef) ?? {
          name: "", tags: [], archived: false, deleted: false,
        },
        conversation: parsed.conversation,
        searchText: parsed.searchText,
        rawFiles: [item.relativePath],
        native: {
          carrier: {
            relativePath: item.relativePath,
            fileName: item.carrier.fileName,
            mode: item.carrier.mode,
          },
          header: {
            version: parsed.header.version,
            parentSession: parsed.header.parentSession ?? null,
          },
          tree: {
            leafId: parsed.leafId,
            roots: parsed.roots,
            branchPoints: parsed.branchPoints,
            entries: parsed.entries.length,
            messages: parsed.messageCount,
          },
          relationStatus: blockers.length === 0 ? "verified" : "external_parent",
          parentSessionRef: parent?.sessionRef ?? null,
          migrationBlockers: blockers,
        },
        scan: { fingerprint: item.fingerprint },
      };
    }).sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
    const snapshot: AgentSnapshot = {
      schemaVersion: "agenthist.history-snapshot/v2",
      snapshotId: workspace.id,
      agent: "pi",
      scannedAt: new Date().toISOString(),
      sessions,
      auxiliaryFiles: [],
      warnings,
      scan: scanState(sourceKey, previous, sessions, reusedSessions),
    };
    warnings.push(...await publishSnapshot(options.stateDirectory, workspace, snapshot));
    return { stateDirectory: options.stateDirectory, snapshot };
  } catch (error) {
    await discardSnapshot(workspace);
    throw error;
  }
}
