import { DatabaseSync } from "node:sqlite";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentAdapter,
  AgentPortableProjection,
  AgentSourceOptions,
  HistorySourceInspection,
} from "../contracts.js";
import type { ArchiveEntry } from "../../domain/archive.js";
import type { AgentSnapshot, StoredSession } from "../../domain/history.js";
import { snapshotRawPath } from "../../infrastructure/history-store.js";
import { failedSourceInspection } from "../source-support.js";
import { requirePortableSession } from "../portable-support.js";
import { backupSQLiteDatabase } from "../../infrastructure/sqlite.js";
import {
  prepareOpenCodeArchive,
  closeOpenCodeSelection,
  closeOpenCodeEntrySelection,
  readOpenCodeNativeDescriptor,
  validateOpenCodeArchiveEntries,
  validateOpenCodeArchiveObjects,
} from "./migration/archive.js";
import { prepareOpenCodeRestore, type RestoreOpenCodeResult } from "./migration/restore.js";
import {
  previewOpenCodeRecovery,
  previewOpenCodeRollback,
  recoverOpenCodeTransaction,
  rollbackOpenCodeTransaction,
} from "./migration/transaction.js";
import {
  projectPortableContextToOpenCode,
  writeOpenCodePortableProjections,
  type OpenCodePortableProjection,
} from "./conversion/portable-projector.js";
import { createOpenCodePortableSourceLoader } from "./conversion/portable.js";
import { readOpenCodeHistory } from "./history/reader.js";
import { scanOpenCode } from "./scan.js";
import { inspectOpenCodeHistorySchema } from "./storage/database.js";
import {
  requireOpenCodeSource,
  resolveOpenCodeSource,
  type OpenCodeSourceOptions,
} from "./source.js";
import { loadOpenCodeToolOutputResources } from "./tool-output.js";

