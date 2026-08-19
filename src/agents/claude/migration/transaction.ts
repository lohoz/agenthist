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
import { discoverClaudeCarriers } from "../carrier.js";
import { claudeSessionRef } from "../identity.js";
import { scanClaude } from "../scan.js";
import { claudeTaskPathIdentity } from "../sidecars/task.js";

const PAYLOAD_SCHEMA = "agenthist.claude.transaction/v6";
const FILE_OBJECT = /^objects\/[0-9]{6}-native-file$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SUBAGENT_TRANSCRIPT = /^agent-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.jsonl$/;
const SUBAGENT_METADATA = /^agent-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.meta\.json$/;
const TOOL_RESULT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(?:txt|json)$/;
const CHECKPOINT_BACKUP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@v[1-9][0-9]*$/;

export type ClaudeNativeFileRole =
  | "main-transcript"
  | "subagent-transcript"
  | "subagent-metadata"
  | "tool-result"
  | "session-sidecar"
  | "checkpoint-backup"
  | "task-entry"
  | "task-highwatermark";
type EffectPosition = "before" | "after" | "diverged";

interface ClaudeFileImage extends ExclusiveFileImage {
  readonly object: string;
}

interface ClaudeTransactionEffect {
  readonly role: ClaudeNativeFileRole;
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly destination: string;
  readonly after: ClaudeFileImage;
}

export interface ClaudeTransactionFile {
  readonly role: ClaudeNativeFileRole;
  readonly destination: string;
  readonly image: ExclusiveFileImage;
}

export interface ClaudeTransactionSession {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly firstRootRecordUuid: string;
  readonly files: readonly ClaudeTransactionFile[];
}

interface ImportedLibrary {
  readonly sessionRef: string;
  readonly library: StoredSession["library"];
}

interface ClaudeTransactionPayload {
  readonly schemaVersion: typeof PAYLOAD_SCHEMA;
  readonly target: { readonly configRoot: string };
  readonly effects: readonly ClaudeTransactionEffect[];
  readonly resources: readonly ManagedResourceTransactionEffect[];
  readonly sessions: readonly ClaudeTransactionSession[];
  readonly importedLibrary: readonly ImportedLibrary[];
  readonly historyHeadBefore: string | null;
  readonly historyHeadAfter: string | null;
}

export interface PreparedClaudeEffect {
  readonly role: ClaudeNativeFileRole;
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly destination: string;
  readonly filePath: string;
  readonly mode: number;
}

export interface PrepareClaudeTransactionOptions {
  readonly stateDirectory: string;
  readonly configRoot: string;
  readonly effects: readonly PreparedClaudeEffect[];
  readonly resources: readonly PreparedManagedResourceEffect[];
  readonly sessions: readonly ClaudeTransactionSession[];
  readonly importedLibrary: ReadonlyMap<string, StoredSession["library"]>;
}

export interface ClaudeTransactionFinding {
  readonly sessionRef: string;
  readonly row: EffectPosition;
  readonly resources?: EffectPosition;
}

export interface ClaudeTransactionPreview {
  readonly transactionRef: string;
  readonly operation: "history_import";
  readonly state: TransactionJournal["state"];
  readonly direction: TransactionJournal["direction"];
  readonly ready: boolean;
  readonly items: number;
  readonly findings: readonly ClaudeTransactionFinding[];
}

