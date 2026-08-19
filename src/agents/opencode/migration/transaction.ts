import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  isHistorySnapshotId,
  libraryMetadataEqual,
  readLibraryMetadata,
  type JsonValue,
  type StoredSession,
} from "../../../domain/history.js";
import { transactionReference, type TransactionJournal } from "../../../domain/transaction.js";
import {
  exclusiveFileMatches,
  observeExclusiveFile,
  publishExclusiveFile,
  removeExclusiveFile,
  requireRealDirectory,
  requireSafeDirectoryParents,
  type ExclusiveFileImage,
} from "../../../infrastructure/exclusive-file.js";
import { digestFile } from "../../../infrastructure/files.js";
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
import { openCodeSessionRef } from "../identity.js";
import { readOpenCodePlanLocations } from "../plan.js";
import {
  applyOpenCodeInsertedRows,
  insertedOpenCodeSessionsUnchanged,
  normalizeOpenCodeInsertedRows,
  observeOpenCodeInsertedRows,
  type OpenCodeInsertedRow,
  type OpenCodeRowPosition,
} from "../storage/native.js";
import { scanOpenCode } from "../scan.js";

const PAYLOAD_SCHEMA = "agenthist.opencode.transaction/v5";
const ARTIFACT_OBJECT = "objects/history.sqlite";
const NATIVE_FILE_OBJECT = /^objects\/[0-9]{6}-native-file$/;
const DIGEST = /^[0-9a-f]{64}$/;

interface OpenCodeTransactionArtifact {
  readonly object: typeof ARTIFACT_OBJECT;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface OpenCodeNativeFileImage extends ExclusiveFileImage {
  readonly object: string;
}

export type OpenCodeNativeFileRole = "session-diff" | "session-plan" | "tool-output";

interface OpenCodeTransactionNativeFile {
  readonly role: OpenCodeNativeFileRole;
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly destination: string;
  readonly after: OpenCodeNativeFileImage;
}

interface OpenCodeTransactionSession {
  readonly sessionRef: string;
  readonly nativeId: string;
}

interface ImportedLibrary {
  readonly sessionRef: string;
  readonly library: StoredSession["library"];
}

interface OpenCodeTransactionPayload {
  readonly schemaVersion: typeof PAYLOAD_SCHEMA;
  readonly target: {
    readonly dataRoot: string;
    readonly database: string;
  };
  readonly artifact: OpenCodeTransactionArtifact | null;
  readonly insertedRows: readonly OpenCodeInsertedRow[];
  readonly files: readonly OpenCodeTransactionNativeFile[];
  readonly resources: readonly ManagedResourceTransactionEffect[];
  readonly sessions: readonly OpenCodeTransactionSession[];
  readonly importedLibrary: readonly ImportedLibrary[];
  readonly historyHeadBefore: string | null;
  readonly historyHeadAfter: string | null;
}

export interface PreparedOpenCodeNativeFileEffect {
  readonly role: OpenCodeNativeFileRole;
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly destination: string;
  readonly filePath: string;
}

export interface PrepareOpenCodeTransactionOptions {
  readonly stateDirectory: string;
  readonly dataRoot: string;
  readonly database: string;
  readonly artifactPath: string;
  readonly insertedRows: readonly OpenCodeInsertedRow[];
  readonly files: readonly PreparedOpenCodeNativeFileEffect[];
  readonly resources: readonly PreparedManagedResourceEffect[];
  readonly sessions: readonly OpenCodeTransactionSession[];
  readonly importedLibrary: ReadonlyMap<string, StoredSession["library"]>;
}

export interface OpenCodeTransactionFinding {
  readonly sessionRef: string;
  readonly row: "before" | "after" | "diverged";
  readonly resources?: "before" | "after" | "diverged";
}

export interface OpenCodeTransactionPreview {
  readonly transactionRef: string;
  readonly operation: "history_import";
  readonly state: TransactionJournal["state"];
  readonly direction: TransactionJournal["direction"];
  readonly ready: boolean;
  readonly items: number;
  readonly findings: readonly OpenCodeTransactionFinding[];
}

type EffectPosition = "before" | "after" | "diverged";

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function libraryValue(value: unknown): StoredSession["library"] | undefined {
  return readLibraryMetadata(value);
}

function jsonValues(value: unknown): readonly JsonValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value as JsonValue[];
}

