import { link, lstat, mkdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  isHistorySnapshotId,
  libraryMetadataEqual,
  readLibraryMetadata,
  type JsonValue,
  type StoredSession,
} from "../../../domain/history.js";
import { transactionReference, type TransactionJournal } from "../../../domain/transaction.js";
import { applyPosixMode, copyStableFile, digestFile, syncDirectory } from "../../../infrastructure/files.js";
import { loadHistoryHead, loadSnapshot, restoreHistoryHead } from "../../../infrastructure/history-store.js";
import {
  observeManagedResourceEffects,
  prepareManagedResourceTransactionEffects,
  publishManagedResourceEffects,
  readManagedResourceTransactionEffects,
  type ManagedResourceObservations,
  type ManagedResourceTransactionEffect,
  type PreparedManagedResourceEffect,
} from "../../../infrastructure/managed-resources.js";
import {
  failTransactionBeforeEffects,
  initializeTransaction,
  newTransactionId,
  recoveryRequiredError,
  resolveTransactionObject,
  saveTransaction,
  type TransactionObjectSource,
} from "../../../infrastructure/transaction-store.js";
import {
  deleteThreadDynamicTools,
  deleteThreadRow,
  deleteThreadSpawnEdge,
  insertThreadDynamicTools,
  insertThreadRow,
  insertThreadSpawnEdge,
  inspectThreadSchema,
  readThreadDynamicTools,
  readThreadRow,
  readThreadSpawnEdges,
  threadDynamicToolsEqual,
  threadRowsEqual,
  threadSpawnEdgesEqual,
  updateThreadRow,
  unsupportedRelatedThreadIds,
  validateThreadDynamicTools,
  validateThreadShape,
  validateThreadSpawnEdge,
  type ThreadDynamicToolRow,
  type ThreadRow,
  type ThreadSpawnEdgeRow,
} from "../storage/database.js";
import { readCodexDynamicTools, readCodexGoal, readCodexSection, readCodexSpawn } from "./archive.js";
import { requireRealDirectory } from "../carrier.js";
import {
  deleteThreadGoalContinuationDeferral,
  deleteThreadGoalRow,
  insertThreadGoalContinuationDeferral,
  insertThreadGoalRow,
  inspectThreadGoalSchema,
  readThreadGoalContinuationDeferral,
  readThreadGoalRow,
  threadGoalRowsEqual,
  validateThreadGoalDeferralTarget,
  validateThreadGoalRow,
  validateThreadGoalShape,
  type CodexGoalStore,
  type ThreadGoalRow,
} from "../storage/goals.js";
import { codexSessionRef } from "../identity.js";
import { scanCodex } from "../scan.js";
import {
  deleteUnreferencedThreadSectionRow,
  insertThreadSectionRow,
  inspectThreadSectionSchema,
  readThreadSectionReferenceIds,
  readThreadSectionRow,
  threadSectionRowsEqual,
  validateThreadSectionRow,
  validateThreadSectionShape,
  type ThreadSectionRow,
} from "../storage/sections.js";
import { isCodexSQLiteStorePath } from "../storage/stores.js";

const PAYLOAD_SCHEMA = "agenthist.codex.transaction/v7";
const DIGEST = /^[0-9a-f]{64}$/;
const OBJECT_PATH = /^objects\/[0-9]{6}-(?:before|after)\.jsonl$/;

export type CodexTransactionOperation = "history_import" | "codex_provider_unify";
type NativeSideName = "before" | "after";
type ObservedPosition = NativeSideName | "unchanged" | "diverged";

class CodexTargetPreconditionError extends Error {}

interface CodexFileImage {
  readonly object: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mode: number;
}

interface CodexNativeSide {
  readonly row: ThreadRow | null;
  readonly section: ThreadSectionRow | null;
  readonly dynamicTools: readonly ThreadDynamicToolRow[];
  readonly spawnEdge: ThreadSpawnEdgeRow | null;
  readonly file: CodexFileImage | null;
}

interface CodexGoalSide {
  readonly row: ThreadGoalRow | null;
  readonly continuationDeferred: boolean;
}

interface CodexGoalEffect {
  readonly before: CodexGoalSide;
  readonly after: CodexGoalSide;
}

interface CodexTransactionEffect {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly destination: string;
  readonly before: CodexNativeSide;
  readonly after: CodexNativeSide;
  readonly goal: CodexGoalEffect | null;
}

interface ImportedLibrary {
  readonly sessionRef: string;
  readonly library: StoredSession["library"];
}

interface CodexTransactionPayload {
  readonly schemaVersion: typeof PAYLOAD_SCHEMA;
  readonly target: {
    readonly codexHome: string;
    readonly sqliteHome: string;
    readonly database: string;
    readonly goalDatabase: string | null;
    readonly goalDeferrals: boolean;
  };
  readonly effects: readonly CodexTransactionEffect[];
  readonly resources: readonly ManagedResourceTransactionEffect[];
  readonly importedLibrary: readonly ImportedLibrary[];
  readonly historyHeadBefore: string | null;
  readonly historyHeadAfter: string | null;
}

export interface PreparedCodexEffect {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly destination: string;
  readonly goal?: {
    readonly before: CodexGoalSide;
    readonly after: CodexGoalSide;
  };
  readonly before: {
    readonly row: ThreadRow | null;
    readonly section: ThreadSectionRow | null;
    readonly dynamicTools: readonly ThreadDynamicToolRow[];
    readonly spawnEdge: ThreadSpawnEdgeRow | null;
    readonly filePath?: string;
  };
  readonly after: {
    readonly row: ThreadRow | null;
    readonly section: ThreadSectionRow | null;
    readonly dynamicTools: readonly ThreadDynamicToolRow[];
    readonly spawnEdge: ThreadSpawnEdgeRow | null;
    readonly filePath?: string;
  };
}

export interface PrepareCodexTransactionOptions {
  readonly stateDirectory: string;
  readonly operation: CodexTransactionOperation;
  readonly codexHome: string;
  readonly sqliteHome: string;
  readonly database: string;
  readonly goalStore?: CodexGoalStore;
  readonly effects: readonly PreparedCodexEffect[];
  readonly resources?: readonly PreparedManagedResourceEffect[];
  readonly importedLibrary?: ReadonlyMap<string, StoredSession["library"]>;
}

export interface CodexTransactionFinding {
  readonly sessionRef: string;
  readonly row: ObservedPosition;
  readonly section: ObservedPosition;
  readonly file: ObservedPosition;
  readonly resources?: ObservedPosition;
  readonly goal?: ObservedPosition;
}

