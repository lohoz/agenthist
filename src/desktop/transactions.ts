import {
  listNativeTransactions,
  recoverNativeTransaction,
  rollbackNativeTransaction,
  type NativeTransactionFinding,
  type NativeTransactionPreview,
  type TransactionAction,
  type TransactionActionResult,
} from "../application/index.js";
import { AGENTS, isAgent, type Agent } from "../domain/agent.js";
import { canonicalDigest } from "../domain/history-identity.js";
import { sessionAgent } from "../domain/history.js";
import { parseTransactionReference, type TransactionDirection, type TransactionState, type TransactionSummary } from "../domain/transaction.js";

const MAX_STATE_DIRECTORY_BYTES = 64 * 1024;
const MAX_TRANSACTIONS = 10_000;
const MAX_FINDINGS = 1_000_000;
const PLAN_REFERENCE = /^ahtxplan1_[0-9a-f]{64}$/;
const POSITIONS = new Set(["before", "after", "unchanged", "diverged"] as const);
const STATES = new Set<TransactionState>([
  "planned", "running", "committed", "rolled_back", "failed", "needs_recovery",
]);

export interface DesktopTransactionSummary {
  readonly transactionRef: string;
  readonly operation: string;
  readonly agents: readonly Agent[];
  readonly state: TransactionState;
  readonly phase: string;
  readonly direction: TransactionDirection;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: number;
  readonly failure?: string;
}

export interface DesktopTransactionPlan {
  readonly planRef: string;
  readonly summary: DesktopTransactionSummary;
  readonly action: TransactionAction;
  readonly ready: boolean;
  readonly findings: readonly NativeTransactionFinding[];
}

export interface ListDesktopTransactionsOptions {
  readonly stateDirectory: string;
}

export interface PlanDesktopTransactionOptions extends ListDesktopTransactionsOptions {
  readonly transactionRef: string;
  readonly action: TransactionAction;
}

export interface ConfirmDesktopTransactionOptions extends PlanDesktopTransactionOptions {
  readonly expectedPlanRef: string;
}

export type DesktopTransactionConfirmation =
  | { readonly status: "replan_required"; readonly plan: DesktopTransactionPlan }
  | { readonly status: "blocked"; readonly plan: DesktopTransactionPlan }
  | {
      readonly status: "completed";
      readonly plan: DesktopTransactionPlan;
      readonly summary: DesktopTransactionSummary;
    };

export interface DesktopTransactionDependencies {
  readonly listNativeTransactions: (stateDirectory: string) => Promise<readonly TransactionSummary[]>;
  readonly rollbackNativeTransaction: (
    stateDirectory: string,
    transactionRef: string,
    apply: boolean,
  ) => Promise<TransactionActionResult>;
  readonly recoverNativeTransaction: (
    stateDirectory: string,
    transactionRef: string,
    apply: boolean,
  ) => Promise<TransactionActionResult>;
}

const DEFAULT_DEPENDENCIES: DesktopTransactionDependencies = {
  listNativeTransactions,
  rollbackNativeTransaction,
  recoverNativeTransaction,
};

function dependencies(overrides: Partial<DesktopTransactionDependencies> | undefined): DesktopTransactionDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown !== undefined) throw new Error(`${label} has an unknown field: ${unknown}`);
}

function stateDirectory(value: string): string {
  if (
    typeof value !== "string" || value === "" || /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_STATE_DIRECTORY_BYTES
  ) throw new Error("desktop transaction state directory is invalid");
  return value;
}

function action(value: TransactionAction): TransactionAction {
  if (value !== "rollback" && value !== "recover") throw new Error("desktop transaction action is invalid");
  return value;
}

function transactionRef(value: string): string {
  if (typeof value !== "string") throw new Error("desktop transaction reference is invalid");
  parseTransactionReference(value);
  return value;
}

