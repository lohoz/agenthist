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
import { discoverPiSessions } from "../carrier.js";
import { parsePiSession } from "../history/session.js";
import { canonicalPiSessionId, piSessionRef } from "../identity.js";
import { scanPi } from "../scan.js";

const PAYLOAD_SCHEMA = "agenthist.pi.transaction/v1";
const FILE_OBJECT = /^objects\/[0-9]{6}-native-file$/;
const DIGEST = /^[0-9a-f]{64}$/;
type EffectPosition = "before" | "after" | "diverged";
type FindingPosition = EffectPosition | "unchanged";

interface PiFileImage extends ExclusiveFileImage {
  readonly object: string;
}

interface PiTransactionEffect {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly destination: string;
  readonly after: PiFileImage;
}

export interface PiTransactionSession {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly destination: string;
  readonly image: ExclusiveFileImage;
}

interface ImportedLibrary {
  readonly sessionRef: string;
  readonly library: StoredSession["library"];
}

interface PiTransactionPayload {
  readonly schemaVersion: typeof PAYLOAD_SCHEMA;
  readonly target: { readonly sessionRoot: string };
  readonly effects: readonly PiTransactionEffect[];
  readonly resources: readonly ManagedResourceTransactionEffect[];
  readonly sessions: readonly PiTransactionSession[];
  readonly importedLibrary: readonly ImportedLibrary[];
  readonly historyHeadBefore: string | null;
  readonly historyHeadAfter: string | null;
}

export interface PreparedPiEffect {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly destination: string;
  readonly filePath: string;
  readonly mode: number;
}

export interface PreparePiTransactionOptions {
  readonly stateDirectory: string;
  readonly sessionRoot: string;
  readonly effects: readonly PreparedPiEffect[];
  readonly resources: readonly PreparedManagedResourceEffect[];
  readonly sessions: readonly PiTransactionSession[];
  readonly importedLibrary: ReadonlyMap<string, StoredSession["library"]>;
}

export interface PiTransactionFinding {
  readonly sessionRef: string;
  readonly row: FindingPosition;
  readonly resources?: EffectPosition;
}

export interface PiTransactionPreview {
  readonly transactionRef: string;
  readonly operation: "history_import";
  readonly state: TransactionJournal["state"];
  readonly direction: TransactionJournal["direction"];
  readonly ready: boolean;
  readonly items: number;
  readonly findings: readonly PiTransactionFinding[];
}