export interface CodexTransactionPreview {
  readonly transactionRef: string;
  readonly operation: CodexTransactionOperation;
  readonly state: TransactionJournal["state"];
  readonly direction: TransactionJournal["direction"];
  readonly ready: boolean;
  readonly items: number;
  readonly findings: readonly CodexTransactionFinding[];
}

interface ObservedEffect extends CodexTransactionFinding {
  readonly effect: CodexTransactionEffect;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function libraryValue(value: unknown): StoredSession["library"] | undefined {
  return readLibraryMetadata(value);
}

function rowValue(value: unknown): ThreadRow | null | undefined {
  if (value === null) return null;
  const object = objectValue(value);
  if (object === undefined) return undefined;
  return object as ThreadRow;
}

function imageValue(value: unknown): CodexFileImage | null | undefined {
  if (value === null) return null;
  const object = objectValue(value);
  if (
    object === undefined || typeof object.object !== "string" || !OBJECT_PATH.test(object.object) ||
    typeof object.sizeBytes !== "number" || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 0 ||
    typeof object.sha256 !== "string" || !DIGEST.test(object.sha256) ||
    typeof object.mode !== "number" || !Number.isSafeInteger(object.mode) || object.mode < 0 || object.mode > 0o777
  ) {
    return undefined;
  }
  return object as unknown as CodexFileImage;
}

function validateSide(value: unknown, nativeId: string, destination: string): CodexNativeSide {
  const object = objectValue(value);
  if (object === undefined) throw new Error("Codex transaction native side is invalid");
  const row = rowValue(object?.row);
  const file = imageValue(object?.file);
  const dynamicTools = validateThreadDynamicTools(object.dynamicTools, nativeId);
  let section: ThreadSectionRow | null;
  try {
    section = object.section === null ? null : validateThreadSectionRow(object.section);
  } catch {
    throw new Error("Codex transaction native side is invalid");
  }
  let spawnEdge: ThreadSpawnEdgeRow | null;
  try {
    spawnEdge = object.spawnEdge === null ? null : validateThreadSpawnEdge(object.spawnEdge, nativeId);
  } catch {
    throw new Error("Codex transaction native side is invalid");
  }
  if (
    row === undefined || file === undefined || (row === null) !== (file === null) ||
    row === null && (dynamicTools.length !== 0 || spawnEdge !== null)
  ) {
    throw new Error("Codex transaction native side is invalid");
  }
  if (row !== null && (row.id !== nativeId || row.rollout_path !== destination)) {
    throw new Error("Codex transaction thread locator is invalid");
  }
  if (row !== null) {
    const sectionId = row.thread_section_id;
    if (section === null ? sectionId !== undefined && sectionId !== null : sectionId !== section.id) {
      throw new Error("Codex transaction thread section is invalid");
    }
  }
  return { row, section, dynamicTools, spawnEdge, file };
}

function validateGoalSide(
  value: unknown,
  nativeId: string,
  goalDeferrals: boolean,
): CodexGoalSide {
  const object = objectValue(value);
  if (object === undefined || typeof object.continuationDeferred !== "boolean") {
    throw new Error("Codex transaction goal side is invalid");
  }
  let row: ThreadGoalRow | null;
  try {
    row = object.row === null ? null : validateThreadGoalRow(object.row, nativeId);
  } catch {
    throw new Error("Codex transaction goal side is invalid");
  }
  if (object.continuationDeferred && (!goalDeferrals || row === null)) {
    throw new Error("Codex transaction goal side is invalid");
  }
  return { row, continuationDeferred: object.continuationDeferred };
}

function validateGoalEffect(
  value: unknown,
  nativeId: string,
  goalDeferrals: boolean,
): CodexGoalEffect | null {
  if (value === null) return null;
  const object = objectValue(value);
  if (object === undefined) throw new Error("Codex transaction goal effect is invalid");
  return {
    before: validateGoalSide(object.before, nativeId, goalDeferrals),
    after: validateGoalSide(object.after, nativeId, goalDeferrals),
  };
}

function sameNonProviderFields(before: ThreadRow, after: ThreadRow): boolean {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    if (name === "model_provider") continue;
    if (JSON.stringify(before[name]) !== JSON.stringify(after[name])) return false;
  }
  return typeof before.model_provider === "string" && typeof after.model_provider === "string" &&
    before.model_provider !== "" && after.model_provider !== "";
}

function fileImagesEqual(before: CodexFileImage, after: CodexFileImage): boolean {
  return before.sizeBytes === after.sizeBytes && before.sha256 === after.sha256 &&
    (process.platform === "win32" || before.mode === after.mode);
}