function timestamp(value: string, label: string): string {
  if (typeof value !== "string" || value === "" || value.length > 128 || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function count(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_FINDINGS) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function summary(value: TransactionSummary): DesktopTransactionSummary {
  transactionRef(value.transactionRef);
  if (typeof value.operation !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value.operation)) {
    throw new Error("desktop transaction operation is invalid");
  }
  if (
    !Array.isArray(value.agents) || value.agents.length === 0 || value.agents.length > AGENTS.length ||
    value.agents.some((agent) => !isAgent(agent)) || new Set(value.agents).size !== value.agents.length
  ) throw new Error("desktop transaction Agents are invalid");
  if (!STATES.has(value.state)) throw new Error("desktop transaction state is invalid");
  if (value.direction !== "forward" && value.direction !== "rollback") {
    throw new Error("desktop transaction direction is invalid");
  }
  if (typeof value.phase !== "string" || value.phase === "" || value.phase.length > 128) {
    throw new Error("desktop transaction phase is invalid");
  }
  if (value.failure !== undefined && (
    typeof value.failure !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/.test(value.failure)
  )) throw new Error("desktop transaction failure is invalid");
  return {
    transactionRef: value.transactionRef,
    operation: value.operation,
    agents: [...value.agents],
    state: value.state,
    phase: value.phase,
    direction: value.direction,
    createdAt: timestamp(value.createdAt, "desktop transaction creation timestamp"),
    updatedAt: timestamp(value.updatedAt, "desktop transaction update timestamp"),
    items: count(value.itemCount, "desktop transaction item count", 1),
    ...(value.failure === undefined ? {} : { failure: value.failure }),
  };
}

function finding(value: NativeTransactionFinding): NativeTransactionFinding {
  if (
    typeof value.sessionRef !== "string" || value.sessionRef.length > 256 ||
    sessionAgent(value.sessionRef) === undefined
  ) {
    throw new Error("desktop transaction finding session reference is invalid");
  }
  for (const [label, position] of [
    ["row", value.row],
    ["section", value.section],
    ["file", value.file],
    ["resources", value.resources],
    ["goal", value.goal],
  ] as const) {
    if (position !== undefined && !POSITIONS.has(position)) {
      throw new Error(`desktop transaction finding ${label} position is invalid`);
    }
  }
  return {
    sessionRef: value.sessionRef,
    row: value.row,
    ...(value.section === undefined ? {} : { section: value.section }),
    ...(value.file === undefined ? {} : { file: value.file }),
    ...(value.resources === undefined ? {} : { resources: value.resources }),
    ...(value.goal === undefined ? {} : { goal: value.goal }),
  };
}

function validatedPreview(
  value: NativeTransactionPreview,
  expectedSummary: DesktopTransactionSummary,
  selectedAction: TransactionAction,
): { readonly ready: boolean; readonly findings: readonly NativeTransactionFinding[] } {
  const expectedDirection = selectedAction === "rollback" ? "rollback" : expectedSummary.direction;
  if (
    value.transactionRef !== expectedSummary.transactionRef || value.operation !== expectedSummary.operation ||
    value.state !== expectedSummary.state || value.direction !== expectedDirection ||
    value.items !== expectedSummary.items || typeof value.ready !== "boolean" ||
    !Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS
  ) throw new Error("desktop transaction preview is inconsistent with its current summary");
  return { ready: value.ready, findings: value.findings.map(finding) };
}

function plan(
  selectedAction: TransactionAction,
  currentSummary: DesktopTransactionSummary,
  preview: NativeTransactionPreview,
): DesktopTransactionPlan {
  const validated = validatedPreview(preview, currentSummary, selectedAction);
  const identity = {
    action: selectedAction,
    summary: currentSummary,
    preview: {
      transactionRef: preview.transactionRef,
      operation: preview.operation,
      state: preview.state,
      direction: preview.direction,
      ready: validated.ready,
      items: preview.items,
      findings: validated.findings,
    },
  };
  return {
    planRef: `ahtxplan1_${canonicalDigest(identity)}`,
    summary: currentSummary,
    action: selectedAction,
    ready: validated.ready,
    findings: validated.findings,
  };
}

function validateListOptions(options: ListDesktopTransactionsOptions): string {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("desktop transaction list options are invalid");
  }
  exactKeys(options, ["stateDirectory"], "desktop transaction list options");
  return stateDirectory(options.stateDirectory);
}

function validatePlanOptions(options: PlanDesktopTransactionOptions): {
  readonly stateDirectory: string;
  readonly transactionRef: string;
  readonly action: TransactionAction;
} {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("desktop transaction plan options are invalid");
  }
  exactKeys(options, ["stateDirectory", "transactionRef", "action"], "desktop transaction plan options");
  return {
    stateDirectory: stateDirectory(options.stateDirectory),
    transactionRef: transactionRef(options.transactionRef),
    action: action(options.action),
  };
}

