import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parsePiSession } from "../../../src/agents/pi/history/session.js";
import { piWorkspaceCarrier } from "../../../src/agents/pi/session-path.js";
import { runCli } from "../../../src/cli/program.js";
import { readScanResult } from "../../support/scan-result.js";

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const INCREMENTAL_ID = "33333333-3333-4333-8333-333333333333";
const PARENT_CWD = "/old-machine/projects/pi-parent";
const CHILD_CWD = "/old-machine/projects/pi-child";
const INCREMENTAL_CWD = "/old-machine/projects/pi-incremental";

function assistant(text: string, timestamp: number) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "fixture-provider",
    model: "gpt-5.4",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function sessionBytes(options: {
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  readonly user: string;
  readonly answer: string;
  readonly timestamp: string;
  readonly parentSession?: string;
  readonly branch?: boolean;
}): string {
  const start = Date.parse(options.timestamp);
  const records: Record<string, unknown>[] = [{
    type: "session",
    version: 3,
    id: options.id,
    timestamp: options.timestamp,
    cwd: options.cwd,
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
  }, {
    type: "session_info",
    id: "aaaaaaaa",
    parentId: null,
    timestamp: options.timestamp,
    name: options.title,
  }, {
    type: "message",
    id: "bbbbbbbb",
    parentId: "aaaaaaaa",
    timestamp: new Date(start + 1_000).toISOString(),
    message: { role: "user", content: [{ type: "text", text: options.user }], timestamp: start + 1_000 },
  }, {
    type: "message",
    id: "cccccccc",
    parentId: "bbbbbbbb",
    timestamp: new Date(start + 2_000).toISOString(),
    message: assistant(options.answer, start + 2_000),
  }];
  if (options.branch) {
    records.push({
      type: "message",
      id: "dddddddd",
      parentId: "bbbbbbbb",
      timestamp: new Date(start + 3_000).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "Use the active Pi branch instead" }],
        timestamp: start + 3_000,
      },
    }, {
      type: "message",
      id: "eeeeeeee",
      parentId: "dddddddd",
      timestamp: new Date(start + 4_000).toISOString(),
      message: assistant("Active Pi branch answer", start + 4_000),
    });
  }
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function bodyAfterHeader(value: string): string {
  return value.slice(value.indexOf("\n") + 1);
}

