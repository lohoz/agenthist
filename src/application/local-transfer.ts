import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Agent } from "../domain/agent.js";
import type { ArchiveEntry } from "../domain/archive.js";
import type { ConversionFinding, ConversionStatus } from "../domain/conversion.js";
import { sessionAgent } from "../domain/history.js";
import { pathFlavorForPlatform } from "../domain/host-path.js";
import { loadSnapshot } from "../infrastructure/history-store.js";
import { withStateReadLock } from "../infrastructure/state.js";
import { prepareImportConversions } from "./conversion.js";
import { importPreparedHistory, type ImportHistoryResult } from "./history-import.js";
import { withPreparedHistorySource } from "./transfer.js";

export interface TransferHistorySessionOptions {
  readonly stateDirectory: string;
  readonly sessionRef: string;
  readonly targetAgent: Agent;
  readonly mode: "dry_run" | "apply";
  readonly allowLossyConversion?: boolean;
  readonly codexHome?: string;
  readonly sqliteHome?: string;
  readonly profile?: string;
  readonly opencodeDataRoot?: string;
  readonly opencodeDatabase?: string;
  readonly claudeConfigRoot?: string;
  readonly piSessionRoot?: string;
  readonly providerPolicy?: string;
  readonly pathMappings?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly home?: string;
}

export interface ExistingHistoryTransfer {
  readonly sourceSessionRef: string;
  readonly targetAgent: Agent;
  readonly targetSessionRef: string;
  readonly targetNativeId: string;
  readonly quality: Exclude<ConversionStatus, "blocked">;
  readonly findings: readonly ConversionFinding[];
}

export type FindExistingHistoryTransferOptions = Omit<TransferHistorySessionOptions, "mode">;

function transferEntries(
  entries: readonly ArchiveEntry[],
  sessionRef: string,
  allowLossyConversion: boolean | undefined,
): readonly ArchiveEntry[] {
  if (!allowLossyConversion) return entries;
  const selected = entries.filter((entry) => entry.sessionRef === sessionRef);
  if (selected.length !== 1) throw new Error("lossy local transfer could not isolate the selected conversation");
  return selected;
}

function objectIdAllocator(existing: ReadonlySet<string>): () => string {
  let next = 0;
  return () => {
    while (true) {
      next++;
      if (next > 999_999) throw new Error("local transfer exceeds the object identity limit");
      const id = `o${next.toString().padStart(6, "0")}`;
      if (!existing.has(id)) return id;
    }
  };
}

export async function findExistingHistoryTransfer(
  options: FindExistingHistoryTransferOptions,
): Promise<ExistingHistoryTransfer | undefined> {
  if (sessionAgent(options.sessionRef) === options.targetAgent) return undefined;
  const targetSnapshot = await withStateReadLock(
    options.stateDirectory,
    () => loadSnapshot(options.stateDirectory, options.targetAgent),
  );
  if (targetSnapshot === undefined) return undefined;
  return withPreparedHistorySource({
    stateDirectory: options.stateDirectory,
    sessions: [options.sessionRef],
    strictSessions: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  }, async (source) => {
    const entries = transferEntries(source.entries, options.sessionRef, options.allowLossyConversion);
    const objects = new Map(source.sources.map((object) => [object.id, object.filePath]));
    if (objects.size !== source.sources.length) throw new Error("prepared history source has duplicate objects");
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-local-transfer-plan-"));
    try {
      const destinations = new Map(entries.map((entry) => [entry.sessionRef, options.targetAgent]));
      const conversions = await prepareImportConversions({
        entries,
        objects,
        destinations,
        workspace,
        pathFlavor: pathFlavorForPlatform(),
        ...(options.allowLossyConversion === undefined ? {} : { allowLossy: options.allowLossyConversion }),
        allocateObjectId: objectIdAllocator(new Set(objects.keys())),
      });
      const planned = conversions.items.find((item) => item.sourceSessionRef === options.sessionRef);
      if (planned === undefined || planned.status === "blocked" || planned.targetSessionRef === "") return undefined;
      const existing = targetSnapshot.sessions.find((session) => session.sessionRef === planned.targetSessionRef);
      if (existing === undefined) return undefined;
      return {
        sourceSessionRef: options.sessionRef,
        targetAgent: options.targetAgent,
        targetSessionRef: planned.targetSessionRef,
        targetNativeId: existing.nativeId,
        quality: planned.status,
        findings: planned.findings,
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

export async function transferHistorySession(
  options: TransferHistorySessionOptions,
): Promise<ImportHistoryResult> {
  return withPreparedHistorySource({
    stateDirectory: options.stateDirectory,
    sessions: [options.sessionRef],
    strictSessions: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  }, async (source) => {
    const entries = transferEntries(source.entries, options.sessionRef, options.allowLossyConversion);
    const objects = new Map(source.sources.map((object) => [object.id, object.filePath]));
    if (objects.size !== source.sources.length) throw new Error("prepared history source has duplicate objects");
    return importPreparedHistory({
      stateDirectory: options.stateDirectory,
      targetAgent: options.targetAgent,
      mode: options.mode,
      ...(options.allowLossyConversion === undefined ? {} : { allowLossyConversion: options.allowLossyConversion }),
      ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
      ...(options.sqliteHome === undefined ? {} : { sqliteHome: options.sqliteHome }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.opencodeDataRoot === undefined ? {} : { opencodeDataRoot: options.opencodeDataRoot }),
      ...(options.opencodeDatabase === undefined ? {} : { opencodeDatabase: options.opencodeDatabase }),
      ...(options.claudeConfigRoot === undefined ? {} : { claudeConfigRoot: options.claudeConfigRoot }),
      ...(options.piSessionRoot === undefined ? {} : { piSessionRoot: options.piSessionRoot }),
      ...(options.providerPolicy === undefined ? {} : { providerPolicy: options.providerPolicy }),
      ...(options.pathMappings === undefined ? {} : { pathMappings: options.pathMappings }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.home === undefined ? {} : { home: options.home }),
    }, {
      entries,
      objects,
      pathFlavor: pathFlavorForPlatform(),
    });
  });
}