function artifactValue(value: unknown): OpenCodeTransactionArtifact | null | undefined {
  if (value === null) return null;
  const artifact = objectValue(value);
  if (
    artifact?.object !== ARTIFACT_OBJECT || typeof artifact.sizeBytes !== "number" ||
    !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 ||
    typeof artifact.sha256 !== "string" || !DIGEST.test(artifact.sha256)
  ) return undefined;
  return { object: ARTIFACT_OBJECT, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 };
}

function nativeFileImage(value: unknown): OpenCodeNativeFileImage | undefined {
  const image = objectValue(value);
  if (
    image === undefined || typeof image.object !== "string" || !NATIVE_FILE_OBJECT.test(image.object) ||
    typeof image.sizeBytes !== "number" || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes < 0 ||
    typeof image.sha256 !== "string" || !DIGEST.test(image.sha256) || image.mode !== 0o600
  ) return undefined;
  return image as unknown as OpenCodeNativeFileImage;
}

export function readOpenCodeTransaction(journal: TransactionJournal): OpenCodeTransactionPayload {
  if (journal.agents.length !== 1 || journal.agents[0] !== "opencode" || journal.operation !== "history_import") {
    throw new Error("transaction is not a supported OpenCode operation");
  }
  const payload = objectValue(journal.payload);
  const target = objectValue(payload?.target);
  const artifact = artifactValue(payload?.artifact);
  if (
    payload?.schemaVersion !== PAYLOAD_SCHEMA || target === undefined || artifact === undefined ||
    typeof target.dataRoot !== "string" || !path.isAbsolute(target.dataRoot) ||
    typeof target.database !== "string" || !path.isAbsolute(target.database) ||
    !Array.isArray(payload.insertedRows) || !Array.isArray(payload.files) || !Array.isArray(payload.resources) ||
    !Array.isArray(payload.sessions) || payload.sessions.length !== journal.itemCount || payload.sessions.length === 0 ||
    !Array.isArray(payload.importedLibrary) || payload.importedLibrary.length !== payload.sessions.length ||
    !(payload.historyHeadBefore === null ||
      typeof payload.historyHeadBefore === "string" && isHistorySnapshotId(payload.historyHeadBefore)) ||
    !(payload.historyHeadAfter === null ||
      typeof payload.historyHeadAfter === "string" && isHistorySnapshotId(payload.historyHeadAfter))
  ) throw new Error("OpenCode transaction payload is invalid");

  const insertedRows: OpenCodeInsertedRow[] = [];
  for (const raw of payload.insertedRows) {
    const item = objectValue(raw);
    const key = jsonValues(item?.key);
    if (item === undefined || typeof item.table !== "string" || key === undefined || key.length === 0) {
      throw new Error("OpenCode transaction inserted row is invalid");
    }
    insertedRows.push({ table: item.table as OpenCodeInsertedRow["table"], key: [...key] });
  }
  if ((insertedRows.length === 0) !== (artifact === null)) {
    throw new Error("OpenCode transaction database artifact is inconsistent");
  }

  const sessions: OpenCodeTransactionSession[] = [];
  const sessionRefs = new Set<string>();
  for (const raw of payload.sessions) {
    const item = objectValue(raw);
    if (
      item === undefined || typeof item.sessionRef !== "string" || typeof item.nativeId !== "string" ||
      openCodeSessionRef(item.nativeId) !== item.sessionRef || sessionRefs.has(item.sessionRef)
    ) throw new Error("OpenCode transaction session is invalid");
    sessionRefs.add(item.sessionRef);
    sessions.push({ sessionRef: item.sessionRef, nativeId: item.nativeId });
  }

  const files: OpenCodeTransactionNativeFile[] = [];
  const fileKeys = new Set<string>();
  const destinations = new Set<string>();
  const objectPaths = new Set<string>();
  for (const raw of payload.files) {
    const item = objectValue(raw);
    const after = nativeFileImage(item?.after);
    const role = item?.role;
    const destination = typeof item?.destination === "string" ? item.destination : "";
    const nativeId = typeof item?.nativeId === "string" ? item.nativeId : "";
    const sessionRef = typeof item?.sessionRef === "string" ? item.sessionRef : "";
    const relative = destination === "" ? "" : path.relative(target.dataRoot, destination);
    const parts = relative.split(path.sep);
    const planName = path.basename(destination);
    const planInsideDataRoot = parts.length === 2 && parts[0] === "plans";
    const planInsideProject = path.basename(path.dirname(destination)) === "plans" &&
      path.basename(path.dirname(path.dirname(destination))) === ".opencode";
    const validDestination = role === "session-diff"
      ? parts.length === 3 && parts[0] === "storage" && parts[1] === "session_diff" && parts[2] === `${nativeId}.json`
      : role === "tool-output"
        ? parts.length === 2 && parts[0] === "tool-output" && parts[1] !== ""
        : role === "session-plan"
          ? (planInsideDataRoot || planInsideProject) && planName.endsWith(".md") && planName !== ".md"
          : false;
    const fileKey = `${sessionRef}\0${role}\0${destination}`;
    if (
      item === undefined || after === undefined || !sessionRefs.has(sessionRef) ||
      openCodeSessionRef(nativeId) !== sessionRef || !path.isAbsolute(destination) || path.resolve(destination) !== destination ||
      (role !== "session-plan" && (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))) ||
      !validDestination || fileKeys.has(fileKey) || destinations.has(destination) || objectPaths.has(after.object)
    ) throw new Error("OpenCode transaction native file effect is invalid");
    fileKeys.add(fileKey);
    destinations.add(destination);
    objectPaths.add(after.object);
    files.push({ role: role as OpenCodeNativeFileRole, sessionRef, nativeId, destination, after });
  }
  const resources = readManagedResourceTransactionEffects(payload.resources, sessionRefs);
  if (resources.some((resource) => destinations.has(resource.destination))) {
    throw new Error("OpenCode transaction resource destination collides with a native file");
  }
  if (insertedRows.length === 0 && files.length === 0 && resources.length === 0) {
    throw new Error("OpenCode transaction has no history changes");
  }

  const importedLibrary: ImportedLibrary[] = [];
  const libraryRefs = new Set<string>();
  for (const raw of payload.importedLibrary) {
    const item = objectValue(raw);
    const library = libraryValue(item?.library);
    if (
      item === undefined || typeof item.sessionRef !== "string" || library === undefined ||
      !sessionRefs.has(item.sessionRef) || libraryRefs.has(item.sessionRef)
    ) throw new Error("OpenCode transaction library reconciliation is invalid");
    libraryRefs.add(item.sessionRef);
    importedLibrary.push({ sessionRef: item.sessionRef, library });
  }
  return {
    schemaVersion: PAYLOAD_SCHEMA,
    target: { dataRoot: target.dataRoot, database: target.database },
    artifact,
    insertedRows,
    files,
    resources,
    sessions,
    importedLibrary,
    historyHeadBefore: payload.historyHeadBefore,
    historyHeadAfter: payload.historyHeadAfter,
  };
}

