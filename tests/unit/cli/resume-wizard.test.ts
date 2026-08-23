import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type {
  HistoryCatalogEntry,
  HistorySelectionCatalog,
  ImportHistoryResult,
} from "../../../src/application/index.js";
import { runResumeWizard, type ResumeWizardRequest } from "../../../src/cli/resume-wizard.js";

function importResult(mode: "dry_run" | "apply", request: ResumeWizardRequest): ImportHistoryResult {
  return {
    mode,
    status: mode === "dry_run" ? "ready" : "completed",
    selectedSessions: 1,
    newSessions: 1,
    written: mode === "apply" ? 1 : 0,
    alreadyPresent: 0,
    blocked: 0,
    blockedSessions: [],
    routes: [{
      sourceAgent: request.session.agent,
      targetAgent: request.targetAgent,
      quality: "degraded",
      sessions: 1,
      findings: [{ disposition: "synthesized", code: "claude.session_identity.synthesized", count: 1 }],
    }],
    agents: [{
      agent: request.targetAgent,
      target: { root: "/target" },
      newSessions: 1,
      written: mode === "apply" ? 1 : 0,
      alreadyPresent: 0,
    }],
    workspaces: [{
      source: request.session.workspace,
      target: request.session.workspace,
      status: "unchanged",
      agents: [request.targetAgent],
      sessions: 1,
    }],
    items: [{
      sourceAgent: request.session.agent,
      targetAgent: request.targetAgent,
      sourceSessionRef: request.session.sessionRef,
      targetSessionRef: "ahsr1_claude_ck1_" + "b".repeat(64),
      targetNativeId: "22222222-2222-4222-8222-222222222222",
      quality: "degraded",
      findings: [],
      classification: "new",
      destination: "/target/session.jsonl",
      provider: "",
      sourceCwd: request.session.workspace,
      cwd: request.session.workspace,
      workspaceStatus: "unchanged",
    }],
    resources: [],
  };
}

test("resume wizard selects one current-workspace session and confirms a cross-Agent route", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-resume-wizard-"));
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 100;
  output.rows = 28;
  const current: HistoryCatalogEntry = {
    sessionRef: "ahsr1_codex_ck1_" + "a".repeat(64),
    agent: "codex",
    nativeId: "11111111-1111-4111-8111-111111111111",
    title: "Continue the current refactor",
    workspace,
    model: "gpt-5.4",
    createdAt: "2026-08-20T01:00:00.000Z",
    updatedAt: "2026-08-20T02:00:00.000Z",
    nativeArchived: false,
    libraryState: "active",
    tags: [],
    resourceCount: 0,
  };
  const other = { ...current, sessionRef: "ahsr1_codex_ck1_" + "c".repeat(64), workspace: "/other" };
  const catalog: HistorySelectionCatalog = {
    entries: [other, current],
    closeSelection(sessionRefs) {
      const selected = new Set(sessionRefs);
      return [other, current].filter((entry) => selected.has(entry.sessionRef));
    },
    async preview(sessionRef) {
      const entry = sessionRef === current.sessionRef ? current : other;
      return { ...entry, conversation: [] };
    },
  };
  const calls: Array<{ readonly mode: string; readonly sessionRef: string; readonly target: string }> = [];
  let rendered = "";
  const actions: Array<{ readonly cue: string; readonly keys: string }> = [
    { cue: "Select sessions", keys: "\r" },
    { cue: "Continue with", keys: "\u001b[B\r" },
    { cue: "Result  DEGRADED", keys: "\r" },
  ];
  let action = 0;
  let searchFrom = 0;
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString("utf8");
    const plain = rendered.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const next = actions[action];
    if (next !== undefined && plain.slice(searchFrom).includes(next.cue)) {
      action++;
      searchFrom = plain.length;
      setImmediate(() => input.write(next.keys));
    }
  });
  try {
    const outcome = await runResumeWizard({
      catalog,
      input,
      output,
      cwd: workspace,
      execute: async (mode, request) => {
        calls.push({ mode, sessionRef: request.session.sessionRef, target: request.targetAgent });
        return importResult(mode, request);
      },
    });
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    assert.equal(outcome.session.sessionRef, current.sessionRef);
    assert.equal(outcome.targetAgent, "claude");
    assert.deepEqual(calls, [
      { mode: "dry_run", sessionRef: current.sessionRef, target: "claude" },
      { mode: "apply", sessionRef: current.sessionRef, target: "claude" },
    ]);
    assert.equal(action, actions.length);
  } finally {
    input.destroy();
    output.destroy();
    await rm(workspace, { recursive: true, force: true });
  }
});
