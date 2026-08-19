import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { pathFlavorForPlatform, samePath } from "../../domain/host-path.js";
import { transactionReference } from "../../domain/transaction.js";
import { validateCodexHistoryBaseBoundary } from "./migration/archive.js";
import { discoverCodexRollouts, requireRealDirectory } from "./carrier.js";
import {
  inspectThreadSchema,
  readAllThreadDynamicTools,
  readThreadSpawnEdges,
  readThreadRows,
  type ThreadDynamicToolRow,
  type ThreadRow,
  type ThreadSpawnEdgeRow,
} from "./storage/database.js";
import { codexSessionRef } from "./identity.js";
import { parseCodexRollout, type ParsedCodexRollout } from "./history/rollout.js";
import { rewriteCodexMetadata } from "./history/rollout-rewrite.js";
import { resolveCodexSource, type CodexSource, type CodexSourceOptions } from "./source.js";
import { requireCodexStateStore } from "./storage/stores.js";
import { executePreparedCodexTransaction, prepareCodexTransaction, type PreparedCodexEffect } from "./migration/transaction.js";
import {
  readThreadSectionRows,
  threadSectionForThread,
  type ThreadSectionRow,
} from "./storage/sections.js";

const PROVIDER_ID = /^[A-Za-z0-9._-]+$/;

interface NativeProviderSession {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly rolloutPath: string;
  readonly archived: boolean;
  readonly parsed: ParsedCodexRollout;
  readonly thread: ThreadRow;
  readonly section: ThreadSectionRow | null;
  readonly dynamicTools: readonly ThreadDynamicToolRow[];
  readonly spawnEdge: ThreadSpawnEdgeRow | null;
}

interface ProviderInventory {
  readonly source: CodexSource;
  readonly databasePath: string;
  readonly sessions: readonly NativeProviderSession[];
}

export interface CodexProviderCount {
  readonly provider: string;
  readonly sessions: number;
  readonly current: boolean;
}

export interface CodexProviderList {
  readonly currentProvider: string;
  readonly providers: readonly CodexProviderCount[];
  readonly totalSessions: number;
}

export interface CodexProviderChange {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly before: string;
  readonly after: string;
}

export interface CodexProviderUnifyResult {
  readonly targetProvider: string;
  readonly changes: readonly CodexProviderChange[];
  readonly unchanged: number;
  readonly transactionRef?: string;
}

export interface CodexProviderOptions extends CodexSourceOptions {
  readonly stateDirectory: string;
}

function threadString(thread: ThreadRow, name: string): string {
  const value = thread[name];
  return typeof value === "string" ? value : "";
}

function threadArchived(thread: ThreadRow): boolean | undefined {
  const value = thread.archived;
  return typeof value === "number" ? value !== 0 : undefined;
}

async function providerInventory(options: CodexSourceOptions): Promise<ProviderInventory> {
  const source = await resolveCodexSource(options);
  await requireRealDirectory(source.codexHome, "Codex home");
  await requireRealDirectory(source.sqliteHome, "Codex SQLite home");
  const databasePath = await requireCodexStateStore(source.sqliteHome);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let threads: Map<string, ThreadRow>;
  let dynamicTools: Map<string, ThreadDynamicToolRow[]>;
  let spawnEdges: Map<string, ThreadSpawnEdgeRow>;
  let sections: Map<string, ThreadSectionRow>;
  try {
    threads = readThreadRows(database);
    dynamicTools = readAllThreadDynamicTools(database);
    spawnEdges = readThreadSpawnEdges(database);
    sections = readThreadSectionRows(database);
    const orphan = [...dynamicTools.keys()].find((id) => !threads.has(id));
    if (orphan !== undefined) throw new Error(`Codex dynamic tool state has no matching thread: ${orphan}`);
  } finally {
    database.close();
  }
  const warnings: string[] = [];
  const rollouts = await discoverCodexRollouts(source.codexHome, warnings);
  if (warnings.length !== 0) throw new Error(`Codex provider inventory is incomplete: ${warnings[0]}`);
  const sessions: NativeProviderSession[] = [];
  const seen = new Set<string>();
  for (const rollout of rollouts) {
    const parsed = await parseCodexRollout(rollout.sourcePath);
    if (seen.has(parsed.nativeId)) throw new Error(`Codex session appears more than once: ${parsed.nativeId}`);
    seen.add(parsed.nativeId);
    const thread = threads.get(parsed.nativeId);
    if (thread === undefined) throw new Error(`Codex session has no matching thread row: ${parsed.nativeId}`);
    const provider = threadString(thread, "model_provider");
    const cwd = threadString(thread, "cwd");
    const rolloutPath = threadString(thread, "rollout_path");
    if (provider === "" || provider !== parsed.provider) throw new Error(`Codex provider disagrees for session: ${parsed.nativeId}`);
    if (!path.isAbsolute(cwd) || cwd !== parsed.cwd) throw new Error(`Codex cwd disagrees for session: ${parsed.nativeId}`);
    if (
      !path.isAbsolute(rolloutPath) ||
      !samePath(path.resolve(rolloutPath), path.resolve(rollout.sourcePath), pathFlavorForPlatform())
    ) {
      throw new Error(`Codex rollout path disagrees for session: ${parsed.nativeId}`);
    }
    if (threadArchived(thread) !== rollout.archived) throw new Error(`Codex archived state disagrees for session: ${parsed.nativeId}`);
    sessions.push({
      sessionRef: codexSessionRef(parsed.nativeId),
      nativeId: parsed.nativeId,
      rolloutPath: rollout.sourcePath,
      archived: rollout.archived,
      parsed,
      thread,
      section: threadSectionForThread(thread, sections),
      dynamicTools: dynamicTools.get(parsed.nativeId) ?? [],
      spawnEdge: spawnEdges.get(parsed.nativeId) ?? null,
    });
  }
  const missing = [...threads.keys()].find((id) => !seen.has(id));
  if (missing !== undefined) throw new Error(`Codex thread has no matching rollout: ${missing}`);
  sessions.sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
  return { source, databasePath, sessions };
}