function sourceOptions(options: AgentSourceOptions): OpenCodeSourceOptions {
  return {
    ...(options.historyRoot === undefined ? {} : { dataRoot: options.historyRoot }),
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function detectOpenCode(options: AgentSourceOptions): Promise<HistorySourceInspection> {
  let source;
  try {
    source = resolveOpenCodeSource(sourceOptions(options));
  } catch (error) {
    return failedSourceInspection("opencode", [], "error", error);
  }
  const locations = [
    { role: "data_root" as const, path: source.dataRoot },
    { role: "database" as const, path: source.databasePath },
  ];
  try {
    if (!await pathExists(source.databasePath)) {
      return { agent: "opencode", status: "not_detected", locations, findings: [] };
    }
    await requireOpenCodeSource(source);
    return { agent: "opencode", status: "ready", locations, findings: [] };
  } catch (error) {
    return failedSourceInspection("opencode", locations, "blocked", error);
  }
}

async function inspectOpenCode(options: AgentSourceOptions): Promise<HistorySourceInspection> {
  const detected = await detectOpenCode(options);
  if (detected.status !== "ready") return detected;
  const databasePath = detected.locations.find((location) => location.role === "database")!.path;
  let workspace: string | undefined;
  try {
    workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-doctor-"));
    const snapshot = path.join(workspace, "opencode.sqlite");
    await backupSQLiteDatabase(databasePath, snapshot);
    const database = new DatabaseSync(snapshot, { readOnly: true, readBigInts: true });
    try {
      inspectOpenCodeHistorySchema(database);
    } finally {
      database.close();
    }
    return detected;
  } catch (error) {
    const status = (error as NodeJS.ErrnoException).code === undefined ? "blocked" : "error";
    return failedSourceInspection("opencode", detected.locations, status, error);
  } finally {
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
  }
}

async function archiveSessions(
  stateDirectory: string,
  snapshot: AgentSnapshot,
  entries: readonly ArchiveEntry[],
): Promise<readonly StoredSession[]> {
  const databaseBinding = entries[0]?.objects.find((binding) => binding.role === "history-database");
  if (databaseBinding === undefined) throw new Error("OpenCode archive source has no history database");
  const databasePath = snapshotRawPath(stateDirectory, snapshot, databaseBinding.relativePath);
  const toolOutputs = new Map(entries.map((entry) => [
    entry.nativeId,
    readOpenCodeNativeDescriptor(entry).toolOutputs,
  ]));
  const resources = await loadOpenCodeToolOutputResources(
    toolOutputs,
    (relativePath) => snapshotRawPath(stateDirectory, snapshot, relativePath),
  );
  const planFiles = new Map(entries.flatMap((entry) => {
    const plan = readOpenCodeNativeDescriptor(entry).plan;
    return plan === null ? [] : [[entry.nativeId, plan] as const];
  }));
  const sidecarFiles = [...new Set(entries.flatMap((entry) => entry.objects
    .filter((binding) => binding.role === "session-diff")
    .map((binding) => binding.relativePath)))].sort();
  const importedLibrary = new Map(entries.map((entry) => [entry.sessionRef, entry.library]));
  const captured = readOpenCodeHistory({
    databasePath,
    databaseRelativePath: databaseBinding.relativePath,
    sidecarFiles,
    planFiles,
    toolOutputs,
    toolOutputResources: resources.byNativePath,
    importedLibrary,
  });
  const byNativeId = new Map(captured.sessions.map((session) => [session.nativeId, session]));
  return entries.map((entry) => {
    const session = byNativeId.get(entry.nativeId);
    if (session === undefined || session.sessionRef !== entry.sessionRef) {
      throw new Error(`OpenCode archive source omitted a session: ${entry.sessionRef}`);
    }
    return {
      ...session,
      title: entry.title,
      context: entry.context,
      model: entry.model,
      provider: entry.provider,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      nativeArchived: entry.nativeArchived,
      library: entry.library,
      rawFiles: entry.objects.map((binding) => binding.relativePath),
      native: entry.native,
    };
  });
}

function openCodeProjection(value: AgentPortableProjection): OpenCodePortableProjection {
  if (value.targetAgent !== "opencode") {
    throw new Error("OpenCode portable target received another Agent projection");
  }
  return value as OpenCodePortableProjection;
}

function nativeImportResult(result: RestoreOpenCodeResult) {
  return {
    target: { root: result.targetDataRoot, database: result.targetDatabase },
    items: result.items,
    newSessions: result.newSessions,
    alreadyPresent: result.alreadyPresent,
    resources: result.resources,
    ...(result.transactionRef === undefined ? {} : { transactionRef: result.transactionRef }),
  };
}

export const openCodeAdapter = {
  id: "opencode",
  source: {
    detect: detectOpenCode,
    inspect: inspectOpenCode,
    async roots(options) {
      const source = resolveOpenCodeSource(sourceOptions(options));
      await requireOpenCodeSource(source);
      return [source.dataRoot, source.databasePath];
    },
    async scan(options) {
      return (await scanOpenCode({ stateDirectory: options.stateDirectory, ...sourceOptions(options) })).snapshot;
    },
  },
  archive: {
    closeExportSelection: closeOpenCodeSelection,
    async prepare(options) {
      return prepareOpenCodeArchive(
        options.stateDirectory,
        options.snapshot,
        options.sessions,
        options.workspace,
        options.allocateObjectId,
      );
    },
    validateEntries: validateOpenCodeArchiveEntries,
    validateObjects: validateOpenCodeArchiveObjects,
    closeSelection: closeOpenCodeEntrySelection,
  },
  nativeImport: {
    async prepare(options) {
      const prepared = await prepareOpenCodeRestore({
        stateDirectory: options.stateDirectory,
        entries: options.entries,
        objects: options.objects,
        pathMappings: options.pathMappings,
        workspace: options.workspace,
        ...sourceOptions(options.source),
      });
      return {
        result: nativeImportResult(prepared.result),
        async apply() {
          return nativeImportResult(await prepared.apply());
        },
      };
    },
  },
  transaction: {
    owns(journal) {
      return journal.agents.length === 1 && journal.agents[0] === "opencode" &&
        journal.operation === "history_import";
    },
    previewRollback: previewOpenCodeRollback,
    rollback: rollbackOpenCodeTransaction,
    previewRecovery: previewOpenCodeRecovery,
    recover: recoverOpenCodeTransaction,
  },
  portableSource: {
    async create(options) {
      const sessions = await archiveSessions(options.stateDirectory, options.snapshot, options.entries);
      const snapshot = { ...options.snapshot, sessions };
      const loader = await createOpenCodePortableSourceLoader(options.stateDirectory, snapshot);
      return {
        sessions,
        async prepare(sessionRef) {
          return loader.prepare(requirePortableSession(sessions, sessionRef));
        },
      };
    },
  },
  portableTarget: {
    writeMode: "shared",
    project: projectPortableContextToOpenCode,
    async write(options) {
      const objectId = options.allocateObjectId();
      return writeOpenCodePortableProjections(
        options.projections.map((item) => openCodeProjection(item.projection)),
        objectId,
        path.join(options.workspace, `${objectId}-opencode.sqlite`),
      );
    },
  },
} satisfies AgentAdapter<"opencode">;
