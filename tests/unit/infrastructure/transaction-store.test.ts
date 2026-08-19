import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { transactionReference, type TransactionJournal } from "../../../src/domain/transaction.js";
import {
  newTransactionId,
  recoveryRequiredError,
} from "../../../src/infrastructure/transaction-store.js";

test("recovery errors retain the transaction reference when journal publication also fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-transaction-fault-"));
  try {
    const id = newTransactionId();
    const now = new Date().toISOString();
    const journal: TransactionJournal = {
      schemaVersion: "agenthist.transaction/v1",
      id,
      operation: "history_import",
      agents: ["codex"],
      state: "running",
      phase: "applying_native",
      direction: "forward",
      createdAt: now,
      updatedAt: now,
      itemCount: 1,
      payload: null,
    };
    const transactionPath = path.join(root, "transactions", id);
    await mkdir(path.dirname(transactionPath), { recursive: true });
    await writeFile(transactionPath, "not a transaction directory\n");

    const nativeFailure = new Error("native write failed");
    const error = await recoveryRequiredError(
      root,
      journal,
      "codex.forward_interrupted",
      "Codex transaction requires recovery",
      nativeFailure,
    );

    assert.equal(
      error.message,
      `Codex transaction requires recovery: ${transactionReference(id)} (recovery journal update failed)`,
    );
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 2);
    assert.equal(error.cause.errors[0], nativeFailure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