export async function listCodexProviders(options: CodexSourceOptions): Promise<CodexProviderList> {
  const inventory = await providerInventory(options);
  const counts = new Map<string, number>();
  for (const session of inventory.sessions) {
    counts.set(session.parsed.provider, (counts.get(session.parsed.provider) ?? 0) + 1);
  }
  const providers = [...counts].map(([provider, sessions]) => ({
    provider,
    sessions,
    current: provider === inventory.source.currentProvider,
  })).sort((left, right) => left.provider.localeCompare(right.provider));
  return { currentProvider: inventory.source.currentProvider, providers, totalSessions: inventory.sessions.length };
}

export async function listCodexProviderUsage(options: CodexSourceOptions): Promise<CodexProviderList> {
  const source = await resolveCodexSource(options);
  await requireRealDirectory(source.sqliteHome, "Codex SQLite home");
  const databasePath = await requireCodexStateStore(source.sqliteHome);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    inspectThreadSchema(database);
    const rows = database.prepare(
      "SELECT model_provider AS provider, COUNT(*) AS sessions " +
      "FROM threads GROUP BY model_provider ORDER BY model_provider",
    ).all() as Array<Record<string, unknown>>;
    const providers = rows.map((row): CodexProviderCount => {
      if (typeof row.provider !== "string" || !PROVIDER_ID.test(row.provider)) {
        throw new Error("Codex history contains an invalid provider ID");
      }
      if (typeof row.sessions !== "number" || !Number.isSafeInteger(row.sessions) || row.sessions < 0) {
        throw new Error(`Codex history contains an invalid session count for provider: ${row.provider}`);
      }
      return {
        provider: row.provider,
        sessions: row.sessions,
        current: row.provider === source.currentProvider,
      };
    });
    return {
      currentProvider: source.currentProvider,
      providers,
      totalSessions: providers.reduce((total, item) => total + item.sessions, 0),
    };
  } finally {
    database.close();
  }
}

function targetProvider(requested: string, source: CodexSource): string {
  const result = requested === "current" ? source.currentProvider : requested;
  if (result === "" || !PROVIDER_ID.test(result)) {
    throw new Error(requested === "current" ? "Codex current provider cannot be resolved" : `invalid Codex provider ID: ${requested}`);
  }
  return result;
}