export function readCodexTransaction(journal: TransactionJournal): CodexTransactionPayload {
  if (
    journal.agents.length !== 1 || journal.agents[0] !== "codex" ||
    (journal.operation !== "history_import" && journal.operation !== "codex_provider_unify")
  ) {
    throw new Error("transaction is not a supported Codex operation");
  }
  const payload = objectValue(journal.payload);
  const target = objectValue(payload?.target);
  if (
    payload?.schemaVersion !== PAYLOAD_SCHEMA || target === undefined ||
    typeof target.codexHome !== "string" || !path.isAbsolute(target.codexHome) ||
    typeof target.sqliteHome !== "string" || !path.isAbsolute(target.sqliteHome) ||
    typeof target.database !== "string" || !path.isAbsolute(target.database) ||
    !isCodexSQLiteStorePath(target.sqliteHome, target.database) ||
    !Array.isArray(payload.effects) || !Array.isArray(payload.resources) ||
    !Array.isArray(payload.importedLibrary) ||
    !(payload.historyHeadBefore === null ||
      typeof payload.historyHeadBefore === "string" && isHistorySnapshotId(payload.historyHeadBefore)) ||
    !(payload.historyHeadAfter === null ||
      typeof payload.historyHeadAfter === "string" && isHistorySnapshotId(payload.historyHeadAfter))
  ) {
    throw new Error("Codex transaction payload is invalid");
  }
  if (
    typeof target.goalDeferrals !== "boolean" ||
    !(target.goalDatabase === null ||
      typeof target.goalDatabase === "string" && path.isAbsolute(target.goalDatabase) &&
      isCodexSQLiteStorePath(target.sqliteHome, target.goalDatabase)) ||
    target.goalDatabase === null && target.goalDeferrals
  ) {
    throw new Error("Codex transaction goal target is invalid");
  }
  const destinations = new Set<string>();
  const sessions = new Set<string>();
  const effects: CodexTransactionEffect[] = [];
  for (const rawEffect of payload.effects) {
    const effect = objectValue(rawEffect);
    const destination = typeof effect?.destination === "string" ? effect.destination : "";
    const relative = destination === "" ? "" : path.relative(target.codexHome, destination);
    const components = relative.split(path.sep);
    if (
      effect === undefined || typeof effect.sessionRef !== "string" || typeof effect.nativeId !== "string" ||
      codexSessionRef(effect.nativeId) !== effect.sessionRef || !path.isAbsolute(destination) ||
      relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ||
      (components[0] !== "sessions" && components[0] !== "archived_sessions") ||
      components.includes("") || components.includes(".") || components.includes("..") || !destination.endsWith(".jsonl") ||
      destinations.has(destination) || sessions.has(effect.sessionRef)
    ) {
      throw new Error("Codex transaction effect is invalid");
    }
    destinations.add(destination);
    sessions.add(effect.sessionRef);
    const before = validateSide(effect.before, effect.nativeId, destination);
    const after = validateSide(effect.after, effect.nativeId, destination);
    const goal = validateGoalEffect(effect.goal, effect.nativeId, target.goalDeferrals);
    const archived = components[0] === "archived_sessions";
    if (
      before.row !== null && (before.row.archived === 1) !== archived ||
      after.row !== null && (after.row.archived === 1) !== archived
    ) {
      throw new Error("Codex transaction archive carrier is invalid");
    }
    const importGoalValid = goal === null
      ? target.goalDatabase === null
      : target.goalDatabase !== null && goal.before.row === null && !goal.before.continuationDeferred &&
        goal.after.continuationDeferred === (goal.after.row !== null && target.goalDeferrals);
    const sectionsEqual = threadSectionRowsEqual(before.section, after.section) &&
      threadSectionRowsEqual(after.section, before.section);
    const importSectionValid = before.section === null || sectionsEqual;
    if (
      journal.operation === "history_import" &&
        (before.row !== null || before.spawnEdge !== null || after.row === null ||
          !importGoalValid || !importSectionValid) ||
      journal.operation === "codex_provider_unify" &&
        (
          goal !== null || target.goalDatabase !== null ||
          before.row === null || after.row === null || !sameNonProviderFields(before.row, after.row) ||
          !sectionsEqual ||
          !threadDynamicToolsEqual(before.dynamicTools, after.dynamicTools) ||
          !threadSpawnEdgesEqual(before.spawnEdge, after.spawnEdge) ||
          before.file === null || after.file === null ||
          (before.row.model_provider === after.row.model_provider && fileImagesEqual(before.file, after.file))
        )
    ) {
      throw new Error("Codex transaction operation effects are invalid");
    }
    effects.push({
      sessionRef: effect.sessionRef,
      nativeId: effect.nativeId,
      destination,
      before,
      after,
      goal,
    });
  }
  const importedLibrary: ImportedLibrary[] = [];
  const librarySessions = new Set<string>();
  for (const rawLibrary of payload.importedLibrary) {
    const item = objectValue(rawLibrary);
    const library = libraryValue(item?.library);
    if (
      item === undefined || typeof item.sessionRef !== "string" || library === undefined ||
      librarySessions.has(item.sessionRef)
    ) {
      throw new Error("Codex transaction library reconciliation is invalid");
    }
    librarySessions.add(item.sessionRef);
    importedLibrary.push({ sessionRef: item.sessionRef, library });
  }
  const affectedSessionRefs = new Set([
    ...effects.map((effect) => effect.sessionRef),
    ...importedLibrary.map((item) => item.sessionRef),
  ]);
  const resources = readManagedResourceTransactionEffects(payload.resources, affectedSessionRefs);
  for (const resource of resources) {
    for (const sessionRef of resource.sessionRefs) affectedSessionRefs.add(sessionRef);
  }
  if (
    resources.some((resource) => destinations.has(resource.destination)) ||
    journal.itemCount !== affectedSessionRefs.size ||
    journal.operation === "codex_provider_unify" && resources.length !== 0 ||
    journal.operation === "history_import" && effects.length === 0 && resources.length === 0
  ) {
    throw new Error("Codex transaction managed resources are invalid");
  }
  return {
    schemaVersion: PAYLOAD_SCHEMA,
    target: {
      codexHome: target.codexHome,
      sqliteHome: target.sqliteHome,
      database: target.database,
      goalDatabase: target.goalDatabase,
      goalDeferrals: target.goalDeferrals,
    },
    effects,
    resources,
    importedLibrary,
    historyHeadBefore: payload.historyHeadBefore,
    historyHeadAfter: payload.historyHeadAfter,
  };
}

