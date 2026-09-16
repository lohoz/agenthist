import assert from "node:assert/strict";
import test from "node:test";

import type {
  NativeTransactionPreview,
  TransactionActionResult,
} from "../../../src/application/index.js";
import type { Agent } from "../../../src/domain/agent.js";
import type { TransactionState, TransactionSummary } from "../../../src/domain/transaction.js";
import {
  confirmDesktopTransaction,
  listDesktopTransactions,
  planDesktopTransaction,
  type DesktopTransactionDependencies,
} from "../../../src/desktop/transactions.js";

const TRANSACTION_REF = "ahtx1_00000000-0000-4000-8000-000000000001";
const OTHER_TRANSACTION_REF = "ahtx1_00000000-0000-4000-8000-000000000002";
const SESSION_REF = `ahsr1_codex_ck1_${"1".repeat(64)}`;

function transaction(
  reference = TRANSACTION_REF,
  state: TransactionState = "committed",
  updatedAt = "2026-09-04T01:00:00.000Z",
): TransactionSummary {
  const terminal = state === "rolled_back"
    ? { phase: "rolled_back", direction: "rollback" as const }
    : state === "committed"
      ? { phase: "committed", direction: "forward" as const }
      : state === "needs_recovery"
        ? { phase: "needs_recovery", direction: "forward" as const, failure: "fixture_interrupted" }
        : { phase: state, direction: "forward" as const };
  return {
    transactionRef: reference,
    operation: "history_import",
    agents: ["codex"],
    state,
    ...terminal,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt,
    itemCount: 2,
  };
}

function preview(
  current: TransactionSummary,
  action: "rollback" | "recover",
  ready = true,
  position: "before" | "after" | "unchanged" | "diverged" = "after",
): TransactionActionResult {
  const value: NativeTransactionPreview = {
    transactionRef: current.transactionRef,
    operation: current.operation,
    state: current.state,
    direction: action === "rollback" ? "rollback" : current.direction,
    ready,
    items: current.itemCount,
    findings: [{ sessionRef: SESSION_REF, row: position, file: position }],
  };
  return { action, dryRun: true, preview: value };
}

function applied(current: TransactionSummary, action: "rollback" | "recover"): TransactionActionResult {
  const final = transaction(
    current.transactionRef,
    action === "rollback" ? "rolled_back" : "committed",
    "2026-09-04T02:00:00.000Z",
  );
  return {
    action,
    dryRun: false,
    preview: {
      transactionRef: current.transactionRef,
      operation: current.operation,
      state: current.state,
      direction: action === "rollback" ? "rollback" : current.direction,
      ready: true,
      items: current.itemCount,
      findings: [{ sessionRef: SESSION_REF, row: "after", file: "after" }],
    },
    transaction: final,
  };
}

function deps(
  current: () => TransactionSummary,
  overrides: Partial<DesktopTransactionDependencies> = {},
): DesktopTransactionDependencies {
  return {
    async listNativeTransactions() { return [current()]; },
    async rollbackNativeTransaction(_state, _reference, apply) {
      return apply ? applied(current(), "rollback") : preview(current(), "rollback");
    },
    async recoverNativeTransaction(_state, _reference, apply) {
      return apply ? applied(current(), "recover") : preview(current(), "recover");
    },
    ...overrides,
  };
}

test("desktop transaction list validates and sorts current summaries by update time", async () => {
  const older = transaction(TRANSACTION_REF, "committed", "2026-09-04T01:00:00.000Z");
  const newer = transaction(OTHER_TRANSACTION_REF, "needs_recovery", "2026-09-04T03:00:00.000Z");
  const dependencies = deps(() => older, {
    async listNativeTransactions() { return [older, newer]; },
  });
  const listed = await listDesktopTransactions({ stateDirectory: "C:\\状态 空格" }, dependencies);
  assert.deepEqual(listed.map((item) => item.transactionRef), [OTHER_TRANSACTION_REF, TRANSACTION_REF]);
  assert.equal(listed[0]!.failure, "fixture_interrupted");
  assert.equal(listed[0]!.items, 2);
});

test("rollback confirmation performs two dry-runs before one authoritative apply", async () => {
  let current = transaction();
  const calls: boolean[] = [];
  const dependencies = deps(() => current, {
    async rollbackNativeTransaction(_state, reference, apply) {
      assert.equal(reference, TRANSACTION_REF);
      calls.push(apply);
      if (!apply) return preview(current, "rollback");
      const result = applied(current, "rollback");
      current = result.transaction!;
      return result;
    },
  });
  const options = {
    stateDirectory: "C:\\状态 空格",
    transactionRef: TRANSACTION_REF,
    action: "rollback" as const,
  };
  const planned = await planDesktopTransaction(options, dependencies);
  assert.equal(planned.action, "rollback");
  assert.equal(planned.ready, true);
  assert.equal(planned.findings[0]!.row, "after");
  const confirmed = await confirmDesktopTransaction({ ...options, expectedPlanRef: planned.planRef }, dependencies);
  assert.equal(confirmed.status, "completed");
  if (confirmed.status !== "completed") return;
  assert.equal(confirmed.summary.state, "rolled_back");
  assert.equal(confirmed.summary.direction, "rollback");
  assert.deepEqual(calls, [false, false, true]);
});