export async function prepareOpenCodeTransaction(options: PrepareOpenCodeTransactionOptions): Promise<TransactionJournal> {
  if (
    options.sessions.length === 0 ||
    (options.insertedRows.length === 0 && options.files.length === 0 && options.resources.length === 0)
  ) {
    throw new Error("OpenCode transaction has no history changes");
  }
  const insertedRows = options.insertedRows.length === 0
    ? []
    : normalizeOpenCodeInsertedRows(options.artifactPath, options.insertedRows);
  const sources: TransactionObjectSource[] = [];
  let artifact: OpenCodeTransactionArtifact | null = null;
  if (insertedRows.length !== 0) {
    const digest = await digestFile(options.artifactPath);
    artifact = { object: ARTIFACT_OBJECT, ...digest };
    sources.push({ relativePath: ARTIFACT_OBJECT, filePath: options.artifactPath, ...digest });
  }
  const files: OpenCodeTransactionNativeFile[] = [];
  for (const [index, effect] of [...options.files]
    .sort((left, right) => left.sessionRef.localeCompare(right.sessionRef) || left.role.localeCompare(right.role) ||
      left.destination.localeCompare(right.destination)).entries()) {
    const object = `objects/${index.toString().padStart(6, "0")}-native-file`;
    const digest = await digestFile(effect.filePath);
    sources.push({ relativePath: object, filePath: effect.filePath, ...digest });
    files.push({
      role: effect.role,
      sessionRef: effect.sessionRef,
      nativeId: effect.nativeId,
      destination: effect.destination,
      after: { object, ...digest, mode: 0o600 },
    });
  }
  const preparedResources = await prepareManagedResourceTransactionEffects(options.resources);
  sources.push(...preparedResources.sources);
  const previous = await loadSnapshot(options.stateDirectory, "opencode");
  const importedLibrary: ImportedLibrary[] = [];
  for (const session of options.sessions) {
    const incoming = options.importedLibrary.get(session.sessionRef);
    if (incoming === undefined) throw new Error(`OpenCode imported library state is unavailable: ${session.sessionRef}`);
    const existing = previous?.sessions.find((candidate) => candidate.sessionRef === session.sessionRef)?.library;
    importedLibrary.push({ sessionRef: session.sessionRef, library: existing ?? incoming });
  }
  importedLibrary.sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
  const id = newTransactionId();
  const now = new Date().toISOString();
  const payload: OpenCodeTransactionPayload = {
    schemaVersion: PAYLOAD_SCHEMA,
    target: { dataRoot: path.resolve(options.dataRoot), database: path.resolve(options.database) },
    artifact,
    insertedRows,
    files,
    resources: preparedResources.effects,
    sessions: [...options.sessions].sort((left, right) => left.sessionRef.localeCompare(right.sessionRef)),
    importedLibrary,
    historyHeadBefore: await loadHistoryHead(options.stateDirectory, "opencode"),
    historyHeadAfter: null,
  };
  const journal: TransactionJournal = {
    schemaVersion: "agenthist.transaction/v1",
    id,
    operation: "history_import",
    agents: ["opencode"],
    state: "planned",
    phase: "prepared",
    direction: "forward",
    createdAt: now,
    updatedAt: now,
    itemCount: payload.sessions.length,
    payload: payload as unknown as JsonValue,
  };
  readOpenCodeTransaction(journal);
  return initializeTransaction(options.stateDirectory, journal, sources);
}

