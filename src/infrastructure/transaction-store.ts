import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { isAgent, type Agent } from "../domain/agent.js";
import { isHistorySnapshotId, type JsonValue } from "../domain/history.js";
import {
  isPendingTransaction,
  isTransactionId,
  summarizeTransaction,
  transactionReference,
  type TransactionDirection,
  type TransactionJournal,
  type TransactionState,
  type TransactionSummary,
} from "../domain/transaction.js";
import {
  copyStableFile,
  digestFile,
  readStableSmallFile,
  syncDirectory,
  syncDirectoryTree,
  writeJsonAtomic,
} from "./files.js";
import { ensurePrivateStateDirectory } from "./state.js";

const TRANSACTIONS_DIRECTORY = "transactions";
const JOURNAL_FILE = "journal.json";
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_TRANSACTIONS = 10_000;
const OPERATION = /^[a-z][a-z0-9_]{0,63}$/;
const FAILURE = /^[a-z][a-z0-9_.-]{0,127}$/;
const STATES = new Set<TransactionState>([
  "planned", "running", "committed", "rolled_back", "failed", "needs_recovery",
]);
const DIRECTIONS = new Set<TransactionDirection>(["forward", "rollback"]);

export interface TransactionObjectSource {
  readonly relativePath: string;
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

function transactionsRoot(stateDirectory: string): string {
  return path.join(stateDirectory, TRANSACTIONS_DIRECTORY);
}

function transactionRoot(stateDirectory: string, id: string): string {
  if (!isTransactionId(id)) throw new Error("invalid transaction ID");
  return path.join(transactionsRoot(stateDirectory), id);
}

async function discardTransactionDrafts(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const drafts = entries.filter((entry) =>
    entry.name.startsWith(".prepare-") && isTransactionId(entry.name.slice(".prepare-".length))
  );
  for (const entry of drafts) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`unsafe transaction draft: ${entry.name}`);
    }
  }
  for (const entry of drafts) await rm(path.join(root, entry.name), { recursive: true, force: true });
  if (drafts.length !== 0) await syncDirectory(root);
}

function journalPath(stateDirectory: string, id: string): string {
  return path.join(transactionRoot(stateDirectory, id), JOURNAL_FILE);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 256) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function validTimestamp(value: string): boolean {
  return value !== "" && !Number.isNaN(Date.parse(value));
}

function validLifecycle(journal: TransactionJournal): boolean {
  const withoutFailure = journal.failure === undefined;
  if (journal.state === "planned") {
    return journal.phase === "prepared" && journal.direction === "forward" && withoutFailure;
  }
  if (journal.state === "running") {
    if (!withoutFailure) return false;
    return journal.direction === "forward"
      ? journal.phase === "applying_native" || journal.phase === "reconciling_history"
      : journal.phase === "rolling_back";
  }
  if (journal.state === "committed") {
    return journal.phase === "committed" && journal.direction === "forward" && withoutFailure;
  }
  if (journal.state === "rolled_back") {
    return journal.phase === "rolled_back" && journal.direction === "rollback" && withoutFailure;
  }
  if (journal.state === "failed") {
    return journal.phase === "failed" && journal.direction === "forward" && journal.failure !== undefined;
  }
  return journal.phase === "needs_recovery" && journal.failure !== undefined;
}

function validateJournal(value: unknown, expectedId?: string): TransactionJournal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("transaction journal is invalid");
  }
  const journal = value as Partial<TransactionJournal>;
  if (
    journal.schemaVersion !== "agenthist.transaction/v1" || typeof journal.id !== "string" ||
    !isTransactionId(journal.id) || (expectedId !== undefined && journal.id !== expectedId) ||
    typeof journal.operation !== "string" || !OPERATION.test(journal.operation) ||
    !Array.isArray(journal.agents) || journal.agents.length === 0 ||
    journal.agents.some((agent) => typeof agent !== "string" || !isAgent(agent)) ||
    new Set(journal.agents).size !== journal.agents.length ||
    typeof journal.state !== "string" || !STATES.has(journal.state as TransactionState) ||
    typeof journal.phase !== "string" ||
    typeof journal.direction !== "string" || !DIRECTIONS.has(journal.direction as TransactionDirection) ||
    typeof journal.createdAt !== "string" || !validTimestamp(journal.createdAt) ||
    typeof journal.updatedAt !== "string" || !validTimestamp(journal.updatedAt) ||
    typeof journal.itemCount !== "number" || !Number.isSafeInteger(journal.itemCount) ||
    journal.itemCount < 1 || journal.itemCount > 1_000_000 || !isJsonValue(journal.payload) ||
    (journal.failure !== undefined && (typeof journal.failure !== "string" || !FAILURE.test(journal.failure)))
  ) {
    throw new Error("transaction journal is invalid");
  }
  const validated = journal as TransactionJournal;
  if (!validLifecycle(validated)) throw new Error("transaction journal lifecycle is invalid");
  return validated;
}