test("recovery confirms a pending journal only through the existing recovery API", async () => {
  let current = transaction(TRANSACTION_REF, "needs_recovery");
  const calls: boolean[] = [];
  const dependencies = deps(() => current, {
    async recoverNativeTransaction(_state, _reference, apply) {
      calls.push(apply);
      if (!apply) return preview(current, "recover", true, "before");
      const result = applied(current, "recover");
      current = result.transaction!;
      return result;
    },
  });
  const options = {
    stateDirectory: "C:\\AgentHist",
    transactionRef: TRANSACTION_REF,
    action: "recover" as const,
  };
  const planned = await planDesktopTransaction(options, dependencies);
  assert.equal(planned.summary.state, "needs_recovery");
  assert.equal(planned.summary.failure, "fixture_interrupted");
  const confirmed = await confirmDesktopTransaction({ ...options, expectedPlanRef: planned.planRef }, dependencies);
  assert.equal(confirmed.status, "completed");
  if (confirmed.status !== "completed") return;
  assert.equal(confirmed.summary.state, "committed");
  assert.deepEqual(calls, [false, false, true]);
});

test("a non-ready transaction remains blocked and never applies", async () => {
  const current = transaction();
  let applyCalls = 0;
  const dependencies = deps(() => current, {
    async rollbackNativeTransaction(_state, _reference, apply) {
      if (apply) applyCalls++;
      return preview(current, "rollback", false, "diverged");
    },
  });
  const options = {
    stateDirectory: "C:\\AgentHist",
    transactionRef: TRANSACTION_REF,
    action: "rollback" as const,
  };
  const planned = await planDesktopTransaction(options, dependencies);
  assert.equal(planned.ready, false);
  const confirmed = await confirmDesktopTransaction({ ...options, expectedPlanRef: planned.planRef }, dependencies);
  assert.equal(confirmed.status, "blocked");
  assert.equal(confirmed.plan.findings[0]!.row, "diverged");
  assert.equal(applyCalls, 0);
});

test("preview changes force replan_required without applying", async () => {
  const current = transaction();
  let dryRuns = 0;
  let applyCalls = 0;
  const dependencies = deps(() => current, {
    async rollbackNativeTransaction(_state, _reference, apply) {
      if (apply) {
        applyCalls++;
        return applied(current, "rollback");
      }
      dryRuns++;
      return preview(current, "rollback", true, dryRuns === 1 ? "after" : "diverged");
    },
  });
  const options = {
    stateDirectory: "C:\\AgentHist",
    transactionRef: TRANSACTION_REF,
    action: "rollback" as const,
  };
  const planned = await planDesktopTransaction(options, dependencies);
  const confirmed = await confirmDesktopTransaction({ ...options, expectedPlanRef: planned.planRef }, dependencies);
  assert.equal(confirmed.status, "replan_required");
  assert.notEqual(confirmed.plan.planRef, planned.planRef);
  assert.equal(confirmed.plan.findings[0]!.row, "diverged");
  assert.equal(applyCalls, 0);
});

test("transaction orchestration rejects malformed inputs and inconsistent core results", async () => {
  const current = transaction();
  const dependencies = deps(() => current);
  await assert.rejects(planDesktopTransaction({
    stateDirectory: "C:\\AgentHist",
    transactionRef: "not-a-transaction",
    action: "rollback",
  }, dependencies), /transaction reference/);
  await assert.rejects(planDesktopTransaction({
    stateDirectory: "C:\\AgentHist",
    transactionRef: TRANSACTION_REF,
    action: "invalid" as "rollback",
  }, dependencies), /action is invalid/);
  await assert.rejects(planDesktopTransaction({
    stateDirectory: "C:\\AgentHist",
    transactionRef: TRANSACTION_REF,
    action: "rollback",
    extra: true,
  } as never, dependencies), /unknown field/);

  const inconsistent = deps(() => current, {
    async rollbackNativeTransaction() {
      return preview(current, "recover") as TransactionActionResult;
    },
  });
  await assert.rejects(planDesktopTransaction({
    stateDirectory: "C:\\AgentHist",
    transactionRef: TRANSACTION_REF,
    action: "rollback",
  }, inconsistent), /did not return a dry-run/);

  const pendingConflict = deps(() => current, {
    async rollbackNativeTransaction(_state, _reference, apply) {
      if (!apply) return preview(current, "rollback");
      throw new Error("another unfinished native write transaction requires recovery");
    },
  });
  const plan = await planDesktopTransaction({
    stateDirectory: "C:\\AgentHist",
    transactionRef: TRANSACTION_REF,
    action: "rollback",
  }, pendingConflict);
  await assert.rejects(confirmDesktopTransaction({
    stateDirectory: "C:\\AgentHist",
    transactionRef: TRANSACTION_REF,
    action: "rollback",
    expectedPlanRef: plan.planRef,
  }, pendingConflict), /unfinished native write transaction/);
});