function orderProviderLineage(sessions: readonly NativeProviderSession[]): NativeProviderSession[] {
  const byNativeId = new Map(sessions.map((session) => [session.nativeId, session]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: NativeProviderSession[] = [];
  const visit = (session: NativeProviderSession): void => {
    if (visiting.has(session.nativeId)) throw new Error(`Codex history lineage contains a cycle: ${session.sessionRef}`);
    if (visited.has(session.nativeId)) return;
    visiting.add(session.nativeId);
    const baseId = session.parsed.historyBase?.threadId;
    if (baseId !== undefined) {
      const base = byNativeId.get(baseId);
      if (base === undefined) throw new Error(`Codex history lineage is incomplete: ${session.sessionRef}`);
      visit(base);
    }
    visiting.delete(session.nativeId);
    visited.add(session.nativeId);
    ordered.push(session);
  };
  for (const session of sessions) visit(session);
  return ordered;
}

async function buildUnifyPlan(
  options: CodexProviderOptions,
  requested: string,
  workspace: string,
): Promise<{
  readonly inventory: ProviderInventory;
  readonly target: string;
  readonly changes: readonly CodexProviderChange[];
  readonly effects: readonly PreparedCodexEffect[];
  readonly unchanged: number;
}> {
  const inventory = await providerInventory(options);
  const target = targetProvider(requested, inventory.source);
  const changes: CodexProviderChange[] = [];
  const effects: PreparedCodexEffect[] = [];
  const byteOffsetDeltas = new Map<string, number>();
  const byNativeId = new Map(inventory.sessions.map((session) => [session.nativeId, session]));
  let unchanged = 0;
  for (const [index, session] of orderProviderLineage(inventory.sessions).entries()) {
    const beforeHistoryBase = session.parsed.historyBase;
    let afterHistoryBase = beforeHistoryBase;
    if (beforeHistoryBase !== undefined) {
      const base = byNativeId.get(beforeHistoryBase.threadId);
      if (base === undefined) throw new Error(`Codex history lineage is incomplete: ${session.sessionRef}`);
      await validateCodexHistoryBaseBoundary(
        base.rolloutPath,
        beforeHistoryBase,
        base.parsed.metadataEndByteOffset,
        session.sessionRef,
      );
      const baseDelta = byteOffsetDeltas.get(beforeHistoryBase.threadId);
      if (baseDelta === undefined) throw new Error(`Codex history base was not projected first: ${session.sessionRef}`);
      const endByteOffset = beforeHistoryBase.endByteOffset + baseDelta;
      if (!Number.isSafeInteger(endByteOffset) || endByteOffset <= 0) {
        throw new Error(`Codex projected history base is invalid: ${session.sessionRef}`);
      }
      afterHistoryBase = { ...beforeHistoryBase, endByteOffset };
    }
    const providerChanged = session.parsed.provider !== target;
    if (providerChanged) {
      changes.push({
        sessionRef: session.sessionRef,
        nativeId: session.nativeId,
        before: session.parsed.provider,
        after: target,
      });
    } else unchanged++;
    const historyBaseChanged = beforeHistoryBase?.endByteOffset !== afterHistoryBase?.endByteOffset;
    if (!providerChanged && !historyBaseChanged) {
      byteOffsetDeltas.set(session.nativeId, 0);
      continue;
    }
    const afterPath = path.join(workspace, `provider-${index.toString().padStart(6, "0")}.jsonl`);
    const rewritten = await rewriteCodexMetadata(session.rolloutPath, afterPath, {
      nativeId: session.nativeId,
      beforeProvider: session.parsed.provider,
      afterProvider: target,
      beforeCwd: session.parsed.cwd,
      afterCwd: session.parsed.cwd,
      ...(beforeHistoryBase === undefined || afterHistoryBase === undefined
        ? {}
        : { historyBase: { before: beforeHistoryBase, after: afterHistoryBase } }),
    });
    byteOffsetDeltas.set(session.nativeId, rewritten.byteOffsetDelta);
    const afterRow = { ...session.thread, model_provider: target };
    effects.push({
      sessionRef: session.sessionRef,
      nativeId: session.nativeId,
      destination: session.rolloutPath,
      before: {
        row: session.thread,
        section: session.section,
        dynamicTools: session.dynamicTools,
        spawnEdge: session.spawnEdge,
        filePath: session.rolloutPath,
      },
      after: {
        row: afterRow,
        section: session.section,
        dynamicTools: session.dynamicTools,
        spawnEdge: session.spawnEdge,
        filePath: afterPath,
      },
    });
  }
  return { inventory, target, changes, effects, unchanged };
}

export async function unifyCodexProviders(
  options: CodexProviderOptions,
  requested: string,
  apply: boolean,
): Promise<CodexProviderUnifyResult> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-provider-"));
  try {
    const plan = await buildUnifyPlan(options, requested, workspace);
    if (plan.effects.length === 0 || !apply) {
      return { targetProvider: plan.target, changes: plan.changes, unchanged: plan.unchanged };
    }
    const journal = await prepareCodexTransaction({
      stateDirectory: options.stateDirectory,
      operation: "codex_provider_unify",
      codexHome: plan.inventory.source.codexHome,
      sqliteHome: plan.inventory.source.sqliteHome,
      database: plan.inventory.databasePath,
      effects: plan.effects,
    });
    const committed = await executePreparedCodexTransaction(options.stateDirectory, journal);
    return {
      targetProvider: plan.target,
      changes: plan.changes,
      unchanged: plan.unchanged,
      transactionRef: transactionReference(committed.id),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