async function transactionArtifact(
  stateDirectory: string,
  journal: TransactionJournal,
  payload: OpenCodeTransactionPayload,
): Promise<string | null> {
  if (payload.artifact === null) return null;
  const file = resolveTransactionObject(stateDirectory, journal.id, payload.artifact.object);
  const actual = await digestFile(file);
  if (actual.sizeBytes !== payload.artifact.sizeBytes || actual.sha256 !== payload.artifact.sha256) {
    throw new Error("OpenCode transaction artifact differs");
  }
  normalizeOpenCodeInsertedRows(file, payload.insertedRows);
  return file;
}

async function validateNativeFileObjects(
  stateDirectory: string,
  journal: TransactionJournal,
  payload: OpenCodeTransactionPayload,
): Promise<void> {
  for (const effect of payload.files) {
    const file = resolveTransactionObject(stateDirectory, journal.id, effect.after.object);
    const actual = await digestFile(file);
    if (actual.sizeBytes !== effect.after.sizeBytes || actual.sha256 !== effect.after.sha256) {
      throw new Error(`OpenCode transaction native file object differs: ${effect.sessionRef}`);
    }
  }
}

function nativeFileRoot(
  payload: OpenCodeTransactionPayload,
  effect: OpenCodeTransactionNativeFile,
): string {
  if (effect.role !== "session-plan") return payload.target.dataRoot;
  return path.basename(path.dirname(path.dirname(effect.destination))) === ".opencode"
    ? path.dirname(path.dirname(path.dirname(effect.destination)))
    : payload.target.dataRoot;
}

