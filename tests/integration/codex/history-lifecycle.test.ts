import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseCodexRollout } from "../../../src/agents/codex/history/rollout.js";
import { codexSessionRef } from "../../../src/agents/codex/identity.js";
import { runCli, type CliRuntime } from "../../../src/cli/program.js";
import { readScanResult } from "../../support/scan-result.js";

const activeId = "abcdef01-2345-4abc-8def-0123456789ab";
const archivedId = "abcdef01-2345-4abc-8def-0123456789ac";
const missingRolloutId = "abcdef01-2345-4abc-8def-0123456789ad";
const copiedChildId = "abcdef01-2345-4abc-8def-0123456789ae";
const incrementalId = "abcdef01-2345-4abc-8def-0123456789af";
const sectionId = "01984de2-8f74-7c91-a3b2-5c5e937cf399";
const CODEX_STATE_STORE = "thread-history.sqlite";
const CODEX_GOAL_STORE = "thread-goals.sqlite";

function rollout(
  id: string,
  question: string,
  answer: string,
  cwd = "/work/agenthist",
  dynamicTools: readonly unknown[] = [],
  metadata: Readonly<Record<string, unknown>> = {},
): string {
  const paginated = metadata.history_mode === "paginated";
  const historyBase = metadata.history_base;
  const historyBaseOrdinal = historyBase !== null && typeof historyBase === "object" && !Array.isArray(historyBase)
    ? (historyBase as Record<string, unknown>).end_ordinal_exclusive
    : undefined;
  const startOrdinal = typeof historyBaseOrdinal === "number" ? historyBaseOrdinal : 0;
  return [
    JSON.stringify({
      timestamp: "2026-08-09T01:00:00Z",
      type: "session_meta",
      ...(paginated ? { ordinal: startOrdinal } : {}),
      payload: {
        session_id: id,
        id,
        timestamp: "2026-08-09T01:00:00Z",
        cwd,
        originator: "codex_cli_rs",
        cli_version: "9.7.3-format-compatible",
        model_provider: "test-provider",
        model: "gpt-5.4",
        ...(dynamicTools.length === 0 ? {} : { dynamic_tools: dynamicTools }),
        ...metadata,
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-09T01:00:01Z",
      type: "response_item",
      ...(paginated ? { ordinal: startOrdinal + 1 } : {}),
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: question }] },
    }),
    JSON.stringify({
      timestamp: "2026-08-09T01:00:02Z",
      type: "response_item",
      ...(paginated ? { ordinal: startOrdinal + 2 } : {}),
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] },
    }),
    "",
  ].join("\n");
}

function copiedSubagentRollout(): string {
  const records = [{
    timestamp: "2026-08-09T03:00:00.000Z",
    type: "session_meta",
    payload: {
      session_id: archivedId,
      id: copiedChildId,
      forked_from_id: archivedId,
      parent_thread_id: archivedId,
      timestamp: "2026-08-09T03:00:00.000Z",
      cwd: "/work/copied-child",
      originator: "codex_cli_rs",
      cli_version: "capability-shaped-fixture",
      model_provider: "receiver-provider",
      model: "gpt-5.4",
      history_mode: "paginated",
      subagent_history_start_ordinal: 4,
    },
  }, {
    timestamp: "2026-08-09T03:00:00.100Z",
    type: "session_meta",
    payload: {
      session_id: archivedId,
      id: archivedId,
      timestamp: "2026-08-09T01:00:00Z",
      cwd: "/work/archive",
      originator: "codex_cli_rs",
      cli_version: "capability-shaped-fixture",
      model_provider: "receiver-provider",
      model: "gpt-5.4",
      history_mode: "paginated",
    },
  }, {
    timestamp: "2026-08-09T03:00:00.200Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Archived question" }],
    },
  }, {
    timestamp: "2026-08-09T03:00:00.300Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Archived answer" }],
    },
  }, {
    timestamp: "2026-08-09T03:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Copied child question" }],
    },
  }, {
    timestamp: "2026-08-09T03:00:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Copied child answer" }],
    },
  }];
  return `${records.map((record, ordinal) => JSON.stringify({ ...record, ordinal })).join("\n")}\n`;
}

interface MutationData {
  readonly changed: boolean;
  readonly before: { readonly state: string; readonly name: string; readonly tags: readonly string[] };
  readonly after: {
    readonly state: string;
    readonly name: string;
    readonly tags: readonly string[];
    readonly restore_state?: string;
  };
}

interface DynamicToolState {
  readonly position: number;
  readonly name: string;
  readonly description: string;
  readonly input_schema: string;
  readonly defer_loading: number;
  readonly namespace: string | null;
}

interface SpawnEdgeState {
  readonly parent_thread_id: string;
  readonly child_thread_id: string;
  readonly status: string;
}

interface GoalState {
  readonly goal_id: string;
  readonly objective: string;
  readonly status: string;
  readonly token_budget: number | null;
  readonly tokens_used: number;
  readonly time_used_seconds: number;
  readonly continuation_deferred: boolean;
}

interface SectionState {
  readonly id: string;
  readonly name: string;
  readonly appearance: string | null;
}