async function summaries(
  selectedStateDirectory: string,
  deps: DesktopTransactionDependencies,
): Promise<DesktopTransactionSummary[]> {
  const listed = await deps.listNativeTransactions(selectedStateDirectory);
  if (!Array.isArray(listed) || listed.length > MAX_TRANSACTIONS) {
    throw new Error("desktop transaction list exceeds supported limits");
  }
  const values = listed.map(summary);
  if (new Set(values.map((item) => item.transactionRef)).size !== values.length) {
    throw new Error("desktop transaction list contains duplicate references");
  }
  return values.toSorted((left, right) =>
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.transactionRef.localeCompare(left.transactionRef));
}

export async function listDesktopTransactions(
  options: ListDesktopTransactionsOptions,
  overrides?: Partial<DesktopTransactionDependencies>,
): Promise<readonly DesktopTransactionSummary[]> {
  const deps = dependencies(overrides);
  return summaries(validateListOptions(options), deps);
}

async function dryRun(
  options: ReturnType<typeof validatePlanOptions>,
  deps: DesktopTransactionDependencies,
): Promise<TransactionActionResult> {
  return options.action === "rollback"
    ? deps.rollbackNativeTransaction(options.stateDirectory, options.transactionRef, false)
    : deps.recoverNativeTransaction(options.stateDirectory, options.transactionRef, false);
}

async function apply(
  options: ReturnType<typeof validatePlanOptions>,
  deps: DesktopTransactionDependencies,
): Promise<TransactionActionResult> {
  return options.action === "rollback"
    ? deps.rollbackNativeTransaction(options.stateDirectory, options.transactionRef, true)
    : deps.recoverNativeTransaction(options.stateDirectory, options.transactionRef, true);
}

export async function planDesktopTransaction(
  rawOptions: PlanDesktopTransactionOptions,
  overrides?: Partial<DesktopTransactionDependencies>,
): Promise<DesktopTransactionPlan> {
  const options = validatePlanOptions(rawOptions);
  const deps = dependencies(overrides);
  const result = await dryRun(options, deps);
  if (result.action !== options.action || result.dryRun !== true || result.transaction !== undefined) {
    throw new Error("desktop transaction planning did not return a dry-run result");
  }
  const current = (await summaries(options.stateDirectory, deps))
    .find((item) => item.transactionRef === options.transactionRef);
  if (current === undefined) throw new Error("desktop transaction was not found after preview");
  return plan(options.action, current, result.preview);
}

export async function confirmDesktopTransaction(
  rawOptions: ConfirmDesktopTransactionOptions,
  overrides?: Partial<DesktopTransactionDependencies>,
): Promise<DesktopTransactionConfirmation> {
  if (rawOptions === null || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw new Error("desktop transaction confirmation options are invalid");
  }
  exactKeys(
    rawOptions,
    ["stateDirectory", "transactionRef", "action", "expectedPlanRef"],
    "desktop transaction confirmation options",
  );
  if (typeof rawOptions.expectedPlanRef !== "string" || !PLAN_REFERENCE.test(rawOptions.expectedPlanRef)) {
    throw new Error("desktop transaction plan reference is invalid");
  }
  const options = validatePlanOptions({
    stateDirectory: rawOptions.stateDirectory,
    transactionRef: rawOptions.transactionRef,
    action: rawOptions.action,
  });
  const deps = dependencies(overrides);
  const current = await planDesktopTransaction(options, deps);
  if (current.planRef !== rawOptions.expectedPlanRef) return { status: "replan_required", plan: current };
  if (!current.ready) return { status: "blocked", plan: current };
  const result = await apply(options, deps);
  const expectedPreviewDirection = options.action === "rollback" ? "rollback" : current.summary.direction;
  const finalStateValid = options.action === "rollback"
    ? result.transaction?.state === "rolled_back"
    : result.transaction?.state === "committed" || result.transaction?.state === "rolled_back";
  if (
    result.action !== options.action || result.dryRun !== false || result.transaction === undefined ||
    result.transaction.transactionRef !== options.transactionRef || !finalStateValid ||
    result.preview.transactionRef !== options.transactionRef ||
    result.preview.operation !== current.summary.operation || result.preview.state !== current.summary.state ||
    result.preview.direction !== expectedPreviewDirection || result.preview.ready !== true
  ) throw new Error("desktop transaction apply returned an invalid result");
  const completed = summary(result.transaction);
  if (completed.operation !== current.summary.operation) {
    throw new Error("desktop transaction apply changed its operation");
  }
  return { status: "completed", plan: current, summary: completed };
}
