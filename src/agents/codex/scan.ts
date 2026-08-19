import { DatabaseSync } from "node:sqlite";
import { lstat } from "node:fs/promises";
import path from "node:path";

import type { AgentSnapshot, JsonValue, StoredSession } from "../../domain/history.js";
import { pathFlavorForPlatform, samePath } from "../../domain/host-path.js";
import { copyStableFile } from "../../infrastructure/files.js";
import { backupSQLiteDatabase } from "../../infrastructure/sqlite.js";
import {
  createSnapshotWorkspace,
  discardSnapshot,
  ensureStateDirectory,
  publishSnapshot,
  loadSnapshot,
  reuseSnapshotFile,
  type SnapshotWorkspace,
} from "../../infrastructure/history-store.js";
import { incrementalSourceKey, metadataFingerprint, scanState } from "../incremental-scan.js";
import { codexSessionRef } from "./identity.js";
import { parseCodexRollout, type ParsedCodexRollout } from "./history/rollout.js";
import { resolveCodexSource, type CodexSourceOptions } from "./source.js";
import {
  readAllThreadDynamicTools,
  readThreadSpawnEdges,
  readThreadRows,
  threadSpawnComponents,
  unsupportedRelatedThreadIds,
  type ThreadDynamicToolRow,
  type ThreadRow,
  type ThreadSpawnEdgeRow,
} from "./storage/database.js";
import {
  readThreadGoalRows,
  resolveCodexGoalStore,
  threadGoalRowsEqual,
  type ThreadGoalRow,
} from "./storage/goals.js";
import {
  readThreadSectionRows,
  threadSectionForThread,
  type ThreadSectionRow,
} from "./storage/sections.js";
import {
  discoverCodexRollouts,
  requireRealDirectory,
  type DiscoveredCodexRollout,
} from "./carrier.js";
import { resolveCodexStateStore } from "./storage/stores.js";

const ROLLOUT_CAPTURE_CONCURRENCY = 8;

export interface ScanCodexOptions extends CodexSourceOptions {
  readonly stateDirectory: string;
  readonly importedLibrary?: ReadonlyMap<string, StoredSession["library"]>;
}

export interface ScanCodexResult {
  readonly stateDirectory: string;
  readonly snapshot: AgentSnapshot;
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function readDatabaseSnapshot(databasePath: string): {
  readonly threads: Map<string, ThreadRow>;
  readonly dynamicTools: Map<string, ThreadDynamicToolRow[]>;
  readonly spawnEdges: Map<string, ThreadSpawnEdgeRow>;
  readonly spawnComponents: ReadonlyMap<string, readonly string[]>;
  readonly invalidSpawnThreads: ReadonlySet<string>;
  readonly unsupportedRelations: ReadonlySet<string>;
  readonly goals: Map<string, ThreadGoalRow>;
  readonly sections: Map<string, ThreadSectionRow>;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const threads = readThreadRows(database);
    const dynamicTools = readAllThreadDynamicTools(database);
    const orphan = [...dynamicTools.keys()].find((id) => !threads.has(id));
    if (orphan !== undefined) throw new Error(`Codex dynamic tool state has no matching thread: ${orphan}`);
    const spawnEdges = readThreadSpawnEdges(database);
    const spawn = threadSpawnComponents(new Set(threads.keys()), spawnEdges);
    return {
      threads,
      dynamicTools,
      spawnEdges,
      spawnComponents: spawn.components,
      invalidSpawnThreads: spawn.invalidThreadIds,
      unsupportedRelations: unsupportedRelatedThreadIds(database, [...threads.keys()]),
      goals: readThreadGoalRows(database) ?? new Map(),
      sections: readThreadSectionRows(database),
    };
  } finally {
    database.close();
  }
}

function threadString(row: ThreadRow | undefined, name: string): string {
  const value = row?.[name];
  return typeof value === "string" ? value : "";
}

function threadBoolean(row: ThreadRow | undefined, name: string): boolean | undefined {
  const value = row?.[name];
  return typeof value === "number" ? value !== 0 : undefined;
}

