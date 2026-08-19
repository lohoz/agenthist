import { lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ImportEntry } from "../../../domain/import.js";
import type { JsonValue, StoredSession } from "../../../domain/history.js";
import { mapAbsolutePath, type PathMappings } from "../../../domain/path-mapping.js";
import {
  newManagedResourceEffects,
  planManagedResources,
  type ManagedResourcePlan,
} from "../../../infrastructure/managed-resources.js";
import { transactionReference } from "../../../domain/transaction.js";
import { digestFile } from "../../../infrastructure/files.js";
import { loadSnapshot } from "../../../infrastructure/history-store.js";
import {
  orderCodexLineage,
  readCodexDynamicTools,
  readCodexGoal,
  readCodexLineage,
  readCodexSection,
  readCodexSpawn,
} from "./archive.js";
import type { CodexHistoryBase } from "../history/rollout.js";
import { scanCodex } from "../scan.js";
import { resolveCodexSource, type CodexSourceOptions } from "../source.js";
import { requireCodexStateStore } from "../storage/stores.js";
import { rewriteCodexMetadata } from "../history/rollout-rewrite.js";
import {
  inspectThreadSchema,
  readThreadDynamicTools,
  readThreadRow,
  readThreadSpawnEdges,
  threadDynamicToolsEqual,
  threadRowsEqual,
  threadSpawnEdgesEqual,
  unsupportedRelatedThreadIds,
  validateDynamicToolTarget,
  validateThreadShape,
  validateThreadSpawnTarget,
  type ThreadColumn,
  type ThreadDynamicToolRow,
  type ThreadRow,
  type ThreadSpawnEdgeRow,
} from "../storage/database.js";
import {
  inspectThreadGoalSchema,
  readThreadGoalContinuationDeferral,
  readThreadGoalRow,
  resolveCodexGoalStore,
  threadGoalRowsEqual,
  validateThreadGoalShape,
  type CodexGoalStore,
  type ThreadGoalRow,
} from "../storage/goals.js";
import {
  inspectThreadSectionSchema,
  readThreadSectionReferenceIds,
  readThreadSectionRow,
  threadSectionRowsEqual,
  validateThreadSectionShape,
  type ThreadSectionRow,
} from "../storage/sections.js";
import { executePreparedCodexTransaction, prepareCodexTransaction } from "./transaction.js";

export type ImportClassification = "new" | "already_present" | "conflict";

export interface CodexImportItem {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly classification: ImportClassification;
  readonly destination: string;
  readonly provider: string;
  readonly cwd: string;
  readonly reason?: string;
}

export interface RestoreCodexOptions extends CodexSourceOptions {
  readonly stateDirectory: string;
  readonly entries: readonly ImportEntry[];
  readonly objects: ReadonlyMap<string, string>;
  readonly providerPolicy: string;
  readonly pathMappings: PathMappings;
  readonly workspace: string;
}

export interface RestoreCodexResult {
  readonly targetCodexHome: string;
  readonly targetSQLiteHome: string;
  readonly items: readonly CodexImportItem[];
  readonly newSessions: number;
  readonly alreadyPresent: number;
  readonly resources: ManagedResourcePlan["items"];
  readonly transactionRef?: string;
}

interface PlannedItem {
  readonly entry: ImportEntry;
  readonly result: CodexImportItem;
  readonly projectedRollout: string;
  readonly destination: string;
  readonly thread: ThreadRow;
  readonly dynamicTools: readonly ThreadDynamicToolRow[];
  readonly spawnEdge: ThreadSpawnEdgeRow | null;
  readonly goal: ThreadGoalRow | null;
  readonly sectionBefore: ThreadSectionRow | null;
  readonly sectionAfter: ThreadSectionRow | null;
}

interface RestorePlan {
  readonly target: Awaited<ReturnType<typeof resolveCodexSource>>;
  readonly databasePath: string;
  readonly planned: readonly PlannedItem[];
  readonly resources: ManagedResourcePlan;
  readonly goalStore?: CodexGoalStore;
}

