import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { claudeProjectCarrier } from "../../../src/agents/claude/project.js";
import { parsePiSession } from "../../../src/agents/pi/history/session.js";
import { runCli } from "../../../src/cli/program.js";
import { nativeFixturePath } from "../../support/native-path.js";
import { createCodexTargetDatabase } from "../../support/conversion/codex-target.js";
import { createOpenCodeTargetDatabase } from "../../support/conversion/opencode-target.js";

const PI_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";
const CLAUDE_ID = "33333333-3333-4333-8333-333333333333";
const PI_WORKSPACE = nativeFixturePath("/source/pi-conversion");
const CODEX_WORKSPACE = nativeFixturePath("/source/codex-to-pi");
const CLAUDE_WORKSPACE = nativeFixturePath("/source/claude-to-pi");
const OPENCODE_WORKSPACE = nativeFixturePath("/source/opencode-to-pi");
const PI_USER_MARKER = "Pi conversion user marker";
const PI_ACTIVE_BRANCH_MARKER = "Pi active branch marker";
const PI_INACTIVE_BRANCH_MARKER = "Pi inactive branch marker";
const PI_TOOL_MARKER = "Pi conversion tool output marker";
const PI_ANSWER_MARKER = "Pi conversion final answer marker";
const PI_USER_IMAGE = Buffer.from("pi-user-image-evidence", "utf8");
const PI_TOOL_IMAGE = Buffer.from("pi-tool-image-evidence", "utf8");

type Runtime = {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly home: string;
};

interface ImportItem {
  readonly target_session_ref: string;
  readonly destination: string;
}

interface ImportResource {
  readonly name: string;
  readonly materialized_path: string;
}

interface ImportConversionResult {
  readonly item: ImportItem;
  readonly resources: readonly ImportResource[];
  readonly findingCodes: readonly string[];
}

function conversationText(output: string): string {
  const parsed = JSON.parse(output) as { data: { conversation: Array<{ text?: string; label?: string }> } };
  return parsed.data.conversation.map((item) => item.text ?? item.label ?? "").join("\n");
}