async function validateTarget(
  payload: OpenCodeTransactionPayload,
  artifact: string | null,
): Promise<void> {
  await requireRealDirectory(payload.target.dataRoot, "OpenCode transaction data root");
  const database = await lstat(payload.target.database);
  if (!database.isFile() || database.isSymbolicLink()) throw new Error("OpenCode transaction database is not a regular file");
  const hasPlans = payload.files.some((effect) => effect.role === "session-plan");
  const planLocations = hasPlans
    ? readOpenCodePlanLocations(
        artifact ?? payload.target.database,
        payload.target.dataRoot,
        artifact === null ? "native" : "history",
      )
    : undefined;
  for (const effect of payload.files) {
    const root = nativeFileRoot(payload, effect);
    if (effect.role === "session-plan") {
      const expected = planLocations?.bySession.get(effect.nativeId);
      if (
        planLocations?.supported !== true || expected === undefined ||
        expected.root !== root || expected.nativePath !== effect.destination
      ) throw new Error(`OpenCode transaction session plan location changed: ${effect.sessionRef}`);
      await requireRealDirectory(root, "OpenCode transaction plan root");
    }
    await requireSafeDirectoryParents(root, effect.destination, `OpenCode ${effect.role}`);
  }
}

function aggregateRows(values: readonly OpenCodeRowPosition[]): EffectPosition {
  if (values.every((value) => value === "absent")) return "before";
  if (values.every((value) => value === "exact")) return "after";
  return "diverged";
}

async function nativeFilePosition(effect: OpenCodeTransactionNativeFile): Promise<EffectPosition> {
  const current = await observeExclusiveFile(effect.destination, `OpenCode ${effect.role} ${effect.sessionRef}`);
  if (current === null) return "before";
  return exclusiveFileMatches(effect.after, current) ? "after" : "diverged";
}

interface OpenCodeNativeObservations {
  readonly artifact: string | null;
  readonly database: EffectPosition | null;
  readonly files: ReadonlyMap<string, readonly EffectPosition[]>;
  readonly positions: readonly EffectPosition[];
  readonly nativePositions: readonly EffectPosition[];
  readonly findings: readonly OpenCodeTransactionFinding[];
}

async function findings(
  stateDirectory: string,
  journal: TransactionJournal,
  payload: OpenCodeTransactionPayload,
  includeResources = true,
): Promise<OpenCodeNativeObservations> {
  const artifact = await transactionArtifact(stateDirectory, journal, payload);
  await validateTarget(payload, artifact);
  await validateNativeFileObjects(stateDirectory, journal, payload);
  const database = artifact === null
    ? null
    : aggregateRows(observeOpenCodeInsertedRows(artifact, payload.target.database, payload.insertedRows));
  const files = new Map<string, EffectPosition[]>();
  const filePositions: EffectPosition[] = [];
  for (const effect of payload.files) {
    const position = await nativeFilePosition(effect);
    filePositions.push(position);
    const owned = files.get(effect.sessionRef) ?? [];
    owned.push(position);
    files.set(effect.sessionRef, owned);
  }
  const resourceObservations: ManagedResourceObservations = includeResources
    ? await observeManagedResourceEffects(stateDirectory, journal.id, payload.resources)
    : { positions: [], bySession: new Map() };
  const nativePositions = [
    ...(database === null ? [] : [database]),
    ...filePositions,
  ];
  const positions = [
    ...nativePositions,
    ...resourceObservations.positions,
  ];
  return {
    artifact,
    database,
    files,
    positions,
    nativePositions,
    findings: payload.sessions.map((session) => {
      const own = files.get(session.sessionRef) ?? [];
      const resourceValues = resourceObservations.bySession.get(session.sessionRef) ?? [];
      const resources = resourceValues.length === 0
        ? undefined
        : resourceValues.every((value) => value === "before")
          ? "before" as const
          : resourceValues.every((value) => value === "after")
            ? "after" as const
            : "diverged" as const;
      const values = [
        ...(database === null ? [] : [database]),
        ...own,
        ...(resourceObservations.bySession.get(session.sessionRef) ?? []),
      ];
      const row: EffectPosition = values.length === 0 || values.every((value) => value === "after")
        ? "after"
        : values.every((value) => value === "before")
          ? "before"
          : "diverged";
      return {
        sessionRef: session.sessionRef,
        row,
        ...(resources === undefined ? {} : { resources }),
      };
    }),
  };
}