export interface PreparedCodexRestore {
  readonly result: RestoreCodexResult;
  readonly apply: () => Promise<RestoreCodexResult>;
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function nativeThread(entry: ImportEntry): ThreadRow {
  const native = objectValue(entry.native);
  const thread = objectValue(native?.thread);
  if (thread === undefined) {
    throw new Error(`Codex session has no restorable SQLite thread: ${entry.sessionRef}`);
  }
  return { ...thread };
}

function targetThread(
  entry: ImportEntry,
  columns: ReadonlyMap<string, ThreadColumn>,
): ThreadRow {
  const thread = nativeThread(entry);
  if (entry.projection === undefined) return thread;
  return Object.fromEntries(Object.entries(thread).filter(([name]) => columns.has(name)));
}

function resolveProvider(policy: string, current: string, entry: ImportEntry): string {
  if (policy === "preserve") return entry.provider;
  if (policy === "current") {
    if (current === "") throw new Error("target Codex current provider cannot be resolved; use preserve or an explicit provider ID");
    return current;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(policy)) throw new Error(`invalid Codex provider policy: ${policy}`);
  return policy;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`target rollout path is not a regular file: ${filePath}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function buildRestorePlan(options: RestoreCodexOptions): Promise<RestorePlan> {
  const target = await resolveCodexSource(options);
  const databasePath = await requireCodexStateStore(target.sqliteHome);
  const goalStore = await resolveCodexGoalStore(target.sqliteHome);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const goalDatabase = goalStore === undefined
    ? undefined
    : goalStore.databasePath === databasePath ? database : new DatabaseSync(goalStore.databasePath, { readOnly: true });
  const mappings = options.pathMappings;
  const destinationSet = new Set<string>();
  const planned: PlannedItem[] = [];
  const workingDirectories = new Map<string, string>();
  const byteOffsetDeltas = new Map<string, number>();
  try {
    const columns = inspectThreadSchema(database);
    const goalColumns = goalDatabase === undefined ? undefined : inspectThreadGoalSchema(goalDatabase);
    const sectionColumns = inspectThreadSectionSchema(database);
    const related = unsupportedRelatedThreadIds(database, options.entries.map((entry) => entry.nativeId));
    const targetSpawnEdges = readThreadSpawnEdges(database);
    const orderedEntries = orderCodexLineage(options.entries);
    for (const [index, entry] of orderedEntries.entries()) {
      if (entry.agent !== "codex") throw new Error(`unsupported import target: ${entry.agent}`);
      const binding = entry.objects[0];
      const objectPath = binding === undefined ? undefined : options.objects.get(binding.id);
      if (binding === undefined || objectPath === undefined) throw new Error(`Codex rollout object is missing: ${entry.sessionRef}`);
      const destination = path.join(target.codexHome, ...binding.relativePath.split("/"));
      const relative = path.relative(target.codexHome, destination);
      if (relative.startsWith("..") || path.isAbsolute(relative) || destinationSet.has(destination)) {
        throw new Error(`Codex rollout target collides or escapes its root: ${entry.sessionRef}`);
      }
      destinationSet.add(destination);
      const provider = resolveProvider(options.providerPolicy, target.currentProvider, entry);
      const cwd = mapAbsolutePath(entry.context, mappings, "Codex history cwd");
      workingDirectories.set(entry.sessionRef, cwd);
      const lineage = readCodexLineage(entry);
      let projectedHistoryBase: CodexHistoryBase | undefined;
      if (lineage.historyBase !== null) {
        const baseDelta = byteOffsetDeltas.get(lineage.historyBase.threadId);
        if (baseDelta === undefined) throw new Error(`Codex history base was not projected first: ${entry.sessionRef}`);
        const endByteOffset = lineage.historyBase.endByteOffset + baseDelta;
        if (!Number.isSafeInteger(endByteOffset) || endByteOffset <= 0) {
          throw new Error(`Codex projected history base is invalid: ${entry.sessionRef}`);
        }
        projectedHistoryBase = { ...lineage.historyBase, endByteOffset };
      }
      let projectedRollout = objectPath;
      if (
        provider !== entry.provider || cwd !== entry.context ||
        projectedHistoryBase !== undefined && projectedHistoryBase.endByteOffset !== lineage.historyBase?.endByteOffset
      ) {
        projectedRollout = path.join(options.workspace, `projected-${index.toString().padStart(6, "0")}.jsonl`);
        const rewritten = await rewriteCodexMetadata(objectPath, projectedRollout, {
          nativeId: entry.nativeId,
          beforeProvider: entry.provider,
          afterProvider: provider,
          beforeCwd: entry.context,
          afterCwd: cwd,
          ...(lineage.historyBase === null || projectedHistoryBase === undefined
            ? {}
            : { historyBase: { before: lineage.historyBase, after: projectedHistoryBase } }),
        });
        byteOffsetDeltas.set(entry.nativeId, rewritten.byteOffsetDelta);
      } else {
        byteOffsetDeltas.set(entry.nativeId, 0);
      }
      const thread = targetThread(entry, columns);
      thread.id = entry.nativeId;
      thread.rollout_path = destination;
      thread.model_provider = provider;
      thread.cwd = cwd;
      thread.archived = entry.nativeArchived ? 1 : 0;
      validateThreadShape(thread, columns);
      const dynamicTools = readCodexDynamicTools(entry);
      validateDynamicToolTarget(database, dynamicTools, entry.nativeId);
      const spawnEdge = readCodexSpawn(entry).incoming;
      validateThreadSpawnTarget(database, spawnEdge, entry.nativeId);
      const goal = readCodexGoal(entry);
      if (goal !== null && goalColumns !== undefined) validateThreadGoalShape(goal, goalColumns);
      const section = readCodexSection(entry);
      if (section !== null && sectionColumns !== undefined) validateThreadSectionShape(section, sectionColumns);
      const existingSection = section === null ? undefined : readThreadSectionRow(database, section.id as string);
      const sectionConflict = section !== null && existingSection !== undefined &&
        !threadSectionRowsEqual(section, existingSection);
      const missingSectionHasReferences = section !== null && existingSection === undefined &&
        readThreadSectionReferenceIds(database, section.id as string).length !== 0;
      const sectionBefore = existingSection ?? null;
      const sectionAfter = existingSection ?? section;
      const targetRow = readThreadRow(database, entry.nativeId);
      const targetDynamicTools = readThreadDynamicTools(database, entry.nativeId);
      const targetSpawnEdge = targetSpawnEdges.get(entry.nativeId);
      const targetGoal = goalDatabase === undefined ? undefined : readThreadGoalRow(goalDatabase, entry.nativeId);
      const targetGoalDeferred = goalDatabase === undefined
        ? false
        : readThreadGoalContinuationDeferral(goalDatabase, entry.nativeId);
      const targetGoalEmpty = targetGoal === undefined && !targetGoalDeferred;
      const targetGoalMatches = goal === null
        ? targetGoalEmpty
        : threadGoalRowsEqual(goal, targetGoal);
      const filePresent = await exists(destination);
      let classification: ImportClassification;
      let reason: string | undefined;
      if (section !== null && sectionColumns === undefined) {
        classification = "conflict";
        reason = "target cannot preserve the Codex thread section";
      } else if (sectionConflict) {
        classification = "conflict";
        reason = "target thread section has a different definition";
      } else if (missingSectionHasReferences) {
        classification = "conflict";
        reason = "target threads reference a missing Codex thread section";
      } else if (goal !== null && goalStore === undefined) {
        classification = "conflict";
        reason = "target cannot preserve the Codex thread goal";
      } else if (related.has(entry.nativeId)) {
        classification = "conflict";
        reason = "target thread has unsupported native relations";
      } else if (
        targetRow === undefined && targetDynamicTools.length === 0 && targetSpawnEdge === undefined &&
        targetGoalEmpty && !filePresent
      ) {
        classification = "new";
      } else if (
        targetRow !== undefined && filePresent && threadRowsEqual(thread, targetRow) &&
        threadDynamicToolsEqual(dynamicTools, targetDynamicTools) &&
        threadSpawnEdgesEqual(spawnEdge, targetSpawnEdge) && targetGoalMatches &&
        threadSectionRowsEqual(sectionAfter, existingSection)
      ) {
        const plannedDigest = await digestFile(projectedRollout);
        const targetDigest = await digestFile(destination);
        if (plannedDigest.sizeBytes === targetDigest.sizeBytes && plannedDigest.sha256 === targetDigest.sha256) {
          classification = "already_present";
        } else {
          classification = "conflict";
          reason = "target rollout bytes differ";
        }
      } else {
        classification = "conflict";
        reason = targetRow === undefined
          ? "target path, dynamic tool state, spawn edge, or goal state is occupied without a thread"
          : "target thread, section, dynamic tool state, spawn edge, goal state, or rollout differs";
      }
      planned.push({
        entry,
        result: {
          sessionRef: entry.sessionRef,
          nativeId: entry.nativeId,
          classification,
          destination,
          provider,
          cwd,
          ...(reason === undefined ? {} : { reason }),
        },
        projectedRollout,
        destination,
        thread,
        dynamicTools,
        spawnEdge,
        goal,
        sectionBefore,
        sectionAfter,
      });
    }
    const resources = await planManagedResources(options.entries, options.objects, workingDirectories);
    return { target, databasePath, planned, resources, ...(goalStore === undefined ? {} : { goalStore }) };
  } finally {
    if (goalDatabase !== undefined && goalDatabase !== database) goalDatabase.close();
    database.close();
  }
}

function resultFromPlan(plan: RestorePlan, transactionRefValue?: string): RestoreCodexResult {
  return {
    targetCodexHome: plan.target.codexHome,
    targetSQLiteHome: plan.target.sqliteHome,
    items: plan.planned.map((item) => item.result),
    newSessions: plan.planned.filter((item) => item.result.classification === "new").length,
    alreadyPresent: plan.planned.filter((item) => item.result.classification === "already_present").length,
    resources: plan.resources.items,
    ...(transactionRefValue === undefined ? {} : { transactionRef: transactionRefValue }),
  };
}

function importedLibrary(options: RestoreCodexOptions): Map<string, StoredSession["library"]> {
  return new Map(options.entries.map((entry) => [entry.sessionRef, entry.library]));
}

async function reconcileWithoutNativeWrite(options: RestoreCodexOptions, plan: RestorePlan): Promise<void> {
  const snapshot = await loadSnapshot(options.stateDirectory, "codex");
  const selected = new Set(options.entries.map((entry) => entry.sessionRef));
  if (snapshot !== undefined && [...selected].every((reference) => snapshot.sessions.some((session) => session.sessionRef === reference))) {
    return;
  }
  await scanCodex({
    stateDirectory: options.stateDirectory,
    codexHome: plan.target.codexHome,
    sqliteHome: plan.target.sqliteHome,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
    importedLibrary: importedLibrary(options),
  });
}

export async function prepareCodexRestore(options: RestoreCodexOptions): Promise<PreparedCodexRestore> {
  const plan = await buildRestorePlan(options);
  return {
    result: resultFromPlan(plan),
    apply: async () => {
      const conflict = plan.planned.find((item) => item.result.classification === "conflict");
      if (conflict !== undefined) {
        throw new Error(`Codex import conflict for ${conflict.entry.sessionRef}: ${conflict.result.reason ?? "unknown conflict"}`);
      }
      const resources = newManagedResourceEffects(plan.resources);
      const created = plan.planned.filter((item) => item.result.classification === "new");
      const affectedRefs = new Set([
        ...created.map((item) => item.entry.sessionRef),
        ...resources.flatMap((resource) => resource.sessionRefs),
      ]);
      if (affectedRefs.size === 0) {
        await reconcileWithoutNativeWrite(options, plan);
        return resultFromPlan(plan);
      }
      const transactionLibrary = new Map(
        [...importedLibrary(options)].filter(([sessionRef]) => affectedRefs.has(sessionRef)),
      );
      const journal = await prepareCodexTransaction({
        stateDirectory: options.stateDirectory,
        operation: "history_import",
        codexHome: plan.target.codexHome,
        sqliteHome: plan.target.sqliteHome,
        database: plan.databasePath,
        ...(plan.goalStore === undefined ? {} : { goalStore: plan.goalStore }),
        resources,
        effects: created.map((item) => ({
          sessionRef: item.entry.sessionRef,
          nativeId: item.entry.nativeId,
          destination: item.destination,
          ...(plan.goalStore === undefined ? {} : {
            goal: {
              before: { row: null, continuationDeferred: false },
              after: {
                row: item.goal,
                continuationDeferred: item.goal !== null && plan.goalStore.hasContinuationDeferrals,
              },
            },
          }),
          before: { row: null, section: item.sectionBefore, dynamicTools: [], spawnEdge: null },
          after: {
            row: item.thread,
            section: item.sectionAfter,
            dynamicTools: item.dynamicTools,
            spawnEdge: item.spawnEdge,
            filePath: item.projectedRollout,
          },
        })),
        importedLibrary: transactionLibrary,
      });
      const committed = await executePreparedCodexTransaction(options.stateDirectory, journal);
      return resultFromPlan(plan, transactionReference(committed.id));
    },
  };
}