function assistantMessage(content: readonly Record<string, unknown>[], timestamp: number) {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "fixture-provider",
    model: "gpt-5.4",
    usage: {
      input: 12,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

async function createPiSource(sessionRoot: string): Promise<void> {
  const start = Date.parse("2026-08-17T01:00:00.000Z");
  const records = [{
    type: "session",
    version: 3,
    id: PI_ID,
    timestamp: "2026-08-17T01:00:00.000Z",
    cwd: PI_WORKSPACE,
  }, {
    type: "session_info",
    id: "aaaaaaaa",
    parentId: null,
    timestamp: "2026-08-17T01:00:00.000Z",
    name: "Pi conversion session",
  }, {
    type: "message",
    id: "bbbbbbbb",
    parentId: "aaaaaaaa",
    timestamp: "2026-08-17T01:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: PI_USER_MARKER }], timestamp: start + 1_000 },
  }, {
    type: "message",
    id: "cccccccc",
    parentId: "bbbbbbbb",
    timestamp: "2026-08-17T01:00:02.000Z",
    message: assistantMessage([{ type: "text", text: PI_INACTIVE_BRANCH_MARKER }], start + 2_000),
  }, {
    type: "message",
    id: "dddddddd",
    parentId: "bbbbbbbb",
    timestamp: "2026-08-17T01:00:03.000Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: PI_ACTIVE_BRANCH_MARKER },
        { type: "image", data: PI_USER_IMAGE.toString("base64"), mimeType: "image/png" },
      ],
      timestamp: start + 3_000,
    },
  }, {
    type: "message",
    id: "eeeeeeee",
    parentId: "dddddddd",
    timestamp: "2026-08-17T01:00:04.000Z",
    message: assistantMessage([
      { type: "thinking", thinking: "Pi historical reasoning marker" },
      { type: "toolCall", id: "call_read", name: "read", arguments: { path: "notes.txt" } },
    ], start + 4_000),
  }, {
    type: "message",
    id: "ffffffff",
    parentId: "eeeeeeee",
    timestamp: "2026-08-17T01:00:05.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_read",
      toolName: "read",
      content: [
        { type: "text", text: PI_TOOL_MARKER },
        { type: "image", data: PI_TOOL_IMAGE.toString("base64"), mimeType: "image/png" },
      ],
      isError: false,
      timestamp: start + 5_000,
    },
  }, {
    type: "message",
    id: "11111111",
    parentId: "ffffffff",
    timestamp: "2026-08-17T01:00:06.000Z",
    message: assistantMessage([{ type: "text", text: PI_ANSWER_MARKER }], start + 6_000),
  }];
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(
    path.join(sessionRoot, `2026-08-17T01-00-00-000Z_${PI_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600 },
  );
}

async function createCodexSource(home: string, sqliteHome: string): Promise<void> {
  const rollout = path.join(home, "sessions", "2026", "08", "17", `rollout-2026-08-17T02-00-00-${CODEX_ID}.jsonl`);
  await mkdir(path.dirname(rollout), { recursive: true });
  await mkdir(sqliteHome, { recursive: true });
  const records = [{
    timestamp: "2026-08-17T02:00:00.000Z",
    type: "session_meta",
    payload: {
      id: CODEX_ID,
      timestamp: "2026-08-17T02:00:00.000Z",
      cwd: CODEX_WORKSPACE,
      originator: "codex_cli_rs",
      cli_version: "format-compatible-fixture",
      model_provider: "fixture-provider",
      model: "gpt-5.4",
    },
  }, {
    timestamp: "2026-08-17T02:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex to Pi user marker" }] },
  }, {
    timestamp: "2026-08-17T02:00:02.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex to Pi answer marker" }] },
  }];
  await writeFile(rollout, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
  const databasePath = path.join(sqliteHome, "state_5.sqlite");
  createCodexTargetDatabase(databasePath);
  const database = new DatabaseSync(databasePath);
  database.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, archived, first_user_message, model, memory_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    CODEX_ID, rollout, 1786932000, 1786932002, "cli", "fixture-provider", CODEX_WORKSPACE,
    "Codex to Pi session", "workspace-write", "on-request", 0,
    "Codex to Pi user marker", "gpt-5.4", "disabled",
  );
  database.close();
}

async function createClaudeSource(configRoot: string): Promise<void> {
  const project = path.join(configRoot, "projects", claudeProjectCarrier(CLAUDE_WORKSPACE));
  await mkdir(project, { recursive: true });
  const records = [{
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: "Claude to Pi user marker" },
    uuid: "44444444-4444-4444-8444-444444444441",
    timestamp: "2026-08-17T03:00:00.000Z",
    cwd: CLAUDE_WORKSPACE,
    sessionId: CLAUDE_ID,
    version: "format-compatible-fixture",
  }, {
    parentUuid: "44444444-4444-4444-8444-444444444441",
    isSidechain: false,
    type: "assistant",
    message: {
      role: "assistant",
      model: "gpt-5.4",
      content: [{ type: "text", text: "Claude to Pi answer marker" }],
    },
    uuid: "44444444-4444-4444-8444-444444444442",
    timestamp: "2026-08-17T03:00:01.000Z",
    cwd: CLAUDE_WORKSPACE,
    sessionId: CLAUDE_ID,
    version: "another-compatible-fixture",
  }];
  await writeFile(
    path.join(project, `${CLAUDE_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600 },
  );
}

async function createOpenCodeSource(dataRoot: string): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  const databasePath = path.join(dataRoot, "opencode.db");
  createOpenCodeTargetDatabase(databasePath);
  const database = new DatabaseSync(databasePath);
  database.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?)").run(
    "global", OPENCODE_WORKSPACE, 1786939200000, 1786939202000, "[]",
  );
  database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "ses_opencode_to_pi", "global", null, "opencode-to-pi", OPENCODE_WORKSPACE, ".",
    "OpenCode to Pi session", "format-compatible-fixture", 0, "build",
    JSON.stringify({ id: "gpt-5.4", providerID: "fixture-provider" }),
    1786939200000, 1786939202000, null,
  );
  database.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "msg_opencode_user", "ses_opencode_to_pi", 1786939200000, 1786939200000,
    JSON.stringify({ role: "user", model: { providerID: "fixture-provider", modelID: "gpt-5.4" } }),
  );
  database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "prt_opencode_user", "msg_opencode_user", "ses_opencode_to_pi", 1786939200000, 1786939200000,
    JSON.stringify({ type: "text", text: "OpenCode to Pi user marker" }),
  );
  database.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "msg_opencode_assistant", "ses_opencode_to_pi", 1786939201000, 1786939202000,
    JSON.stringify({ role: "assistant", providerID: "fixture-provider", modelID: "gpt-5.4", finish: "stop" }),
  );
  database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "prt_opencode_assistant", "msg_opencode_assistant", "ses_opencode_to_pi", 1786939201000, 1786939202000,
    JSON.stringify({ type: "text", text: "OpenCode to Pi answer marker" }),
  );
  database.close();
}

