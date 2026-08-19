import type { AgentAdapter, AgentTransactionPreview } from "../agents/contracts.js";
import { agentAdapter } from "../agents/registry.js";
import { AGENTS } from "../domain/agent.js";
import {
  isPendingTransaction,
  parseTransactionReference,
  summarizeTransaction,
  transactionReference,
  type TransactionDirection,
  type TransactionJournal,
  type TransactionState,
  type TransactionSummary,
} from "../domain/transaction.js";
import {
  assertNoPendingTransactions,
  listTransactions,
  loadTransaction,
} from "../infrastructure/transaction-store.js";
import { withStateReadLock, withStateWriteLock } from "../infrastructure/state.js";

export type TransactionAction = "rollback" | "recover";
export type TransactionFindingPosition = "before" | "after" | "unchanged" | "diverged";

export interface NativeTransactionFinding {
  readonly sessionRef: string;
  readonly row: TransactionFindingPosition;
  readonly section?: TransactionFindingPosition;
  readonly file?: TransactionFindingPosition;
  readonly resources?: TransactionFindingPosition;
  readonly goal?: TransactionFindingPosition;
}

export interface NativeTransactionPreview {
  readonly transactionRef: string;
  readonly operation: string;
  readonly state: TransactionState;
  readonly direction: TransactionDirection;
  readonly ready: boolean;
  readonly items: number;
  readonly findings: readonly NativeTransactionFinding[];
}

export interface TransactionActionSummary {
  readonly action: TransactionAction;
  readonly preview: NativeTransactionPreview;
}

export type TransactionActionResult = TransactionActionSummary & (
  | { readonly dryRun: true; readonly transaction?: undefined }
  | { readonly dryRun: false; readonly transaction: TransactionSummary }
);

function publicPreview(preview: AgentTransactionPreview): NativeTransactionPreview {
  return {
    transactionRef: preview.transactionRef,
    operation: preview.operation,
    state: preview.state,
    direction: preview.direction,
    ready: preview.ready,
    items: preview.items,
    findings: preview.findings.map((finding) => ({
      sessionRef: finding.sessionRef,
      row: finding.row,
      ...(finding.section === undefined ? {} : { section: finding.section }),
      ...(finding.file === undefined ? {} : { file: finding.file }),
      ...(finding.resources === undefined ? {} : { resources: finding.resources }),
      ...(finding.goal === undefined ? {} : { goal: finding.goal }),
    })),
  };
}

function transactionAdapter(journal: TransactionJournal): AgentAdapter {
  const matches = AGENTS.map(agentAdapter).filter((adapter) => adapter.transaction.owns(journal));
  if (matches.length !== 1) throw new Error("transaction operation has no unique Agent owner");
  return matches[0]!;
}

function finalizedRecoveryPreview(
  journal: Awaited<ReturnType<typeof loadTransaction>>,
): NativeTransactionPreview | undefined {
  if (journal.state !== "committed" && journal.state !== "rolled_back") return undefined;
  return {
    transactionRef: transactionReference(journal.id),
    operation: journal.operation,
    state: journal.state,
    direction: journal.direction,
    ready: true,
    items: journal.itemCount,
    findings: [],
  };
}

async function publicRecoveryPreview(
  stateDirectory: string,
  journal: Awaited<ReturnType<typeof loadTransaction>>,
): Promise<NativeTransactionPreview> {
  return finalizedRecoveryPreview(journal) ??
    publicPreview(await transactionAdapter(journal).transaction.previewRecovery(stateDirectory, journal));
}

export async function listNativeTransactions(stateDirectory: string): Promise<readonly TransactionSummary[]> {
  return listTransactions(stateDirectory);
}

async function assertOnlyTargetPending(stateDirectory: string, transactionRef: string): Promise<void> {
  const other = (await listTransactions(stateDirectory)).find(
    (item) => isPendingTransaction(item.state) && item.transactionRef !== transactionRef,
  );
  if (other !== undefined) {
    throw new Error(`another unfinished native write transaction requires recovery: ${other.transactionRef}`);
  }
}

export async function rollbackNativeTransaction(
  stateDirectory: string,
  reference: string,
  apply: boolean,
): Promise<TransactionActionResult> {
  const id = parseTransactionReference(reference);
  if (!apply) {
    return withStateReadLock(stateDirectory, async () => {
      const journal = await loadTransaction(stateDirectory, id);
      return {
        action: "rollback",
        dryRun: true,
        preview: publicPreview(await transactionAdapter(journal).transaction.previewRollback(stateDirectory, journal)),
      };
    });
  }
  return withStateWriteLock(stateDirectory, async () => {
    await assertNoPendingTransactions(stateDirectory);
    const journal = await loadTransaction(stateDirectory, id);
    const adapter = transactionAdapter(journal);
    const preview = await adapter.transaction.previewRollback(stateDirectory, journal);
    if (!preview.ready) throw new Error("transaction rollback conflicts with current target history");
    const rolledBack = await adapter.transaction.rollback(stateDirectory, journal);
    return {
      action: "rollback",
      dryRun: false,
      preview: publicPreview(preview),
      transaction: summarizeTransaction(rolledBack),
    };
  });
}

export async function recoverNativeTransaction(
  stateDirectory: string,
  reference: string,
  apply: boolean,
): Promise<TransactionActionResult> {
  const id = parseTransactionReference(reference);
  if (!apply) {
    return withStateReadLock(stateDirectory, async () => {
      const journal = await loadTransaction(stateDirectory, id);
      return {
        action: "recover",
        dryRun: true,
        preview: await publicRecoveryPreview(stateDirectory, journal),
      };
    });
  }
  return withStateWriteLock(stateDirectory, async () => {
    const journal = await loadTransaction(stateDirectory, id);
    if (isPendingTransaction(journal.state)) await assertOnlyTargetPending(stateDirectory, reference);
    const preview = await publicRecoveryPreview(stateDirectory, journal);
    if (!preview.ready) throw new Error("transaction recovery conflicts with current target history");
    if (journal.state === "committed" || journal.state === "rolled_back") {
      return {
        action: "recover",
        dryRun: false,
        preview,
        transaction: summarizeTransaction(journal),
      };
    }
    const recovered = await transactionAdapter(journal).transaction.recover(stateDirectory, journal);
    return {
      action: "recover",
      dryRun: false,
      preview,
      transaction: summarizeTransaction(recovered),
    };
  });
}