interface ClaudeObservations {
  readonly positions: readonly EffectPosition[];
  readonly nativePositions: readonly EffectPosition[];
  readonly unexpected: ReadonlySet<string>;
  readonly changedInvariants: ReadonlySet<string>;
  readonly findings: readonly ClaudeTransactionFinding[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function libraryValue(value: unknown): StoredSession["library"] | undefined {
  return readLibraryMetadata(value);
}

function exclusiveImage(value: unknown): ExclusiveFileImage | undefined {
  const image = objectValue(value);
  if (
    image === undefined ||
    typeof image.sizeBytes !== "number" || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes < 0 ||
    typeof image.sha256 !== "string" || !DIGEST.test(image.sha256) ||
    typeof image.mode !== "number" || !Number.isSafeInteger(image.mode) || image.mode < 0 || image.mode > 0o777
  ) return undefined;
  return { sizeBytes: image.sizeBytes, sha256: image.sha256, mode: image.mode };
}

function fileImage(value: unknown): ClaudeFileImage | undefined {
  const image = objectValue(value);
  const exclusive = exclusiveImage(value);
  if (image === undefined || exclusive === undefined || typeof image.object !== "string" || !FILE_OBJECT.test(image.object)) {
    return undefined;
  }
  return image as unknown as ClaudeFileImage;
}

function sameImage(left: ExclusiveFileImage, right: ExclusiveFileImage): boolean {
  return left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256 && left.mode === right.mode;
}

function destinationRole(configRoot: string, nativeId: string, destination: string): ClaudeNativeFileRole | undefined {
  if (!path.isAbsolute(destination) || path.resolve(destination) !== destination) return undefined;
  const relative = path.relative(configRoot, destination);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const parts = relative.split(path.sep);
  if (
    parts.length === 3 && parts[0] === "projects" && parts[1] !== "" &&
    parts[2] === `${nativeId}.jsonl`
  ) return "main-transcript";
  if (
    parts.length === 5 && parts[0] === "projects" && parts[1] !== "" &&
    parts[2] === nativeId
  ) {
    if (parts[3] === "subagents") {
      if (SUBAGENT_TRANSCRIPT.test(parts[4]!)) return "subagent-transcript";
      if (SUBAGENT_METADATA.test(parts[4]!)) return "subagent-metadata";
    }
    if (parts[3] === "tool-results" && TOOL_RESULT.test(parts[4]!)) return "tool-result";
  }
  if (
    parts.length >= 4 && parts[0] === "projects" && parts[1] !== "" &&
    parts[2] === nativeId && parts.slice(3).every((part) => part !== "" && part !== "." && part !== "..")
  ) return "session-sidecar";
  if (
    parts.length === 3 && parts[0] === "file-history" && parts[1] === nativeId &&
    CHECKPOINT_BACKUP.test(parts[2]!)
  ) return "checkpoint-backup";
  const task = claudeTaskPathIdentity(`claude/${parts.join("/")}`);
  if (task !== undefined && task.sessionId === nativeId) return task.role;
  return undefined;
}

function validateSessionFiles(
  configRoot: string,
  session: ClaudeTransactionSession,
  global: Set<string>,
): void {
  const roles = new Map<string, Set<ClaudeNativeFileRole>>();
  let projectCarrier: string | undefined;
  let main = 0;
  for (const file of session.files) {
    const role = destinationRole(configRoot, session.nativeId, file.destination);
    const relativeParts = path.relative(configRoot, file.destination).split(path.sep);
    const projectRole = role === "main-transcript" || role === "subagent-transcript" ||
      role === "subagent-metadata" || role === "tool-result" || role === "session-sidecar";
    const carrier = projectRole ? relativeParts[1] : undefined;
    if (
      role !== file.role || projectRole && (carrier === undefined || carrier === "" ||
        projectCarrier !== undefined && carrier !== projectCarrier) || global.has(file.destination)
    ) {
      throw new Error("Claude Code transaction carrier set is invalid");
    }
    if (projectRole) projectCarrier = carrier;
    global.add(file.destination);
    if (file.role !== "checkpoint-backup" && file.image.mode !== 0o600) {
      throw new Error("Claude Code transaction native file mode is invalid");
    }
    if (file.role === "checkpoint-backup" && (file.image.mode & 0o400) === 0) {
      throw new Error("Claude Code transaction checkpoint mode is unreadable");
    }
    if (file.role === "main-transcript") {
      main++;
      continue;
    }
    if (
      file.role === "tool-result" || file.role === "checkpoint-backup" ||
      file.role === "task-entry" || file.role === "task-highwatermark" || file.role === "session-sidecar"
    ) continue;
    const name = path.basename(file.destination).replace(/\.meta\.json$|\.jsonl$/, "");
    const values = roles.get(name) ?? new Set<ClaudeNativeFileRole>();
    if (values.has(file.role)) throw new Error("Claude Code transaction subagent carrier is duplicated");
    values.add(file.role);
    roles.set(name, values);
  }
  if (main !== 1 || [...roles.values()].some((values) => values.size !== 2)) {
    throw new Error("Claude Code transaction carrier closure is incomplete");
  }
}

export function readClaudeTransaction(journal: TransactionJournal): ClaudeTransactionPayload {
  if (journal.agents.length !== 1 || journal.agents[0] !== "claude" || journal.operation !== "history_import") {
    throw new Error("transaction is not a supported Claude Code operation");
  }
  const payload = objectValue(journal.payload);
  const target = objectValue(payload?.target);
  if (
    payload?.schemaVersion !== PAYLOAD_SCHEMA || target === undefined ||
    typeof target.configRoot !== "string" || !path.isAbsolute(target.configRoot) ||
    path.resolve(target.configRoot) !== target.configRoot ||
    !Array.isArray(payload.effects) || !Array.isArray(payload.resources) ||
    !Array.isArray(payload.sessions) || payload.sessions.length !== journal.itemCount || payload.sessions.length === 0 ||
    !Array.isArray(payload.importedLibrary) || payload.importedLibrary.length !== payload.sessions.length ||
    !(payload.historyHeadBefore === null ||
      typeof payload.historyHeadBefore === "string" && isHistorySnapshotId(payload.historyHeadBefore)) ||
    !(payload.historyHeadAfter === null ||
      typeof payload.historyHeadAfter === "string" && isHistorySnapshotId(payload.historyHeadAfter))
  ) throw new Error("Claude Code transaction payload is invalid");

  const sessions: ClaudeTransactionSession[] = [];
  const sessionRefs = new Set<string>();
  const nativeIds = new Set<string>();
  const destinations = new Set<string>();
  for (const raw of payload.sessions) {
    const item = objectValue(raw);
    if (
      item === undefined || typeof item.sessionRef !== "string" || typeof item.nativeId !== "string" ||
      typeof item.firstRootRecordUuid !== "string" || !Array.isArray(item.files) || item.files.length === 0 ||
      claudeSessionRef(item.nativeId, item.firstRootRecordUuid) !== item.sessionRef ||
      sessionRefs.has(item.sessionRef) || nativeIds.has(item.nativeId)
    ) throw new Error("Claude Code transaction session is invalid");
    const files: ClaudeTransactionFile[] = item.files.map((rawFile) => {
      const file = objectValue(rawFile);
      const image = exclusiveImage(file?.image);
      if (
        file === undefined || image === undefined || typeof file.destination !== "string" ||
        (file.role !== "main-transcript" && file.role !== "subagent-transcript" &&
          file.role !== "subagent-metadata" && file.role !== "tool-result" &&
          file.role !== "session-sidecar" && file.role !== "checkpoint-backup" && file.role !== "task-entry" &&
          file.role !== "task-highwatermark")
      ) throw new Error("Claude Code transaction session file is invalid");
      return { role: file.role, destination: file.destination, image };
    });
    const session: ClaudeTransactionSession = {
      sessionRef: item.sessionRef,
      nativeId: item.nativeId,
      firstRootRecordUuid: item.firstRootRecordUuid,
      files,
    };
    validateSessionFiles(target.configRoot, session, destinations);
    sessionRefs.add(session.sessionRef);
    nativeIds.add(session.nativeId);
    sessions.push(session);
  }

  const effects: ClaudeTransactionEffect[] = [];
  const effectDestinations = new Set<string>();
  const objectPaths = new Set<string>();
  for (const raw of payload.effects) {
    const item = objectValue(raw);
    const after = fileImage(item?.after);
    const role = item?.role;
    const sessionRef = typeof item?.sessionRef === "string" ? item.sessionRef : "";
    const nativeId = typeof item?.nativeId === "string" ? item.nativeId : "";
    const destination = typeof item?.destination === "string" ? item.destination : "";
    const session = sessions.find((candidate) => candidate.sessionRef === sessionRef);
    const expected = session?.files.find((file) => file.destination === destination);
    if (
      item === undefined || after === undefined || session === undefined || session.nativeId !== nativeId ||
      expected === undefined || expected.role !== role || !sameImage(expected.image, after) ||
      destinationRole(target.configRoot, nativeId, destination) !== role || effectDestinations.has(destination) ||
      objectPaths.has(after.object)
    ) throw new Error("Claude Code transaction native file effect is invalid");
    effectDestinations.add(destination);
    objectPaths.add(after.object);
    effects.push({ role: role as ClaudeNativeFileRole, sessionRef, nativeId, destination, after });
  }
  const resources = readManagedResourceTransactionEffects(payload.resources, sessionRefs);
  if (resources.some((resource) => effectDestinations.has(resource.destination))) {
    throw new Error("Claude Code transaction resource destination collides with a native file");
  }
  if (effects.length === 0 && resources.length === 0) {
    throw new Error("Claude Code transaction has no native changes");
  }
  if (sessions.some((session) =>
    !effects.some((effect) => effect.sessionRef === session.sessionRef) &&
    !resources.some((resource) => resource.sessionRefs.includes(session.sessionRef)))) {
    throw new Error("Claude Code transaction session has no native change");
  }

  const importedLibrary: ImportedLibrary[] = [];
  const librarySessions = new Set<string>();
  for (const raw of payload.importedLibrary) {
    const item = objectValue(raw);
    const library = libraryValue(item?.library);
    if (
      item === undefined || typeof item.sessionRef !== "string" || !sessionRefs.has(item.sessionRef) ||
      library === undefined || librarySessions.has(item.sessionRef)
    ) throw new Error("Claude Code transaction library reconciliation is invalid");
    librarySessions.add(item.sessionRef);
    importedLibrary.push({ sessionRef: item.sessionRef, library });
  }
  return {
    schemaVersion: PAYLOAD_SCHEMA,
    target: { configRoot: target.configRoot },
    effects,
    resources,
    sessions,
    importedLibrary,
    historyHeadBefore: payload.historyHeadBefore,
    historyHeadAfter: payload.historyHeadAfter,
  };
}

export async function prepareClaudeTransaction(options: PrepareClaudeTransactionOptions): Promise<TransactionJournal> {
  if ((options.effects.length === 0 && options.resources.length === 0) || options.sessions.length === 0) {
    throw new Error("Claude Code transaction has no history changes");
  }
  const sources: TransactionObjectSource[] = [];
  const effects: ClaudeTransactionEffect[] = [];
  for (const [index, effect] of [...options.effects].sort((left, right) =>
    left.sessionRef.localeCompare(right.sessionRef) || left.destination.localeCompare(right.destination)).entries()) {
    const object = `objects/${index.toString().padStart(6, "0")}-native-file`;
    const digest = await digestFile(effect.filePath);
    sources.push({ relativePath: object, filePath: effect.filePath, ...digest });
    effects.push({ ...effect, after: { object, ...digest, mode: effect.mode } });
  }
  const preparedResources = await prepareManagedResourceTransactionEffects(options.resources);
  sources.push(...preparedResources.sources);
  const previous = await loadSnapshot(options.stateDirectory, "claude");
  const sessions = [...options.sessions].sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
  const importedLibrary: ImportedLibrary[] = [];
  for (const session of sessions) {
    const incoming = options.importedLibrary.get(session.sessionRef);
    if (incoming === undefined) throw new Error(`Claude Code imported library state is unavailable: ${session.sessionRef}`);
    const existing = previous?.sessions.find((candidate) => candidate.sessionRef === session.sessionRef)?.library;
    importedLibrary.push({ sessionRef: session.sessionRef, library: existing ?? incoming });
  }
  const id = newTransactionId();
  const now = new Date().toISOString();
  const payload: ClaudeTransactionPayload = {
    schemaVersion: PAYLOAD_SCHEMA,
    target: { configRoot: path.resolve(options.configRoot) },
    effects,
    resources: preparedResources.effects,
    sessions,
    importedLibrary,
    historyHeadBefore: await loadHistoryHead(options.stateDirectory, "claude"),
    historyHeadAfter: null,
  };
  const journal: TransactionJournal = {
    schemaVersion: "agenthist.transaction/v1",
    id,
    operation: "history_import",
    agents: ["claude"],
    state: "planned",
    phase: "prepared",
    direction: "forward",
    createdAt: now,
    updatedAt: now,
    itemCount: sessions.length,
    payload: payload as unknown as JsonValue,
  };
  readClaudeTransaction(journal);
  return initializeTransaction(options.stateDirectory, journal, sources);
}

async function unexpectedSessions(payload: ClaudeTransactionPayload): Promise<ReadonlySet<string>> {
  const byNativeId = new Map(payload.sessions.map((session) => [session.nativeId, session]));
  const unexpected = new Set<string>();
  for (const carrier of await discoverClaudeCarriers(payload.target.configRoot)) {
    const session = carrier.sessionCandidate === undefined ? undefined : byNativeId.get(carrier.sessionCandidate);
    if (session === undefined) continue;
    if (!session.files.some((file) => file.destination === path.resolve(carrier.sourcePath))) {
      unexpected.add(session.sessionRef);
    }
  }
  return unexpected;
}

async function effectPosition(effect: ClaudeTransactionEffect): Promise<EffectPosition> {
  const current = await observeExclusiveFile(effect.destination, `Claude Code ${effect.role}`);
  if (current === null) return "before";
  return exclusiveFileMatches(effect.after, current) ? "after" : "diverged";
}

async function observations(
  stateDirectory: string,
  journal: TransactionJournal,
  payload: ClaudeTransactionPayload,
  includeResources = true,
): Promise<ClaudeObservations> {
  await requireRealDirectory(payload.target.configRoot, "Claude Code transaction config root");
  for (const effect of payload.effects) {
    await requireSafeDirectoryParents(payload.target.configRoot, effect.destination, `Claude Code ${effect.role}`);
    const object = resolveTransactionObject(stateDirectory, journal.id, effect.after.object);
    const digest = await digestFile(object);
    if (digest.sizeBytes !== effect.after.sizeBytes || digest.sha256 !== effect.after.sha256) {
      throw new Error("Claude Code transaction object differs");
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
    for (const file of session.files) {
      if (effectDestinations.has(file.destination)) continue;
      const current = await observeExclusiveFile(file.destination, `Claude Code ${file.role}`);
      if (!exclusiveFileMatches(file.image, current)) changedInvariants.add(session.sessionRef);
    }
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
  const positions = [...nativePositions, ...resourceObservations.positions];
  return {
    positions,
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
      const row: EffectPosition = unexpected.has(session.sessionRef) || changedInvariants.has(session.sessionRef)
        ? "diverged"
        : values.every((value) => value === "before")
          ? "before"
          : values.every((value) => value === "after")
            ? "after"
            : "diverged";
      return {
        sessionRef: session.sessionRef,
        row,
        ...(resources === undefined ? {} : { resources }),
      };
    }),
  };
}

function allAt(observed: ClaudeObservations, position: EffectPosition): boolean {
  return observed.unexpected.size === 0 && observed.changedInvariants.size === 0 && observed.positions.length !== 0 &&
    observed.positions.every((value) => value === position);
}

function nativeAt(observed: ClaudeObservations, position: EffectPosition): boolean {
  return observed.unexpected.size === 0 && observed.changedInvariants.size === 0 &&
    observed.nativePositions.every((value) => value === position);
}

function noNativeDivergence(observed: ClaudeObservations): boolean {
  return observed.unexpected.size === 0 && observed.changedInvariants.size === 0 &&
    observed.nativePositions.every((value) => value !== "diverged");
}

function noForwardDivergence(observed: ClaudeObservations): boolean {
  return noNativeDivergence(observed) && observed.positions.every((value) => value !== "diverged");
}

async function requireInvariantFiles(payload: ClaudeTransactionPayload): Promise<void> {
  const effects = new Set(payload.effects.map((effect) => effect.destination));
  for (const session of payload.sessions) {
    for (const file of session.files) {
      if (effects.has(file.destination)) continue;
      const current = await observeExclusiveFile(file.destination, `Claude Code ${file.role}`);
      if (!exclusiveFileMatches(file.image, current)) throw new Error("Claude Code target carrier set diverged");
    }
  }
}

async function publishEffects(
  stateDirectory: string,
  journal: TransactionJournal,
  payload: ClaudeTransactionPayload,
  recovery: boolean,
): Promise<void> {
  if ((await unexpectedSessions(payload)).size !== 0) throw new Error("Claude Code target carrier set diverged");
  await requireInvariantFiles(payload);
  await publishManagedResourceEffects(stateDirectory, journal.id, payload.resources, recovery);
  for (const [index, effect] of payload.effects.entries()) {
    await publishExclusiveFile({
      root: payload.target.configRoot,
      destination: effect.destination,
      source: resolveTransactionObject(stateDirectory, journal.id, effect.after.object),
      temporary: path.join(
        path.dirname(effect.destination),
        `.agenthist-${journal.id}-${index.toString().padStart(6, "0")}-native-file.tmp`,
      ),
      image: effect.after,
      description: `Claude Code ${effect.role} ${effect.sessionRef}`,
      recovery,
    });
  }
  if ((await unexpectedSessions(payload)).size !== 0) throw new Error("Claude Code target carrier set diverged");
  await requireInvariantFiles(payload);
}

async function removeEffects(payload: ClaudeTransactionPayload, recovery: boolean): Promise<void> {
  if ((await unexpectedSessions(payload)).size !== 0) throw new Error("Claude Code target carrier set diverged");
  await requireInvariantFiles(payload);
  for (const effect of [...payload.effects].reverse()) {
    await removeExclusiveFile({
      destination: effect.destination,
      image: effect.after,
      description: `Claude Code ${effect.role} ${effect.sessionRef}`,
      recovery,
    });
  }
  if ((await unexpectedSessions(payload)).size !== 0) throw new Error("Claude Code target carrier set diverged");
  await requireInvariantFiles(payload);
}

function withoutFailure(journal: TransactionJournal): Omit<TransactionJournal, "failure"> {
  const { failure: _failure, ...rest } = journal;
  return rest;
}

function withPayload(journal: TransactionJournal, payload: ClaudeTransactionPayload): TransactionJournal {
  return { ...journal, payload: payload as unknown as JsonValue };
}

async function reconciledHeadMatches(stateDirectory: string, payload: ClaudeTransactionPayload): Promise<boolean> {
  const snapshot = await loadSnapshot(stateDirectory, "claude");
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
  payload: ClaudeTransactionPayload,
): Promise<{ readonly journal: TransactionJournal; readonly payload: ClaudeTransactionPayload }> {
  const currentHead = await loadHistoryHead(stateDirectory, "claude");
  if (payload.historyHeadAfter !== null) {
    if (currentHead !== payload.historyHeadAfter) throw new Error("Claude Code history head changed after reconciliation");
    return { journal, payload };
  }
  if (currentHead !== payload.historyHeadBefore) {
    if (!await reconciledHeadMatches(stateDirectory, payload)) throw new Error("Claude Code history head changed before reconciliation");
    const accepted = { ...payload, historyHeadAfter: currentHead };
    return { journal: await saveTransaction(stateDirectory, withPayload(journal, accepted)), payload: accepted };
  }
  const library = new Map(payload.importedLibrary.map((item) => [item.sessionRef, item.library]));
  const scanned = await scanClaude({
    stateDirectory,
    configRoot: payload.target.configRoot,
    importedLibrary: library,
  });
  const reconciled = { ...payload, historyHeadAfter: scanned.snapshot.snapshotId };
  return { journal: await saveTransaction(stateDirectory, withPayload(journal, reconciled)), payload: reconciled };
}

export async function executePreparedClaudeTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  let journal = rawJournal;
  let payload = readClaudeTransaction(journal);
  if (journal.state !== "planned" || journal.direction !== "forward") throw new Error("Claude Code transaction is not ready to apply");
  const observed = await observations(stateDirectory, journal, payload);
  if (!allAt(observed, "before")) {
    const failed = await failTransactionBeforeEffects(
      stateDirectory,
      journal,
      "claude.target_changed_before_apply",
    );
    throw new Error(`Claude Code transaction did not start: ${transactionReference(failed.id)}`);
  }
  journal = await saveTransaction(stateDirectory, { ...journal, state: "running", phase: "applying_native" });
  try {
    await publishEffects(stateDirectory, journal, payload, false);
    journal = await saveTransaction(stateDirectory, { ...journal, phase: "reconciling_history" });
    ({ journal, payload } = await reconcileForward(stateDirectory, journal, payload));
    return saveTransaction(stateDirectory, {
      ...withoutFailure(withPayload(journal, payload)), state: "committed", phase: "committed", direction: "forward",
    });
  } catch (error) {
    throw await recoveryRequiredError(
      stateDirectory, journal, "claude.forward_interrupted", "Claude Code transaction requires recovery", error,
    );
  }
}

export async function previewClaudeRollback(
  stateDirectory: string,
  journal: TransactionJournal,
): Promise<ClaudeTransactionPreview> {
  const payload = readClaudeTransaction(journal);
  if (journal.state === "rolled_back") return {
    transactionRef: transactionReference(journal.id), operation: "history_import", state: journal.state,
    direction: journal.direction, ready: true, items: payload.sessions.length, findings: [],
  };
  if (journal.state !== "committed" || payload.historyHeadAfter === null) throw new Error("only a committed transaction can be rolled back");
  const observed = await observations(stateDirectory, journal, payload, false);
  return {
    transactionRef: transactionReference(journal.id), operation: "history_import", state: journal.state,
    direction: "rollback", ready: nativeAt(observed, "after") &&
      await loadHistoryHead(stateDirectory, "claude") === payload.historyHeadAfter,
    items: payload.sessions.length, findings: observed.findings,
  };
}

export async function rollbackClaudeTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  const preview = await previewClaudeRollback(stateDirectory, rawJournal);
  if (rawJournal.state === "rolled_back") return rawJournal;
  if (!preview.ready) throw new Error("Claude Code rollback conflicts with current target history");
  let journal = await saveTransaction(stateDirectory, {
    ...withoutFailure(rawJournal), state: "running", phase: "rolling_back", direction: "rollback",
  });
  const payload = readClaudeTransaction(journal);
  try {
    await removeEffects(payload, false);
    await restoreHistoryHead(stateDirectory, "claude", payload.historyHeadBefore);
    journal = await saveTransaction(stateDirectory, {
      ...withoutFailure(journal), state: "rolled_back", phase: "rolled_back", direction: "rollback",
    });
    return journal;
  } catch (error) {
    throw await recoveryRequiredError(
      stateDirectory, journal, "claude.rollback_interrupted", "Claude Code rollback requires recovery", error,
    );
  }
}