async function scanAndExport(
  runtime: Runtime,
  state: string,
  archive: string,
  agent: "codex" | "claude" | "opencode" | "pi",
  globals: readonly string[],
): Promise<void> {
  const scanned = await runCli(["--json", "--state-dir", state, ...globals, "scan", "--agent", agent], runtime);
  assert.equal(scanned.exitCode, 0, scanned.stderr);
  const exported = await runCli(["--json", "--state-dir", state, "export", "--agent", agent, "-o", archive], runtime);
  assert.equal(exported.exitCode, 0, exported.stderr);
}

async function importConversion(options: {
  readonly runtime: Runtime;
  readonly state: string;
  readonly archive: string;
  readonly source: "codex" | "claude" | "opencode" | "pi";
  readonly target: "codex" | "claude" | "opencode" | "pi";
  readonly globals?: readonly string[];
  readonly targetRoot: string;
  readonly sourceWorkspace: string;
  readonly targetWorkspace: string;
}): Promise<ImportConversionResult> {
  const args = [
    "--json", "--state-dir", options.state, ...(options.globals ?? []),
    "import", options.archive, "--agent", options.source, "--to", options.target,
    "--target", `${options.target}=${options.targetRoot}`,
    "--map-path", `${options.sourceWorkspace}=${options.targetWorkspace}`,
  ];
  const planned = await runCli([...args, "--dry-run"], options.runtime);
  assert.equal(planned.exitCode, 0, planned.stdout || planned.stderr);
  const plan = (JSON.parse(planned.stdout) as {
    data: {
      status: string;
      routes: Array<{
        source_agent: string;
        target_agent: string;
        quality: string;
        findings: Array<{ code: string }>;
      }>;
      items: ImportItem[];
    };
  }).data;
  assert.equal(plan.status, "ready");
  assert.deepEqual(
    plan.routes.map((route) => [route.source_agent, route.target_agent, route.quality]),
    [[options.source, options.target, "degraded"]],
  );
  assert.equal(plan.items.length, 1);
  const applied = await runCli([...args, "--apply"], options.runtime);
  assert.equal(applied.exitCode, 0, applied.stdout || applied.stderr);
  const result = (JSON.parse(applied.stdout) as {
    data: { written: number; items: ImportItem[]; resources: ImportResource[] };
  }).data;
  assert.equal(result.written, 1);
  assert.equal(result.items.length, 1);
  return {
    item: result.items[0]!,
    resources: result.resources,
    findingCodes: plan.routes[0]!.findings.map((finding) => finding.code),
  };
}