interface PiObservations {
  readonly positions: readonly EffectPosition[];
  readonly nativePositions: readonly EffectPosition[];
  readonly unexpected: ReadonlySet<string>;
  readonly changedInvariants: ReadonlySet<string>;
  readonly findings: readonly PiTransactionFinding[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exclusiveImage(value: unknown): ExclusiveFileImage | undefined {
  const image = objectValue(value);
  if (
    image === undefined || typeof image.sizeBytes !== "number" || !Number.isSafeInteger(image.sizeBytes) ||
    image.sizeBytes < 0 || typeof image.sha256 !== "string" || !DIGEST.test(image.sha256) ||
    typeof image.mode !== "number" || !Number.isSafeInteger(image.mode) || image.mode < 0 || image.mode > 0o777
  ) return undefined;
  return { sizeBytes: image.sizeBytes, sha256: image.sha256, mode: image.mode };
}

function fileImage(value: unknown): PiFileImage | undefined {
  const image = objectValue(value);
  const exclusive = exclusiveImage(value);
  if (image === undefined || exclusive === undefined || typeof image.object !== "string" || !FILE_OBJECT.test(image.object)) {
    return undefined;
  }
  return image as unknown as PiFileImage;
}

function validDestination(root: string, destination: string): boolean {
  if (!path.isAbsolute(destination) || path.resolve(destination) !== destination || path.extname(destination) !== ".jsonl") {
    return false;
  }
  const relative = path.relative(root, destination);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sameImage(left: ExclusiveFileImage, right: ExclusiveFileImage): boolean {
  return left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256 && left.mode === right.mode;
}

export function readPiTransaction(journal: TransactionJournal): PiTransactionPayload {
  if (journal.agents.length !== 1 || journal.agents[0] !== "pi" || journal.operation !== "history_import") {
    throw new Error("transaction is not a supported Pi operation");
  }
  const payload = objectValue(journal.payload);
  const target = objectValue(payload?.target);
  if (
    payload?.schemaVersion !== PAYLOAD_SCHEMA || target === undefined ||
    typeof target.sessionRoot !== "string" || !path.isAbsolute(target.sessionRoot) ||
    path.resolve(target.sessionRoot) !== target.sessionRoot || !Array.isArray(payload.effects) ||
    !Array.isArray(payload.resources) || !Array.isArray(payload.sessions) || payload.sessions.length === 0 ||
    payload.sessions.length !== journal.itemCount || !Array.isArray(payload.importedLibrary) ||
    payload.importedLibrary.length !== payload.sessions.length ||
    !(payload.historyHeadBefore === null ||
      typeof payload.historyHeadBefore === "string" && isHistorySnapshotId(payload.historyHeadBefore)) ||
    !(payload.historyHeadAfter === null ||
      typeof payload.historyHeadAfter === "string" && isHistorySnapshotId(payload.historyHeadAfter))
  ) throw new Error("Pi transaction payload is invalid");

  const sessions: PiTransactionSession[] = [];
  const sessionRefs = new Set<string>();
  const nativeIds = new Set<string>();
  const destinations = new Set<string>();
  for (const raw of payload.sessions) {
    const item = objectValue(raw);
    const image = exclusiveImage(item?.image);
    if (
      item === undefined || image === undefined || typeof item.sessionRef !== "string" ||
      typeof item.nativeId !== "string" || typeof item.destination !== "string" ||
      piSessionRef(canonicalPiSessionId(item.nativeId)) !== item.sessionRef ||
      !validDestination(target.sessionRoot, item.destination) || sessionRefs.has(item.sessionRef) ||
      nativeIds.has(item.nativeId) || destinations.has(item.destination)
    ) throw new Error("Pi transaction session is invalid");
    sessionRefs.add(item.sessionRef);
    nativeIds.add(item.nativeId);
    destinations.add(item.destination);
    sessions.push({
      sessionRef: item.sessionRef,
      nativeId: item.nativeId,
      destination: item.destination,
      image,
    });
  }

  const effects: PiTransactionEffect[] = [];
  const effectDestinations = new Set<string>();
  const objects = new Set<string>();
  for (const raw of payload.effects) {
    const item = objectValue(raw);
    const after = fileImage(item?.after);
    const session = sessions.find((candidate) => candidate.sessionRef === item?.sessionRef);
    if (
      item === undefined || after === undefined || session === undefined || item.nativeId !== session.nativeId ||
      item.destination !== session.destination || !sameImage(session.image, after) ||
      effectDestinations.has(session.destination) || objects.has(after.object)
    ) throw new Error("Pi transaction native file effect is invalid");
    effectDestinations.add(session.destination);
    objects.add(after.object);
    effects.push({
      sessionRef: session.sessionRef,
      nativeId: session.nativeId,
      destination: session.destination,
      after,
    });
  }
  const resources = readManagedResourceTransactionEffects(payload.resources, sessionRefs);
  if (resources.some((resource) => destinations.has(resource.destination))) {
    throw new Error("Pi transaction resource destination collides with a session file");
  }
  if (effects.length === 0 && resources.length === 0) throw new Error("Pi transaction has no native changes");
  const importedLibrary: ImportedLibrary[] = [];
  const librarySessions = new Set<string>();
  for (const raw of payload.importedLibrary) {
    const item = objectValue(raw);
    const library = readLibraryMetadata(item?.library);
    if (
      item === undefined || typeof item.sessionRef !== "string" || !sessionRefs.has(item.sessionRef) ||
      library === undefined || librarySessions.has(item.sessionRef)
    ) throw new Error("Pi transaction library reconciliation is invalid");
    librarySessions.add(item.sessionRef);
    importedLibrary.push({ sessionRef: item.sessionRef, library });
  }
  return {
    schemaVersion: PAYLOAD_SCHEMA,
    target: { sessionRoot: target.sessionRoot },
    effects,
    resources,
    sessions,
    importedLibrary,
    historyHeadBefore: payload.historyHeadBefore,
    historyHeadAfter: payload.historyHeadAfter,
  };
}

export async function preparePiTransaction(options: PreparePiTransactionOptions): Promise<TransactionJournal> {
  if ((options.effects.length === 0 && options.resources.length === 0) || options.sessions.length === 0) {
    throw new Error("Pi transaction has no history changes");
  }
  const sources: TransactionObjectSource[] = [];
  const effects: PiTransactionEffect[] = [];
  for (const [index, effect] of [...options.effects].sort((left, right) =>
    left.sessionRef.localeCompare(right.sessionRef)).entries()) {
    const object = `objects/${index.toString().padStart(6, "0")}-native-file`;
    const digest = await digestFile(effect.filePath);
    sources.push({ relativePath: object, filePath: effect.filePath, ...digest });
    effects.push({ ...effect, after: { object, ...digest, mode: effect.mode } });
  }
  const preparedResources = await prepareManagedResourceTransactionEffects(options.resources);
  sources.push(...preparedResources.sources);
  const previous = await loadSnapshot(options.stateDirectory, "pi");
  const sessions = [...options.sessions].sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
  const importedLibrary: ImportedLibrary[] = [];
  for (const session of sessions) {
    const incoming = options.importedLibrary.get(session.sessionRef);
    if (incoming === undefined) throw new Error(`Pi imported library state is unavailable: ${session.sessionRef}`);
    const existing = previous?.sessions.find((candidate) => candidate.sessionRef === session.sessionRef)?.library;
    importedLibrary.push({ sessionRef: session.sessionRef, library: existing ?? incoming });
  }
  const id = newTransactionId();
  const now = new Date().toISOString();
  const payload: PiTransactionPayload = {
    schemaVersion: PAYLOAD_SCHEMA,
    target: { sessionRoot: path.resolve(options.sessionRoot) },
    effects,
    resources: preparedResources.effects,
    sessions,
    importedLibrary,
    historyHeadBefore: await loadHistoryHead(options.stateDirectory, "pi"),
    historyHeadAfter: null,
  };
  const journal: TransactionJournal = {
    schemaVersion: "agenthist.transaction/v1",
    id,
    operation: "history_import",
    agents: ["pi"],
    state: "planned",
    phase: "prepared",
    direction: "forward",
    createdAt: now,
    updatedAt: now,
    itemCount: sessions.length,
    payload: payload as unknown as JsonValue,
  };
  readPiTransaction(journal);
  return initializeTransaction(options.stateDirectory, journal, sources);
}

async function unexpectedSessions(payload: PiTransactionPayload): Promise<ReadonlySet<string>> {
  const expected = new Map(payload.sessions.map((session) => [session.nativeId, session]));
  const unexpected = new Set<string>();
  for (const carrier of await discoverPiSessions(payload.target.sessionRoot)) {
    const parsed = await parsePiSession(carrier.sourcePath, carrier.modifiedAt);
    const session = expected.get(parsed.header.id);
    if (session !== undefined && path.resolve(carrier.sourcePath) !== session.destination) {
      unexpected.add(session.sessionRef);
    }
  }
  return unexpected;
}

async function effectPosition(effect: PiTransactionEffect): Promise<EffectPosition> {
  const current = await observeExclusiveFile(effect.destination, `Pi session ${effect.sessionRef}`);
  if (current === null) return "before";
  return exclusiveFileMatches(effect.after, current) ? "after" : "diverged";
}

async function observations(
  stateDirectory: string,
  journal: TransactionJournal,
  payload: PiTransactionPayload,
  includeResources = true,
): Promise<PiObservations> {
  await requireRealDirectory(payload.target.sessionRoot, "Pi transaction session root");
  for (const effect of payload.effects) {
    await requireSafeDirectoryParents(payload.target.sessionRoot, effect.destination, "Pi session");
    const object = resolveTransactionObject(stateDirectory, journal.id, effect.after.object);
    const digest = await digestFile(object);
    if (digest.sizeBytes !== effect.after.sizeBytes || digest.sha256 !== effect.after.sha256) {
      throw new Error("Pi transaction object differs");
    }
  }
  const unexpected = await unexpectedSessions(payload);
  const nativePositions = await Promise.all(payload.effects.map(effectPosition));
  const resourceObservations: ManagedResourceObservations = includeResources
    ? await observeManagedResourceEffects(stateDirectory, journal.id, payload.resources)
    : { positions: [], bySession: new Map() };
  const effectDestinations = new Set(payload.effects.map((effect) => effect.destination));
  const changedInvariants = new Set<string>();
  for (const session of payload.sessions) {
    if (effectDestinations.has(session.destination)) continue;
    const current = await observeExclusiveFile(session.destination, `Pi session ${session.sessionRef}`);
    if (!exclusiveFileMatches(session.image, current)) changedInvariants.add(session.sessionRef);
  }
  const bySession = new Map<string, EffectPosition[]>();
  for (const [index, effect] of payload.effects.entries()) {
    const owned = bySession.get(effect.sessionRef) ?? [];
    owned.push(nativePositions[index]!);
    bySession.set(effect.sessionRef, owned);
  }
  for (const [sessionRef, values] of resourceObservations.bySession) {
    const owned = bySession.get(sessionRef) ?? [];
    owned.push(...values);
    bySession.set(sessionRef, owned);
  }
  return {
    positions: [...nativePositions, ...resourceObservations.positions],
    nativePositions,
    unexpected,
    changedInvariants,
    findings: payload.sessions.map((session) => {
      const values = bySession.get(session.sessionRef) ?? [];
      const resourceValues = resourceObservations.bySession.get(session.sessionRef) ?? [];
      const resources = resourceValues.length === 0
        ? undefined
        : resourceValues.every((value) => value === "before")
          ? "before" as const
          : resourceValues.every((value) => value === "after")
            ? "after" as const
            : "diverged" as const;
      const row: FindingPosition = unexpected.has(session.sessionRef) || changedInvariants.has(session.sessionRef)
        ? "diverged"
        : values.length === 0
          ? "unchanged"
        : values.every((value) => value === "before")
          ? "before"
          : values.every((value) => value === "after")
            ? "after"
            : "diverged";
      return { sessionRef: session.sessionRef, row, ...(resources === undefined ? {} : { resources }) };
    }),
  };
}

function allAt(observed: PiObservations, position: EffectPosition): boolean {
  return observed.unexpected.size === 0 && observed.changedInvariants.size === 0 && observed.positions.length !== 0 &&
    observed.positions.every((value) => value === position);
}

function nativeAt(observed: PiObservations, position: EffectPosition): boolean {
  return observed.unexpected.size === 0 && observed.changedInvariants.size === 0 &&
    observed.nativePositions.every((value) => value === position);
}

function noNativeDivergence(observed: PiObservations): boolean {
  return observed.unexpected.size === 0 && observed.changedInvariants.size === 0 &&
    observed.nativePositions.every((value) => value !== "diverged");
}

function noForwardDivergence(observed: PiObservations): boolean {
  return noNativeDivergence(observed) && observed.positions.every((value) => value !== "diverged");
}

async function requireInvariantFiles(payload: PiTransactionPayload): Promise<void> {
  const effects = new Set(payload.effects.map((effect) => effect.destination));
  for (const session of payload.sessions) {
    if (effects.has(session.destination)) continue;
    const current = await observeExclusiveFile(session.destination, `Pi session ${session.sessionRef}`);
    if (!exclusiveFileMatches(session.image, current)) throw new Error("Pi target session set diverged");
  }
}

async function publishEffects(
  stateDirectory: string,
  journal: TransactionJournal,
  payload: PiTransactionPayload,
  recovery: boolean,
): Promise<void> {
  if ((await unexpectedSessions(payload)).size !== 0) throw new Error("Pi target session set diverged");
  await requireInvariantFiles(payload);
  await publishManagedResourceEffects(stateDirectory, journal.id, payload.resources, recovery);
  for (const [index, effect] of payload.effects.entries()) {
    await publishExclusiveFile({
      root: payload.target.sessionRoot,
      destination: effect.destination,
      source: resolveTransactionObject(stateDirectory, journal.id, effect.after.object),
      temporary: path.join(
        path.dirname(effect.destination),
        `.agenthist-${journal.id}-${index.toString().padStart(6, "0")}-pi-session.tmp`,
      ),
      image: effect.after,
      description: `Pi session ${effect.sessionRef}`,
      recovery,
    });
  }
  if ((await unexpectedSessions(payload)).size !== 0) throw new Error("Pi target session set diverged");
  await requireInvariantFiles(payload);
}

async function removeEffects(payload: PiTransactionPayload, recovery: boolean): Promise<void> {
  if ((await unexpectedSessions(payload)).size !== 0) throw new Error("Pi target session set diverged");
  await requireInvariantFiles(payload);
  for (const effect of [...payload.effects].reverse()) {
    await removeExclusiveFile({
      destination: effect.destination,
      image: effect.after,
      description: `Pi session ${effect.sessionRef}`,
      recovery,
    });
  }
  await requireInvariantFiles(payload);
}

function withoutFailure(journal: TransactionJournal): Omit<TransactionJournal, "failure"> {
  const { failure: _failure, ...rest } = journal;
  return rest;
}

function withPayload(journal: TransactionJournal, payload: PiTransactionPayload): TransactionJournal {
  return { ...journal, payload: payload as unknown as JsonValue };
}

async function reconciledHeadMatches(stateDirectory: string, payload: PiTransactionPayload): Promise<boolean> {
  const snapshot = await loadSnapshot(stateDirectory, "pi");
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
  payload: PiTransactionPayload,
): Promise<{ readonly journal: TransactionJournal; readonly payload: PiTransactionPayload }> {
  const currentHead = await loadHistoryHead(stateDirectory, "pi");
  if (payload.historyHeadAfter !== null) {
    if (currentHead !== payload.historyHeadAfter) throw new Error("Pi history head changed after reconciliation");
    return { journal, payload };
  }
  if (currentHead !== payload.historyHeadBefore) {
    if (!await reconciledHeadMatches(stateDirectory, payload)) throw new Error("Pi history head changed before reconciliation");
    const accepted = { ...payload, historyHeadAfter: currentHead };
    return { journal: await saveTransaction(stateDirectory, withPayload(journal, accepted)), payload: accepted };
  }
  const library = new Map(payload.importedLibrary.map((item) => [item.sessionRef, item.library]));
  const scanned = await scanPi({
    stateDirectory,
    sessionRoot: payload.target.sessionRoot,
    importedLibrary: library,
  });
  const reconciled = { ...payload, historyHeadAfter: scanned.snapshot.snapshotId };
  return { journal: await saveTransaction(stateDirectory, withPayload(journal, reconciled)), payload: reconciled };
}

export async function executePreparedPiTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  let journal = rawJournal;
  let payload = readPiTransaction(journal);
  if (journal.state !== "planned" || journal.direction !== "forward") throw new Error("Pi transaction is not ready to apply");
  const observed = await observations(stateDirectory, journal, payload);
  if (!allAt(observed, "before")) {
    const failed = await failTransactionBeforeEffects(stateDirectory, journal, "pi.target_changed_before_apply");
    throw new Error(`Pi transaction did not start: ${transactionReference(failed.id)}`);
  }
  journal = await saveTransaction(stateDirectory, { ...journal, state: "running", phase: "applying_native" });
  try {
    await publishEffects(stateDirectory, journal, payload, false);
    journal = await saveTransaction(stateDirectory, { ...journal, phase: "reconciling_history" });
    ({ journal, payload } = await reconcileForward(stateDirectory, journal, payload));
    return saveTransaction(stateDirectory, {
      ...withoutFailure(withPayload(journal, payload)),
      state: "committed",
      phase: "committed",
      direction: "forward",
    });
  } catch (error) {
    throw await recoveryRequiredError(
      stateDirectory,
      journal,
      "pi.forward_interrupted",
      "Pi transaction requires recovery",
      error,
    );
  }
}

export async function previewPiRollback(
  stateDirectory: string,
  journal: TransactionJournal,
): Promise<PiTransactionPreview> {
  const payload = readPiTransaction(journal);
  if (journal.state === "rolled_back") return {
    transactionRef: transactionReference(journal.id),
    operation: "history_import",
    state: journal.state,
    direction: journal.direction,
    ready: true,
    items: payload.sessions.length,
    findings: [],
  };
  if (journal.state !== "committed" || payload.historyHeadAfter === null) {
    throw new Error("only a committed transaction can be rolled back");
  }
  const observed = await observations(stateDirectory, journal, payload, false);
  return {
    transactionRef: transactionReference(journal.id),
    operation: "history_import",
    state: journal.state,
    direction: "rollback",
    ready: nativeAt(observed, "after") && await loadHistoryHead(stateDirectory, "pi") === payload.historyHeadAfter,
    items: payload.sessions.length,
    findings: observed.findings,
  };
}

export async function rollbackPiTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  const preview = await previewPiRollback(stateDirectory, rawJournal);
  if (rawJournal.state === "rolled_back") return rawJournal;
  if (!preview.ready) throw new Error("Pi rollback conflicts with current target history");
  let journal = await saveTransaction(stateDirectory, {
    ...withoutFailure(rawJournal),
    state: "running",
    phase: "rolling_back",
    direction: "rollback",
  });
  const payload = readPiTransaction(journal);
  try {
    await removeEffects(payload, false);
    await restoreHistoryHead(stateDirectory, "pi", payload.historyHeadBefore);
    journal = await saveTransaction(stateDirectory, {
      ...withoutFailure(journal),
      state: "rolled_back",
      phase: "rolled_back",
      direction: "rollback",
    });
    return journal;
  } catch (error) {
    throw await recoveryRequiredError(
      stateDirectory,
      journal,
      "pi.rollback_interrupted",
      "Pi rollback requires recovery",
      error,
    );
  }
}

export async function previewPiRecovery(
  stateDirectory: string,
  journal: TransactionJournal,
): Promise<PiTransactionPreview> {
  const payload = readPiTransaction(journal);
  if (journal.state !== "planned" && journal.state !== "running" && journal.state !== "needs_recovery") {
    throw new Error("transaction does not require recovery");
  }
  const observed = await observations(stateDirectory, journal, payload, journal.direction !== "rollback");
  const head = await loadHistoryHead(stateDirectory, "pi");
  const headReady = journal.direction === "rollback"
    ? head === payload.historyHeadAfter || head === payload.historyHeadBefore
    : payload.historyHeadAfter === null
      ? head === payload.historyHeadBefore || await reconciledHeadMatches(stateDirectory, payload)
      : head === payload.historyHeadAfter;
  return {
    transactionRef: transactionReference(journal.id),
    operation: "history_import",
    state: journal.state,
    direction: journal.direction,
    ready: headReady && (journal.direction === "rollback" ? noNativeDivergence(observed) : noForwardDivergence(observed)),
    items: payload.sessions.length,
    findings: observed.findings,
  };
}

export async function recoverPiTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  const preview = await previewPiRecovery(stateDirectory, rawJournal);
  if (!preview.ready) throw new Error("Pi recovery conflicts with current target history");
  let journal = await saveTransaction(stateDirectory, {
    ...withoutFailure(rawJournal),
    state: "running",
    phase: rawJournal.direction === "rollback" ? "rolling_back" : "applying_native",
  });
  let payload = readPiTransaction(journal);
  try {
    if (journal.direction === "rollback") {
      await removeEffects(payload, true);
      await restoreHistoryHead(stateDirectory, "pi", payload.historyHeadBefore);
      return saveTransaction(stateDirectory, {
        ...withoutFailure(journal),
        state: "rolled_back",
        phase: "rolled_back",
      });
    }
    await publishEffects(stateDirectory, journal, payload, true);
    journal = await saveTransaction(stateDirectory, { ...journal, phase: "reconciling_history" });
    ({ journal, payload } = await reconcileForward(stateDirectory, journal, payload));
    return saveTransaction(stateDirectory, {
      ...withoutFailure(withPayload(journal, payload)),
      state: "committed",
      phase: "committed",
    });
  } catch (error) {
    throw await recoveryRequiredError(
      stateDirectory,
      journal,
      "pi.recovery_interrupted",
      "Pi transaction still requires recovery",
      error,
    );
  }
}
