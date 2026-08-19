import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../../../src/cli/program.js";
import { nativeFixturePath } from "../../support/native-path.js";
import { readScanResult } from "../../support/scan-result.js";

const INCREMENTAL_SESSION = "ses_incremental_delta";

function addOpenCodeIncrementalSession(databasePath: string, directory: string, text: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(`
      INSERT INTO session
        (id, slug, project_id, parent_id, directory, path, title, version, model,
         time_created, time_updated, time_archived, future_session_field)
      VALUES (?, ?, ?, NULL, ?, '.', ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      INCREMENTAL_SESSION,
      "incremental-delta",
      "prj_history_fixture",
      directory,
      "Incremental OpenCode session",
      "incremental-capability-fixture",
      JSON.stringify({ id: "gpt-5.4", providerID: "provider-alpha" }),
      1_786_240_030_000,
      1_786_240_031_000,
    );
    database.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "msg_incremental_delta",
      INCREMENTAL_SESSION,
      1_786_240_030_000,
      1_786_240_031_000,
      JSON.stringify({ role: "user", model: { providerID: "provider-alpha", modelID: "gpt-5.4" } }),
    );
    database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
      "prt_incremental_delta",
      "msg_incremental_delta",
      INCREMENTAL_SESSION,
      1_786_240_030_000,
      1_786_240_031_000,
      JSON.stringify({ type: "text", text }),
    );
  } finally {
    database.close();
  }
}

function updateOpenCodeIncrementalSession(databasePath: string, text: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare("UPDATE part SET data = ?, time_updated = ? WHERE id = ?").run(
      JSON.stringify({ type: "text", text }),
      1_786_240_032_000,
      "prt_incremental_delta",
    );
  } finally {
    database.close();
  }
}

function removeOpenCodeIncrementalSession(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare("DELETE FROM part WHERE session_id = ?").run(INCREMENTAL_SESSION);
    database.prepare("DELETE FROM message WHERE session_id = ?").run(INCREMENTAL_SESSION);
    database.prepare("DELETE FROM session WHERE id = ?").run(INCREMENTAL_SESSION);
  } finally {
    database.close();
  }
}

function replaceSourcePaths(value: unknown, sourceBase: string): unknown {
  if (typeof value === "string") {
    return value === "/source"
      ? sourceBase
      : value.replaceAll("/source/", `${sourceBase}${path.sep}`);
  }
  if (Array.isArray(value)) return value.map((item) => replaceSourcePaths(item, sourceBase));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceSourcePaths(item, sourceBase)]),
    );
  }
  return value;
}

function createSource(
  databasePath: string,
  toolOutputPath?: string,
  pendingSessionId?: string,
  sourceBase = nativeFixturePath("/source"),
): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT,
      vcs TEXT,
      sandboxes TEXT NOT NULL,
      future_project_field TEXT
    );
    CREATE TABLE project_directory (
      project_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      type TEXT,
      strategy TEXT,
      time_created INTEGER NOT NULL,
      PRIMARY KEY (project_id, directory)
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      directory TEXT NOT NULL,
      path TEXT,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER,
      future_session_field TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE session_input (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      delivery TEXT NOT NULL,
      admitted_seq INTEGER NOT NULL,
      promoted_seq INTEGER,
      time_created INTEGER NOT NULL
    );
    CREATE TABLE credential (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
    INSERT INTO migration VALUES ('agenthist-test-schema-complete', 0);

    INSERT INTO project VALUES ('prj_history_fixture', '/source/work', 'git', '["/source/archive"]', 'additive-project-value');
    INSERT INTO project_directory VALUES
      ('prj_history_fixture', '/source/work', 'main', NULL, 1786239999000),
      ('prj_history_fixture', '/source/archive', 'git_worktree', NULL, 1786239999500);
    INSERT INTO credential VALUES ('private', 'CONNECTION_SECRET_MUST_NOT_BE_CAPTURED');

    INSERT INTO session VALUES
      ('ses_root_alpha', 'root-alpha', 'prj_history_fixture', NULL, '/source/work', '.', 'Root conversation',
       '999-format-compatible', '{"id":"gpt-5.4","providerID":"provider-alpha"}',
       1786240000000, 1786240005000, NULL, 'additive-root-value'),
      ('ses_child_alpha', 'child-alpha', 'prj_history_fixture', 'ses_root_alpha', '/source/work', '.', 'Child conversation',
       'another-compatible-build', '{"id":"gpt-5.4","providerID":"provider-alpha"}',
       1786240001000, 1786240002000, NULL, 'additive-child-value'),
      ('ses_archived_beta', 'archived-beta', 'prj_history_fixture', NULL, '/source/archive', '.', 'Archived conversation',
       'future-compatible-build', '{"id":"gpt-5.4","providerID":"provider-beta"}',
       1786240010000, 1786240015000, 1786240020000, 'additive-archive-value');

    INSERT INTO message VALUES
      ('msg_root_user', 'ses_root_alpha', 1786240000000, 1786240000000,
       '{"role":"user","model":{"providerID":"provider-alpha","modelID":"gpt-5.4"}}'),
      ('msg_root_assistant', 'ses_root_alpha', 1786240000100, 1786240005000,
       '{"role":"assistant","providerID":"provider-alpha","modelID":"gpt-5.4"}'),
      ('msg_child_user', 'ses_child_alpha', 1786240001000, 1786240001000,
       '{"role":"user","model":{"providerID":"provider-alpha","modelID":"gpt-5.4"}}'),
      ('msg_archived_user', 'ses_archived_beta', 1786240010000, 1786240010000,
       '{"role":"user","model":{"providerID":"provider-beta","modelID":"gpt-5.4"}}');

    INSERT INTO part VALUES
      ('prt_root_text', 'msg_root_user', 'ses_root_alpha', 1786240000000, 1786240000000,
       '{"type":"text","text":"OpenCode persisted search marker"}'),
      ('prt_root_tool', 'msg_root_assistant', 'ses_root_alpha', 1786240000100, 1786240000200,
       '{"type":"tool","tool":"read","callID":"call_read","state":{"status":"completed","input":{"filePath":"/source/work/paper.md"},"title":"Read paper","output":"tool output remains readable","metadata":{"outputPath":"/tmp/tool_output_1"}}}'),
      ('prt_child_text', 'msg_child_user', 'ses_child_alpha', 1786240001000, 1786240001000,
       '{"type":"text","text":"child session content"}'),
      ('prt_archived_text', 'msg_archived_user', 'ses_archived_beta', 1786240010000, 1786240010000,
       '{"type":"text","text":"archived session content"}');

    INSERT INTO session_input VALUES
      ('inp_root_promoted', 'ses_root_alpha', '{"text":"already executed"}', 'queue', 1, 2, 1786240000000);
  `);
  if (pendingSessionId !== undefined) {
    database.prepare(
      "INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created) " +
        "VALUES (?, ?, ?, ?, ?, NULL, ?)",
    ).run("inp_pending", pendingSessionId, '{"text":"must not execute on target"}', "queue", 3, 1786240030000);
  }
  if (toolOutputPath !== undefined) {
    database.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "prt_root_truncated",
      "msg_root_assistant",
      "ses_root_alpha",
      1786240000200,
      1786240000300,
      JSON.stringify({
        type: "tool",
        tool: "grep",
        callID: "call_truncated",
        state: {
          status: "completed",
          input: { pattern: "history" },
          output: `matching preview\n\n...4096 bytes truncated...\n\nFull output saved to: ${toolOutputPath}`,
          title: "Search history",
          metadata: { truncated: true, outputPath: toolOutputPath },
        },
      }),
    );
  }
  if (sourceBase !== "/source") {
    database.prepare("UPDATE project SET worktree = ?").run(path.join(sourceBase, "work"));
    database.prepare("UPDATE project SET sandboxes = ?").run(JSON.stringify([path.join(sourceBase, "archive")]));
    for (const table of ["project_directory", "session"] as const) {
      const rows = database.prepare(`SELECT rowid, directory FROM ${table}`).all() as Array<{
        rowid: number;
        directory: string;
      }>;
      const update = database.prepare(`UPDATE ${table} SET directory = ? WHERE rowid = ?`);
      for (const row of rows) update.run(replaceSourcePaths(row.directory, sourceBase) as string, row.rowid);
    }
    const parts = database.prepare("SELECT id, data FROM part").all() as Array<{ id: string; data: string }>;
    const updatePart = database.prepare("UPDATE part SET data = ? WHERE id = ?");
    for (const part of parts) {
      updatePart.run(JSON.stringify(replaceSourcePaths(JSON.parse(part.data), sourceBase)), part.id);
    }
  }
  database.close();
}

