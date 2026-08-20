import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type {
  ExportCatalog,
  ExportHistoryPlan,
  ExportHistoryResult,
  HistoryCatalogEntry,
} from "../../../src/application/index.js";
import {
  runExportWizard,
  type ExportWizardRequest,
} from "../../../src/cli/export-wizard/index.js";
import { cleanTerminalText } from "../../../src/cli/import-wizard/terminal.js";

const CODEX: HistoryCatalogEntry = {
  sessionRef: "ahsr1_codex_ck1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  agent: "codex",
  nativeId: "11111111-1111-4111-8111-111111111111",
  title: "Refactor the API boundary",
  workspace: "/work/api",
  model: "gpt-5.4",
  createdAt: "2026-08-20T01:00:00.000Z",
  updatedAt: "2026-08-20T01:05:00.000Z",
  nativeArchived: false,
  libraryState: "active",
  tags: [],
  resourceCount: 0,
};

const CLAUDE: HistoryCatalogEntry = {
  ...CODEX,
  sessionRef: "ahsr1_claude_ck1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  agent: "claude",
  nativeId: "22222222-2222-4222-8222-222222222222",
  title: "Review the experiment",
  workspace: "/work/paper",
  updatedAt: "2026-08-20T02:05:00.000Z",
};

const SKIPPED = {
  agent: "opencode" as const,
  sessionRef: "ahsr1_opencode_ck1_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  title: "Pending input session",
  reason: "session has pending input",
};

function plan(request: ExportWizardRequest): ExportHistoryPlan {
  return {
    file: path.resolve(request.output),
    entries: 2,
    objects: 2,
    resources: 0,
    agents: [
      { agent: "codex", sessions: 1 },
      { agent: "claude", sessions: 1 },
    ],
    items: [
      { agent: CODEX.agent, sessionRef: CODEX.sessionRef, title: CODEX.title, workspace: CODEX.workspace },
      { agent: CLAUDE.agent, sessionRef: CLAUDE.sessionRef, title: CLAUDE.title, workspace: CLAUDE.workspace },
    ],
    skippedSessions: [SKIPPED],
  };
}

function result(request: ExportWizardRequest): ExportHistoryResult {
  return {
    file: path.resolve(request.output),
    sizeBytes: 1024,
    sha256: "d".repeat(64),
    entries: 2,
    objects: 2,
    resources: 0,
    agents: plan(request).agents,
    skippedSessions: [SKIPPED],
  };
}

test("interactive export selects, previews, reviews, renames, and exports history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-export-wizard-"));
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 100;
  output.rows = 28;
  const initialArchive = path.join(root, "initial.agenthist");
  const selectedArchive = path.join(root, "selected.agenthist");
  let rendered = "";
  const actions: Array<{ readonly cue: string; readonly keys: string }> = [
    { cue: "Select history to export", keys: "\u001b[Cv" },
    { cue: "Session preview", keys: "\u001b" },
    { cue: "Select history to export", keys: "\r" },
    { cue: "Review export", keys: "o" },
    { cue: "Archive: ", keys: `\u0015${selectedArchive}\r` },
    { cue: "Review export", keys: "l" },
    { cue: "确认导出", keys: "\u001b[6~" },
    { cue: "Pending input session", keys: "\r" },
  ];
  let actionIndex = 0;
  let searchFrom = 0;
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString("utf8");
    const plain = rendered.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const action = actions[actionIndex];
    if (action !== undefined && plain.slice(searchFrom).includes(action.cue)) {
      actionIndex++;
      searchFrom = plain.length;
      setImmediate(() => { input.write(action.keys); });
    }
  });
  const catalog: ExportCatalog = {
    entries: [CODEX, CLAUDE],
    skippedSessions: [SKIPPED],
    closeSelection(sessionRefs) {
      const selected = new Set(sessionRefs);
      return [CODEX, CLAUDE].filter((entry) => selected.has(entry.sessionRef));
    },
    async preview(sessionRef) {
      const entry = sessionRef === CODEX.sessionRef ? CODEX : CLAUDE;
      return {
        ...entry,
        conversation: [
          { kind: "message", role: "user", text: "Check the selected history.", timestamp: entry.createdAt },
          { kind: "message", role: "assistant", text: "History checked.", timestamp: entry.updatedAt },
        ],
      };
    },
  };
  const plans: ExportWizardRequest[] = [];
  const executions: ExportWizardRequest[] = [];
  try {
    const outcome = await runExportWizard({
      catalog,
      input,
      output,
      cwd: root,
      archive: initialArchive,
      color: true,
      language: "en",
      async plan(request) {
        plans.push(request);
        return plan(request);
      },
      async execute(request) {
        executions.push(request);
        return result(request);
      },
    });
    input.end();
    assert.equal(outcome.status, "completed");
    assert.equal(actionIndex, actions.length);
    assert.equal(plans.length, 2);
    assert.equal(executions.length, 1);
    assert.deepEqual(executions[0]!.sessions, [CODEX.sessionRef, CLAUDE.sessionRef, SKIPPED.sessionRef]);
    assert.equal(executions[0]!.output, selectedArchive);
    assert.equal(executions[0]!.strictSessions, false);
    const plain = cleanTerminalText(rendered);
    assert.match(plain, /AgentHist Export/);
    assert.match(plain, /Session preview/);
    assert.match(plain, /Check the selected history\./);
    assert.match(plain, /Review export/);
    assert.match(plain, /Pending input session/);
    assert.match(plain, /selected\.agenthist/);
    assert.match(plain, /AgentHist 导出/);
    assert.match(plain, /确认导出/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