function threadTimestamp(row: ThreadRow | undefined, name: string): string {
  const value = row?.[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  const milliseconds = name.endsWith("_ms") ? value : value * 1000;
  return new Date(milliseconds).toISOString();
}

async function backupStateDatabase(sourcePath: string, destinationPath: string): Promise<{
  readonly threads: Map<string, ThreadRow>;
  readonly dynamicTools: Map<string, ThreadDynamicToolRow[]>;
  readonly spawnEdges: Map<string, ThreadSpawnEdgeRow>;
  readonly spawnComponents: ReadonlyMap<string, readonly string[]>;
  readonly invalidSpawnThreads: ReadonlySet<string>;
  readonly unsupportedRelations: ReadonlySet<string>;
  readonly goals: Map<string, ThreadGoalRow>;
  readonly sections: Map<string, ThreadSectionRow>;
}> {
  await backupSQLiteDatabase(sourcePath, destinationPath);
  return readDatabaseSnapshot(destinationPath);
}

function readGoalDatabaseSnapshot(databasePath: string): Map<string, ThreadGoalRow> | undefined {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return readThreadGoalRows(database);
  } finally {
    database.close();
  }
}

function mergeGoals(target: Map<string, ThreadGoalRow>, incoming: ReadonlyMap<string, ThreadGoalRow>): void {
  for (const [threadId, row] of incoming) {
    const existing = target.get(threadId);
    if (existing !== undefined && !threadGoalRowsEqual(existing, row)) {
      throw new Error(`Codex thread goal disagrees between native stores: ${threadId}`);
    }
    target.set(threadId, row);
  }
}