function withoutFailure(journal: TransactionJournal): Omit<TransactionJournal, "failure"> {
  const { failure: _failure, ...rest } = journal;
  return rest;
}

function withPayload(journal: TransactionJournal, payload: OpenCodeTransactionPayload): TransactionJournal {
  return { ...journal, payload: payload as unknown as JsonValue };
}

async function reconciledHeadMatches(stateDirectory: string, payload: OpenCodeTransactionPayload): Promise<boolean> {
  const snapshot = await loadSnapshot(stateDirectory, "opencode");
  if (snapshot === undefined || !payload.sessions.every((item) =>
    snapshot.sessions.some((session) => session.sessionRef === item.sessionRef && session.nativeId === item.nativeId)
  )) return false;
  return payload.importedLibrary.every((item) => {
    const session = snapshot.sessions.find((candidate) => candidate.sessionRef === item.sessionRef);
    return session !== undefined && libraryMetadataEqual(session.library, item.library);
  });
}

async function reconcileForward(
  stateDirectory: string,
  journal: TransactionJournal,
  payload: OpenCodeTransactionPayload,
): Promise<{ readonly journal: TransactionJournal; readonly payload: OpenCodeTransactionPayload }> {
  const currentHead = await loadHistoryHead(stateDirectory, "opencode");
  if (payload.historyHeadAfter !== null) {
    if (currentHead !== payload.historyHeadAfter) throw new Error("OpenCode history head changed after reconciliation");
    return { journal, payload };
  }
  if (currentHead !== payload.historyHeadBefore) {
    if (!await reconciledHeadMatches(stateDirectory, payload)) throw new Error("OpenCode history head changed before reconciliation");
    const accepted = { ...payload, historyHeadAfter: currentHead };
    return { journal: await saveTransaction(stateDirectory, withPayload(journal, accepted)), payload: accepted };
  }
  const importedLibrary = new Map(payload.importedLibrary.map((item) => [item.sessionRef, item.library]));
  const scan = await scanOpenCode({
    stateDirectory,
    dataRoot: payload.target.dataRoot,
    databasePath: payload.target.database,
    importedLibrary,
  });
  const reconciled = { ...payload, historyHeadAfter: scan.snapshot.snapshotId };
  return { journal: await saveTransaction(stateDirectory, withPayload(journal, reconciled)), payload: reconciled };
}

function allAt(observed: OpenCodeNativeObservations, position: EffectPosition): boolean {
  return observed.positions.length !== 0 && observed.positions.every((value) => value === position);
}

function allNativeAt(observed: OpenCodeNativeObservations, position: EffectPosition): boolean {
  return observed.nativePositions.every((value) => value === position);
}

function noDivergence(observed: OpenCodeNativeObservations): boolean {
  return observed.positions.every((value) => value !== "diverged");
}

function noNativeDivergence(observed: OpenCodeNativeObservations): boolean {
  return observed.nativePositions.every((value) => value !== "diverged");
}

function rowsUnchanged(observed: OpenCodeNativeObservations, payload: OpenCodeTransactionPayload): boolean {
  return observed.artifact === null || insertedOpenCodeSessionsUnchanged(
    observed.artifact,
    payload.target.database,
    payload.insertedRows,
  );
}

function rowsReadyForRollback(observed: OpenCodeNativeObservations, payload: OpenCodeTransactionPayload): boolean {
  return observed.database === null || observed.database === "before" ||
    observed.database === "after" && rowsUnchanged(observed, payload);
}

