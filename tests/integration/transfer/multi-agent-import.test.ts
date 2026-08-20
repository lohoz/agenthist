import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { claudeProjectCarrier } from "../../../src/agents/claude/project.js";
import { openImportCatalog } from "../../../src/application/index.js";
import { runCli } from "../../../src/cli/program.js";
import { nativeFixturePath } from "../../support/native-path.js";

const CODEX_ID = "77777777-7777-4777-8777-777777777777";
const CLAUDE_ID = "88888888-8888-4888-8888-888888888888";
const CODEX_STATE_STORE = "history-store.sqlite";
const CODEX_WORKSPACE = nativeFixturePath("/source/codex");
const CLAUDE_WORKSPACE = nativeFixturePath("/source/claude");

function createCodexDatabase(databasePath: string, rolloutPath?: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
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
      model TEXT NOT NULL
    )
  `);
  if (rolloutPath !== undefined) {
    database.prepare(`
      INSERT INTO threads
        (id, rollout_path, created_at, updated_at, model_provider, cwd, title, archived, first_user_message, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      CODEX_ID,
      rolloutPath,
      1786251600,
      1786251602,
      "source-provider",
      CODEX_WORKSPACE,
      "Codex batch session",
      0,
      "Codex batch prompt",
      "gpt-5.4",
    );
  }
  database.close();
}

async function createCodexSource(home: string, sqliteHome: string): Promise<void> {
  const relative = path.join(
    "sessions", "2026", "08", "09", `rollout-2026-08-09T05-00-00-${CODEX_ID}.jsonl`,
  );
  const rolloutPath = path.join(home, relative);
  await mkdir(path.dirname(rolloutPath), { recursive: true });
  await mkdir(sqliteHome, { recursive: true });
  const records = [
    {
      timestamp: "2026-08-09T05:00:00.000Z",
      type: "session_meta",
      payload: {
        id: CODEX_ID,
        timestamp: "2026-08-09T05:00:00.000Z",
        cwd: CODEX_WORKSPACE,
        originator: "codex_cli_rs",
        cli_version: "format-capability-fixture",
        model_provider: "source-provider",
        model: "gpt-5.4",
      },
    },
    {
      timestamp: "2026-08-09T05:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex batch prompt" }] },
    },
    {
      timestamp: "2026-08-09T05:00:02.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex batch answer" }] },
    },
  ];
  await writeFile(rolloutPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  createCodexDatabase(path.join(sqliteHome, CODEX_STATE_STORE), rolloutPath);
}