async function describeFile(filePath: string, object: string): Promise<{
  readonly image: CodexFileImage;
  readonly source: TransactionObjectSource;
}> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Codex transaction source is not a regular file: ${filePath}`);
  const digest = await digestFile(filePath);
  const image = { object, ...digest, mode: info.mode & 0o777 };
  return { image, source: { relativePath: object, filePath, ...digest } };
}

export async function prepareCodexTransaction(options: PrepareCodexTransactionOptions): Promise<TransactionJournal> {
  if (options.effects.length === 0 && (options.resources?.length ?? 0) === 0) {
    throw new Error("Codex transaction has no history changes");
  }
  const id = newTransactionId();
  const objectSources: TransactionObjectSource[] = [];
  const effects: CodexTransactionEffect[] = [];
  for (const [index, effect] of options.effects.entries()) {
    const number = index.toString().padStart(6, "0");
    const beforeDescriptor = effect.before.filePath === undefined
      ? null
      : await describeFile(effect.before.filePath, `objects/${number}-before.jsonl`);
    const afterDescriptor = effect.after.filePath === undefined
      ? null
      : await describeFile(effect.after.filePath, `objects/${number}-after.jsonl`);
    if (beforeDescriptor !== null) objectSources.push(beforeDescriptor.source);
    if (afterDescriptor !== null) objectSources.push(afterDescriptor.source);
    effects.push({
      sessionRef: effect.sessionRef,
      nativeId: effect.nativeId,
      destination: effect.destination,
      before: {
        row: effect.before.row,
        section: effect.before.section,
        dynamicTools: [...effect.before.dynamicTools],
        spawnEdge: effect.before.spawnEdge,
        file: beforeDescriptor?.image ?? null,
      },
      after: {
        row: effect.after.row,
        section: effect.after.section,
        dynamicTools: [...effect.after.dynamicTools],
        spawnEdge: effect.after.spawnEdge,
        file: afterDescriptor?.image ?? null,
      },
      goal: effect.goal === undefined
        ? null
        : {
          before: {
            row: effect.goal.before.row,
            continuationDeferred: effect.goal.before.continuationDeferred,
          },
          after: {
            row: effect.goal.after.row,
            continuationDeferred: effect.goal.after.continuationDeferred,
          },
        },
    });
  }
  const preparedResources = await prepareManagedResourceTransactionEffects(options.resources ?? []);
  objectSources.push(...preparedResources.sources);
  const previous = await loadSnapshot(options.stateDirectory, "codex");
  const resolvedLibrary: ImportedLibrary[] = [];
  for (const [sessionRef, incoming] of options.importedLibrary?.entries() ?? []) {
    const existing = previous?.sessions.find((session) => session.sessionRef === sessionRef)?.library;
    resolvedLibrary.push({ sessionRef, library: existing ?? incoming });
  }
  resolvedLibrary.sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
  const now = new Date().toISOString();
  const sqliteHome = path.resolve(options.sqliteHome);
  const database = path.resolve(options.database);
  if (!isCodexSQLiteStorePath(sqliteHome, database)) {
    throw new Error("Codex transaction database is outside the SQLite home");
  }
  const payload: CodexTransactionPayload = {
    schemaVersion: PAYLOAD_SCHEMA,
    target: {
      codexHome: path.resolve(options.codexHome),
      sqliteHome,
      database,
      goalDatabase: options.goalStore === undefined ? null : path.resolve(options.goalStore.databasePath),
      goalDeferrals: options.goalStore?.hasContinuationDeferrals ?? false,
    },
    effects,
    resources: preparedResources.effects,
    importedLibrary: resolvedLibrary,
    historyHeadBefore: await loadHistoryHead(options.stateDirectory, "codex"),
    historyHeadAfter: null,
  };
  const affectedSessionRefs = new Set([
    ...effects.map((effect) => effect.sessionRef),
    ...preparedResources.effects.flatMap((effect) => effect.sessionRefs),
  ]);
  const journal: TransactionJournal = {
    schemaVersion: "agenthist.transaction/v1",
    id,
    operation: options.operation,
    agents: ["codex"],
    state: "planned",
    phase: "prepared",
    direction: "forward",
    createdAt: now,
    updatedAt: now,
    itemCount: affectedSessionRefs.size,
    payload: payload as unknown as JsonValue,
  };
  readCodexTransaction(journal);
  return initializeTransaction(options.stateDirectory, journal, objectSources);
}

async function currentFile(destination: string): Promise<{ readonly sizeBytes: number; readonly sha256: string; readonly mode: number } | null> {
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Codex target rollout is not a regular file: ${destination}`);
    const digest = await digestFile(destination);
    return { ...digest, mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function requireSafeDestinationParent(codexHome: string, destination: string): Promise<void> {
  const relative = path.relative(codexHome, path.dirname(destination));
  let current = codexHome;
  for (const component of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Codex rollout parent is unsafe: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function validateNativeTarget(payload: CodexTransactionPayload): Promise<void> {
  await requireRealDirectory(payload.target.codexHome, "Codex home");
  await requireRealDirectory(payload.target.sqliteHome, "Codex SQLite home");
  const database = await lstat(payload.target.database);
  if (!database.isFile() || database.isSymbolicLink()) throw new Error("Codex transaction database is not a regular file");
  const stateDatabase = new DatabaseSync(payload.target.database, { readOnly: true });
  try {
    inspectThreadSchema(stateDatabase);
    const sectionColumns = inspectThreadSectionSchema(stateDatabase);
    for (const effect of payload.effects) {
      for (const side of [effect.before, effect.after]) {
        if (side.section === null) continue;
        if (sectionColumns === undefined) throw new Error("Codex transaction section capability changed");
        validateThreadSectionShape(side.section, sectionColumns);
      }
    }
  } finally {
    stateDatabase.close();
  }
  if (payload.target.goalDatabase !== null) {
    const goalInfo = await lstat(payload.target.goalDatabase);
    if (!goalInfo.isFile() || goalInfo.isSymbolicLink()) {
      throw new Error("Codex transaction goal database is not a regular file");
    }
    const goalDatabase = new DatabaseSync(payload.target.goalDatabase, { readOnly: true });
    try {
      const goalColumns = inspectThreadGoalSchema(goalDatabase);
      if (goalColumns === undefined ||
        validateThreadGoalDeferralTarget(goalDatabase) !== payload.target.goalDeferrals) {
        throw new Error("Codex transaction goal database capability changed");
      }
      for (const effect of payload.effects) {
        if (effect.goal !== null) {
          if (effect.goal.before.row !== null) validateThreadGoalShape(effect.goal.before.row, goalColumns);
          if (effect.goal.after.row !== null) validateThreadGoalShape(effect.goal.after.row, goalColumns);
        }
      }
    } finally {
      goalDatabase.close();
    }
  }
  for (const effect of payload.effects) await requireSafeDestinationParent(payload.target.codexHome, effect.destination);
}

function imageMatches(expected: CodexFileImage | null, actual: Awaited<ReturnType<typeof currentFile>>): boolean {
  return expected === null
    ? actual === null
    : actual !== null && expected.sizeBytes === actual.sizeBytes && expected.sha256 === actual.sha256 &&
      (process.platform === "win32" || expected.mode === actual.mode);
}

function position(before: boolean, after: boolean): ObservedPosition {
  if (before && after) return "unchanged";
  if (!before && !after) return "diverged";
  return before ? "before" : "after";
}

function positionMatches(observed: ObservedPosition, expected: NativeSideName): boolean {
  return observed === expected || observed === "unchanged";
}

function sqliteSideMatches(
  side: CodexNativeSide,
  row: ThreadRow | undefined,
  dynamicTools: readonly ThreadDynamicToolRow[],
  spawnEdge: ThreadSpawnEdgeRow | undefined,
): boolean {
  return side.row === null
    ? row === undefined && dynamicTools.length === 0 && spawnEdge === undefined
    : threadRowsEqual(side.row, row) && threadDynamicToolsEqual(side.dynamicTools, dynamicTools) &&
      threadSpawnEdgesEqual(side.spawnEdge, spawnEdge);
}

function goalSideMatches(
  side: CodexGoalSide,
  row: ThreadGoalRow | undefined,
  continuationDeferred: boolean,
): boolean {
  return threadGoalRowsEqual(side.row, row) && side.continuationDeferred === continuationDeferred;
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function observeEffects(
  payload: CodexTransactionPayload,
  allowRelations: boolean,
): Promise<readonly ObservedEffect[]> {
  const database = new DatabaseSync(payload.target.database, { readOnly: true });
  const goalDatabase = payload.target.goalDatabase === null
    ? undefined
    : payload.target.goalDatabase === payload.target.database
      ? database
      : new DatabaseSync(payload.target.goalDatabase, { readOnly: true });
  try {
    inspectThreadSchema(database);
    const related = unsupportedRelatedThreadIds(database, payload.effects.map((effect) => effect.nativeId));
    const spawnEdges = readThreadSpawnEdges(database);
    const expectedSectionReferences = new Map<string, string[]>();
    for (const effect of payload.effects) {
      const sectionId = effect.after.row?.thread_section_id;
      if (typeof sectionId !== "string") continue;
      const references = expectedSectionReferences.get(sectionId) ?? [];
      references.push(effect.nativeId);
      expectedSectionReferences.set(sectionId, references);
    }
    for (const references of expectedSectionReferences.values()) references.sort();
    const sectionStates = new Map<string, {
      readonly row: ThreadSectionRow | undefined;
      readonly references: readonly string[];
    }>();
    const result: ObservedEffect[] = [];
    for (const effect of payload.effects) {
      const row = readThreadRow(database, effect.nativeId);
      const dynamicTools = readThreadDynamicTools(database, effect.nativeId);
      const file = await currentFile(effect.destination);
      const sectionId = (effect.after.section ?? effect.before.section)?.id;
      let currentSection: ThreadSectionRow | undefined;
      let currentSectionReferences: readonly string[] = [];
      if (typeof sectionId === "string") {
        let state = sectionStates.get(sectionId);
        if (state === undefined) {
          state = {
            row: readThreadSectionRow(database, sectionId),
            references: readThreadSectionReferenceIds(database, sectionId),
          };
          sectionStates.set(sectionId, state);
        }
        currentSection = state.row;
        currentSectionReferences = state.references;
      }
      const createsSection = effect.before.section === null && effect.after.section !== null;
      const expectedReferences = typeof sectionId === "string"
        ? expectedSectionReferences.get(sectionId) ?? []
        : [];
      const sectionBeforeMatches = threadSectionRowsEqual(effect.before.section, currentSection) &&
        (!createsSection || currentSectionReferences.length === 0);
      const sectionAfterMatches = threadSectionRowsEqual(effect.after.section, currentSection) &&
        (!createsSection || sameOrderedStrings(currentSectionReferences, expectedReferences));
      const currentGoal = effect.goal === null || goalDatabase === undefined
        ? undefined
        : readThreadGoalRow(goalDatabase, effect.nativeId);
      const currentGoalDeferred = effect.goal === null || goalDatabase === undefined
        ? false
        : readThreadGoalContinuationDeferral(goalDatabase, effect.nativeId);
      const rowPosition = !allowRelations && related.has(effect.nativeId)
        ? "diverged"
        : position(
          sqliteSideMatches(effect.before, row, dynamicTools, spawnEdges.get(effect.nativeId)),
          sqliteSideMatches(effect.after, row, dynamicTools, spawnEdges.get(effect.nativeId)),
        );
      result.push({
        effect,
        sessionRef: effect.sessionRef,
        row: rowPosition,
        section: position(sectionBeforeMatches, sectionAfterMatches),
        file: position(imageMatches(effect.before.file, file), imageMatches(effect.after.file, file)),
        ...(effect.goal === null ? {} : {
          goal: position(
            goalSideMatches(effect.goal.before, currentGoal, currentGoalDeferred),
            goalSideMatches(effect.goal.after, currentGoal, currentGoalDeferred),
          ),
        }),
      });
    }
    return result;
  } finally {
    if (goalDatabase !== undefined && goalDatabase !== database) goalDatabase.close();
    database.close();
  }
}

function aggregateResourcePosition(
  values: readonly ("before" | "after" | "diverged")[],
): ObservedPosition | undefined {
  if (values.length === 0) return undefined;
  if (values.every((value) => value === "before")) return "before";
  if (values.every((value) => value === "after")) return "after";
  return "diverged";
}

function codexFindings(
  payload: CodexTransactionPayload,
  native: readonly ObservedEffect[],
  resources: ManagedResourceObservations,
): readonly CodexTransactionFinding[] {
  const nativeBySession = new Map(native.map((finding) => [finding.sessionRef, finding]));
  const sessionRefs = new Set([
    ...native.map((finding) => finding.sessionRef),
    ...payload.resources.flatMap((resource) => resource.sessionRefs),
  ]);
  return [...sessionRefs].sort().map((sessionRef) => {
    const finding = nativeBySession.get(sessionRef);
    const resourcePosition = aggregateResourcePosition(resources.bySession.get(sessionRef) ?? []);
    return finding === undefined
      ? {
          sessionRef,
          row: "unchanged",
          section: "unchanged",
          file: "unchanged",
          ...(resourcePosition === undefined ? {} : { resources: resourcePosition }),
        }
      : {
          sessionRef,
          row: finding.row,
          section: finding.section,
          file: finding.file,
          ...(resourcePosition === undefined ? {} : { resources: resourcePosition }),
          ...(finding.goal === undefined ? {} : { goal: finding.goal }),
        };
  });
}

function resourcesAt(resources: ManagedResourceObservations, position: "before" | "after"): boolean {
  return resources.positions.every((value) => value === position);
}

function resourcesHaveNoDivergence(resources: ManagedResourceObservations): boolean {
  return resources.positions.every((value) => value !== "diverged");
}

function opposite(side: NativeSideName): NativeSideName {
  return side === "before" ? "after" : "before";
}

function sameFingerprint(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function materializeFile(
  stateDirectory: string,
  transactionId: string,
  codexHome: string,
  effect: CodexTransactionEffect,
  index: number,
  desiredName: NativeSideName,
): Promise<void> {
  const desired = effect[desiredName].file;
  const other = effect[opposite(desiredName)].file;
  const observed = await currentFile(effect.destination);
  const temporary = path.join(
    path.dirname(effect.destination),
    `.agenthist-${transactionId}-${index.toString().padStart(6, "0")}-${desiredName}.tmp`,
  );
  if (imageMatches(desired, observed)) {
    const staged = await currentFile(temporary);
    if (staged !== null) {
      if (desired === null || !imageMatches(desired, staged)) {
        throw new Error(`Codex transaction staging file diverged: ${effect.sessionRef}`);
      }
      await unlink(temporary);
      await syncDirectory(path.dirname(effect.destination));
    }
    return;
  }
  if (!imageMatches(other, observed)) throw new Error(`Codex rollout diverged: ${effect.sessionRef}`);
  if (desired === null) {
    const before = await lstat(effect.destination);
    const check = await currentFile(effect.destination);
    const after = await lstat(effect.destination);
    if (!sameFingerprint(before, after) || !imageMatches(other, check)) {
      throw new Error(`Codex rollout changed while deleting: ${effect.sessionRef}`);
    }
    await unlink(effect.destination);
    await syncDirectory(path.dirname(effect.destination));
    return;
  }
  await mkdir(path.dirname(effect.destination), { recursive: true, mode: 0o700 });
  await requireSafeDestinationParent(codexHome, effect.destination);
  let temporaryExists = false;
  try {
    const temporaryImage = await currentFile(temporary);
    if (temporaryImage === null) {
      await copyStableFile(resolveTransactionObject(stateDirectory, transactionId, desired.object), temporary);
      await applyPosixMode(temporary, desired.mode);
    } else if (!imageMatches(desired, temporaryImage)) {
      throw new Error(`Codex transaction staging file diverged: ${effect.sessionRef}`);
    }
    temporaryExists = true;
    const staged = await currentFile(temporary);
    if (!imageMatches(desired, staged)) throw new Error(`Codex transaction staging verification failed: ${effect.sessionRef}`);
    const target = await currentFile(effect.destination);
    if (!imageMatches(other, target)) throw new Error(`Codex rollout changed before publish: ${effect.sessionRef}`);
    if (other === null) {
      await link(temporary, effect.destination);
      await unlink(temporary);
    } else {
      const before = await lstat(effect.destination);
      const check = await currentFile(effect.destination);
      const after = await lstat(effect.destination);
      if (!sameFingerprint(before, after) || !imageMatches(other, check)) {
        throw new Error(`Codex rollout changed before replacement: ${effect.sessionRef}`);
      }
      await rename(temporary, effect.destination);
    }
    temporaryExists = false;
    await syncDirectory(path.dirname(effect.destination));
  } catch (error) {
    if (!temporaryExists) await rm(temporary, { force: true });
    throw error;
  }
}

function applyRows(
  database: DatabaseSync,
  payload: CodexTransactionPayload,
  desiredName: NativeSideName,
  allowRelations: boolean,
): void {
  const columns = inspectThreadSchema(database);
  const related = unsupportedRelatedThreadIds(database, payload.effects.map((effect) => effect.nativeId));
  if (!allowRelations && related.size !== 0) throw new Error("Codex transaction target gained unsupported native relations");
  for (const effect of payload.effects) {
    const desired = effect[desiredName].row;
    const desiredDynamicTools = effect[desiredName].dynamicTools;
    const other = effect[opposite(desiredName)].row;
    const otherDynamicTools = effect[opposite(desiredName)].dynamicTools;
    const current = readThreadRow(database, effect.nativeId);
    const currentDynamicTools = readThreadDynamicTools(database, effect.nativeId);
    const desiredMatches = desired === null
      ? current === undefined && currentDynamicTools.length === 0
      : threadRowsEqual(desired, current) && threadDynamicToolsEqual(desiredDynamicTools, currentDynamicTools);
    if (desiredMatches) continue;
    const matchesOther = other === null
      ? current === undefined && currentDynamicTools.length === 0
      : threadRowsEqual(other, current) && threadDynamicToolsEqual(otherDynamicTools, currentDynamicTools);
    if (!matchesOther) throw new Error(`Codex thread diverged: ${effect.sessionRef}`);
    if (desired === null) {
      deleteThreadDynamicTools(database, effect.nativeId);
      deleteThreadRow(database, effect.nativeId);
    } else if (current === undefined) {
      validateThreadShape(desired, columns);
      insertThreadRow(database, desired);
      insertThreadDynamicTools(database, desiredDynamicTools, effect.nativeId);
    } else {
      validateThreadShape(desired, columns);
      updateThreadRow(database, current, desired);
      if (!threadDynamicToolsEqual(desiredDynamicTools, currentDynamicTools)) {
        deleteThreadDynamicTools(database, effect.nativeId);
        insertThreadDynamicTools(database, desiredDynamicTools, effect.nativeId);
      }
    }
  }
}

function applySections(
  database: DatabaseSync,
  payload: CodexTransactionPayload,
  desiredName: NativeSideName,
): void {
  for (const effect of payload.effects) {
    const desired = effect[desiredName].section;
    const other = effect[opposite(desiredName)].section;
    const sectionId = (desired ?? other)?.id;
    if (typeof sectionId !== "string") continue;
    if (
      (desired !== null && desired.id !== sectionId) ||
      (other !== null && other.id !== sectionId)
    ) {
      throw new Error(`Codex thread section identity changed: ${effect.sessionRef}`);
    }
    const current = readThreadSectionRow(database, sectionId);
    if (threadSectionRowsEqual(desired, current)) continue;
    if (!threadSectionRowsEqual(other, current)) {
      throw new Error(`Codex thread section diverged: ${effect.sessionRef}`);
    }
    if (desired === null) {
      deleteUnreferencedThreadSectionRow(database, sectionId);
    } else if (current === undefined) {
      insertThreadSectionRow(database, desired);
    } else {
      throw new Error(`Codex thread section changed while applying: ${effect.sessionRef}`);
    }
  }
}

function applySpawnEdges(
  database: DatabaseSync,
  payload: CodexTransactionPayload,
  desiredName: NativeSideName,
): void {
  const currentEdges = readThreadSpawnEdges(database);
  for (const effect of payload.effects) {
    const desired = effect[desiredName].spawnEdge;
    const other = effect[opposite(desiredName)].spawnEdge;
    const current = currentEdges.get(effect.nativeId);
    if (threadSpawnEdgesEqual(desired, current)) continue;
    if (!threadSpawnEdgesEqual(other, current)) throw new Error(`Codex spawn edge diverged: ${effect.sessionRef}`);
    if (desired === null) {
      deleteThreadSpawnEdge(database, effect.nativeId);
    } else {
      insertThreadSpawnEdge(database, desired, effect.nativeId);
    }
  }
}

function applyGoalEffects(
  database: DatabaseSync,
  payload: CodexTransactionPayload,
  desiredName: NativeSideName,
): void {
  const columns = inspectThreadGoalSchema(database);
  if (columns === undefined || validateThreadGoalDeferralTarget(database) !== payload.target.goalDeferrals) {
    throw new Error("Codex transaction goal database capability changed");
  }
  for (const effect of payload.effects) {
    if (effect.goal === null) continue;
    const desired = effect.goal[desiredName];
    const other = effect.goal[opposite(desiredName)];
    const current = readThreadGoalRow(database, effect.nativeId);
    const currentDeferred = readThreadGoalContinuationDeferral(database, effect.nativeId);
    if (goalSideMatches(desired, current, currentDeferred)) continue;
    if (!goalSideMatches(other, current, currentDeferred)) {
      throw new Error(`Codex thread goal diverged: ${effect.sessionRef}`);
    }
    if (desired.row === null) {
      if (currentDeferred) deleteThreadGoalContinuationDeferral(database, effect.nativeId);
      if (current !== undefined) deleteThreadGoalRow(database, effect.nativeId);
      continue;
    }
    validateThreadGoalShape(desired.row, columns);
    if (current === undefined) {
      insertThreadGoalRow(database, desired.row);
    } else if (!threadGoalRowsEqual(desired.row, current)) {
      throw new Error(`Codex thread goal changed while applying: ${effect.sessionRef}`);
    }
    if (desired.continuationDeferred !== currentDeferred) {
      if (desired.continuationDeferred) {
        insertThreadGoalContinuationDeferral(database, effect.nativeId);
      } else {
        deleteThreadGoalContinuationDeferral(database, effect.nativeId);
      }
    }
  }
}

async function applyNativeState(
  stateDirectory: string,
  journal: TransactionJournal,
  payload: CodexTransactionPayload,
  desiredName: NativeSideName,
  recovery: boolean,
): Promise<void> {
  await validateNativeTarget(payload);
  const allowRelations = journal.operation === "codex_provider_unify";
  const observed = await observeEffects(payload, allowRelations);
  const permitted = recovery
    ? observed.every((item) =>
      item.row !== "diverged" && item.section !== "diverged" &&
      item.file !== "diverged" && item.goal !== "diverged"
    )
    : observed.every((item) =>
      positionMatches(item.row, opposite(desiredName)) &&
      positionMatches(item.section, opposite(desiredName)) && positionMatches(item.file, opposite(desiredName)) &&
      (item.goal === undefined || positionMatches(item.goal, opposite(desiredName)))
    );
  if (!permitted) {
    throw new CodexTargetPreconditionError("Codex transaction target no longer matches its before/after states");
  }
  for (const [index, effect] of payload.effects.entries()) {
    await materializeFile(stateDirectory, journal.id, payload.target.codexHome, effect, index, desiredName);
  }
  const database = new DatabaseSync(payload.target.database);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (desiredName === "before" && payload.target.goalDatabase === payload.target.database) {
        applyGoalEffects(database, payload, desiredName);
      }
      if (desiredName === "before") applySpawnEdges(database, payload, desiredName);
      if (desiredName === "after") applySections(database, payload, desiredName);
      applyRows(database, payload, desiredName, allowRelations);
      if (desiredName === "before") applySections(database, payload, desiredName);
      if (desiredName === "after") applySpawnEdges(database, payload, desiredName);
      if (desiredName === "after" && payload.target.goalDatabase === payload.target.database) {
        applyGoalEffects(database, payload, desiredName);
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  } finally {
    database.close();
  }
  if (payload.target.goalDatabase !== null && payload.target.goalDatabase !== payload.target.database) {
    const goalDatabase = new DatabaseSync(payload.target.goalDatabase);
    try {
      goalDatabase.exec("BEGIN IMMEDIATE");
      try {
        applyGoalEffects(goalDatabase, payload, desiredName);
        goalDatabase.exec("COMMIT");
      } catch (error) {
        try { goalDatabase.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
        throw error;
      }
    } finally {
      goalDatabase.close();
    }
  }
  const verified = await observeEffects(payload, allowRelations);
  if (!verified.every((item) =>
    positionMatches(item.row, desiredName) && positionMatches(item.section, desiredName) &&
    positionMatches(item.file, desiredName) &&
    (item.goal === undefined || positionMatches(item.goal, desiredName))
  )) {
    throw new Error("Codex transaction verification failed");
  }
}

function withPayload(journal: TransactionJournal, payload: CodexTransactionPayload): TransactionJournal {
  return { ...journal, payload: payload as unknown as JsonValue };
}

function withoutFailure(journal: TransactionJournal): Omit<TransactionJournal, "failure"> {
  const { failure: _failure, ...rest } = journal;
  return rest;
}

async function reconcileForward(
  stateDirectory: string,
  journal: TransactionJournal,
  payload: CodexTransactionPayload,
): Promise<{ readonly journal: TransactionJournal; readonly payload: CodexTransactionPayload }> {
  const currentHead = await loadHistoryHead(stateDirectory, "codex");
  if (payload.historyHeadAfter !== null) {
    if (currentHead !== payload.historyHeadAfter) throw new Error("Codex history head changed after transaction reconciliation");
    return { journal, payload };
  }
  if (currentHead !== payload.historyHeadBefore) {
    if (!await reconciledHeadMatches(stateDirectory, payload)) {
      throw new Error("Codex history head changed before transaction reconciliation");
    }
    const accepted = { ...payload, historyHeadAfter: currentHead };
    const saved = await saveTransaction(stateDirectory, withPayload(journal, accepted));
    return { journal: saved, payload: accepted };
  }
  const importedLibrary = new Map(payload.importedLibrary.map((item) => [item.sessionRef, item.library]));
  const scan = await scanCodex({
    stateDirectory,
    codexHome: payload.target.codexHome,
    sqliteHome: payload.target.sqliteHome,
    importedLibrary,
  });
  const reconciled = { ...payload, historyHeadAfter: scan.snapshot.snapshotId };
  const saved = await saveTransaction(stateDirectory, withPayload(journal, reconciled));
  return { journal: saved, payload: reconciled };
}

async function reconciledHeadMatches(stateDirectory: string, payload: CodexTransactionPayload): Promise<boolean> {
  const snapshot = await loadSnapshot(stateDirectory, "codex");
  if (snapshot === undefined || !payload.effects.every((effect) => {
    const session = snapshot.sessions.find((candidate) => candidate.sessionRef === effect.sessionRef);
    const row = effect.after.row;
    return session !== undefined && row !== null && session.provider === row.model_provider && session.context === row.cwd &&
      threadSectionRowsEqual(effect.after.section, readCodexSection(session)) &&
      threadDynamicToolsEqual(effect.after.dynamicTools, readCodexDynamicTools(session)) &&
      threadSpawnEdgesEqual(effect.after.spawnEdge, readCodexSpawn(session).incoming) &&
      (effect.goal === null || threadGoalRowsEqual(effect.goal.after.row, readCodexGoal(session) ?? undefined));
  })) {
    return false;
  }
  return payload.importedLibrary.every((item) => {
    const session = snapshot.sessions.find((candidate) => candidate.sessionRef === item.sessionRef);
    return session !== undefined && libraryMetadataEqual(session.library, item.library);
  });
}

export async function executePreparedCodexTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  let journal = rawJournal;
  let payload = readCodexTransaction(journal);
  if (journal.state !== "planned" || journal.direction !== "forward") {
    throw new Error("Codex transaction is not ready to apply");
  }
  const resources = await observeManagedResourceEffects(stateDirectory, journal.id, payload.resources);
  if (!resourcesAt(resources, "before")) {
    const failed = await failTransactionBeforeEffects(
      stateDirectory,
      journal,
      "codex.target_changed_before_apply",
    );
    throw new Error(`Codex transaction did not start: ${transactionReference(failed.id)}`);
  }
  journal = await saveTransaction(stateDirectory, { ...journal, state: "running", phase: "applying_native" });
  try {
    await applyNativeState(stateDirectory, journal, payload, "after", false);
    await publishManagedResourceEffects(stateDirectory, journal.id, payload.resources, false);
    journal = await saveTransaction(stateDirectory, { ...journal, phase: "reconciling_history" });
    ({ journal, payload } = await reconcileForward(stateDirectory, journal, payload));
    return await saveTransaction(stateDirectory, {
      ...withoutFailure(withPayload(journal, payload)),
      state: "committed",
      phase: "committed",
      direction: "forward",
    });
  } catch (error) {
    if (error instanceof CodexTargetPreconditionError) {
      const failed = await failTransactionBeforeEffects(
        stateDirectory,
        journal,
        "codex.target_changed_before_apply",
      );
      throw new Error(`Codex transaction did not start: ${transactionReference(failed.id)}`, { cause: error });
    }
    throw await recoveryRequiredError(
      stateDirectory, journal, "codex.forward_interrupted", "Codex transaction requires recovery", error,
    );
  }
}

export async function previewCodexRollback(
  stateDirectory: string,
  journal: TransactionJournal,
): Promise<CodexTransactionPreview> {
  const payload = readCodexTransaction(journal);
  if (journal.state === "rolled_back") {
    return {
      transactionRef: transactionReference(journal.id), operation: journal.operation as CodexTransactionOperation,
      state: journal.state, direction: journal.direction, ready: true, items: journal.itemCount, findings: [],
    };
  }
  if (journal.state !== "committed" || payload.historyHeadAfter === null) {
    throw new Error("only a committed transaction can be rolled back");
  }
  await validateNativeTarget(payload);
  const native = await observeEffects(payload, journal.operation === "codex_provider_unify");
  const resources: ManagedResourceObservations = { positions: [], bySession: new Map() };
  const head = await loadHistoryHead(stateDirectory, "codex");
  return {
    transactionRef: transactionReference(journal.id),
    operation: journal.operation as CodexTransactionOperation,
    state: journal.state,
    direction: "rollback",
    ready: head === payload.historyHeadAfter && native.every((item) =>
      positionMatches(item.row, "after") && positionMatches(item.section, "after") &&
      positionMatches(item.file, "after") &&
      (item.goal === undefined || positionMatches(item.goal, "after"))
    ),
    items: journal.itemCount,
    findings: codexFindings(payload, native, resources),
  };
}

export async function rollbackCodexTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  const preview = await previewCodexRollback(stateDirectory, rawJournal);
  if (rawJournal.state === "rolled_back") return rawJournal;
  if (!preview.ready) throw new Error("Codex rollback conflicts with current target history");
  let journal = await saveTransaction(stateDirectory, {
    ...withoutFailure(rawJournal),
    state: "running",
    phase: "rolling_back",
    direction: "rollback",
  });
  const payload = readCodexTransaction(journal);
  try {
    await applyNativeState(stateDirectory, journal, payload, "before", false);
    await restoreHistoryHead(stateDirectory, "codex", payload.historyHeadBefore);
    journal = await saveTransaction(stateDirectory, {
      ...withoutFailure(journal),
      state: "rolled_back",
      phase: "rolled_back",
      direction: "rollback",
    });
    return journal;
  } catch (error) {
    throw await recoveryRequiredError(
      stateDirectory, journal, "codex.rollback_interrupted", "Codex rollback requires recovery", error,
    );
  }
}

export async function previewCodexRecovery(
  stateDirectory: string,
  journal: TransactionJournal,
): Promise<CodexTransactionPreview> {
  const payload = readCodexTransaction(journal);
  if (journal.state !== "planned" && journal.state !== "running" && journal.state !== "needs_recovery") {
    throw new Error("transaction does not require recovery");
  }
  await validateNativeTarget(payload);
  const native = await observeEffects(payload, journal.operation === "codex_provider_unify");
  const resources = journal.direction === "rollback"
    ? { positions: [], bySession: new Map() } as ManagedResourceObservations
    : await observeManagedResourceEffects(stateDirectory, journal.id, payload.resources);
  const head = await loadHistoryHead(stateDirectory, "codex");
  const nativeReady = native.every((item) =>
    item.row !== "diverged" && item.section !== "diverged" &&
    item.file !== "diverged" && item.goal !== "diverged"
  ) && (journal.direction === "rollback" || resourcesHaveNoDivergence(resources));
  const headReady = journal.direction === "rollback"
    ? head === payload.historyHeadAfter || head === payload.historyHeadBefore
    : payload.historyHeadAfter === null
      ? head === payload.historyHeadBefore || await reconciledHeadMatches(stateDirectory, payload)
      : head === payload.historyHeadAfter;
  return {
    transactionRef: transactionReference(journal.id),
    operation: journal.operation as CodexTransactionOperation,
    state: journal.state,
    direction: journal.direction,
    ready: nativeReady && headReady,
    items: journal.itemCount,
    findings: codexFindings(payload, native, resources),
  };
}

export async function recoverCodexTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  const preview = await previewCodexRecovery(stateDirectory, rawJournal);
  if (!preview.ready) throw new Error("Codex recovery conflicts with current target history");
  let journal = await saveTransaction(stateDirectory, {
    ...withoutFailure(rawJournal),
    state: "running",
    phase: rawJournal.direction === "rollback" ? "rolling_back" : "applying_native",
  });
  let payload = readCodexTransaction(journal);
  try {
    if (journal.direction === "rollback") {
      await applyNativeState(stateDirectory, journal, payload, "before", true);
      await restoreHistoryHead(stateDirectory, "codex", payload.historyHeadBefore);
      return await saveTransaction(stateDirectory, {
        ...withoutFailure(journal), state: "rolled_back", phase: "rolled_back",
      });
    }
    await applyNativeState(stateDirectory, journal, payload, "after", true);
    await publishManagedResourceEffects(stateDirectory, journal.id, payload.resources, true);
    journal = await saveTransaction(stateDirectory, { ...journal, phase: "reconciling_history" });
    ({ journal, payload } = await reconcileForward(stateDirectory, journal, payload));
    return await saveTransaction(stateDirectory, {
      ...withoutFailure(withPayload(journal, payload)), state: "committed", phase: "committed",
    });
  } catch (error) {
    throw await recoveryRequiredError(
      stateDirectory, journal, "codex.recovery_interrupted", "Codex transaction still requires recovery", error,
    );
  }
}