function dynamicToolState(databasePath: string, threadId: string): DynamicToolState | undefined {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT position, name, description, input_schema, defer_loading, namespace
      FROM thread_dynamic_tools
      WHERE thread_id = ?
    `).get(threadId) as DynamicToolState | undefined;
  } finally {
    database.close();
  }
}

function spawnEdgeState(databasePath: string, threadId: string): SpawnEdgeState | undefined {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      "SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges WHERE child_thread_id = ?",
    ).get(threadId) as SpawnEdgeState | undefined;
    return row === undefined ? undefined : { ...row };
  } finally {
    database.close();
  }
}

function goalState(databasePath: string, threadId: string): GoalState | undefined {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT goal_id, objective, status, token_budget, tokens_used, time_used_seconds
      FROM thread_goals
      WHERE thread_id = ?
    `).get(threadId) as Omit<GoalState, "continuation_deferred"> | undefined;
    if (row === undefined) return undefined;
    const deferred = database.prepare(
      "SELECT 1 AS present FROM thread_goal_continuation_deferrals WHERE thread_id = ?",
    ).get(threadId) !== undefined;
    return { ...row, continuation_deferred: deferred };
  } finally {
    database.close();
  }
}

function sectionState(databasePath: string, id: string): SectionState | undefined {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("SELECT id, name, appearance FROM thread_sections WHERE id = ?").get(id) as
      | SectionState
      | undefined;
    return row === undefined ? undefined : { ...row };
  } finally {
    database.close();
  }
}

async function assertLineageBoundary(childPath: string, basePath: string): Promise<void> {
  const child = await parseCodexRollout(childPath);
  assert.equal(child.sessionId, archivedId);
  assert.equal(child.subagentHistoryStartOrdinal, undefined);
  assert.equal(child.historyBase?.threadId, archivedId);
  assert.equal(child.historyBase?.endByteOffset, (await readFile(basePath)).byteLength);
}

async function assertImportedCopiedSubagent(childPath: string, provider: string, expectedCwd: string): Promise<void> {
  const parsed = await parseCodexRollout(childPath);
  assert.equal(parsed.sessionId, archivedId);
  assert.equal(parsed.parentThreadId, archivedId);
  assert.equal(parsed.subagentHistoryStartOrdinal, 4);
  const visible = JSON.stringify(parsed.conversation);
  const portable = JSON.stringify(parsed.portableConversation);
  assert.doesNotMatch(visible, /Archived question|Archived answer/);
  assert.match(visible, /Copied child question/);
  assert.match(portable, /Archived question/);
  assert.match(portable, /Copied child question/);

  const metadata = (await readFile(childPath, "utf8")).trimEnd().split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
    .filter((record) => record.type === "session_meta");
  assert.equal(metadata.length, 2);
  assert.equal(metadata[0]!.payload.id, copiedChildId);
  assert.equal(metadata[0]!.payload.session_id, archivedId);
  assert.equal(metadata[0]!.payload.model_provider, provider);
  assert.equal(metadata[0]!.payload.cwd, expectedCwd);
  assert.equal(metadata[1]!.payload.id, archivedId);
  assert.equal(metadata[1]!.payload.model_provider, "receiver-provider");
  assert.equal(metadata[1]!.payload.cwd, "/work/archive");
}

async function mutate(
  state: string,
  runtime: CliRuntime,
  action: string,
  reference: string,
  ...args: string[]
): Promise<MutationData> {
  const result = await runCli([
    "--json", "--state-dir", state, "history", action, reference, ...args,
  ], runtime);
  assert.equal(result.exitCode, 0, result.stderr);
  return (JSON.parse(result.stdout) as { data: MutationData }).data;
}