test("Pi history scans, closes parent exports, and restores transactionally with mapped paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-pi-"));
  try {
    const sourceRoot = path.join(root, "source-sessions");
    const parentCarrier = path.join(sourceRoot, piWorkspaceCarrier(PARENT_CWD));
    const childCarrier = path.join(sourceRoot, piWorkspaceCarrier(CHILD_CWD));
    const incrementalCarrier = path.join(sourceRoot, piWorkspaceCarrier(INCREMENTAL_CWD));
    const state = path.join(root, "state");
    const archive = path.join(root, "pi.agenthist");
    const parentFile = path.join(parentCarrier, `2026-08-16T01-00-00-000Z_${PARENT_ID}.jsonl`);
    const childFile = path.join(childCarrier, `2026-08-16T02-00-00-000Z_${CHILD_ID}.jsonl`);
    const incrementalFile = path.join(
      incrementalCarrier,
      `2026-08-16T03-00-00-000Z_${INCREMENTAL_ID}.jsonl`,
    );
    await mkdir(parentCarrier, { recursive: true });
    await mkdir(childCarrier, { recursive: true });
    const parentBytes = sessionBytes({
      id: PARENT_ID,
      cwd: PARENT_CWD,
      title: "Pi parent session",
      user: "Pi parent searchable marker",
      answer: "Parent answer",
      timestamp: "2026-08-16T01:00:00.000Z",
    });
    const childBytes = sessionBytes({
      id: CHILD_ID,
      cwd: CHILD_CWD,
      title: "Pi child session",
      user: "Pi inactive branch marker",
      answer: "Inactive branch answer",
      timestamp: "2026-08-16T02:00:00.000Z",
      parentSession: parentFile,
      branch: true,
    });
    await writeFile(parentFile, parentBytes, { mode: 0o600 });
    await writeFile(childFile, childBytes, { mode: 0o600 });
    const sourceRuntime = { environment: { HOME: root }, cwd: root, home: root };

    const scanned = await runCli([
      "--json", "--state-dir", state, "--pi-session-dir", sourceRoot,
      "scan", "--agent", "pi",
    ], sourceRuntime);
    assert.equal(scanned.exitCode, 0, scanned.stderr);
    const scanData = readScanResult(scanned.stdout, "pi");
    assert.equal(scanData.sessions, 2);
    assert.equal(scanData.agent.reusedSessions, 0);
    assert.equal(scanData.agent.rebuiltSessions, 2);
    assert.equal(scanData.agent.removedSessions, 0);

    const unchanged = await runCli([
      "--json", "--state-dir", state, "--pi-session-dir", sourceRoot,
      "scan", "--agent", "pi",
    ], sourceRuntime);
    assert.equal(unchanged.exitCode, 0, unchanged.stderr);
    const unchangedAgent = readScanResult(unchanged.stdout, "pi").agent;
    assert.equal(unchangedAgent.reusedSessions, 2);
    assert.equal(unchangedAgent.rebuiltSessions, 0);

    await mkdir(incrementalCarrier, { recursive: true });
    await writeFile(incrementalFile, sessionBytes({
      id: INCREMENTAL_ID,
      cwd: INCREMENTAL_CWD,
      title: "Pi incremental session",
      user: "Pi incremental added marker",
      answer: "Pi incremental initial answer",
      timestamp: "2026-08-16T03:00:00.000Z",
    }), { mode: 0o600 });
    const added = await runCli([
      "--json", "--state-dir", state, "--pi-session-dir", sourceRoot,
      "scan", "--agent", "pi",
    ], sourceRuntime);
    assert.equal(added.exitCode, 0, added.stderr);
    const addedAgent = readScanResult(added.stdout, "pi").agent;
    assert.deepEqual(
      [addedAgent.reusedSessions, addedAgent.rebuiltSessions, addedAgent.removedSessions],
      [2, 1, 0],
    );

    await writeFile(incrementalFile, sessionBytes({
      id: INCREMENTAL_ID,
      cwd: INCREMENTAL_CWD,
      title: "Pi incremental session",
      user: "Pi incremental changed marker",
      answer: "Pi incremental updated answer with changed content",
      timestamp: "2026-08-16T03:00:00.000Z",
    }), { mode: 0o600 });
    const changed = await runCli([
      "--json", "--state-dir", state, "--pi-session-dir", sourceRoot,
      "scan", "--agent", "pi",
    ], sourceRuntime);
    assert.equal(changed.exitCode, 0, changed.stderr);
    const changedAgent = readScanResult(changed.stdout, "pi").agent;
    assert.deepEqual(
      [changedAgent.reusedSessions, changedAgent.rebuiltSessions, changedAgent.removedSessions],
      [2, 1, 0],
    );
    const changedSearch = await runCli([
      "--json", "--state-dir", state, "history", "search", "Pi incremental changed marker",
    ], sourceRuntime);
    assert.equal(changedSearch.exitCode, 0, changedSearch.stderr);
    assert.equal((JSON.parse(changedSearch.stdout) as { data: { total_hits: number } }).data.total_hits, 1);

    await rm(incrementalFile);
    const removed = await runCli([
      "--json", "--state-dir", state, "--pi-session-dir", sourceRoot,
      "scan", "--agent", "pi",
    ], sourceRuntime);
    assert.equal(removed.exitCode, 0, removed.stderr);
    const removedAgent = readScanResult(removed.stdout, "pi").agent;
    assert.deepEqual(
      [removedAgent.reusedSessions, removedAgent.rebuiltSessions, removedAgent.removedSessions],
      [2, 0, 1],
    );
    const removedSearch = await runCli([
      "--json", "--state-dir", state, "history", "search", "Pi incremental changed marker",
    ], sourceRuntime);
    assert.equal(removedSearch.exitCode, 0, removedSearch.stderr);
    assert.equal((JSON.parse(removedSearch.stdout) as { data: { total_hits: number } }).data.total_hits, 0);

    const malformed = path.join(childCarrier, "malformed.jsonl");
    await writeFile(malformed, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-malformed-session",
      timestamp: "2026-08-16T02:30:00.000Z",
      cwd: CHILD_CWD,
    })}\nnot-json\n`, { mode: 0o600 });
    const rejectedScan = await runCli([
      "--json", "--state-dir", state, "--pi-session-dir", sourceRoot,
      "scan", "--agent", "pi",
    ], sourceRuntime);
    assert.equal(rejectedScan.exitCode, 3);
    assert.match(rejectedScan.stdout, /Pi session contains invalid JSON/);
    await rm(malformed);

    const retained = await runCli([
      "--json", "--state-dir", state, "history", "list", "--agent", "pi", "--view", "all",
    ], sourceRuntime);
    assert.equal(retained.exitCode, 0, retained.stderr);
    assert.equal((JSON.parse(retained.stdout) as { data: { total_sessions: number } }).data.total_sessions, 2);

    const searched = await runCli([
      "--json", "--state-dir", state, "history", "search", "inactive branch marker", "--agent", "pi",
    ], sourceRuntime);
    assert.equal(searched.exitCode, 0, searched.stderr);
    assert.equal((JSON.parse(searched.stdout) as { data: { total_hits: number } }).data.total_hits, 1);

    const listed = await runCli([
      "--json", "--state-dir", state, "history", "list", "--agent", "pi", "--view", "all",
    ], sourceRuntime);
    assert.equal(listed.exitCode, 0, listed.stderr);
    const sessions = (JSON.parse(listed.stdout) as {
      data: { sessions: Array<{ session_ref: string; title: string }> };
    }).data.sessions;
    const childRef = sessions.find((session) => session.title === "Pi child session")?.session_ref;
    assert.ok(childRef);

    const exported = await runCli([
      "--json", "--state-dir", state, "export", "--session", childRef, "-o", archive,
    ], sourceRuntime);
    assert.equal(exported.exitCode, 0, exported.stderr);
    assert.equal((JSON.parse(exported.stdout) as { data: { entries: number } }).data.entries, 2);
    const inspected = await runCli(["--json", "inspect", archive], sourceRuntime);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    assert.equal((JSON.parse(inspected.stdout) as { data: { total_entries: number } }).data.total_entries, 2);

    const targetHome = path.join(root, "target-home");
    const targetRoot = path.join(targetHome, ".pi", "agent", "sessions");
    const targetParentCwd = path.join(root, "target-parent-project");
    const targetChildCwd = path.join(root, "target-child-project");
    await mkdir(targetRoot, { recursive: true });
    await mkdir(targetParentCwd, { recursive: true });
    await mkdir(targetChildCwd, { recursive: true });
    const targetRuntime = { environment: { HOME: targetHome }, cwd: root, home: targetHome };
    const importArgs = [
      "--json", "--state-dir", state, "import", archive,
      "--map-path", `${PARENT_CWD}=${targetParentCwd}`,
      "--map-path", `${CHILD_CWD}=${targetChildCwd}`,
    ];
    const dryRun = await runCli([...importArgs, "--dry-run"], targetRuntime);
    assert.equal(dryRun.exitCode, 0, dryRun.stderr);
    assert.equal((JSON.parse(dryRun.stdout) as { data: { new_sessions: number } }).data.new_sessions, 2);
    const applied = await runCli([...importArgs, "--apply"], targetRuntime);
    assert.equal(applied.exitCode, 0, applied.stderr);
    const appliedData = (JSON.parse(applied.stdout) as {
      data: { written: number; agents: Array<{ transaction_ref?: string }> };
    }).data;
    assert.equal(appliedData.written, 2);
    const transactionRef = appliedData.agents[0]?.transaction_ref;
    assert.ok(transactionRef);

    const targetParent = path.join(
      targetRoot,
      piWorkspaceCarrier(targetParentCwd),
      path.basename(parentFile),
    );
    const targetChild = path.join(
      targetRoot,
      piWorkspaceCarrier(targetChildCwd),
      path.basename(childFile),
    );
    const projectedParent = await readFile(targetParent, "utf8");
    const projectedChild = await readFile(targetChild, "utf8");
    assert.equal(bodyAfterHeader(projectedParent), bodyAfterHeader(parentBytes));
    assert.equal(bodyAfterHeader(projectedChild), bodyAfterHeader(childBytes));
    const parsedChild = await parsePiSession(targetChild, "2026-08-16T03:00:00.000Z");
    assert.equal(parsedChild.header.cwd, targetChildCwd);
    assert.equal(parsedChild.header.parentSession, targetParent);
    assert.equal(parsedChild.branchPoints, 1);

    const repeated = await runCli([...importArgs, "--apply"], targetRuntime);
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    const repeatedData = (JSON.parse(repeated.stdout) as {
      data: { written: number; already_present: number };
    }).data;
    assert.equal(repeatedData.written, 0);
    assert.equal(repeatedData.already_present, 2);

    const transactionId = transactionRef.slice("ahtx1_".length);
    const journalPath = path.join(state, "transactions", transactionId, "journal.json");
    const interrupted = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    interrupted.state = "needs_recovery";
    interrupted.phase = "needs_recovery";
    interrupted.failure = "pi.commit_response_lost";
    await writeFile(journalPath, `${JSON.stringify(interrupted, null, 2)}\n`, { mode: 0o600 });
    const recoverDry = await runCli([
      "--json", "--state-dir", state, "transaction", "recover", transactionRef, "--dry-run",
    ], targetRuntime);
    assert.equal(recoverDry.exitCode, 0, recoverDry.stderr);
    assert.equal((JSON.parse(recoverDry.stdout) as { data: { ready: boolean } }).data.ready, true);
    const recovered = await runCli([
      "--json", "--state-dir", state, "transaction", "recover", transactionRef, "--apply",
    ], targetRuntime);
    assert.equal(recovered.exitCode, 0, recovered.stderr);
    assert.equal((JSON.parse(recovered.stdout) as {
      data: { transaction: { state: string } };
    }).data.transaction.state, "committed");

    const rollback = await runCli([
      "--json", "--state-dir", state, "transaction", "rollback", transactionRef, "--apply",
    ], targetRuntime);
    assert.equal(rollback.exitCode, 0, rollback.stderr);
    await assert.rejects(readFile(targetParent), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await assert.rejects(readFile(targetChild), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    const conflictingCwd = path.join(root, "target-conflicting-project");
    const conflictingCarrier = path.join(targetRoot, piWorkspaceCarrier(conflictingCwd));
    const conflictingFile = path.join(conflictingCarrier, `duplicate_${CHILD_ID}.jsonl`);
    await mkdir(conflictingCarrier, { recursive: true });
    await writeFile(conflictingFile, sessionBytes({
      id: CHILD_ID,
      cwd: conflictingCwd,
      title: "Conflicting Pi session",
      user: "Conflicting Pi user",
      answer: "Conflicting Pi answer",
      timestamp: "2026-08-16T04:00:00.000Z",
    }), { mode: 0o600 });
    const conflicted = await runCli([...importArgs, "--dry-run"], targetRuntime);
    assert.equal(conflicted.exitCode, 3);
    assert.match(conflicted.stdout, /target already stores this Pi session at/);
    await assert.rejects(readFile(targetParent), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await assert.rejects(readFile(targetChild), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
