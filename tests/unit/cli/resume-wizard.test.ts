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

function historyEntry(
  workspace: string,
  overrides: Partial<HistoryCatalogEntry> = {},
): HistoryCatalogEntry {
  return {
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
    ...overrides,
  };
}

function historyCatalog(entries: readonly HistoryCatalogEntry[]): HistorySelectionCatalog {
  return {
    entries,
    closeSelection(sessionRefs) {
      const selected = new Set(sessionRefs);
      return entries.filter((entry) => selected.has(entry.sessionRef));
    },
    async preview(sessionRef) {
      const entry = entries.find((candidate) => candidate.sessionRef === sessionRef)!;
      return { ...entry, conversation: [] };
    },
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
  const current = historyEntry(workspace);
  const other = { ...current, sessionRef: "ahsr1_codex_ck1_" + "c".repeat(64), workspace: "/other" };
  const catalog = historyCatalog([other, current]);
  const calls: Array<{ readonly mode: string; readonly sessionRef: string; readonly target: string }> = [];
  const events: string[] = [];
  let rendered = "";
  const actions: Array<{ readonly cue: string; readonly keys: string }> = [
    { cue: "Choose a conversation", keys: "\r" },
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
      ensureTargetAvailable: async (request) => {
        events.push(`check:${request.targetAgent}`);
      },
      findExistingTarget: async (request) => {
        events.push(`find:${request.targetAgent}`);
        return undefined;
      },
      execute: async (mode, request) => {
        events.push(mode);
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
    assert.deepEqual(events, ["check:claude", "find:claude", "dry_run", "apply"]);
    assert.equal(action, actions.length);
    const plain = rendered.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    assert.match(plain, /AgentHist Resume/);
    assert.doesNotMatch(plain, /AgentHist Import|\[✓\]|Space\s+Select/);
  } finally {
    input.destroy();
    output.destroy();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resume wizard checks the target CLI before preparing a conversion", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-resume-preflight-"));
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 100;
  output.rows = 24;
  const session = historyEntry(workspace, {
    sessionRef: "ahsr1_codex_ck1_" + "d".repeat(64),
    nativeId: "33333333-3333-4333-8333-333333333333",
    title: "Check the target first",
  });
  const catalog = historyCatalog([session]);
  let executions = 0;
  try {
    await assert.rejects(runResumeWizard({
      catalog,
      input,
      output,
      cwd: workspace,
      sessionRef: session.sessionRef,
      targetAgent: "claude",
      ensureTargetAvailable: async () => {
        throw new Error("claude is not installed or is not available on PATH");
      },
      findExistingTarget: async () => undefined,
      execute: async (mode, request) => {
        executions++;
        return importResult(mode, request);
      },
    }), /claude is not installed or is not available on PATH/);
    assert.equal(executions, 0);
  } finally {
    input.destroy();
    output.destroy();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resume wizard offers directory candidates when the source workspace moved", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-resume-workspace-"));
  const missing = path.join(workspace, "missing");
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 100;
  output.rows = 24;
  const session = historyEntry(missing, {
    sessionRef: "ahsr1_codex_ck1_" + "e".repeat(64),
    nativeId: "44444444-4444-4444-8444-444444444444",
    title: "Continue from a moved workspace",
  });
  const catalog = historyCatalog([session]);
  let rendered = "";
  let submitted = false;
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString("utf8");
    if (!submitted && rendered.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").includes("Directory candidates")) {
      submitted = true;
      setImmediate(() => input.write("\r"));
    }
  });
  try {
    const outcome = await runResumeWizard({
      catalog,
      input,
      output,
      cwd: workspace,
      sessionRef: session.sessionRef,
      targetAgent: "codex",
      ensureTargetAvailable: async () => {},
      findExistingTarget: async () => undefined,
      execute: async (mode, request) => importResult(mode, request),
    });
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    assert.equal(outcome.cwd, workspace);
  } finally {
    input.destroy();
    output.destroy();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resume wizard reuses an existing cross-Agent continuation without importing again", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-resume-existing-"));
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 100;
  output.rows = 24;
  const session = historyEntry(workspace, {
    sessionRef: "ahsr1_codex_ck1_" + "f".repeat(64),
    nativeId: "55555555-5555-4555-8555-555555555555",
    title: "Reuse the converted continuation",
  });
  const catalog = historyCatalog([session]);
  let executions = 0;
  try {
    const outcome = await runResumeWizard({
      catalog,
      input,
      output,
      cwd: workspace,
      sessionRef: session.sessionRef,
      targetAgent: "claude",
      ensureTargetAvailable: async () => {},
      findExistingTarget: async () => ({
        sourceSessionRef: session.sessionRef,
        targetAgent: "claude",
        targetSessionRef: "ahsr1_claude_ck1_" + "1".repeat(64),
        targetNativeId: "66666666-6666-4666-8666-666666666666",
        quality: "degraded",
        findings: [],
      }),
      execute: async (mode, request) => {
        executions++;
        return importResult(mode, request);
      },
    });
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    assert.equal(outcome.targetNativeId, "66666666-6666-4666-8666-666666666666");
    assert.equal(outcome.reusedExisting, true);
    assert.equal(executions, 0);
  } finally {
    input.destroy();
    output.destroy();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("native resume and cancellation never enter the conversion path", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-resume-native-"));
  const session = historyEntry(workspace, {
    sessionRef: "ahsr1_codex_ck1_" + "2".repeat(64),
    nativeId: "77777777-7777-4777-8777-777777777777",
    title: "Continue native history",
  });
  const catalog = historyCatalog([session]);
  let conversions = 0;
  const nativeInput = new PassThrough() as PassThrough & { isTTY: boolean };
  const nativeOutput = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  nativeInput.isTTY = true;
  nativeOutput.isTTY = true;
  nativeOutput.columns = 100;
  nativeOutput.rows = 24;
  try {
    const native = await runResumeWizard({
      catalog,
      input: nativeInput,
      output: nativeOutput,
      cwd: workspace,
      sessionRef: session.sessionRef,
      targetAgent: "codex",
      ensureTargetAvailable: async () => {},
      findExistingTarget: async () => {
        conversions++;
        return undefined;
      },
      execute: async (mode, request) => {
        conversions++;
        return importResult(mode, request);
      },
    });
    assert.equal(native.status, "ready");
    assert.equal(conversions, 0);
  } finally {
    nativeInput.destroy();
    nativeOutput.destroy();
  }

  const cancelInput = new PassThrough() as PassThrough & { isTTY: boolean };
  const cancelOutput = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  cancelInput.isTTY = true;
  cancelOutput.isTTY = true;
  cancelOutput.columns = 100;
  cancelOutput.rows = 24;
  let escaped = false;
  let cancelRendered = "";
  cancelOutput.on("data", (chunk: Buffer) => {
    cancelRendered += chunk.toString("utf8");
    if (!escaped && cancelRendered.includes("Continue with")) {
      escaped = true;
      setImmediate(() => cancelInput.write("\u001b"));
    }
  });
  try {
    const cancelled = await runResumeWizard({
      catalog,
      input: cancelInput,
      output: cancelOutput,
      cwd: workspace,
      sessionRef: session.sessionRef,
      ensureTargetAvailable: async () => {
        conversions++;
      },
      findExistingTarget: async () => {
        conversions++;
        return undefined;
      },
      execute: async (mode, request) => {
        conversions++;
        return importResult(mode, request);
      },
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(conversions, 0);
  } finally {
    cancelInput.destroy();
    cancelOutput.destroy();
    await rm(workspace, { recursive: true, force: true });
  }
});