test("Codex scan remains listable, searchable, and readable after the native source is removed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-ts-codex-"));
  const home = path.join(root, "codex-home");
  const sqliteHome = path.join(root, "sqlite-home");
  const state = path.join(root, "state");
  try {
    const activeRelative = path.join(
      "sessions",
      "2026",
      "08",
      "09",
      `rollout-2026-08-09T01-00-00-${activeId}.jsonl`,
    );
    const archivedRelative = path.join(
      "archived_sessions",
      `rollout-2026-08-09T02-00-00-${archivedId}.jsonl`,
    );
    const copiedChildRelative = path.join(
      "sessions",
      "2026",
      "08",
      "09",
      `rollout-2026-08-09T03-00-00-${copiedChildId}.jsonl`,
    );
    const incrementalRelative = path.join(
      "sessions",
      "2026",
      "08",
      "09",
      `rollout-2026-08-09T04-00-00-${incrementalId}.jsonl`,
    );
    await mkdir(path.dirname(path.join(home, activeRelative)), { recursive: true });
    await mkdir(path.dirname(path.join(home, archivedRelative)), { recursive: true });
    await mkdir(path.dirname(path.join(home, copiedChildRelative)), { recursive: true });
    await mkdir(sqliteHome, { recursive: true });
    const archivedRollout = rollout(
      archivedId,
      "Archived question",
      "Archived answer",
      "/work/archive",
      [],
      { history_mode: "paginated", model_provider: "receiver-provider" },
    );
    const activeRollout = rollout(
      activeId,
      "科研场景的重复约束",
      "Keep the raw bytes.",
      "/work/agenthist",
      [{
        name: "fixture_lookup",
        description: "Look up fixture history",
        input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        defer_loading: true,
        namespace: "fixture",
      }],
      {
        history_mode: "paginated",
        session_id: archivedId,
        model_provider: "unified-provider",
        forked_from_id: archivedId,
        parent_thread_id: archivedId,
        history_base: {
          thread_id: archivedId,
          end_ordinal_exclusive: 3,
          end_byte_offset: Buffer.byteLength(archivedRollout),
        },
      },
    );
    await writeFile(path.join(home, activeRelative), activeRollout);
    await writeFile(path.join(home, archivedRelative), archivedRollout);
    await writeFile(path.join(home, copiedChildRelative), copiedSubagentRollout());

    const database = new DatabaseSync(path.join(sqliteHome, CODEX_STATE_STORE));
    database.exec(`
      CREATE TABLE thread_sections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        appearance TEXT
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        archived INTEGER NOT NULL,
        first_user_message TEXT NOT NULL,
        model TEXT NOT NULL,
        thread_section_id TEXT REFERENCES thread_sections(id) ON DELETE SET NULL,
        section_position INTEGER,
        section_entered_at_ms INTEGER
      );
      CREATE TABLE thread_dynamic_tools (
        thread_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        defer_loading INTEGER NOT NULL DEFAULT 0,
        namespace TEXT,
        PRIMARY KEY(thread_id, position),
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      )
    `);
    database.prepare("INSERT INTO thread_sections (id, name, appearance) VALUES (?, ?, ?)")
      .run(sectionId, "Research", "blue");
    const insert = database.prepare(`
      INSERT INTO threads
        (id, rollout_path, created_at, updated_at, model_provider, cwd, title, archived,
         first_user_message, model, thread_section_id, section_position, section_entered_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(activeId, path.join(home, activeRelative), 1786237200, 1786237202, "unified-provider", "/work/agenthist", "Active title", 0, "科研场景的重复约束", "gpt-5.4", sectionId, 1_000_000, 1_786_237_200_000);
    insert.run(archivedId, path.join(home, archivedRelative), 1786240800, 1786240802, "receiver-provider", "/work/archive", "Archived title", 1, "Archived question", "gpt-5.4", sectionId, 2_000_000, 1_786_240_800_000);
    insert.run(copiedChildId, path.join(home, copiedChildRelative), 1786244400, 1786244402, "receiver-provider", "/work/copied-child", "Copied child title", 0, "Copied child question", "gpt-5.4", null, null, null);
    insert.run(missingRolloutId, path.join(home, "sessions", "missing.jsonl"), 1786244400, 1786244402, "unified-provider", "/work/missing", "Missing rollout title", 0, "Missing rollout question", "gpt-5.4", null, null, null);
    database.prepare(`
      INSERT INTO thread_dynamic_tools
        (thread_id, position, name, description, input_schema, defer_loading, namespace)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      activeId,
      0,
      "fixture_lookup",
      "Look up fixture history",
      JSON.stringify({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
      1,
      "fixture",
    );
    database.prepare(
      "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)",
    ).run(archivedId, activeId, "closed");
    database.prepare(
      "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)",
    ).run(archivedId, copiedChildId, "closed");
    database.close();

    const goalsDatabase = new DatabaseSync(path.join(sqliteHome, CODEX_GOAL_STORE));
    goalsDatabase.exec(`
      CREATE TABLE thread_goals (
        thread_id TEXT PRIMARY KEY NOT NULL,
        goal_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE thread_goal_continuation_deferrals (
        thread_id TEXT PRIMARY KEY NOT NULL REFERENCES thread_goals(thread_id) ON DELETE CASCADE
      )
    `);
    goalsDatabase.prepare(`
      INSERT INTO thread_goals
        (thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      activeId,
      "goal-fixture-1",
      "Finish the durable migration fixture",
      "active",
      100_000,
      12_345,
      67,
      1_786_237_200_000,
      1_786_237_202_000,
    );
    goalsDatabase.close();

    const runtime = { environment: { HOME: root }, cwd: root, home: root };
    const scanned = await runCli([
      "--json",
      "--state-dir", state,
      "--codex-home", home,
      "--codex-sqlite-home", sqliteHome,
      "scan",
    ], runtime);
    assert.equal(scanned.exitCode, 0, scanned.stderr);
    const scanData = readScanResult(scanned.stdout, "codex");
    assert.equal(scanData.sessions, 3);
    assert.equal(scanData.agent.reusedSessions, 0);
    assert.equal(scanData.agent.rebuiltSessions, 3);
    assert.equal(scanData.agent.removedSessions, 0);
    assert.equal(scanData.warnings.includes(
      `Codex thread row has no matching supported rollout: ${missingRolloutId}`,
    ), true);

    const incrementalPath = path.join(home, incrementalRelative);
    await writeFile(incrementalPath, rollout(
      incrementalId,
      "Codex incremental added marker",
      "Codex incremental initial answer",
    ));
    const addedScan = await runCli([
      "--json", "--state-dir", state, "--codex-home", home, "--codex-sqlite-home", sqliteHome,
      "scan", "--agent", "codex",
    ], runtime);
    assert.equal(addedScan.exitCode, 0, addedScan.stderr);
    const addedMetrics = readScanResult(addedScan.stdout, "codex");
    assert.deepEqual(
      [addedMetrics.agent.reusedSessions, addedMetrics.agent.rebuiltSessions, addedMetrics.agent.removedSessions],
      [3, 1, 0],
    );

    const incompleteReference = codexSessionRef(incrementalId);
    const mixedArchive = path.join(root, "codex-mixed.agenthist");
    const mixedExport = await runCli([
      "--json", "--state-dir", state, "export", "--agent", "codex", "-o", mixedArchive,
    ], runtime);
    assert.equal(mixedExport.exitCode, 0, mixedExport.stderr);
    const mixedData = (JSON.parse(mixedExport.stdout) as {
      data: {
        entries: number;
        skipped_sessions: Array<{ session_ref: string; reason: string }>;
      };
    }).data;
    assert.equal(mixedData.entries, 3);
    assert.deepEqual(mixedData.skipped_sessions.map((session) => session.session_ref), [incompleteReference]);
    assert.match(mixedData.skipped_sessions[0]!.reason, /no restorable thread row/);
    const mixedInspect = await runCli(["--json", "inspect", mixedArchive], runtime);
    assert.equal(mixedInspect.exitCode, 0, mixedInspect.stderr);
    assert.equal((JSON.parse(mixedInspect.stdout) as {
      data: { entries: Array<{ session_ref: string }> };
    }).data.entries.some((entry) => entry.session_ref === incompleteReference), false);
    const incompleteExport = await runCli([
      "--json", "--state-dir", state, "export", "--session", incompleteReference,
      "-o", path.join(root, "codex-incomplete.agenthist"),
    ], runtime);
    assert.equal(incompleteExport.exitCode, 3);
    assert.match((JSON.parse(incompleteExport.stdout) as { error: { message: string } }).error.message,
      /no restorable thread row/);

    await writeFile(incrementalPath, rollout(
      incrementalId,
      "Codex incremental changed marker",
      "Codex incremental updated answer",
    ));
    const changedScan = await runCli([
      "--json", "--state-dir", state, "--codex-home", home, "--codex-sqlite-home", sqliteHome,
      "scan", "--agent", "codex",
    ], runtime);
    assert.equal(changedScan.exitCode, 0, changedScan.stderr);
    const changedMetrics = readScanResult(changedScan.stdout, "codex");
    assert.deepEqual(
      [changedMetrics.agent.reusedSessions, changedMetrics.agent.rebuiltSessions, changedMetrics.agent.removedSessions],
      [3, 1, 0],
    );
    const changedSearch = await runCli([
      "--json", "--state-dir", state, "history", "search", "Codex incremental changed marker",
    ], runtime);
    assert.equal(changedSearch.exitCode, 0, changedSearch.stderr);
    assert.equal((JSON.parse(changedSearch.stdout) as { data: { total_hits: number } }).data.total_hits, 1);

    await rm(incrementalPath);
    const removedScan = await runCli([
      "--json", "--state-dir", state, "--codex-home", home, "--codex-sqlite-home", sqliteHome,
      "scan", "--agent", "codex",
    ], runtime);
    assert.equal(removedScan.exitCode, 0, removedScan.stderr);
    const removedMetrics = readScanResult(removedScan.stdout, "codex");
    assert.deepEqual(
      [removedMetrics.agent.reusedSessions, removedMetrics.agent.rebuiltSessions, removedMetrics.agent.removedSessions],
      [3, 0, 1],
    );
    const removedSearch = await runCli([
      "--json", "--state-dir", state, "history", "search", "Codex incremental changed marker",
    ], runtime);
    assert.equal(removedSearch.exitCode, 0, removedSearch.stderr);
    assert.equal((JSON.parse(removedSearch.stdout) as { data: { total_hits: number } }).data.total_hits, 0);

    const initialList = await runCli(["--json", "--state-dir", state, "history", "list"], runtime);
    assert.equal(initialList.exitCode, 0, initialList.stderr);
    const initialSessions = (JSON.parse(initialList.stdout) as {
      data: { sessions: Array<{ session_ref: string; title: string }> };
    }).data.sessions;
    const activeReference = initialSessions.find((session) => session.title === "Active title")?.session_ref;
    const copiedChildReference = initialSessions.find((session) => session.title === "Copied child title")?.session_ref;
    assert.ok(activeReference);
    assert.ok(copiedChildReference);
    const sourceChild = await runCli([
      "--json", "--state-dir", state, "history", "show", copiedChildReference,
    ], runtime);
    assert.equal(sourceChild.exitCode, 0, sourceChild.stderr);
    assert.doesNotMatch(sourceChild.stdout, /Archived question|Archived answer/);
    assert.match(sourceChild.stdout, /Copied child question/);

    const renamed = await mutate(state, runtime, "rename", activeReference, "--name", "Research Codex");
    assert.equal(renamed.changed, true);
    assert.equal(renamed.after.name, "Research Codex");
    const tagged = await mutate(
      state,
      runtime,
      "tag",
      activeReference,
      "--add", "research",
      "--add", "library-tag-unique",
      "--add", "library-tag-unique",
    );
    assert.deepEqual(tagged.after.tags, ["library-tag-unique", "research"]);
    const untagged = await mutate(state, runtime, "tag", activeReference, "--remove", "research");
    assert.deepEqual(untagged.after.tags, ["library-tag-unique"]);
    const archived = await mutate(state, runtime, "archive", activeReference);
    assert.equal(archived.after.state, "archived");
    const deleted = await mutate(state, runtime, "delete", activeReference);
    assert.equal(deleted.after.state, "deleted");
    assert.equal(deleted.after.restore_state, "archived");
    const undeleted = await mutate(state, runtime, "undelete", activeReference);
    assert.equal(undeleted.after.state, "archived");
    const noChange = await mutate(state, runtime, "archive", activeReference);
    assert.equal(noChange.changed, false);
    const unarchived = await mutate(state, runtime, "unarchive", activeReference);
    assert.equal(unarchived.after.state, "active");

    for (const query of ["research codex", "LIBRARY-TAG-UNIQUE"]) {
      const result = await runCli([
        "--json", "--state-dir", state, "history", "search", query,
      ], runtime);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal((JSON.parse(result.stdout) as { data: { total_hits: number } }).data.total_hits, 1);
    }

    const rescanned = await runCli([
      "--json",
      "--state-dir", state,
      "--codex-home", home,
      "--codex-sqlite-home", sqliteHome,
      "scan", "--agent", "codex",
    ], runtime);
    assert.equal(rescanned.exitCode, 0, rescanned.stderr);
    const rescanData = readScanResult(rescanned.stdout, "codex");
    assert.equal(rescanData.sessions, 3);
    assert.equal(rescanData.warnings.length, 1);
    assert.equal(rescanData.agent.reusedSessions, 3);
    assert.equal(rescanData.agent.rebuiltSessions, 0);
    assert.equal(rescanData.agent.removedSessions, 0);
    assert.equal(
      (await readdir(path.join(state, "history", "codex", "snapshots"))).length,
      1,
    );
    const afterRescan = await runCli([
      "--json", "--state-dir", state, "history", "show", activeReference,
    ], runtime);
    assert.equal(afterRescan.exitCode, 0, afterRescan.stderr);
    const afterRescanSession = (JSON.parse(afterRescan.stdout) as {
      data: { session: { title: string; tags: readonly string[] } };
    }).data.session;
    assert.equal(afterRescanSession.title, "Research Codex");
    assert.deepEqual(afterRescanSession.tags, ["library-tag-unique"]);

    await rm(home, { recursive: true });
    await rm(sqliteHome, { recursive: true });

    const listed = await runCli(["--json", "--state-dir", state, "history", "list"], runtime);
    assert.equal(listed.exitCode, 0, listed.stderr);
    const listData = (JSON.parse(listed.stdout) as {
      data: {
        total_sessions: number;
        returned_sessions: number;
        remaining_sessions: number;
        next_offset?: number;
        sessions: Array<{ session_ref: string; title: string; tags: readonly string[] }>;
      };
    }).data;
    assert.equal(listData.total_sessions, 3);
    assert.equal(listData.returned_sessions, 3);
    assert.equal(listData.remaining_sessions, 0);
    assert.equal(listData.next_offset, undefined);
    const activeAfterRemoval = listData.sessions.find((session) => session.session_ref === activeReference);
    assert.equal(activeAfterRemoval?.title, "Research Codex");
    assert.deepEqual(activeAfterRemoval?.tags, ["library-tag-unique"]);

    const pagedList = await runCli([
      "--json", "--state-dir", state, "history", "list", "--limit", "1",
    ], runtime);
    assert.equal(pagedList.exitCode, 0, pagedList.stderr);
    const pagedListData = (JSON.parse(pagedList.stdout) as {
      data: { total_sessions: number; returned_sessions: number; remaining_sessions: number; next_offset: number };
    }).data;
    assert.equal(pagedListData.total_sessions, 3);
    assert.equal(pagedListData.returned_sessions, 1);
    assert.equal(pagedListData.remaining_sessions, 2);
    assert.equal(pagedListData.next_offset, 1);

    const pagedSearch = await runCli([
      "--json", "--state-dir", state, "history", "search", "ahsr1_codex_", "--limit", "1",
    ], runtime);
    assert.equal(pagedSearch.exitCode, 0, pagedSearch.stderr);
    const pagedSearchData = (JSON.parse(pagedSearch.stdout) as {
      data: { total_hits: number; returned_hits: number; remaining_hits: number; next_offset: number };
    }).data;
    assert.equal(pagedSearchData.total_hits, 3);
    assert.equal(pagedSearchData.returned_hits, 1);
    assert.equal(pagedSearchData.remaining_hits, 2);
    assert.equal(pagedSearchData.next_offset, 1);

    const searched = await runCli(["--json", "--state-dir", state, "history", "search", "科研场景"], runtime);
    assert.equal(searched.exitCode, 0, searched.stderr);
    assert.equal((JSON.parse(searched.stdout) as { data: { total_hits: number } }).data.total_hits, 1);

    const archive = path.join(root, "backup.agenthist");
    const exported = await runCli(["--json", "--state-dir", state, "export", "-o", archive], runtime);
    assert.equal(exported.exitCode, 0, exported.stderr);
    const exportedData = (JSON.parse(exported.stdout) as {
      data: { entries: number; agents: Array<{ agent: string; sessions: number }> };
    }).data;
    assert.equal(exportedData.entries, 3);
    assert.deepEqual(exportedData.agents, [{ agent: "codex", sessions: 3 }]);
    const inspected = await runCli(["--json", "inspect", archive, "--limit", "2"], runtime);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    const firstInspectPage = (JSON.parse(inspected.stdout) as {
      data: { entries: Array<{ session_ref: string }>; total_entries: number; remaining_entries: number; next_cursor: string };
    }).data;
    assert.equal(firstInspectPage.entries.length, 2);
    assert.equal(firstInspectPage.total_entries, 3);
    assert.equal(firstInspectPage.remaining_entries, 1);
    const secondInspectPage = await runCli([
      "--json", "inspect", archive, "--limit", "2", "--cursor", firstInspectPage.next_cursor,
    ], runtime);
    assert.equal(secondInspectPage.exitCode, 0, secondInspectPage.stderr);
    const secondInspectData = (JSON.parse(secondInspectPage.stdout) as {
      data: { entries: Array<{ session_ref: string }>; remaining_entries: number; next_cursor?: string };
    }).data;
    assert.equal(secondInspectData.entries.length, 1);
    assert.equal(firstInspectPage.entries.some((entry) =>
      entry.session_ref === secondInspectData.entries[0]!.session_ref), false);
    assert.equal(secondInspectData.remaining_entries, 0);
    assert.equal(secondInspectData.next_cursor, undefined);
    const filteredInspect = await runCli([
      "--json", "inspect", archive, "--agent", "codex", "--session", activeReference,
    ], runtime);
    assert.equal(filteredInspect.exitCode, 0, filteredInspect.stderr);
    assert.deepEqual((JSON.parse(filteredInspect.stdout) as {
      data: { entries: Array<{ session_ref: string }> };
    }).data.entries.map((entry) => entry.session_ref), [activeReference]);
    const lineageArchive = path.join(root, "lineage.agenthist");
    const lineageExport = await runCli([
      "--json", "--state-dir", state, "export", "--session", activeReference, "-o", lineageArchive,
    ], runtime);
    assert.equal(lineageExport.exitCode, 0, lineageExport.stderr);
    const lineageInspect = await runCli(["--json", "inspect", lineageArchive], runtime);
    assert.equal(lineageInspect.exitCode, 0, lineageInspect.stderr);
    assert.equal((JSON.parse(lineageInspect.stdout) as { data: { entries: unknown[] } }).data.entries.length, 3);
    const targetHome = path.join(root, "target-codex");
    const targetSQLite = path.join(root, "target-sqlite");
    const targetState = path.join(root, "target-state");
    await mkdir(targetHome, { recursive: true });
    await mkdir(targetSQLite, { recursive: true });
    await writeFile(path.join(targetHome, "config.toml"), 'model_provider = "receiver-provider"\n');
    const targetDatabase = new DatabaseSync(path.join(targetSQLite, CODEX_STATE_STORE));
    targetDatabase.exec(`
      CREATE TABLE thread_sections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        appearance TEXT
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        archived INTEGER NOT NULL,
        first_user_message TEXT NOT NULL,
        model TEXT NOT NULL,
        thread_section_id TEXT REFERENCES thread_sections(id) ON DELETE SET NULL,
        section_position INTEGER,
        section_entered_at_ms INTEGER
      );
      CREATE TABLE thread_dynamic_tools (
        thread_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        defer_loading INTEGER NOT NULL DEFAULT 0,
        namespace TEXT,
        PRIMARY KEY(thread_id, position),
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      )
    `);
    targetDatabase.close();
    const targetGoals = new DatabaseSync(path.join(targetSQLite, CODEX_GOAL_STORE));
    targetGoals.exec(`
      CREATE TABLE thread_goals (
        thread_id TEXT PRIMARY KEY NOT NULL,
        goal_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE thread_goal_continuation_deferrals (
        thread_id TEXT PRIMARY KEY NOT NULL REFERENCES thread_goals(thread_id) ON DELETE CASCADE
      )
    `);
    targetGoals.close();
    const targetWork = path.join(root, "target-work");
    await mkdir(path.join(targetWork, "agenthist"), { recursive: true });
    await mkdir(path.join(targetWork, "archive"), { recursive: true });
    await mkdir(path.join(targetWork, "copied-child"), { recursive: true });
    const commonImportArguments = [
      "--json",
      "--state-dir", targetState,
      "--codex-sqlite-home", targetSQLite,
    ];
    const fullImportArguments = [
      ...commonImportArguments,
      "import", lineageArchive,
      "--session", activeReference,
      "--target", `codex=${targetHome}`,
      "--codex-provider", "preserve",
      "--map-path", `/work=${targetWork}`,
    ];
    const dryRun = await runCli([...fullImportArguments, "--dry-run"], runtime);
    assert.equal(dryRun.exitCode, 0, dryRun.stderr);
    const dryRunData = (JSON.parse(dryRun.stdout) as {
      data: { new_sessions: number; written: number };
    }).data;
    assert.equal(dryRunData.new_sessions, 3);
    assert.equal(dryRunData.written, 0);
    const beforeApply = new DatabaseSync(path.join(targetSQLite, CODEX_STATE_STORE), { readOnly: true });
    assert.equal((beforeApply.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count, 0);
    beforeApply.close();
    assert.equal(goalState(path.join(targetSQLite, CODEX_GOAL_STORE), activeId), undefined);
    assert.equal(sectionState(path.join(targetSQLite, CODEX_STATE_STORE), sectionId), undefined);
    const staleDraft = ".prepare-00000000-0000-4000-8000-000000000001";
    await mkdir(path.join(targetState, "transactions", staleDraft, "objects"), { recursive: true });
    await writeFile(path.join(targetState, "transactions", staleDraft, "objects", "partial"), "interrupted");

    const completed = await runCli([...fullImportArguments, "--apply"], runtime);
    assert.equal(completed.exitCode, 0, completed.stderr);
    const completedData = (JSON.parse(completed.stdout) as {
      data: { written: number; already_present: number; agents: Array<{ transaction_ref?: string }> };
    }).data;
    assert.equal(completedData.written, 3);
    assert.equal(completedData.already_present, 0);
    assert.equal((await readdir(path.join(targetState, "transactions"))).includes(staleDraft), false);
    const completedReference = completedData.agents[0]!.transaction_ref!;
    assert.match(completedReference, /^ahtx1_/);
    assert.equal(dynamicToolState(path.join(targetSQLite, CODEX_STATE_STORE), activeId)?.name, "fixture_lookup");
    assert.deepEqual(spawnEdgeState(path.join(targetSQLite, CODEX_STATE_STORE), activeId), {
      parent_thread_id: archivedId,
      child_thread_id: activeId,
      status: "closed",
    });
    assert.deepEqual(spawnEdgeState(path.join(targetSQLite, CODEX_STATE_STORE), copiedChildId), {
      parent_thread_id: archivedId,
      child_thread_id: copiedChildId,
      status: "closed",
    });
    assert.deepEqual(goalState(path.join(targetSQLite, CODEX_GOAL_STORE), activeId), {
      goal_id: "goal-fixture-1",
      objective: "Finish the durable migration fixture",
      status: "active",
      token_budget: 100_000,
      tokens_used: 12_345,
      time_used_seconds: 67,
      continuation_deferred: true,
    });
    assert.deepEqual(sectionState(path.join(targetSQLite, CODEX_STATE_STORE), sectionId), {
      id: sectionId,
      name: "Research",
      appearance: "blue",
    });
    await assertLineageBoundary(path.join(targetHome, activeRelative), path.join(targetHome, archivedRelative));
    await assertImportedCopiedSubagent(
      path.join(targetHome, copiedChildRelative),
      "receiver-provider",
      path.join(targetWork, "copied-child"),
    );
    const repeated = await runCli([...fullImportArguments, "--apply"], runtime);
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    const repeatedData = (JSON.parse(repeated.stdout) as {
      data: { written: number; already_present: number; agents: Array<{ transaction_ref?: string }> };
    }).data;
    assert.equal(repeatedData.written, 0);
    assert.equal(repeatedData.already_present, 3);
    assert.equal(repeatedData.agents[0]!.transaction_ref, undefined);

    const rollbackDry = await runCli([
      "--json", "--state-dir", targetState,
      "transaction", "rollback", completedReference, "--dry-run",
    ], runtime);
    assert.equal(rollbackDry.exitCode, 0, rollbackDry.stderr);
    const rollbackDryData = (JSON.parse(rollbackDry.stdout) as {
      data: { ready: boolean; dry_run: boolean };
    }).data;
    assert.equal(rollbackDryData.ready, true);
    assert.equal(rollbackDryData.dry_run, true);
    const rollbackApply = await runCli([
      "--json", "--state-dir", targetState,
      "transaction", "rollback", completedReference, "--apply",
    ], runtime);
    assert.equal(rollbackApply.exitCode, 0, rollbackApply.stderr);
    assert.equal((JSON.parse(rollbackApply.stdout) as {
      data: { transaction: { state: string } };
    }).data.transaction.state, "rolled_back");
    const afterRollback = new DatabaseSync(path.join(targetSQLite, CODEX_STATE_STORE), { readOnly: true });
    assert.equal((afterRollback.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count, 0);
    afterRollback.close();
    assert.equal(dynamicToolState(path.join(targetSQLite, CODEX_STATE_STORE), activeId), undefined);
    assert.equal(spawnEdgeState(path.join(targetSQLite, CODEX_STATE_STORE), activeId), undefined);
    assert.equal(spawnEdgeState(path.join(targetSQLite, CODEX_STATE_STORE), copiedChildId), undefined);
    assert.equal(goalState(path.join(targetSQLite, CODEX_GOAL_STORE), activeId), undefined);
    assert.equal(sectionState(path.join(targetSQLite, CODEX_STATE_STORE), sectionId), undefined);

    const reimported = await runCli([...fullImportArguments, "--apply"], runtime);
    assert.equal(reimported.exitCode, 0, reimported.stderr);
    const reimportedData = (JSON.parse(reimported.stdout) as {
      data: { written: number; already_present: number };
    }).data;
    assert.equal(reimportedData.written, 3);
    assert.equal(reimportedData.already_present, 0);
    assert.equal(
      goalState(path.join(targetSQLite, CODEX_GOAL_STORE), activeId)?.continuation_deferred,
      true,
    );
    assert.equal(sectionState(path.join(targetSQLite, CODEX_STATE_STORE), sectionId)?.name, "Research");

    const providerGlobals = [
      "--json",
      "--state-dir", targetState,
      "--codex-home", targetHome,
      "--codex-sqlite-home", targetSQLite,
    ];
    const providers = await runCli([...providerGlobals, "codex", "provider", "list"], runtime);
    assert.equal(providers.exitCode, 0, providers.stderr);
    const providersData = (JSON.parse(providers.stdout) as {
      data: { total_sessions: number; providers: Array<{ provider: string; sessions: number }> };
    }).data;
    assert.equal(providersData.total_sessions, 3);
    assert.deepEqual(providersData.providers, [
      { provider: "receiver-provider", sessions: 2, current: true },
      { provider: "unified-provider", sessions: 1, current: false },
    ]);

    const unifyDry = await runCli([
      ...providerGlobals,
      "codex", "provider", "unify", "--dry-run",
    ], runtime);
    assert.equal(unifyDry.exitCode, 0, unifyDry.stderr);
    const unifyDryData = (JSON.parse(unifyDry.stdout) as {
      data: { target_provider: string; changed: number; dry_run: boolean; transaction_ref?: string };
    }).data;
    assert.equal(unifyDryData.target_provider, "openai");
    assert.equal(unifyDryData.changed, 3);
    assert.equal(unifyDryData.dry_run, true);
    assert.equal(unifyDryData.transaction_ref, undefined);
    const unified = await runCli([
      ...providerGlobals,
      "codex", "provider", "unify", "--apply",
    ], runtime);
    assert.equal(unified.exitCode, 0, unified.stderr);
    const unifyData = (JSON.parse(unified.stdout) as {
      data: { changed: number; transaction_ref: string };
    }).data;
    assert.equal(unifyData.changed, 3);
    assert.match(unifyData.transaction_ref, /^ahtx1_/);
    await assertLineageBoundary(path.join(targetHome, activeRelative), path.join(targetHome, archivedRelative));
    await assertImportedCopiedSubagent(
      path.join(targetHome, copiedChildRelative),
      "openai",
      path.join(targetWork, "copied-child"),
    );
    assert.equal(spawnEdgeState(path.join(targetSQLite, CODEX_STATE_STORE), activeId)?.status, "closed");
    assert.equal(goalState(path.join(targetSQLite, CODEX_GOAL_STORE), activeId)?.goal_id, "goal-fixture-1");
    assert.equal(sectionState(path.join(targetSQLite, CODEX_STATE_STORE), sectionId)?.name, "Research");

    // One bounded commit-window simulation: native state and history head are
    // already complete, but the final committed journal response was lost.
    const unifyId = unifyData.transaction_ref.slice("ahtx1_".length);
    const journalPath = path.join(targetState, "transactions", unifyId, "journal.json");
    const interrupted = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    interrupted.state = "needs_recovery";
    interrupted.phase = "needs_recovery";
    interrupted.failure = "codex.commit_response_lost";
    await writeFile(journalPath, `${JSON.stringify(interrupted, null, 2)}\n`, { mode: 0o600 });

    const recoverDry = await runCli([
      "--json", "--state-dir", targetState,
      "transaction", "recover", unifyData.transaction_ref, "--dry-run",
    ], runtime);
    assert.equal(recoverDry.exitCode, 0, recoverDry.stderr);
    const recoverDryData = (JSON.parse(recoverDry.stdout) as {
      data: { ready: boolean; requested_action: string; dry_run: boolean };
    }).data;
    assert.equal(recoverDryData.ready, true);
    assert.equal(recoverDryData.requested_action, "recover");
    assert.equal(recoverDryData.dry_run, true);
    const recoverApply = await runCli([
      "--json", "--state-dir", targetState,
      "transaction", "recover", unifyData.transaction_ref, "--apply",
    ], runtime);
    assert.equal(recoverApply.exitCode, 0, recoverApply.stderr);

    const finalizedRecoverDry = await runCli([
      "--json", "--state-dir", targetState,
      "transaction", "recover", unifyData.transaction_ref, "--dry-run",
    ], runtime);
    assert.equal(finalizedRecoverDry.exitCode, 0, finalizedRecoverDry.stderr);
    const finalizedRecoverDryData = (JSON.parse(finalizedRecoverDry.stdout) as {
      data: { ready: boolean; findings: unknown[] };
    }).data;
    assert.equal(finalizedRecoverDryData.ready, true);
    assert.deepEqual(finalizedRecoverDryData.findings, []);
    const finalizedRecoverApply = await runCli([
      "--json", "--state-dir", targetState,
      "transaction", "recover", unifyData.transaction_ref, "--apply",
    ], runtime);
    assert.equal(finalizedRecoverApply.exitCode, 0, finalizedRecoverApply.stderr);
    assert.equal((JSON.parse(finalizedRecoverApply.stdout) as {
      data: { transaction: { state: string } };
    }).data.transaction.state, "committed");

    const providerRollback = await runCli([
      "--json", "--state-dir", targetState,
      "transaction", "rollback", unifyData.transaction_ref, "--apply",
    ], runtime);
    assert.equal(providerRollback.exitCode, 0, providerRollback.stderr);
    const providersRestored = await runCli([...providerGlobals, "codex", "provider", "list"], runtime);
    assert.equal(providersRestored.exitCode, 0, providersRestored.stderr);
    assert.deepEqual(
      (JSON.parse(providersRestored.stdout) as { data: { providers: unknown[] } }).data.providers,
      [
        { provider: "receiver-provider", sessions: 2, current: true },
        { provider: "unified-provider", sessions: 1, current: false },
      ],
    );
    const restoredDynamicTool = dynamicToolState(path.join(targetSQLite, CODEX_STATE_STORE), activeId)!;
    assert.equal(restoredDynamicTool.position, 0);
    assert.equal(restoredDynamicTool.name, "fixture_lookup");
    assert.equal(restoredDynamicTool.description, "Look up fixture history");
    assert.deepEqual(JSON.parse(restoredDynamicTool.input_schema), {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    assert.equal(restoredDynamicTool.defer_loading, 1);
    assert.equal(restoredDynamicTool.namespace, "fixture");
    assert.equal(spawnEdgeState(path.join(targetSQLite, CODEX_STATE_STORE), activeId)?.status, "closed");
    assert.equal(goalState(path.join(targetSQLite, CODEX_GOAL_STORE), activeId)?.goal_id, "goal-fixture-1");
    assert.equal(sectionState(path.join(targetSQLite, CODEX_STATE_STORE), sectionId)?.name, "Research");
    await assertLineageBoundary(path.join(targetHome, activeRelative), path.join(targetHome, archivedRelative));
    await assertImportedCopiedSubagent(
      path.join(targetHome, copiedChildRelative),
      "receiver-provider",
      path.join(targetWork, "copied-child"),
    );

    const transactions = await runCli(["--json", "--state-dir", targetState, "transaction", "list"], runtime);
    assert.equal(transactions.exitCode, 0, transactions.stderr);
    assert.equal((JSON.parse(transactions.stdout) as { data: { transactions: unknown[] } }).data.transactions.length, 3);

    const targetList = await runCli(["--json", "--state-dir", targetState, "history", "list"], runtime);
    assert.equal(targetList.exitCode, 0, targetList.stderr);
    const targetListData = (JSON.parse(targetList.stdout) as {
      data: { total_sessions: number; sessions: Array<{ title: string; tags: readonly string[] }> };
    }).data;
    assert.equal(targetListData.total_sessions, 3);
    assert.deepEqual(
      targetListData.sessions.find((session) => session.title === "Research Codex")?.tags,
      ["library-tag-unique"],
    );

    const shown = await runCli([
      "--json",
      "--state-dir", state,
      "history",
      "show",
      activeReference,
    ], runtime);
    assert.equal(shown.exitCode, 0, shown.stderr);
    assert.match(shown.stdout, /raw bytes|Archived answer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