async function copyOptionalFile(
  sourcePath: string,
  relativePath: string,
  workspace: SnapshotWorkspace,
  auxiliary: string[],
): Promise<void> {
  try {
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Codex auxiliary history is not a regular file: ${sourcePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await copyStableFile(sourcePath, path.join(workspace.rawRoot, relativePath));
  auxiliary.push(portablePath(relativePath));
}

interface CapturedRollout {
  readonly rollout: DiscoveredCodexRollout;
  readonly parsed: ScanParsedCodexRollout;
  readonly fingerprint: string;
  readonly reused: boolean;
}

type ScanParsedCodexRollout = Pick<
  ParsedCodexRollout,
  | "nativeId"
  | "createdAt"
  | "updatedAt"
  | "cwd"
  | "provider"
  | "model"
  | "title"
  | "conversation"
  | "nativeSummary"
  | "historyMode"
  | "sessionId"
  | "subagentHistoryStartOrdinal"
  | "forkedFromId"
  | "parentThreadId"
  | "historyBase"
>;

function objectValue(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function optionalString(value: JsonValue | undefined): string | undefined | null {
  return value === null || typeof value === "string" ? value : undefined;
}

function cachedHistoryBase(value: JsonValue | undefined): ParsedCodexRollout["historyBase"] | null | undefined {
  if (value === null) return null;
  const item = value === undefined ? undefined : objectValue(value);
  return item !== undefined && typeof item.threadId === "string" &&
      typeof item.endOrdinalExclusive === "number" && typeof item.endByteOffset === "number"
    ? {
        threadId: item.threadId,
        endOrdinalExclusive: item.endOrdinalExclusive,
        endByteOffset: item.endByteOffset,
      }
    : undefined;
}

function cachedCodexRollout(session: StoredSession): ScanParsedCodexRollout | undefined {
  const source = session.scan?.source === undefined ? undefined : objectValue(session.scan.source);
  if (source === undefined || !Object.hasOwn(source, "nativeSummary")) return undefined;
  const createdAt = source.createdAt;
  const updatedAt = source.updatedAt;
  const cwd = source.cwd;
  const provider = source.provider;
  const model = source.model;
  const title = source.title;
  const historyMode = source.historyMode;
  const sessionId = source.sessionId;
  const nativeSummary = source.nativeSummary;
  const subagentHistoryStartOrdinal = source.subagentHistoryStartOrdinal;
  const forkedFromId = optionalString(source.forkedFromId);
  const parentThreadId = optionalString(source.parentThreadId);
  const historyBase = cachedHistoryBase(source.historyBase);
  if (
    typeof createdAt !== "string" || typeof updatedAt !== "string" || typeof cwd !== "string" ||
    typeof provider !== "string" || typeof model !== "string" || typeof title !== "string" ||
    (historyMode !== "legacy" && historyMode !== "paginated") || typeof sessionId !== "string" ||
    nativeSummary === undefined ||
    !(subagentHistoryStartOrdinal === null || typeof subagentHistoryStartOrdinal === "number") ||
    forkedFromId === undefined || parentThreadId === undefined || historyBase === undefined
  ) return undefined;
  return {
    nativeId: session.nativeId,
    createdAt,
    updatedAt,
    cwd,
    provider,
    model,
    title,
    conversation: session.conversation,
    nativeSummary,
    historyMode,
    sessionId,
    ...(subagentHistoryStartOrdinal === null ? {} : { subagentHistoryStartOrdinal }),
    ...(forkedFromId === null ? {} : { forkedFromId }),
    ...(parentThreadId === null ? {} : { parentThreadId }),
    ...(historyBase === null ? {} : { historyBase }),
  };
}

function codexScanSource(parsed: ScanParsedCodexRollout): JsonValue {
  return {
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    cwd: parsed.cwd,
    provider: parsed.provider,
    model: parsed.model,
    title: parsed.title,
    nativeSummary: parsed.nativeSummary,
    historyMode: parsed.historyMode,
    sessionId: parsed.sessionId,
    subagentHistoryStartOrdinal: parsed.subagentHistoryStartOrdinal ?? null,
    forkedFromId: parsed.forkedFromId ?? null,
    parentThreadId: parsed.parentThreadId ?? null,
    historyBase: parsed.historyBase === undefined ? null : { ...parsed.historyBase },
  };
}

async function captureRollouts(
  rollouts: readonly DiscoveredCodexRollout[],
  workspace: SnapshotWorkspace,
  stateDirectory: string,
  previous: AgentSnapshot | undefined,
  previousByRaw: ReadonlyMap<string, StoredSession>,
): Promise<CapturedRollout[]> {
  const captured: CapturedRollout[] = [];
  for (let offset = 0; offset < rollouts.length; offset += ROLLOUT_CAPTURE_CONCURRENCY) {
    const batch = rollouts.slice(offset, offset + ROLLOUT_CAPTURE_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(async (rollout): Promise<CapturedRollout> => {
      const fingerprint = metadataFingerprint("codex-rollout/v1", [
        rollout.relativePath,
        rollout.archived,
        rollout.fingerprint,
      ]);
      const cached = previousByRaw.get(rollout.relativePath);
      const parsed = cached?.scan?.fingerprint === fingerprint ? cachedCodexRollout(cached) : undefined;
      if (parsed !== undefined) {
        await reuseSnapshotFile(stateDirectory, previous!, rollout.relativePath, workspace);
        return { rollout, parsed, fingerprint, reused: true };
      }
      const destination = path.join(workspace.rawRoot, ...rollout.relativePath.split("/"));
      await copyStableFile(rollout.sourcePath, destination);
      return { rollout, parsed: await parseCodexRollout(destination), fingerprint, reused: false };
    }));
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      captured.push(result.value);
    }
  }
  return captured;
}

export async function scanCodex(options: ScanCodexOptions): Promise<ScanCodexResult> {
  const source = await resolveCodexSource(options);
  await requireRealDirectory(source.codexHome, "Codex home");
  await requireRealDirectory(source.sqliteHome, "Codex SQLite home");
  await ensureStateDirectory(options.stateDirectory, [source.codexHome, source.sqliteHome]);
  const previous = await loadSnapshot(options.stateDirectory, "codex");
  const sourceKey = incrementalSourceKey("codex", [source.codexHome, source.sqliteHome]);
  const previousByRaw = previous?.scan?.sourceKey === sourceKey
    ? new Map(previous.sessions.flatMap((session) => session.rawFiles.length === 1 ? [[session.rawFiles[0]!, session]] : []))
    : new Map<string, StoredSession>();
  const previousLibrary = new Map(previous?.sessions.map((session) => [session.sessionRef, session.library]));

  const warnings: string[] = [];
  const rollouts = await discoverCodexRollouts(source.codexHome, warnings);
  if (rollouts.length === 0) {
    throw new Error("Codex has no supported persisted sessions");
  }

  const workspace = await createSnapshotWorkspace(options.stateDirectory, "codex");
  try {
    const auxiliaryFiles: string[] = [];
    await copyOptionalFile(path.join(source.codexHome, "history.jsonl"), "history.jsonl", workspace, auxiliaryFiles);
    await copyOptionalFile(path.join(source.codexHome, "session_index.jsonl"), "session_index.jsonl", workspace, auxiliaryFiles);

    const databaseSource = await resolveCodexStateStore(source.sqliteHome);
    let threads = new Map<string, ThreadRow>();
    let dynamicTools = new Map<string, ThreadDynamicToolRow[]>();
    let spawnEdges = new Map<string, ThreadSpawnEdgeRow>();
    let spawnComponents = new Map<string, readonly string[]>();
    let invalidSpawnThreads = new Set<string>();
    let unsupportedRelations = new Set<string>();
    let sections = new Map<string, ThreadSectionRow>();
    const goals = new Map<string, ThreadGoalRow>();
    if (databaseSource === undefined) {
      warnings.push("Codex SQLite home has no compatible threads store; readable rollout history was preserved without thread metadata");
    } else {
      const databaseRelative = path.join("sqlite", path.basename(databaseSource));
      const database = await backupStateDatabase(databaseSource, path.join(workspace.rawRoot, databaseRelative));
      threads = database.threads;
      dynamicTools = database.dynamicTools;
      spawnEdges = database.spawnEdges;
      spawnComponents = new Map(database.spawnComponents);
      invalidSpawnThreads = new Set(database.invalidSpawnThreads);
      unsupportedRelations = new Set(database.unsupportedRelations);
      sections = database.sections;
      mergeGoals(goals, database.goals);
      for (const threadId of invalidSpawnThreads) {
        warnings.push(`Codex thread has an incomplete spawn graph: ${threadId}`);
      }
      auxiliaryFiles.push(portablePath(databaseRelative));
    }

    const goalStore = await resolveCodexGoalStore(source.sqliteHome);
    if (goalStore !== undefined && goalStore.databasePath !== databaseSource) {
      const goalsRelative = path.join("sqlite", path.basename(goalStore.databasePath));
      const goalsSnapshot = path.join(workspace.rawRoot, goalsRelative);
      await backupSQLiteDatabase(goalStore.databasePath, goalsSnapshot);
      const capturedGoals = readGoalDatabaseSnapshot(goalsSnapshot);
      if (capturedGoals === undefined) throw new Error("Codex goal store capability changed while scanning");
      mergeGoals(goals, capturedGoals);
      auxiliaryFiles.push(portablePath(goalsRelative));
    }

    const sessions: StoredSession[] = [];
    const seen = new Set<string>();
    const capturedRollouts = await captureRollouts(
      rollouts,
      workspace,
      options.stateDirectory,
      previous,
      previousByRaw,
    );
    for (const { rollout, parsed, fingerprint } of capturedRollouts) {
      if (seen.has(parsed.nativeId)) {
        throw new Error(`Codex session appears more than once: ${parsed.nativeId}`);
      }
      seen.add(parsed.nativeId);
      const thread = threads.get(parsed.nativeId);
      const threadArchived = threadBoolean(thread, "archived");
      if (threadArchived !== undefined && threadArchived !== rollout.archived) {
        throw new Error(`Codex archived state disagrees for session: ${parsed.nativeId}`);
      }
      if (thread !== undefined) {
        const rolloutPath = threadString(thread, "rollout_path");
        const provider = threadString(thread, "model_provider");
        const cwd = threadString(thread, "cwd");
        if (
          !path.isAbsolute(rolloutPath) ||
          !samePath(path.resolve(rolloutPath), path.resolve(rollout.sourcePath), pathFlavorForPlatform())
        ) {
          throw new Error(`Codex rollout path disagrees for session: ${parsed.nativeId}`);
        }
        if (provider === "" || provider !== parsed.provider) {
          throw new Error(`Codex provider disagrees for session: ${parsed.nativeId}`);
        }
        if (
          !path.isAbsolute(cwd) || !path.isAbsolute(parsed.cwd) ||
          !samePath(path.resolve(cwd), path.resolve(parsed.cwd), pathFlavorForPlatform())
        ) {
          throw new Error(`Codex cwd disagrees for session: ${parsed.nativeId}`);
        }
      }
      if (thread === undefined && threads.size !== 0) {
        warnings.push(`Codex session has no matching thread row: ${parsed.nativeId}`);
      }
      const title = threadString(thread, "title") || threadString(thread, "first_user_message") || parsed.title;
      const createdAt = threadTimestamp(thread, "created_at_ms") || threadTimestamp(thread, "created_at") || parsed.createdAt;
      const updatedAt = threadTimestamp(thread, "updated_at_ms") || threadTimestamp(thread, "updated_at") || parsed.updatedAt;
      const sessionRef = codexSessionRef(parsed.nativeId);
      sessions.push({
        sessionRef,
        agent: "codex",
        nativeId: parsed.nativeId,
        title,
        context: threadString(thread, "cwd") || parsed.cwd,
        model: threadString(thread, "model") || parsed.model,
        provider: threadString(thread, "model_provider") || parsed.provider,
        createdAt,
        updatedAt,
        nativeArchived: rollout.archived,
        library: previousLibrary.get(sessionRef) ?? options.importedLibrary?.get(sessionRef) ?? {
          name: "", tags: [], archived: false, deleted: false,
        },
        conversation: parsed.conversation,
        searchText: [],
        rawFiles: [rollout.relativePath],
        native: {
          rollout: {
            relativePath: rollout.relativePath,
            archived: rollout.archived,
            summary: parsed.nativeSummary,
          },
          lineage: {
            historyMode: parsed.historyMode,
            sessionId: parsed.sessionId,
            subagentHistoryStartOrdinal: parsed.subagentHistoryStartOrdinal ?? null,
            forkedFromId: parsed.forkedFromId ?? null,
            parentThreadId: parsed.parentThreadId ?? null,
            historyBase: parsed.historyBase === undefined ? null : { ...parsed.historyBase },
          },
          spawn: {
            incoming: spawnEdges.get(parsed.nativeId) ?? null,
            componentNativeIds: [...(spawnComponents.get(parsed.nativeId) ?? [parsed.nativeId])],
            relationStatus: thread === undefined
              ? "unknown"
              : invalidSpawnThreads.has(parsed.nativeId) ? "invalid" : "valid",
          },
          thread: thread ?? null,
          section: threadSectionForThread(thread, sections),
          dynamicTools: dynamicTools.get(parsed.nativeId) ?? [],
          goal: goals.get(parsed.nativeId) ?? null,
          unsupportedRelationStatus: thread === undefined
            ? "unknown"
            : unsupportedRelations.has(parsed.nativeId) ? "present" : "empty",
        },
        scan: { fingerprint, source: codexScanSource(parsed) },
      });
    }
    for (const threadId of threads.keys()) {
      if (!seen.has(threadId)) warnings.push(`Codex thread row has no matching supported rollout: ${threadId}`);
    }
    for (const threadId of goals.keys()) {
      if (!seen.has(threadId)) warnings.push(`Codex thread goal has no matching supported session: ${threadId}`);
    }
    sessions.sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
    const snapshot: AgentSnapshot = {
      schemaVersion: "agenthist.history-snapshot/v2",
      snapshotId: workspace.id,
      agent: "codex",
      scannedAt: new Date().toISOString(),
      sessions,
      auxiliaryFiles,
      warnings,
      scan: scanState(
        sourceKey,
        previous,
        sessions,
        capturedRollouts.filter((item) => item.reused).length,
      ),
    };
    warnings.push(...await publishSnapshot(options.stateDirectory, workspace, snapshot));
    return { stateDirectory: options.stateDirectory, snapshot };
  } catch (error) {
    await discardSnapshot(workspace);
    throw error;
  }
}