function nativeFileTemporary(journal: TransactionJournal, effect: OpenCodeTransactionNativeFile, index: number): string {
  return path.join(
    path.dirname(effect.destination),
    `.agenthist-${journal.id}-${index.toString().padStart(6, "0")}-native-file.tmp`,
  );
}

async function publishNativeFiles(
  stateDirectory: string,
  journal: TransactionJournal,
  payload: OpenCodeTransactionPayload,
  recovery: boolean,
): Promise<void> {
  for (const [index, effect] of payload.files.entries()) {
    await publishExclusiveFile({
      root: nativeFileRoot(payload, effect),
      destination: effect.destination,
      source: resolveTransactionObject(stateDirectory, journal.id, effect.after.object),
      temporary: nativeFileTemporary(journal, effect, index),
      image: effect.after,
      description: `OpenCode ${effect.role} ${effect.sessionRef}`,
      recovery,
    });
  }
}

async function removeNativeFiles(payload: OpenCodeTransactionPayload, recovery: boolean): Promise<void> {
  for (const effect of [...payload.files].reverse()) {
    await removeExclusiveFile({
      destination: effect.destination,
      image: effect.after,
      description: `OpenCode ${effect.role} ${effect.sessionRef}`,
      recovery,
    });
  }
}

function applyDatabase(
  artifact: string | null,
  payload: OpenCodeTransactionPayload,
  desired: "present" | "absent",
  recovery: boolean,
): void {
  if (artifact !== null) {
    applyOpenCodeInsertedRows(artifact, payload.target.database, payload.insertedRows, desired, recovery);
  }
}

export async function executePreparedOpenCodeTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  let journal = rawJournal;
  let payload = readOpenCodeTransaction(journal);
  if (journal.state !== "planned" || journal.direction !== "forward") throw new Error("OpenCode transaction is not ready to apply");
  const observed = await findings(stateDirectory, journal, payload);
  if (!allAt(observed, "before")) {
    const failed = await failTransactionBeforeEffects(
      stateDirectory,
      journal,
      "opencode.target_changed_before_apply",
    );
    throw new Error(`OpenCode transaction did not start: ${transactionReference(failed.id)}`);
  }
  journal = await saveTransaction(stateDirectory, { ...journal, state: "running", phase: "applying_native" });
  try {
    await publishManagedResourceEffects(stateDirectory, journal.id, payload.resources, false);
    applyDatabase(observed.artifact, payload, "present", false);
    await publishNativeFiles(stateDirectory, journal, payload, false);
    journal = await saveTransaction(stateDirectory, { ...journal, phase: "reconciling_history" });
    ({ journal, payload } = await reconcileForward(stateDirectory, journal, payload));
    return saveTransaction(stateDirectory, {
      ...withoutFailure(withPayload(journal, payload)), state: "committed", phase: "committed", direction: "forward",
    });
  } catch (error) {
    throw await recoveryRequiredError(
      stateDirectory, journal, "opencode.forward_interrupted", "OpenCode transaction requires recovery", error,
    );
  }
}

export async function previewOpenCodeRollback(
  stateDirectory: string,
  journal: TransactionJournal,
): Promise<OpenCodeTransactionPreview> {
  const payload = readOpenCodeTransaction(journal);
  if (journal.state === "rolled_back") return {
    transactionRef: transactionReference(journal.id), operation: "history_import", state: journal.state,
    direction: journal.direction, ready: true, items: payload.sessions.length, findings: [],
  };
  if (journal.state !== "committed" || payload.historyHeadAfter === null) throw new Error("only a committed transaction can be rolled back");
  const observed = await findings(stateDirectory, journal, payload, false);
  return {
    transactionRef: transactionReference(journal.id), operation: "history_import", state: journal.state,
    direction: "rollback", ready: allNativeAt(observed, "after") && rowsUnchanged(observed, payload) &&
      await loadHistoryHead(stateDirectory, "opencode") === payload.historyHeadAfter,
    items: payload.sessions.length, findings: observed.findings,
  };
}