export async function previewClaudeRecovery(
  stateDirectory: string,
  journal: TransactionJournal,
): Promise<ClaudeTransactionPreview> {
  const payload = readClaudeTransaction(journal);
  if (journal.state !== "planned" && journal.state !== "running" && journal.state !== "needs_recovery") {
    throw new Error("transaction does not require recovery");
  }
  const observed = await observations(stateDirectory, journal, payload, journal.direction !== "rollback");
  const head = await loadHistoryHead(stateDirectory, "claude");
  const headReady = journal.direction === "rollback"
    ? head === payload.historyHeadAfter || head === payload.historyHeadBefore
    : payload.historyHeadAfter === null
      ? head === payload.historyHeadBefore || await reconciledHeadMatches(stateDirectory, payload)
      : head === payload.historyHeadAfter;
  return {
    transactionRef: transactionReference(journal.id), operation: "history_import", state: journal.state,
    direction: journal.direction,
    ready: headReady && (journal.direction === "rollback" ? noNativeDivergence(observed) : noForwardDivergence(observed)),
    items: payload.sessions.length, findings: observed.findings,
  };
}

export async function recoverClaudeTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  const preview = await previewClaudeRecovery(stateDirectory, rawJournal);
  if (!preview.ready) throw new Error("Claude Code recovery conflicts with current target history");
  let journal = await saveTransaction(stateDirectory, {
    ...withoutFailure(rawJournal), state: "running",
    phase: rawJournal.direction === "rollback" ? "rolling_back" : "applying_native",
  });
  let payload = readClaudeTransaction(journal);
  try {
    if (journal.direction === "rollback") {
      await removeEffects(payload, true);
      await restoreHistoryHead(stateDirectory, "claude", payload.historyHeadBefore);
      return saveTransaction(stateDirectory, { ...withoutFailure(journal), state: "rolled_back", phase: "rolled_back" });
    }
    await publishEffects(stateDirectory, journal, payload, true);
    journal = await saveTransaction(stateDirectory, { ...journal, phase: "reconciling_history" });
    ({ journal, payload } = await reconcileForward(stateDirectory, journal, payload));
    return saveTransaction(stateDirectory, {
      ...withoutFailure(withPayload(journal, payload)), state: "committed", phase: "committed",
    });
  } catch (error) {
    throw await recoveryRequiredError(
      stateDirectory, journal, "claude.recovery_interrupted", "Claude Code transaction still requires recovery", error,
    );
  }
}
