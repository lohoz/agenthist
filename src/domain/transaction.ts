import type { Agent } from "./agent.js";
import type { JsonValue } from "./history.js";

const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRANSACTION_REFERENCE_PREFIX = "ahtx1_";

export type TransactionState =
  | "planned"
  | "running"
  | "committed"
  | "rolled_back"
  | "failed"
  | "needs_recovery";

export type TransactionDirection = "forward" | "rollback";

export interface TransactionJournal {
  readonly schemaVersion: "agenthist.transaction/v1";
  readonly id: string;
  readonly operation: string;
  readonly agents: readonly Agent[];
  readonly state: TransactionState;
  readonly phase: string;
  readonly direction: TransactionDirection;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly itemCount: number;
  readonly payload: JsonValue;
  readonly failure?: string;
}

export interface TransactionSummary {
  readonly transactionRef: string;
  readonly operation: string;
  readonly agents: readonly Agent[];
  readonly state: TransactionState;
  readonly phase: string;
  readonly direction: TransactionDirection;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly itemCount: number;
  readonly failure?: string;
}

export function isTransactionId(value: string): boolean {
  return TRANSACTION_ID.test(value);
}

export function transactionReference(id: string): string {
  if (!isTransactionId(id)) throw new Error("invalid transaction ID");
  return `${TRANSACTION_REFERENCE_PREFIX}${id}`;
}

export function parseTransactionReference(value: string): string {
  if (!value.startsWith(TRANSACTION_REFERENCE_PREFIX)) {
    throw new Error("invalid transaction reference");
  }
  const id = value.slice(TRANSACTION_REFERENCE_PREFIX.length);
  if (!isTransactionId(id) || transactionReference(id) !== value) {
    throw new Error("invalid transaction reference");
  }
  return id;
}

export function isPendingTransaction(state: TransactionState): boolean {
  return state === "planned" || state === "running" || state === "needs_recovery";
}

export function summarizeTransaction(journal: TransactionJournal): TransactionSummary {
  return {
    transactionRef: transactionReference(journal.id),
    operation: journal.operation,
    agents: journal.agents,
    state: journal.state,
    phase: journal.phase,
    direction: journal.direction,
    createdAt: journal.createdAt,
    updatedAt: journal.updatedAt,
    itemCount: journal.itemCount,
    ...(journal.failure === undefined ? {} : { failure: journal.failure }),
  };
}
