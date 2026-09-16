import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentSnapshot, StoredSession } from "../../../src/domain/history.js";
import { historyHeadMatchesSnapshot } from "../../../src/infrastructure/history-store.js";

const EXPECTED_ID = "10000000-0000-4000-8000-000000000001";
const CURRENT_ID = "10000000-0000-4000-8000-000000000002";

function session(title = "Equivalent conversation"): StoredSession {
  return {
    sessionRef: `ahsr1_codex_ck1_${"a".repeat(64)}`,
    agent: "codex",
    nativeId: "20000000-0000-4000-8000-000000000001",
    title,
    context: "C:\\workspace",
    model: "fixture-model",
    provider: "fixture-provider",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:01:00.000Z",
    nativeArchived: false,
    library: { name: "", tags: [], archived: false, deleted: false },
    conversation: [{
      kind: "message",
      role: "user",
      text: "hello",
      timestamp: "2026-09-04T00:00:00.000Z",
    }],
    searchText: ["hello"],
    rawFiles: [],
    native: {},
    scan: { fingerprint: "same-native-source" },
  };
}

function snapshot(snapshotId: string, title = "Equivalent conversation"): AgentSnapshot {
  return {
    schemaVersion: "agenthist.history-snapshot/v2",
    snapshotId,
    agent: "codex",
    scannedAt: snapshotId === EXPECTED_ID ? "2026-09-04T00:02:00.000Z" : "2026-09-04T00:03:00.000Z",
    sessions: [session(title)],
    auxiliaryFiles: [],
    warnings: [],
    scan: {
      sourceKey: "same-source",
      reusedSessions: snapshotId === EXPECTED_ID ? 0 : 1,
      rebuiltSessions: snapshotId === EXPECTED_ID ? 1 : 0,
      removedSessions: 0,
    },
  };
}

async function writeSnapshot(stateDirectory: string, value: AgentSnapshot): Promise<void> {
  const directory = path.join(stateDirectory, "history", "codex", "snapshots", value.snapshotId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.json"), `${JSON.stringify(value)}\n`, "utf8");
}

async function selectHead(stateDirectory: string, snapshotId: string): Promise<void> {
  const root = path.join(stateDirectory, "history", "codex");
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "head.json"),
    `${JSON.stringify({ schemaVersion: "agenthist.history-head/v1", snapshotId })}\n`,
    "utf8",
  );
}

test("history head equivalence ignores only publication metadata and detects content changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-history-equivalence-"));
  try {
    await writeSnapshot(root, snapshot(EXPECTED_ID));
    await writeSnapshot(root, snapshot(CURRENT_ID));
    await selectHead(root, CURRENT_ID);
    assert.equal(await historyHeadMatchesSnapshot(root, "codex", EXPECTED_ID), true);

    await writeSnapshot(root, snapshot(CURRENT_ID, "Actually changed conversation"));
    assert.equal(await historyHeadMatchesSnapshot(root, "codex", EXPECTED_ID), false);

    await selectHead(root, EXPECTED_ID);
    assert.equal(await historyHeadMatchesSnapshot(root, "codex", EXPECTED_ID), true);
    await assert.rejects(
      historyHeadMatchesSnapshot(root, "codex", "not-a-snapshot"),
      /snapshot identity/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