async function createClaudeSource(configRoot: string): Promise<void> {
  const project = path.join(configRoot, "projects", claudeProjectCarrier(CLAUDE_WORKSPACE));
  await mkdir(project, { recursive: true });
  const records = [
    {
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "Claude batch prompt" },
      uuid: "99999999-9999-4999-8999-999999999991",
      timestamp: "2026-08-09T05:10:00.000Z",
      cwd: CLAUDE_WORKSPACE,
      sessionId: CLAUDE_ID,
      version: "format-capability-fixture",
    },
    {
      parentUuid: "99999999-9999-4999-8999-999999999991",
      isSidechain: false,
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Claude batch answer" }],
      },
      uuid: "99999999-9999-4999-8999-999999999992",
      timestamp: "2026-08-09T05:10:01.000Z",
      cwd: CLAUDE_WORKSPACE,
      sessionId: CLAUDE_ID,
      version: "another-format-capability-fixture",
    },
  ];
  await writeFile(path.join(project, `${CLAUDE_ID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
    mode: 0o600,
  });
}

test("one archive preflights and imports multiple Agents in product order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-ts-multi-import-"));
  const runtime = { environment: { HOME: root }, cwd: root, home: root };
  const sourceState = path.join(root, "source-state");
  const sourceCodex = path.join(root, "source-codex");
  const sourceSQLite = path.join(root, "source-sqlite");
  const sourceClaude = path.join(root, "source-claude-config");
  try {
    await createCodexSource(sourceCodex, sourceSQLite);
    await createClaudeSource(sourceClaude);
    const codexScan = await runCli([
      "--json", "--state-dir", sourceState,
      "--codex-home", sourceCodex, "--codex-sqlite-home", sourceSQLite,
      "scan", "--agent", "codex",
    ], runtime);
    assert.equal(codexScan.exitCode, 0, codexScan.stderr);
    const claudeScan = await runCli([
      "--json", "--state-dir", sourceState, "--claude-config-dir", sourceClaude,
      "scan", "--agent", "claude",
    ], runtime);
    assert.equal(claudeScan.exitCode, 0, claudeScan.stderr);

    const archive = path.join(root, "two-agents.agenthist");
    const exported = await runCli(["--json", "--state-dir", sourceState, "export", "-o", archive], runtime);
    assert.equal(exported.exitCode, 0, exported.stderr);
    assert.equal((JSON.parse(exported.stdout) as { data: { entries: number } }).data.entries, 2);
    const inspected = await runCli(["--json", "inspect", archive], runtime);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    const inspectedData = (JSON.parse(inspected.stdout) as {
      data: {
        workspaces: Array<{ source: string; agents: string[]; sessions: number }>;
        entries: Array<{ context: string }>;
      };
    }).data;
    const expectedWorkspaces = [
      { source: CLAUDE_WORKSPACE, agents: ["claude"], sessions: 1 },
      { source: CODEX_WORKSPACE, agents: ["codex"], sessions: 1 },
    ].sort((left, right) => left.source.localeCompare(right.source));
    assert.deepEqual(inspectedData.workspaces, expectedWorkspaces);
    assert.deepEqual(
      inspectedData.entries.map((entry) => entry.context).sort(),
      [CLAUDE_WORKSPACE, CODEX_WORKSPACE].sort(),
    );

    const workspaceArchive = path.join(root, "one-workspace.agenthist");
    const workspaceExport = await runCli([
      "--json", "--state-dir", sourceState, "export",
      "--workspace", CODEX_WORKSPACE,
      "--workspace", CODEX_WORKSPACE,
      "-o", workspaceArchive,
    ], runtime);
    assert.equal(workspaceExport.exitCode, 0, workspaceExport.stderr);
    assert.equal((JSON.parse(workspaceExport.stdout) as { data: { entries: number } }).data.entries, 1);
    const workspaceInspect = await runCli(["--json", "inspect", workspaceArchive], runtime);
    assert.equal(workspaceInspect.exitCode, 0, workspaceInspect.stderr);
    assert.deepEqual((JSON.parse(workspaceInspect.stdout) as {
      data: { entries: Array<{ agent: string; context: string }> };
    }).data.entries.map(({ agent, context }) => ({ agent, context })), [
      { agent: "codex", context: CODEX_WORKSPACE },
    ]);

    const missingWorkspace = await runCli([
      "--json", "--state-dir", sourceState, "export",
      "--workspace", nativeFixturePath("/source/missing"),
      "-o", path.join(root, "missing-workspace.agenthist"),
    ], runtime);
    assert.equal(missingWorkspace.exitCode, 3);
    assert.match((JSON.parse(missingWorkspace.stdout) as { error: { message: string } }).error.message,
      /selected history workspace was not found/);

    const catalog = await openImportCatalog(archive, root);
    try {
      assert.deepEqual(catalog.entries.map((entry) => entry.agent).sort(), ["claude", "codex"]);
      const codexEntry = catalog.entries.find((entry) => entry.agent === "codex")!;
      const preview = await catalog.preview(codexEntry.sessionRef);
      assert.equal(preview.title, "Codex batch session");
      assert.deepEqual(preview.conversation.map((item) => item.kind === "message" ? item.text : item.label), [
        "Codex batch prompt",
        "Codex batch answer",
      ]);
      const workspaceInspection = await catalog.inspectWorkspaces(
        catalog.entries.map((entry) => entry.sessionRef),
        Object.fromEntries(catalog.entries.map((entry) => [entry.sessionRef, entry.agent])),
        [],
      );
      assert.deepEqual(
        workspaceInspection.map((item) => [item.source, item.availability]),
        [CLAUDE_WORKSPACE, CODEX_WORKSPACE]
          .sort((left, right) => left.localeCompare(right))
          .map((source) => [source, "missing"]),
      );
    } finally {
      await catalog.close();
    }

    const targetState = path.join(root, "target-state");
    const targetCodex = path.join(root, "target-codex");
    const targetSQLite = path.join(root, "target-sqlite");
    const targetClaude = path.join(root, "target-claude");
    const targetCodexWork = path.join(root, "target-codex-work");
    const targetClaudeWork = path.join(root, "target-claude-work");
    await mkdir(targetCodex, { recursive: true });
    await mkdir(targetSQLite, { recursive: true });
    await mkdir(targetCodexWork, { recursive: true });
    await mkdir(targetClaudeWork, { recursive: true });
    await writeFile(path.join(targetCodex, "config.toml"), 'model_provider = "receiver-provider"\n');
    const codexConfigBefore = await readFile(path.join(targetCodex, "config.toml"));
    createCodexDatabase(path.join(targetSQLite, CODEX_STATE_STORE));

    const codexUnmapped = await runCli([
      "--json", "--state-dir", targetState, "--codex-sqlite-home", targetSQLite,
      "import", archive, "--agent", "codex", "--target", `codex=${targetCodex}`, "--dry-run",
    ], runtime);
    assert.equal(codexUnmapped.exitCode, 3);
    const codexUnmappedMessage = (JSON.parse(codexUnmapped.stdout) as { error: { message: string } }).error.message;
    assert.ok(codexUnmappedMessage.includes(`${CODEX_WORKSPACE}: target directory does not exist`));
    assert.ok(codexUnmappedMessage.includes(`use --map-path ${CODEX_WORKSPACE}=/absolute/target`));

    const unresolved = await runCli([
      "--json", "--state-dir", targetState, "--codex-sqlite-home", targetSQLite,
      "import", archive, "--target", `codex=${targetCodex}`, "--target", `claude=${targetClaude}`, "--dry-run",
    ], runtime);
    assert.equal(unresolved.exitCode, 3);
    const unresolvedMessage = (JSON.parse(unresolved.stdout) as { error: { message: string } }).error.message;
    assert.match(unresolvedMessage, /^workspace path resolution failed before import:/);
    assert.ok(unresolvedMessage.includes(`${CLAUDE_WORKSPACE}: target directory does not exist`));
    assert.ok(unresolvedMessage.includes(`use --map-path ${CLAUDE_WORKSPACE}=/absolute/target`));

    const importArguments = [
      "--json", "--state-dir", targetState, "--codex-sqlite-home", targetSQLite,
      "import", archive,
      "--target", `codex=${targetCodex}`,
      "--target", `claude=${targetClaude}`,
      "--map-path", `${CODEX_WORKSPACE}=${targetCodexWork}`,
      "--map-path", `${CLAUDE_WORKSPACE}=${targetClaudeWork}`,
    ];
    const blocked = await runCli([...importArguments, "--apply"], runtime);
    assert.equal(blocked.exitCode, 3);
    assert.equal(blocked.stderr, "");
    assert.match((JSON.parse(blocked.stdout) as { error: { message: string } }).error.message,
      /Claude Code config root does not exist/);
    const before = new DatabaseSync(path.join(targetSQLite, CODEX_STATE_STORE), { readOnly: true });
    assert.equal((before.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count, 0);
    before.close();

    await mkdir(targetClaude, { recursive: true });
    const planned = await runCli([...importArguments, "--dry-run"], runtime);
    assert.equal(planned.exitCode, 0, planned.stderr);
    const planData = (JSON.parse(planned.stdout) as {
      data: {
        new_sessions: number;
        written: number;
        agents: Array<{ agent: string; transaction_ref?: string }>;
        workspaces: Array<{ source: string; target: string; status: string; agents: string[]; sessions: number }>;
        items: Array<{ source_cwd: string; cwd: string; workspace_status: string }>;
      };
    }).data;
    assert.equal(planData.new_sessions, 2);
    assert.equal(planData.written, 0);
    assert.deepEqual(planData.agents.map((item) => item.agent), ["codex", "claude"]);
    assert.equal(planData.agents.every((item) => item.transaction_ref === undefined), true);
    assert.deepEqual(planData.workspaces, [
      { source: CLAUDE_WORKSPACE, target: targetClaudeWork, status: "mapped", agents: ["claude"], sessions: 1 },
      { source: CODEX_WORKSPACE, target: targetCodexWork, status: "mapped", agents: ["codex"], sessions: 1 },
    ].sort((left, right) => left.source.localeCompare(right.source)));
    assert.deepEqual(
      planData.items.map((item) => [item.source_cwd, item.cwd, item.workspace_status]).sort(),
      [
        [CLAUDE_WORKSPACE, targetClaudeWork, "mapped"],
        [CODEX_WORKSPACE, targetCodexWork, "mapped"],
      ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    );

    const imported = await runCli([...importArguments, "--apply"], runtime);
    assert.equal(imported.exitCode, 0, imported.stderr);
    const importData = (JSON.parse(imported.stdout) as {
      data: {
        written: number;
        already_present: number;
        agents: Array<{ agent: string; transaction_ref?: string }>;
        items: Array<{ target_agent: string; destination: string }>;
      };
    }).data;
    assert.equal(importData.written, 2);
    assert.equal(importData.already_present, 0);
    assert.deepEqual(importData.agents.map((item) => item.agent), ["codex", "claude"]);
    assert.equal(importData.agents.every((item) => /^ahtx1_/.test(item.transaction_ref ?? "")), true);

    const repeated = await runCli([...importArguments, "--apply"], runtime);
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    const repeatedData = (JSON.parse(repeated.stdout) as {
      data: { written: number; already_present: number; agents: Array<{ transaction_ref?: string }> };
    }).data;
    assert.equal(repeatedData.written, 0);
    assert.equal(repeatedData.already_present, 2);
    assert.equal(repeatedData.agents.every((item) => item.transaction_ref === undefined), true);

    const targetList = await runCli([
      "--json", "--state-dir", targetState, "history", "list", "--view", "all",
    ], runtime);
    assert.equal(targetList.exitCode, 0, targetList.stderr);
    assert.deepEqual((JSON.parse(targetList.stdout) as {
      data: { sessions: Array<{ agent: string }> };
    }).data.sessions.map((session) => session.agent).sort(), ["claude", "codex"]);
    const transactions = await runCli([
      "--json", "--state-dir", targetState, "transaction", "list",
    ], runtime);
    assert.equal(transactions.exitCode, 0, transactions.stderr);
    assert.equal((JSON.parse(transactions.stdout) as {
      data: { transactions: unknown[] };
    }).data.transactions.length, 2);

    const claudeDestination = importData.items.find((item) => item.target_agent === "claude")!.destination;
    const claudeFiles = await readFile(claudeDestination, "utf8");
    assert.match(claudeFiles, /Claude batch answer/);
    assert.deepEqual(await readFile(path.join(targetCodex, "config.toml")), codexConfigBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
