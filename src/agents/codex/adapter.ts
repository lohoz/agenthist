import path from "node:path";

import type { ProjectedArchiveEntry } from "../../domain/archive.js";
import type { ArchiveObjectSource } from "../../infrastructure/archive.js";
import type {
  AgentAdapter,
  AgentPortableProjection,
  AgentSourceOptions,
  HistorySourceInspection,
} from "../contracts.js";
import { failedSourceInspection } from "../source-support.js";
import { requirePortableSession } from "../portable-support.js";
import { discoverCodexRollouts, requireRealDirectory } from "./carrier.js";
import {
  prepareCodexArchive,
  closeCodexSelection,
  closeCodexEntrySelection,
  validateCodexArchiveEntries,
  validateCodexArchiveObjects,
} from "./migration/archive.js";
import { prepareCodexRestore, type RestoreCodexResult } from "./migration/restore.js";
import {
  previewCodexRecovery,
  previewCodexRollback,
  recoverCodexTransaction,
  rollbackCodexTransaction,
} from "./migration/transaction.js";
import {
  projectPortableContextToCodex,
  writeCodexPortableProjection,
  type CodexPortableProjection,
} from "./conversion/portable-projector.js";
import { createCodexPortableMaterializer } from "./conversion/portable.js";
import { scanCodex } from "./scan.js";
import { resolveCodexSource, type CodexSourceOptions } from "./source.js";

function sourceOptions(options: AgentSourceOptions): CodexSourceOptions {
  return {
    ...(options.historyRoot === undefined ? {} : { codexHome: options.historyRoot }),
    ...(options.nativeStateRoot === undefined ? {} : { sqliteHome: options.nativeStateRoot }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
}

async function detectCodex(options: AgentSourceOptions): Promise<HistorySourceInspection> {
  let source;
  try {
    source = await resolveCodexSource(sourceOptions(options));
  } catch (error) {
    return failedSourceInspection("codex", [], "error", error);
  }
  const locations = [
    { role: "history_root" as const, path: source.codexHome },
    { role: "native_state_root" as const, path: source.sqliteHome },
  ];
  const warnings: string[] = [];
  try {
    const rollouts = await discoverCodexRollouts(source.codexHome, warnings);
    if (rollouts.length === 0) return { agent: "codex", status: "not_detected", locations, findings: [] };
    await requireRealDirectory(source.codexHome, "Codex home");
    await requireRealDirectory(source.sqliteHome, "Codex SQLite home");
    return {
      agent: "codex",
      status: "ready",
      locations,
      findings: warnings.length === 0 ? [] : ["codex.history.carrier_skipped"],
    };
  } catch (error) {
    return failedSourceInspection("codex", locations, "blocked", error);
  }
}

function codexProjection(value: AgentPortableProjection): CodexPortableProjection {
  if (value.targetAgent !== "codex") throw new Error("Codex portable target received another Agent projection");
  return value as CodexPortableProjection;
}

function nativeImportResult(result: RestoreCodexResult) {
  return {
    target: { root: result.targetCodexHome, databaseRoot: result.targetSQLiteHome },
    items: result.items,
    newSessions: result.newSessions,
    alreadyPresent: result.alreadyPresent,
    resources: result.resources,
    ...(result.transactionRef === undefined ? {} : { transactionRef: result.transactionRef }),
  };
}

export const codexAdapter = {
  id: "codex",
  source: {
    detect: detectCodex,
    inspect: detectCodex,
    async roots(options) {
      const source = await resolveCodexSource(sourceOptions(options));
      await requireRealDirectory(source.codexHome, "Codex home");
      await requireRealDirectory(source.sqliteHome, "Codex SQLite home");
      return [source.codexHome, source.sqliteHome];
    },
    async scan(options) {
      return (await scanCodex({ stateDirectory: options.stateDirectory, ...sourceOptions(options) })).snapshot;
    },
  },
  archive: {
    closeExportSelection: closeCodexSelection,
    async prepare(options) {
      return prepareCodexArchive(
        options.stateDirectory,
        options.snapshot,
        options.sessions,
        options.allocateObjectId,
      );
    },
    validateEntries: validateCodexArchiveEntries,
    validateObjects: validateCodexArchiveObjects,
    closeSelection: closeCodexEntrySelection,
  },
  nativeImport: {
    async prepare(options) {
      const prepared = await prepareCodexRestore({
        stateDirectory: options.stateDirectory,
        entries: options.entries,
        objects: options.objects,
        providerPolicy: options.providerPolicy,
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
      return journal.agents.length === 1 && journal.agents[0] === "codex" &&
        (journal.operation === "history_import" || journal.operation === "codex_provider_unify");
    },
    previewRollback: previewCodexRollback,
    rollback: rollbackCodexTransaction,
    previewRecovery: previewCodexRecovery,
    recover: recoverCodexTransaction,
  },
  portableSource: {
    async create(options) {
      const materializer = createCodexPortableMaterializer(options.stateDirectory, options.snapshot);
      return {
        sessions: options.snapshot.sessions,
        prepare(sessionRef) {
          return materializer.prepare(requirePortableSession(options.snapshot.sessions, sessionRef));
        },
      };
    },
  },
  portableTarget: {
    writeMode: "independent",
    project: projectPortableContextToCodex,
    async write(options) {
      const sources: ArchiveObjectSource[] = [];
      const entries: ProjectedArchiveEntry[] = [];
      for (const item of options.projections) {
        const projection = codexProjection(item.projection);
        const objectId = options.allocateObjectId();
        const written = await writeCodexPortableProjection(
          projection,
          objectId,
          path.join(options.workspace, `${objectId}.jsonl`),
        );
        sources.push(...written.sources);
        entries.push(...written.entries);
      }
      return { sources, entries };
    },
  },
} satisfies AgentAdapter<"codex">;