test("Pi conversions complete all six routes and remain readable in the target Agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-pi-conversion-"));
  const runtime = { environment: { HOME: root }, cwd: root, home: root };
  try {
    const piSource = path.join(root, "pi-source");
    const piState = path.join(root, "pi-state");
    const piArchive = path.join(root, "pi.agenthist");
    await createPiSource(piSource);
    await scanAndExport(runtime, piState, piArchive, "pi", ["--pi-session-dir", piSource]);

    for (const target of ["codex", "claude", "opencode"] as const) {
      const targetRoot = path.join(root, `pi-to-${target}`);
      const targetState = path.join(root, `pi-to-${target}-state`);
      const targetWorkspace = path.join(root, `pi-to-${target}-workspace`);
      await mkdir(targetRoot, { recursive: true });
      await mkdir(targetWorkspace, { recursive: true });
      let globals: readonly string[] = [];
      if (target === "codex") {
        const sqliteHome = path.join(root, "pi-to-codex-sqlite");
        await mkdir(sqliteHome, { recursive: true });
        await writeFile(path.join(targetRoot, "config.toml"), 'model_provider = "target-provider"\n');
        createCodexTargetDatabase(path.join(sqliteHome, "state_5.sqlite"));
        globals = ["--codex-sqlite-home", sqliteHome];
      } else if (target === "opencode") {
        createOpenCodeTargetDatabase(path.join(targetRoot, "opencode.db"));
      }
      const converted = await importConversion({
        runtime,
        state: targetState,
        archive: piArchive,
        source: "pi",
        target,
        globals,
        targetRoot,
        sourceWorkspace: PI_WORKSPACE,
        targetWorkspace,
      });
      const { item } = converted;
      assert.deepEqual(converted.resources.map((resource) => resource.name).sort(), [
        "pi-dddddddd-1.png",
        "pi-ffffffff-1.png",
      ]);
      assert.deepEqual(
        await readFile(converted.resources.find((resource) => resource.name === "pi-dddddddd-1.png")!.materialized_path),
        PI_USER_IMAGE,
      );
      assert.deepEqual(
        await readFile(converted.resources.find((resource) => resource.name === "pi-ffffffff-1.png")!.materialized_path),
        PI_TOOL_IMAGE,
      );
      for (const code of [
        "pi.branch_structure.skipped",
        "pi.inactive_branch.skipped",
        "pi.inline_image.managed",
        "pi.reasoning_trace.degraded",
        "pi.tool_history.degraded",
      ]) assert.equal(converted.findingCodes.includes(code), true, `${target} missing ${code}`);
      const shown = await runCli(["--json", "--state-dir", targetState, "history", "show", item.target_session_ref], runtime);
      assert.equal(shown.exitCode, 0, shown.stderr);
      const history = conversationText(shown.stdout);
      assert.match(history, new RegExp(PI_USER_MARKER));
      assert.match(history, new RegExp(PI_ACTIVE_BRANCH_MARKER));
      assert.doesNotMatch(history, new RegExp(PI_INACTIVE_BRANCH_MARKER));
      assert.match(history, new RegExp(PI_TOOL_MARKER));
      assert.match(history, new RegExp(PI_ANSWER_MARKER));
    }

    const codexSource = path.join(root, "codex-source");
    const codexSQLite = path.join(root, "codex-source-sqlite");
    const claudeSource = path.join(root, "claude-source");
    const openCodeSource = path.join(root, "opencode-source");
    await createCodexSource(codexSource, codexSQLite);
    await createClaudeSource(claudeSource);
    await createOpenCodeSource(openCodeSource);

    const sources = [{
      agent: "codex" as const,
      workspace: CODEX_WORKSPACE,
      markers: ["Codex to Pi user marker", "Codex to Pi answer marker"],
      globals: ["--codex-home", codexSource, "--codex-sqlite-home", codexSQLite],
    }, {
      agent: "claude" as const,
      workspace: CLAUDE_WORKSPACE,
      markers: ["Claude to Pi user marker", "Claude to Pi answer marker"],
      globals: ["--claude-config-dir", claudeSource],
    }, {
      agent: "opencode" as const,
      workspace: OPENCODE_WORKSPACE,
      markers: ["OpenCode to Pi user marker", "OpenCode to Pi answer marker"],
      globals: ["--opencode-data-root", openCodeSource],
    }];
    const piTarget = path.join(root, "converted-pi-target");
    const piTargetState = path.join(root, "converted-pi-state");
    await mkdir(piTarget, { recursive: true });

    for (const source of sources) {
      const state = path.join(root, `${source.agent}-source-state`);
      const archive = path.join(root, `${source.agent}-to-pi.agenthist`);
      const targetWorkspace = path.join(root, `${source.agent}-to-pi-workspace`);
      await mkdir(targetWorkspace, { recursive: true });
      await scanAndExport(runtime, state, archive, source.agent, source.globals);
      const { item } = await importConversion({
        runtime,
        state: piTargetState,
        archive,
        source: source.agent,
        target: "pi",
        targetRoot: piTarget,
        sourceWorkspace: source.workspace,
        targetWorkspace,
      });
      const parsed = await parsePiSession(item.destination, "2026-08-17T06:00:00.000Z");
      assert.equal(parsed.header.version, 3);
      assert.equal(parsed.header.cwd, targetWorkspace);
      assert.equal(parsed.provider, "agenthist-converted");
      const shown = await runCli(["--json", "--state-dir", piTargetState, "history", "show", item.target_session_ref], runtime);
      assert.equal(shown.exitCode, 0, shown.stderr);
      const history = conversationText(shown.stdout);
      for (const marker of source.markers) assert.match(history, new RegExp(marker));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