function safeObjectRelativePath(value: string): boolean {
  if (value === "" || value.includes("\\") || path.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized.startsWith("objects/") && !normalized.split("/").includes("..");
}

export function newTransactionId(): string {
  return randomUUID();
}

export function resolveTransactionObject(stateDirectory: string, id: string, relativePath: string): string {
  if (!safeObjectRelativePath(relativePath)) throw new Error("invalid transaction object path");
  return path.join(transactionRoot(stateDirectory, id), ...relativePath.split("/"));
}

export async function initializeTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
  objects: readonly TransactionObjectSource[],
): Promise<TransactionJournal> {
  const journal = validateJournal(rawJournal);
  if (journal.state !== "planned" || journal.phase !== "prepared" || journal.direction !== "forward") {
    throw new Error("new transaction journal is not prepared");
  }
  await ensurePrivateStateDirectory(stateDirectory);
  const root = transactionsRoot(stateDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await discardTransactionDrafts(root);
  const draft = path.join(root, `.prepare-${journal.id}`);
  const final = transactionRoot(stateDirectory, journal.id);
  await mkdir(path.join(draft, "objects"), { recursive: true, mode: 0o700 });
  try {
    for (const source of objects) {
      if (!safeObjectRelativePath(source.relativePath)) throw new Error("invalid transaction object path");
      const destination = path.join(draft, ...source.relativePath.split("/"));
      await copyStableFile(source.filePath, destination);
      const copied = await digestFile(destination);
      if (copied.sizeBytes !== source.sizeBytes || copied.sha256 !== source.sha256) {
        throw new Error(`transaction object copy differs: ${source.relativePath}`);
      }
    }
    await syncDirectoryTree(path.join(draft, "objects"));
    await writeJsonAtomic(path.join(draft, JOURNAL_FILE), journal);
    await rename(draft, final);
    await syncDirectory(root);
    return journal;
  } catch (error) {
    await rm(draft, { recursive: true, force: true });
    throw error;
  }
}

export async function saveTransaction(
  stateDirectory: string,
  rawJournal: TransactionJournal,
): Promise<TransactionJournal> {
  const journal = validateJournal(rawJournal);
  const updated = validateJournal({ ...journal, updatedAt: new Date().toISOString() }, journal.id);
  await writeJsonAtomic(journalPath(stateDirectory, journal.id), updated);
  return updated;
}

export async function failTransactionBeforeEffects(
  stateDirectory: string,
  rawJournal: TransactionJournal,
  failure: string,
): Promise<TransactionJournal> {
  const journal = validateJournal(rawJournal);
  const beforeEffects = journal.direction === "forward" && (
    journal.state === "planned" && journal.phase === "prepared" ||
    journal.state === "running" && journal.phase === "applying_native"
  );
  if (!beforeEffects) throw new Error("transaction is not before its first native effect");
  return saveTransaction(stateDirectory, {
    ...journal,
    state: "failed",
    phase: "failed",
    failure,
  });
}

export async function recoveryRequiredError(
  stateDirectory: string,
  journal: TransactionJournal,
  failure: string,
  description: string,
  cause: unknown,
): Promise<Error> {
  let journalFailure: unknown;
  try {
    await saveTransaction(stateDirectory, {
      ...journal,
      state: "needs_recovery",
      phase: "needs_recovery",
      failure,
    });
  } catch (error) {
    journalFailure = error;
  }
  return new Error(
    `${description}: ${transactionReference(journal.id)}` +
      (journalFailure === undefined ? "" : " (recovery journal update failed)"),
    {
      cause: journalFailure === undefined
        ? cause
        : new AggregateError([cause, journalFailure], "native operation and recovery journal update both failed"),
    },
  );
}

export async function loadTransaction(stateDirectory: string, id: string): Promise<TransactionJournal> {
  const bytes = await readStableSmallFile(journalPath(stateDirectory, id), MAX_JOURNAL_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("transaction journal is invalid JSON");
  }
  return validateJournal(parsed, id);
}

async function transactionIds(stateDirectory: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(transactionsRoot(stateDirectory), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids = entries.filter((entry) => isTransactionId(entry.name));
  if (ids.length > MAX_TRANSACTIONS) throw new Error("too many transactions");
  for (const entry of ids) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`unsafe transaction directory: ${entry.name}`);
    }
  }
  return ids.map((entry) => entry.name);
}

export async function listTransactions(stateDirectory: string): Promise<readonly TransactionSummary[]> {
  const journals: TransactionJournal[] = [];
  for (const id of await transactionIds(stateDirectory)) {
    journals.push(await loadTransaction(stateDirectory, id));
  }
  journals.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return journals.map(summarizeTransaction);
}

function transactionPayload(value: JsonValue): Readonly<Record<string, JsonValue>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : undefined;
}

export async function retainedHistorySnapshotIds(
  stateDirectory: string,
  agent: Agent,
): Promise<ReadonlySet<string>> {
  const retained = new Set<string>();
  for (const id of await transactionIds(stateDirectory)) {
    const journal = await loadTransaction(stateDirectory, id);
    if (journal.state === "rolled_back" || journal.state === "failed" || !journal.agents.includes(agent)) continue;
    if (journal.agents.length !== 1) {
      throw new Error("multi-Agent transaction history heads are not representable");
    }
    const payload = transactionPayload(journal.payload);
    const before = payload?.historyHeadBefore;
    const after = payload?.historyHeadAfter;
    if (
      payload === undefined ||
      !(before === null || typeof before === "string" && isHistorySnapshotId(before)) ||
      !(after === null || typeof after === "string" && isHistorySnapshotId(after))
    ) {
      throw new Error(`transaction history head references are invalid: ${transactionReference(journal.id)}`);
    }
    if (typeof before === "string") retained.add(before);
    if (typeof after === "string") retained.add(after);
  }
  return retained;
}

export async function assertNoPendingTransactions(stateDirectory: string): Promise<void> {
  const pending = (await listTransactions(stateDirectory)).find((item) => isPendingTransaction(item.state));
  if (pending !== undefined) {
    throw new Error(`unfinished native write transaction requires recovery: ${pending.transactionRef}`);
  }
}