function clearTarget(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    DELETE FROM part;
    DELETE FROM message;
    DELETE FROM session_input;
    DELETE FROM session;
    DELETE FROM project_directory;
    DELETE FROM project;
    DELETE FROM credential;
  `);
  database.close();
}

test("OpenCode scan preserves readable multi-session history without copying connection tables", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-ts-opencode-"));
  const dataRoot = path.join(root, "xdg", "opencode");
  const state = path.join(root, "state");
  const databasePath = path.join(dataRoot, "opencode.db");
  try {
    await mkdir(dataRoot, { recursive: true });
    const toolOutputRoot = path.join(dataRoot, "tool-output");
    const sourceToolOutput = path.join(toolOutputRoot, "tool_fixture_output");
    const toolOutputContents = "complete tool output retained outside the OpenCode database\nsecond line\n";
    const sourceBase = path.join(root, "source-work");
    const sourcePlan = path.join(sourceBase, "work", ".opencode", "plans", "1786240000000-root-alpha.md");
    const planContents = "# Root plan\n\n- preserve the native OpenCode plan across machines\n";
    await mkdir(toolOutputRoot, { recursive: true });
    await mkdir(path.join(sourceBase, "archive"), { recursive: true });
    await mkdir(path.dirname(sourcePlan), { recursive: true });
    await writeFile(sourceToolOutput, toolOutputContents, { mode: 0o600 });
    await writeFile(sourcePlan, planContents, { mode: 0o600 });
    createSource(databasePath, sourceToolOutput, undefined, sourceBase);
    const sessionDiffRoot = path.join(dataRoot, "storage", "session_diff");
    const archivedSessionDiff = path.join(sessionDiffRoot, "ses_archived_beta.json");
    const archivedDiffContents = `${JSON.stringify([{
      file: "paper.md",
      patch: "@@ -1 +1 @@\\n-old\\n+new",
      additions: 1,
      deletions: 1,
      status: "modified",
    }])}\n`;
    await mkdir(sessionDiffRoot, { recursive: true });
    await writeFile(archivedSessionDiff, archivedDiffContents, { mode: 0o600 });
    const runtime = { environment: { HOME: root }, cwd: root, home: root };
    const scanned = await runCli([
      "--json",
      "--state-dir", state,
      "--opencode-data-root", dataRoot,
      "scan",
      "--agent", "opencode",
    ], runtime);
    assert.equal(scanned.exitCode, 0, scanned.stdout || scanned.stderr);
    const scanData = readScanResult(scanned.stdout, "opencode");
    assert.equal(scanData.sessions, 3);
    assert.equal(scanData.agent.reusedSessions, 0);
    assert.equal(scanData.agent.rebuiltSessions, 3);
    assert.equal(scanData.agent.removedSessions, 0);

    const rescanned = await runCli([
      "--json",
      "--state-dir", state,
      "--opencode-data-root", dataRoot,
      "scan",
      "--agent", "opencode",
    ], runtime);
    assert.equal(rescanned.exitCode, 0, rescanned.stdout || rescanned.stderr);
    const rescanAgent = readScanResult(rescanned.stdout, "opencode").agent;
    assert.equal(rescanAgent.reusedSessions, 2);
    assert.equal(rescanAgent.rebuiltSessions, 1);
    assert.equal(rescanAgent.removedSessions, 0);

    addOpenCodeIncrementalSession(
      databasePath,
      path.join(sourceBase, "work"),
      "OpenCode incremental added marker",
    );
    const addedScan = await runCli([
      "--json", "--state-dir", state, "--opencode-data-root", dataRoot,
      "scan", "--agent", "opencode",
    ], runtime);
    assert.equal(addedScan.exitCode, 0, addedScan.stdout || addedScan.stderr);
    const addedMetrics = readScanResult(addedScan.stdout, "opencode").agent;
    assert.deepEqual(
      [addedMetrics.reusedSessions, addedMetrics.rebuiltSessions, addedMetrics.removedSessions],
      [2, 2, 0],
    );

    updateOpenCodeIncrementalSession(databasePath, "OpenCode incremental changed marker");
    const changedScan = await runCli([
      "--json", "--state-dir", state, "--opencode-data-root", dataRoot,
      "scan", "--agent", "opencode",
    ], runtime);
    assert.equal(changedScan.exitCode, 0, changedScan.stdout || changedScan.stderr);
    const changedMetrics = readScanResult(changedScan.stdout, "opencode").agent;
    assert.deepEqual(
      [changedMetrics.reusedSessions, changedMetrics.rebuiltSessions, changedMetrics.removedSessions],
      [2, 2, 0],
    );
    const changedSearch = await runCli([
      "--json", "--state-dir", state, "history", "search", "OpenCode incremental changed marker",
    ], runtime);
    assert.equal(changedSearch.exitCode, 0, changedSearch.stderr);
    assert.equal((JSON.parse(changedSearch.stdout) as { data: { total_hits: number } }).data.total_hits, 1);

    removeOpenCodeIncrementalSession(databasePath);
    const removedScan = await runCli([
      "--json", "--state-dir", state, "--opencode-data-root", dataRoot,
      "scan", "--agent", "opencode",
    ], runtime);
    assert.equal(removedScan.exitCode, 0, removedScan.stdout || removedScan.stderr);
    const removedMetrics = readScanResult(removedScan.stdout, "opencode").agent;
    assert.deepEqual(
      [removedMetrics.reusedSessions, removedMetrics.rebuiltSessions, removedMetrics.removedSessions],
      [2, 1, 1],
    );
    const removedSearch = await runCli([
      "--json", "--state-dir", state, "history", "search", "OpenCode incremental changed marker",
    ], runtime);
    assert.equal(removedSearch.exitCode, 0, removedSearch.stderr);
    assert.equal((JSON.parse(removedSearch.stdout) as { data: { total_hits: number } }).data.total_hits, 0);

    const head = JSON.parse(await readFile(path.join(state, "history", "opencode", "head.json"), "utf8")) as {
      snapshotId: string;
    };
    const capturedDatabase = path.join(
      state, "history", "opencode", "snapshots", head.snapshotId, "raw", "opencode", "history.sqlite",
    );
    const evidence = new DatabaseSync(capturedDatabase, { readOnly: true });
    const capturedTables = evidence.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    assert.equal(capturedTables.some((row) => row.name === "credential"), false);
    assert.equal(capturedTables.some((row) => row.name === "project_directory"), false);
    assert.equal(capturedTables.some((row) => row.name === "session"), true);
    assert.equal(
      (evidence.prepare("SELECT future_session_field AS value FROM session WHERE id = ?").get("ses_root_alpha") as { value: string }).value,
      "additive-root-value",
    );
    evidence.close();

    const listed = await runCli([
      "--json", "--state-dir", state, "history", "list", "--agent", "opencode", "--view", "all",
    ], runtime);
    assert.equal(listed.exitCode, 0, listed.stderr);
    const listData = (JSON.parse(listed.stdout) as {
      data: { total_sessions: number; sessions: Array<{ session_ref: string; provider: string; title: string }> };
    }).data;
    assert.equal(listData.total_sessions, 3);
    assert.deepEqual(new Set(listData.sessions.map((session) => session.provider)), new Set(["provider-alpha", "provider-beta"]));

    const capturedIndex = JSON.parse(await readFile(path.join(
      state, "history", "opencode", "snapshots", head.snapshotId, "index.json",
    ), "utf8")) as {
      sessions: Array<{
        nativeId: string;
        native: { carrier: {
          sidecars: string[];
          plan: string | null;
          toolOutputs: Array<{ nativePath: string; relativePath: string; available: boolean }>;
        } };
      }>;
    };
    const sidecarsBySession = new Map(capturedIndex.sessions.map((session) => [
      session.nativeId,
      session.native.carrier.sidecars,
    ]));
    assert.deepEqual(sidecarsBySession.get("ses_archived_beta"), [
      "opencode/session_diff/ses_archived_beta.json",
    ]);
    assert.deepEqual(sidecarsBySession.get("ses_root_alpha"), []);
    assert.deepEqual(sidecarsBySession.get("ses_child_alpha"), []);
    const plansBySession = new Map(capturedIndex.sessions.map((session) => [
      session.nativeId,
      session.native.carrier.plan,
    ]));
    assert.equal(plansBySession.get("ses_root_alpha"), "opencode/plan/ses_root_alpha.md");
    assert.equal(plansBySession.get("ses_child_alpha"), null);
    assert.equal(plansBySession.get("ses_archived_beta"), null);
    const outputsBySession = new Map(capturedIndex.sessions.map((session) => [
      session.nativeId,
      session.native.carrier.toolOutputs,
    ]));
    assert.deepEqual(outputsBySession.get("ses_root_alpha"), [{
      nativePath: sourceToolOutput,
      relativePath: "opencode/tool-output/tool_fixture_output",
      available: true,
    }]);
    assert.deepEqual(outputsBySession.get("ses_child_alpha"), []);
    assert.deepEqual(outputsBySession.get("ses_archived_beta"), []);

    const child = listData.sessions.find((session) => session.title === "Child conversation")!;
    const selectedArchive = path.join(root, "opencode-selected.agenthist");
    const selectedExport = await runCli([
      "--json", "--state-dir", state, "export", "--session", child.session_ref, "-o", selectedArchive,
    ], runtime);
    assert.equal(selectedExport.exitCode, 0, selectedExport.stderr);
    const selectedInspect = await runCli(["--json", "inspect", selectedArchive], runtime);
    assert.equal(selectedInspect.exitCode, 0, selectedInspect.stderr);
    const selectedEntries = (JSON.parse(selectedInspect.stdout) as {
      data: { entries: Array<{ title: string }> };
    }).data.entries;
    assert.deepEqual(new Set(selectedEntries.map((entry) => entry.title)), new Set(["Root conversation", "Child conversation"]));

    await rm(dataRoot, { recursive: true, maxRetries: 5, retryDelay: 100 });
    await rm(sourceBase, { recursive: true });

    const fullArchive = path.join(root, "opencode-full.agenthist");
    const exported = await runCli([
      "--json", "--state-dir", state, "export", "--agent", "opencode", "-o", fullArchive,
    ], runtime);
    assert.equal(exported.exitCode, 0, exported.stderr);
    const exportData = (JSON.parse(exported.stdout) as { data: { entries: number; objects: number } }).data;
    assert.equal(exportData.entries, 3);
    assert.equal(exportData.objects, 4);
    const inspected = await runCli(["--json", "inspect", fullArchive], runtime);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    const inspectedEntries = (JSON.parse(inspected.stdout) as {
      data: { entries: Array<{ title: string; objects: number }> };
    }).data.entries;
    assert.equal(inspectedEntries.length, 3);
    assert.equal(inspectedEntries.find((entry) => entry.title === "Archived conversation")?.objects, 2);
    assert.equal(inspectedEntries.find((entry) => entry.title === "Root conversation")?.objects, 3);

    const targetRoot = path.join(root, "target-opencode");
    const targetDatabase = path.join(targetRoot, "opencode.db");
    const targetState = path.join(root, "target-state");
    const targetPlan = path.join(
      root, "target-work", "work", ".opencode", "plans", "1786240000000-root-alpha.md",
    );
    await mkdir(targetRoot, { recursive: true });
    await mkdir(path.join(root, "target-work", "work"), { recursive: true });
    await mkdir(path.join(root, "target-work", "archive"), { recursive: true });
    createSource(targetDatabase);
    clearTarget(targetDatabase);
    const importGlobals = ["--json", "--state-dir", targetState];
    const selectedImport = [
      ...importGlobals,
      "import", selectedArchive,
      "--target", `opencode=${targetRoot}`,
      "--map-path", `${sourceBase}=${path.join(root, "target-work")}`,
    ];
    const dryRun = await runCli([...selectedImport, "--dry-run"], runtime);
    assert.equal(dryRun.exitCode, 0, dryRun.stderr);
    const dryRunData = (JSON.parse(dryRun.stdout) as {
      data: { new_sessions: number; written: number };
    }).data;
    assert.equal(dryRunData.new_sessions, 2);
    assert.equal(dryRunData.written, 0);
    const beforeApply = new DatabaseSync(targetDatabase, { readOnly: true });
    assert.equal((beforeApply.prepare("SELECT count(*) AS count FROM session").get() as { count: number }).count, 0);
    beforeApply.close();

    const imported = await runCli([...selectedImport, "--apply"], runtime);
    assert.equal(imported.exitCode, 0, imported.stderr);
    const importedData = (JSON.parse(imported.stdout) as {
      data: { written: number; already_present: number; agents: Array<{ transaction_ref?: string }> };
    }).data;
    assert.equal(importedData.written, 2);
    assert.equal(importedData.already_present, 0);
    const importedReference = importedData.agents[0]!.transaction_ref!;
    assert.match(importedReference, /^ahtx1_/);
    const targetAfterImport = new DatabaseSync(targetDatabase, { readOnly: true });
    assert.equal((targetAfterImport.prepare("SELECT count(*) AS count FROM session").get() as { count: number }).count, 2);
    assert.equal(
      (targetAfterImport.prepare("SELECT directory FROM session WHERE id = 'ses_root_alpha'").get() as { directory: string }).directory,
      path.join(root, "target-work", "work"),
    );
    const importedProject = targetAfterImport.prepare(
      "SELECT worktree, sandboxes, future_project_field FROM project WHERE id = 'prj_history_fixture'",
    ).get() as { worktree: string; sandboxes: string; future_project_field: string };
    assert.deepEqual({ ...importedProject }, {
      worktree: path.join(root, "target-work", "work"),
      sandboxes: "[]",
      future_project_field: "additive-project-value",
    });
    assert.equal(
      (targetAfterImport.prepare("SELECT count(*) AS count FROM project_directory").get() as { count: number }).count,
      0,
    );
    const restoredToolOutput = path.join(targetRoot, "tool-output", "tool_fixture_output");
    const projectedToolPart = JSON.parse((targetAfterImport.prepare(
      "SELECT data FROM part WHERE id = 'prt_root_truncated'",
    ).get() as { data: string }).data) as { state: { output: string; metadata: { outputPath: string } } };
    assert.equal(projectedToolPart.state.metadata.outputPath, restoredToolOutput);
    assert.match(projectedToolPart.state.output, new RegExp(restoredToolOutput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    targetAfterImport.close();
    assert.equal(await readFile(restoredToolOutput, "utf8"), toolOutputContents);
    assert.equal(await readFile(targetPlan, "utf8"), planContents);

    const repeatedSelected = await runCli([...selectedImport, "--apply"], runtime);
    assert.equal(repeatedSelected.exitCode, 0, repeatedSelected.stderr);
    const repeatedSelectedData = (JSON.parse(repeatedSelected.stdout) as {
      data: { written: number; already_present: number; agents: Array<{ transaction_ref?: string }> };
    }).data;
    assert.equal(repeatedSelectedData.written, 0);
    assert.equal(repeatedSelectedData.already_present, 2);
    assert.equal(repeatedSelectedData.agents[0]!.transaction_ref, undefined);

    const selectedRollback = await runCli([
      ...importGlobals, "transaction", "rollback", importedReference, "--apply",
    ], runtime);
    assert.equal(selectedRollback.exitCode, 0, selectedRollback.stderr);
    const afterSelectedRollback = new DatabaseSync(targetDatabase, { readOnly: true });
    assert.equal((afterSelectedRollback.prepare("SELECT count(*) AS count FROM session").get() as { count: number }).count, 0);
    afterSelectedRollback.close();
    await assert.rejects(readFile(restoredToolOutput), { code: "ENOENT" });
    await assert.rejects(readFile(targetPlan), { code: "ENOENT" });
    const reimportedSelected = await runCli([...selectedImport, "--apply"], runtime);
    assert.equal(reimportedSelected.exitCode, 0, reimportedSelected.stderr);
    assert.equal(await readFile(restoredToolOutput, "utf8"), toolOutputContents);
    assert.equal(await readFile(targetPlan, "utf8"), planContents);

    const fullImport = [
      ...importGlobals,
      "import", fullArchive,
      "--target", `opencode=${targetRoot}`,
      "--map-path", `${sourceBase}=${path.join(root, "target-work")}`,
    ];
    const completed = await runCli([...fullImport, "--apply"], runtime);
    assert.equal(completed.exitCode, 0, completed.stderr);
    const completedData = (JSON.parse(completed.stdout) as {
      data: { written: number; already_present: number; agents: Array<{ transaction_ref?: string }> };
    }).data;
    assert.equal(completedData.written, 1);
    assert.equal(completedData.already_present, 2);
    const completedReference = completedData.agents[0]!.transaction_ref!;
    assert.match(completedReference, /^ahtx1_/);
    const restoredSessionDiff = path.join(targetRoot, "storage", "session_diff", "ses_archived_beta.json");
    assert.equal(await readFile(restoredSessionDiff, "utf8"), archivedDiffContents);

    const repeatedFull = await runCli([...fullImport, "--apply"], runtime);
    assert.equal(repeatedFull.exitCode, 0, repeatedFull.stderr);
    const repeatedFullData = (JSON.parse(repeatedFull.stdout) as {
      data: { written: number; already_present: number; agents: Array<{ transaction_ref?: string }> };
    }).data;
    assert.equal(repeatedFullData.written, 0);
    assert.equal(repeatedFullData.already_present, 3);
    assert.equal(repeatedFullData.agents[0]!.transaction_ref, undefined);

    const completedId = completedReference.slice("ahtx1_".length);
    const journalPath = path.join(targetState, "transactions", completedId, "journal.json");
    const interrupted = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    interrupted.state = "needs_recovery";
    interrupted.phase = "needs_recovery";
    interrupted.failure = "opencode.commit_response_lost";
    await writeFile(journalPath, `${JSON.stringify(interrupted, null, 2)}\n`, { mode: 0o600 });
    const recovered = await runCli([
      ...importGlobals, "transaction", "recover", completedReference, "--apply",
    ], runtime);
    assert.equal(recovered.exitCode, 0, recovered.stderr);
    assert.equal(await readFile(restoredSessionDiff, "utf8"), archivedDiffContents);

    const fullRollback = await runCli([
      ...importGlobals, "transaction", "rollback", completedReference, "--apply",
    ], runtime);
    assert.equal(fullRollback.exitCode, 0, fullRollback.stderr);
    const remaining = new DatabaseSync(targetDatabase, { readOnly: true });
    assert.equal((remaining.prepare("SELECT count(*) AS count FROM session").get() as { count: number }).count, 2);
    remaining.close();
    await assert.rejects(readFile(restoredSessionDiff), { code: "ENOENT" });
    assert.equal(await readFile(restoredToolOutput, "utf8"), toolOutputContents);

    const sidecarOnlyRoot = path.join(root, "sidecar-only-opencode");
    const sidecarOnlyDatabase = path.join(sidecarOnlyRoot, "opencode.db");
    const sidecarOnlyState = path.join(root, "sidecar-only-state");
    await mkdir(sidecarOnlyRoot, { recursive: true });
    const sidecarOnlyToolOutput = path.join(sidecarOnlyRoot, "tool-output", "tool_fixture_output");
    await mkdir(path.dirname(sidecarOnlyToolOutput), { recursive: true });
    await writeFile(sidecarOnlyToolOutput, toolOutputContents, { mode: 0o600 });
    createSource(sidecarOnlyDatabase, sidecarOnlyToolOutput, undefined, sourceBase);
    const existing = new DatabaseSync(sidecarOnlyDatabase);
    existing.prepare(
      "UPDATE project SET worktree = ?, sandboxes = '[]', future_project_field = 'target-local-project-value' " +
        "WHERE id = 'prj_history_fixture'",
    ).run(path.join(root, "target-work", "work"));
    existing.prepare("DELETE FROM project_directory WHERE project_id = 'prj_history_fixture'").run();
    existing.prepare(
      "INSERT INTO project_directory VALUES (?, ?, 'main', NULL, ?)",
    ).run("prj_history_fixture", path.join(root, "target-work", "work"), 1786240099000);
    existing.prepare("UPDATE session SET directory = ? WHERE id IN ('ses_root_alpha', 'ses_child_alpha')")
      .run(path.join(root, "target-work", "work"));
    existing.prepare("UPDATE session SET directory = ? WHERE id = 'ses_archived_beta'")
      .run(path.join(root, "target-work", "archive"));
    existing.close();
    const sidecarOnlyImport = [
      "--json", "--state-dir", sidecarOnlyState,
      "import", fullArchive,
      "--target", `opencode=${sidecarOnlyRoot}`,
      "--map-path", `${sourceBase}=${path.join(root, "target-work")}`,
    ];
    const repaired = await runCli([...sidecarOnlyImport, "--apply"], runtime);
    assert.equal(repaired.exitCode, 0, repaired.stderr);
    const repairedData = (JSON.parse(repaired.stdout) as {
      data: { written: number; already_present: number; agents: Array<{ transaction_ref?: string }> };
    }).data;
    assert.equal(repairedData.written, 1);
    assert.equal(repairedData.already_present, 2);
    const repairedReference = repairedData.agents[0]!.transaction_ref!;
    const repairedSidecar = path.join(sidecarOnlyRoot, "storage", "session_diff", "ses_archived_beta.json");
    assert.equal(await readFile(repairedSidecar, "utf8"), archivedDiffContents);
    const repairedRollback = await runCli([
      "--json", "--state-dir", sidecarOnlyState,
      "transaction", "rollback", repairedReference, "--apply",
    ], runtime);
    assert.equal(repairedRollback.exitCode, 0, repairedRollback.stderr);
    const preserved = new DatabaseSync(sidecarOnlyDatabase, { readOnly: true });
    assert.equal((preserved.prepare("SELECT count(*) AS count FROM session").get() as { count: number }).count, 3);
    const preservedProject = preserved.prepare(
      "SELECT worktree, sandboxes, future_project_field FROM project WHERE id = 'prj_history_fixture'",
    ).get() as { worktree: string; sandboxes: string; future_project_field: string };
    assert.deepEqual({ ...preservedProject }, {
      worktree: path.join(root, "target-work", "work"),
      sandboxes: "[]",
      future_project_field: "target-local-project-value",
    });
    const preservedDirectories = preserved.prepare(
      "SELECT directory FROM project_directory WHERE project_id = ? ORDER BY directory",
    ).all("prj_history_fixture") as Array<{ directory: string }>;
    assert.deepEqual(preservedDirectories.map((row) => row.directory), [path.join(root, "target-work", "work")]);
    preserved.close();
    await assert.rejects(readFile(repairedSidecar), { code: "ENOENT" });
    assert.equal(await readFile(sidecarOnlyToolOutput, "utf8"), toolOutputContents);
    assert.equal(await readFile(targetPlan, "utf8"), planContents);

    const searched = await runCli([
      "--json", "--state-dir", state, "history", "search", "persisted search", "--agent", "opencode",
    ], runtime);
    assert.equal(searched.exitCode, 0, searched.stderr);
    assert.equal((JSON.parse(searched.stdout) as { data: { total_hits: number } }).data.total_hits, 1);

    const rootSession = listData.sessions.find((session) => session.title === "Root conversation")!;
    const shown = await runCli([
      "--json", "--state-dir", state, "history", "show", rootSession.session_ref,
    ], runtime);
    assert.equal(shown.exitCode, 0, shown.stderr);
    assert.match(shown.stdout, /persisted search marker/);

    const toolSearch = await runCli([
      "--json", "--state-dir", state, "history", "search", "tool output remains", "--agent", "opencode",
    ], runtime);
    assert.equal(toolSearch.exitCode, 0, toolSearch.stderr);
    assert.equal((JSON.parse(toolSearch.stdout) as { data: { total_hits: number } }).data.total_hits, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode keeps pending-input and active-revert sessions readable but blocks migration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-ts-opencode-pending-"));
  const dataRoot = path.join(root, "opencode-data");
  const state = path.join(root, "state");
  try {
    await mkdir(dataRoot, { recursive: true });
    const sourceBase = path.join(root, "source-work");
    await mkdir(path.join(sourceBase, "work"), { recursive: true });
    createSource(path.join(dataRoot, "opencode.db"), undefined, "ses_archived_beta", sourceBase);
    const live = new DatabaseSync(path.join(dataRoot, "opencode.db"));
    live.exec(`
      ALTER TABLE session ADD COLUMN revert TEXT;
      UPDATE session SET revert = 'null' WHERE id = 'ses_child_gamma';
      INSERT INTO session (
        id, slug, project_id, parent_id, directory, path, title, version, model,
        time_created, time_updated, time_archived, future_session_field, revert
      ) VALUES (
        'ses_z_active_revert', 'active-revert', 'prj_history_fixture', NULL, '/source/work', '.', 'Reverted conversation',
        'capability-shaped-build', '{"id":"gpt-5.4","providerID":"provider-alpha"}',
        1786240040000, 1786240041000, NULL, 'additive-revert-value',
        '{"messageID":"msg_revert_user","snapshot":"snapshot_external_to_history"}'
      );
      INSERT INTO message VALUES (
        'msg_revert_user', 'ses_z_active_revert', 1786240040000, 1786240040000,
        '{"role":"user","model":{"providerID":"provider-alpha","modelID":"gpt-5.4"}}'
      );
      INSERT INTO part VALUES (
        'prt_revert_user', 'msg_revert_user', 'ses_z_active_revert', 1786240040000, 1786240040000,
        '{"type":"text","text":"active revert remains readable"}'
      );
    `);
    live.prepare("UPDATE session SET directory = ? WHERE id = 'ses_z_active_revert'")
      .run(path.join(sourceBase, "work"));
    live.close();
    const runtime = { environment: { HOME: root }, cwd: root, home: root };
    const scanned = await runCli([
      "--json", "--state-dir", state, "--opencode-data-root", dataRoot,
      "scan", "--agent", "opencode",
    ], runtime);
    assert.equal(scanned.exitCode, 0, scanned.stdout || scanned.stderr);

    const listed = await runCli([
      "--json", "--state-dir", state, "history", "list", "--agent", "opencode", "--view", "all",
    ], runtime);
    assert.equal(listed.exitCode, 0, listed.stderr);
    const sessions = (JSON.parse(listed.stdout) as {
      data: { sessions: Array<{ session_ref: string; title: string }> };
    }).data.sessions;
    const safe = sessions.find((session) => session.title === "Child conversation")!;
    const pending = sessions.find((session) => session.title === "Archived conversation")!;
    const reverted = sessions.find((session) => session.title === "Reverted conversation")!;

    const safeExport = await runCli([
      "--json", "--state-dir", state, "export", "--session", safe.session_ref,
      "-o", path.join(root, "safe.agenthist"),
    ], runtime);
    assert.equal(safeExport.exitCode, 0, safeExport.stderr);

    const pendingExport = await runCli([
      "--json", "--state-dir", state, "export", "--session", pending.session_ref,
      "-o", path.join(root, "pending.agenthist"),
    ], runtime);
    assert.notEqual(pendingExport.exitCode, 0);
    assert.match(
      (JSON.parse(pendingExport.stdout) as { error: { message: string } }).error.message,
      /pending input/,
    );

    const revertedExport = await runCli([
      "--json", "--state-dir", state, "export", "--session", reverted.session_ref,
      "-o", path.join(root, "reverted.agenthist"),
    ], runtime);
    assert.notEqual(revertedExport.exitCode, 0);
    assert.match(
      (JSON.parse(revertedExport.stdout) as { error: { message: string } }).error.message,
      /active revert/,
    );

    const fullExport = await runCli([
      "--json", "--state-dir", state, "export", "--agent", "opencode",
      "-o", path.join(root, "full.agenthist"),
    ], runtime);
    assert.notEqual(fullExport.exitCode, 0);
    assert.match(
      (JSON.parse(fullExport.stdout) as { error: { message: string } }).error.message,
      /pending input/,
    );

  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
