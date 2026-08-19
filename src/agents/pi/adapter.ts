import path from "node:path";

import type { ProjectedArchiveEntry } from "../../domain/archive.js";
import type { ArchiveObjectSource } from "../../infrastructure/archive.js";
import type {
  AgentAdapter,
  AgentPortableProjection,
  AgentSourceOptions,
  HistorySourceInspection,
} from "../contracts.js";
import { requirePortableSession } from "../portable-support.js";
import { failedSourceInspection } from "../source-support.js";
import { discoverPiSessions } from "./carrier.js";
import { preparePiPortableSource } from "./conversion/portable.js";
import {
  projectPortableContextToPi,
  writePiPortableProjection,
  type PiPortableProjection,
} from "./conversion/portable-projector.js";
import {
  closePiEntrySelection,
  preparePiArchive,
  validatePiArchiveEntries,
  validatePiArchiveObjects,
} from "./migration/archive.js";
import { preparePiRestore, type RestorePiResult } from "./migration/restore.js";
import {
  previewPiRecovery,
  previewPiRollback,
  recoverPiTransaction,
  rollbackPiTransaction,
} from "./migration/transaction.js";
import { scanPi } from "./scan.js";
import { requirePiSource, resolvePiSource, type PiSourceOptions } from "./source.js";

function sourceOptions(options: AgentSourceOptions): PiSourceOptions {
  return {
    ...(options.historyRoot === undefined ? {} : { sessionRoot: options.historyRoot }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
}

async function detectPi(options: AgentSourceOptions): Promise<HistorySourceInspection> {
  let source;
  try {
    source = resolvePiSource(sourceOptions(options));
  } catch (error) {
    return failedSourceInspection("pi", [], "error", error);
  }
  const locations = [{ role: "history_root" as const, path: source.sessionRoot }];
  try {
    const carriers = await discoverPiSessions(source.sessionRoot);
    if (carriers.length === 0) return { agent: "pi", status: "not_detected", locations, findings: [] };
    await requirePiSource(source);
    return { agent: "pi", status: "ready", locations, findings: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { agent: "pi", status: "not_detected", locations, findings: [] };
    }
    return failedSourceInspection("pi", locations, "blocked", error);
  }
}

function piProjection(value: AgentPortableProjection): PiPortableProjection {
  if (value.targetAgent !== "pi") throw new Error("Pi portable target received another Agent projection");
  return value as PiPortableProjection;
}

function nativeImportResult(result: RestorePiResult) {
  return {
    target: { root: result.targetSessionRoot },
    items: result.items,
    newSessions: result.newSessions,
    alreadyPresent: result.alreadyPresent,
    resources: result.resources,
    ...(result.transactionRef === undefined ? {} : { transactionRef: result.transactionRef }),
  };
}

export const piAdapter = {
  id: "pi",
  source: {
    detect: detectPi,
    inspect: detectPi,
    async roots(options) {
      const source = resolvePiSource(sourceOptions(options));
      await requirePiSource(source);
      return [source.sessionRoot];
    },
    async scan(options) {
      return (await scanPi({ stateDirectory: options.stateDirectory, ...sourceOptions(options) })).snapshot;
    },
  },
  archive: {
    async prepare(options) {
      return preparePiArchive(
        options.stateDirectory,
        options.snapshot,
        options.sessions,
        options.allocateObjectId,
      );
    },
    validateEntries: validatePiArchiveEntries,
    validateObjects: validatePiArchiveObjects,
    closeSelection: closePiEntrySelection,
  },
  nativeImport: {
    async prepare(options) {
      const prepared = await preparePiRestore({
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
      return journal.agents.length === 1 && journal.agents[0] === "pi" && journal.operation === "history_import";
    },
    previewRollback: previewPiRollback,
    rollback: rollbackPiTransaction,
    previewRecovery: previewPiRecovery,
    recover: recoverPiTransaction,
  },
  portableSource: {
    async create(options) {
      return {
        sessions: options.snapshot.sessions,
        prepare(sessionRef) {
          return preparePiPortableSource(
            options.stateDirectory,
            options.snapshot,
            requirePortableSession(options.snapshot.sessions, sessionRef),
          );
        },
      };
    },
  },
  portableTarget: {
    writeMode: "independent",
    project: projectPortableContextToPi,
    async write(options) {
      const sources: ArchiveObjectSource[] = [];
      const entries: ProjectedArchiveEntry[] = [];
      for (const item of options.projections) {
        const projection = piProjection(item.projection);
        const objectId = options.allocateObjectId();
        const written = await writePiPortableProjection(
          projection,
          objectId,
          path.join(options.workspace, `${objectId}.jsonl`),
          item.sourceUpdatedAt,
        );
        sources.push(...written.sources);
        entries.push(...written.entries);
      }
      return { sources, entries };
    },
  },
} satisfies AgentAdapter<"pi">;