export async function rollbackOpenCodeTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  const preview = await previewOpenCodeRollback(stateDirectory, rawJournal);
  if (rawJournal.state === "rolled_back") return rawJournal;
  if (!preview.ready) throw new Error("OpenCode rollback conflicts with current target history");
  let journal = await saveTransaction(stateDirectory, {
    ...withoutFailure(rawJournal), state: "running", phase: "rolling_back", direction: "rollback",
  });
  const payload = readOpenCodeTransaction(journal);
  try {
    const artifact = await transactionArtifact(stateDirectory, journal, payload);
    await validateNativeFileObjects(stateDirectory, journal, payload);
    await removeNativeFiles(payload, false);
    applyDatabase(artifact, payload, "absent", false);
    await restoreHistoryHead(stateDirectory, "opencode", payload.historyHeadBefore);
    journal = await saveTransaction(stateDirectory, {
      ...withoutFailure(journal), state: "rolled_back", phase: "rolled_back", direction: "rollback",
    });
    return journal;
  } catch (error) {
    throw await recoveryRequiredError(
      stateDirectory, journal, "opencode.rollback_interrupted", "OpenCode rollback requires recovery", error,
    );
  }
}

export async function previewOpenCodeRecovery(
  stateDirectory: string,
  journal: TransactionJournal,
): Promise<OpenCodeTransactionPreview> {
  const payload = readOpenCodeTransaction(journal);
  if (journal.state !== "planned" && journal.state !== "running" && journal.state !== "needs_recovery") {
    throw new Error("transaction does not require recovery");
  }
  const observed = await findings(stateDirectory, journal, payload, journal.direction !== "rollback");
  const head = await loadHistoryHead(stateDirectory, "opencode");
  const nativeReady = (journal.direction === "rollback" ? noNativeDivergence(observed) : noDivergence(observed)) &&
    (journal.direction !== "rollback" || rowsReadyForRollback(observed, payload));
  const headReady = journal.direction === "rollback"
    ? head === payload.historyHeadAfter || head === payload.historyHeadBefore
    : payload.historyHeadAfter === null
      ? head === payload.historyHeadBefore || await reconciledHeadMatches(stateDirectory, payload)
      : head === payload.historyHeadAfter;
  return {
    transactionRef: transactionReference(journal.id), operation: "history_import", state: journal.state,
    direction: journal.direction, ready: nativeReady && headReady, items: payload.sessions.length,
    findings: observed.findings,
  };
}

export async function recoverOpenCodeTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  const preview = await previewOpenCodeRecovery(stateDirectory, rawJournal);
  if (!preview.ready) throw new Error("OpenCode recovery conflicts with current target history");
  let journal = await saveTransaction(stateDirectory, {
    ...withoutFailure(rawJournal), state: "running",
    phase: rawJournal.direction === "rollback" ? "rolling_back" : "applying_native",
  });
  let payload = readOpenCodeTransaction(journal);
  try {
    const artifact = await transactionArtifact(stateDirectory, journal, payload);
    await validateNativeFileObjects(stateDirectory, journal, payload);
    if (journal.direction === "rollback") {
      await removeNativeFiles(payload, true);
      applyDatabase(artifact, payload, "absent", true);
      await restoreHistoryHead(stateDirectory, "opencode", payload.historyHeadBefore);
      return saveTransaction(stateDirectory, {
        ...withoutFailure(journal), state: "rolled_back", phase: "rolled_back",
      });
    }
    await publishManagedResourceEffects(stateDirectory, journal.id, payload.resources, true);
    applyDatabase(artifact, payload, "present", true);
    await publishNativeFiles(stateDirectory, journal, payload, true);
    journal = await saveTransaction(stateDirectory, { ...journal, phase: "reconciling_history" });
    ({ journal, payload } = await reconcileForward(stateDirectory, journal, payload));
    return saveTransaction(stateDirectory, {
      ...withoutFailure(withPayload(journal, payload)), state: "committed", phase: "committed",
    });
  } catch (error) {
    throw await recoveryRequiredError(
      stateDirectory, journal, "opencode.recovery_interrupted", "OpenCode transaction still requires recovery", error,
    );
  }
}
