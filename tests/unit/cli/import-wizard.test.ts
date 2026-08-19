import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type {
  ImportCatalog,
  ImportCatalogEntry,
  ImportHistoryResult,
} from "../../../src/application/index.js";
import {
  runImportWizard,
  type ImportWizardRequest,
} from "../../../src/cli/import-wizard/index.js";
import { detectImportWizardLanguage } from "../../../src/cli/import-wizard/copy.js";
import { cleanTerminalText, columns, displayWidth } from "../../../src/cli/import-wizard/terminal.js";

const ENTRY: ImportCatalogEntry = {
  sessionRef: "ahsr1_claude_ck1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  agent: "claude",
  nativeId: "11111111-1111-4111-8111-111111111111",
  title: "Review the experiment",
  workspace: "/old/research",
  model: "gpt-5.4",
  createdAt: "2026-08-15T10:00:00.000Z",
  updatedAt: "2026-08-15T10:05:00.000Z",
  nativeArchived: false,
  libraryState: "active",
  tags: [],
  resourceCount: 0,
};

const BLOCKED_ENTRY: ImportCatalogEntry = {
  ...ENTRY,
  sessionRef: "ahsr1_claude_ck1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  nativeId: "22222222-2222-4222-8222-222222222222",
  title: "Summarize the architecture discussion before changing code",
  updatedAt: "2026-08-15T11:05:00.000Z",
};

function result(mode: "dry_run" | "apply", target: string): ImportHistoryResult {
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
      sourceAgent: "claude",
      targetAgent: "codex",
      quality: "exact",
      sessions: 1,
      findings: [],
    }],
    agents: [{
      agent: "codex",
      target: { root: target },
      newSessions: 1,
      written: mode === "apply" ? 1 : 0,
      alreadyPresent: 0,
      ...(mode === "apply" ? { transactionRef: "ahtx1_test" } : {}),
    }],
    workspaces: [{
      source: ENTRY.workspace,
      target,
      status: "mapped",
      agents: ["codex"],
      sessions: 1,
    }],
    items: [],
    resources: [],
  };
}

function blockedResult(target: string): ImportHistoryResult {
  const findings = [{
    code: "portable.messages.empty",
    disposition: "blocked" as const,
    count: 1,
  }];
  return {
    mode: "dry_run",
    status: "blocked",
    selectedSessions: 2,
    newSessions: 0,
    written: 0,
    alreadyPresent: 0,
    blocked: 1,
    blockedSessions: [{
      sourceAgent: "claude",
      targetAgent: "codex",
      sourceSessionRef: BLOCKED_ENTRY.sessionRef,
      findings,
    }],
    routes: [{
      sourceAgent: "claude",
      targetAgent: "codex",
      quality: "blocked",
      sessions: 2,
      findings,
    }],
    agents: [],
    workspaces: [{
      source: ENTRY.workspace,
      target,
      status: "mapped",
      agents: ["codex"],
      sessions: 2,
    }],
    items: [],
    resources: [],
  };
}

test("interactive import uses the four-step keyboard flow for preview, routing, mapping, and apply", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-import-wizard-"));
  const targetWorkspace = path.join(root, "research");
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 100;
  output.rows = 28;
  let rendered = "";
  const actions: Array<{ readonly cue: string; readonly keys: string }> = [
    { cue: "Select sessions", keys: "l" },
    { cue: "选择会话", keys: "l" },
    { cue: "Select sessions", keys: "aa\u001b[Cv" },
    { cue: "Session preview", keys: "\u001b" },
    { cue: "Select sessions", keys: "\r" },
    { cue: "Choose target Agents", keys: "t" },
    { cue: "Set target Agent", keys: "\u001b[B\r" },
    { cue: "Choose target Agents", keys: "p" },
    { cue: "Choose Codex provider", keys: "\u001b[B\r" },
    { cue: "Choose target Agents", keys: "\r" },
    { cue: "Workspace paths", keys: "e" },
    { cue: "Target directory: ", keys: `${targetWorkspace}\r` },
    { cue: "Workspace paths", keys: "\u001b[B\u001b[A\r" },
    { cue: "Review import", keys: "\r" },
    { cue: "Confirm import", keys: "\r" },
  ];
  let actionIndex = 0;
  let searchFrom = 0;
  let initialTargetsFrame = "";
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString("utf8");
    const plain = rendered.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const action = actions[actionIndex];
    if (action !== undefined && plain.slice(searchFrom).includes(action.cue)) {
      if (action.cue === "Choose target Agents" && initialTargetsFrame === "") {
        initialTargetsFrame = plain.slice(searchFrom);
      }
      actionIndex++;
      searchFrom = plain.length;
      setImmediate(() => { input.write(action.keys); });
    }
  });
  const requests: Array<{ mode: "dry_run" | "apply"; request: ImportWizardRequest }> = [];
  let workspaceInspections = 0;
  let providerResolutions = 0;
  let providerListings = 0;
  try {
    await mkdir(targetWorkspace, { recursive: true });
    const catalog: ImportCatalog = {
      file: path.join(root, "fixture.agenthist"),
      sizeBytes: 1,
      sha256: "a".repeat(64),
      entries: [ENTRY],
      closeSelection: () => [ENTRY],
      async inspectWorkspaces(_sessionRefs, _destinations, pathMappings) {
        workspaceInspections++;
        const mapped = pathMappings.some((mapping) => mapping === `${ENTRY.workspace}=${targetWorkspace}`);
        return [{
          source: ENTRY.workspace,
          target: mapped ? targetWorkspace : ENTRY.workspace,
          status: mapped ? "mapped" : "unchanged",
          availability: mapped ? "available" : "missing",
          agents: [_destinations[ENTRY.sessionRef] ?? "claude"],
          sessionRefs: [ENTRY.sessionRef],
        }];
      },
      async preview() {
        return {
          ...ENTRY,
          conversation: [
            { kind: "message", role: "user", text: "Check the evidence.", timestamp: ENTRY.createdAt },
            { kind: "message", role: "assistant", text: "The evidence is consistent.", timestamp: ENTRY.updatedAt },
          ],
        };
      },
      async close() {},
    };
    const pending = runImportWizard({
      catalog,
      input,
      output,
      color: true,
      sessions: [],
      pathMappings: [],
      providerPolicy: "current",
      async resolveCodexCurrentProvider() {
        providerResolutions++;
        return "test-provider";
      },
      async listCodexProviders() {
        providerListings++;
        return [
          { provider: "test-provider", sessions: 2 },
          { provider: "legacy-provider", sessions: 4 },
        ];
      },
      async execute(mode, request) {
        requests.push({ mode, request });
        return result(mode, targetWorkspace);
      },
    });
    const outcome = await pending;
    input.end();

    assert.equal(outcome.status, "completed");
    assert.equal(actionIndex, actions.length);
    assert.deepEqual(requests.map((item) => item.mode), ["dry_run", "apply"]);
    assert.deepEqual(requests[0]!.request.sessions, [ENTRY.sessionRef]);
    assert.deepEqual(requests[0]!.request.sessionTargets, { [ENTRY.sessionRef]: "codex" });
    assert.deepEqual(requests[0]!.request.pathMappings, [`${ENTRY.workspace}=${targetWorkspace}`]);
    assert.equal(workspaceInspections, 2);
    assert.equal(providerResolutions, 1);
    assert.equal(providerListings, 1);
    assert.equal(requests[0]!.request.providerPolicy, "legacy-provider");
    const rawRendered = rendered;
    rendered = cleanTerminalText(rendered);
    initialTargetsFrame = cleanTerminalText(initialTargetsFrame);
    assert.match(rendered, /Review the experiment/);
    assert.match(rendered, /AgentHist 导入/);
    assert.match(rendered, /选择会话/);
    assert.match(rendered, /\[l\] English/);
    assert.match(rendered, /Session preview/);
    assert.match(rendered, /Check the evidence\./);
    assert.match(rendered, /SOURCES/);
    assert.match(rendered, /SCOPES/);
    assert.match(rendered, /SESSIONS · Claude Code/);
    assert.match(rendered, /\[✓\]/);
    assert.match(rendered, /Choose target Agents/);
    assert.match(rendered, /Set target Agent/);
    assert.match(rendered, /Target provider: test-provider/);
    assert.match(rendered, /Target provider: legacy-provider/);
    assert.match(rendered, /Current machine: test-provider/);
    assert.match(rendered, /legacy-provider.*4 existing sessions/);
    assert.match(rendered, /Codex convert/);
    assert.match(rendered, /MISSING/);
    assert.match(rendered, /MAPPED/);
    assert.match(rendered, /1 path ready/);
    assert.match(rendered, /MAPPED · 1 session/);
    assert.match(rendered, /Overview/);
    assert.match(rendered, /1 selected.*1 new.*0 already on target/s);
    assert.match(rendered, /Routes/);
    assert.match(rendered, /Cross-Agent conversions/);
    assert.match(rendered, /Claude Code -> Codex/);
    assert.match(rendered, /1 session · EXACT/);
    assert.match(rendered, /Target settings/);
    assert.match(rendered, /Provider\s+Codex · legacy-provider/);
    assert.match(rendered, /Workspaces/);
    assert.match(rendered, /Dry-run complete.*Nothing written/s);
    assert.doesNotMatch(rendered, /Managed resources/);
    assert.doesNotMatch(rendered, /Technical details/);
    assert.match(rendered, /Confirm import/);
    assert.match(rendered, /\[Enter\].*Apply/s);
    assert.match(rendered, /\[Left\/Right\] Switch pane/);
    assert.match(rendered, /\[a\] Clear all/);
    assert.match(rendered, /\[a\] Select all/);
    assert.match(rendered, /\[v\] Preview/);
    assert.match(rendered, /\[t\] Set target/);
    assert.match(rendered, /\[p\] Change provider/);
    assert.doesNotMatch(initialTargetsFrame, /Codex provider/);
    assert.doesNotMatch(rendered, /Policy:/);
    assert.doesNotMatch(rendered, /Provider: current/);
    assert.doesNotMatch(rendered, /\[x\]/);
    assert.doesNotMatch(rendered, /\[o\]/);
    assert.doesNotMatch(rendered, /Target storage/);
    assert.doesNotMatch(rendered, /Commands: <n>/);
    assert.doesNotMatch(rendered, /Tab/);
    assert.equal(rendered.match(/Checking\.\.\./g)?.length ?? 0, 1);
    assert.equal(rawRendered.match(/\u001b\[2J/g)?.length ?? 0, 1);
  } finally {
    input.destroy();
    output.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive import language detection follows the terminal locale", () => {
  assert.equal(detectImportWizardLanguage({ LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(detectImportWizardLanguage({ LC_ALL: "C.UTF-8", LANG: "zh_CN.UTF-8" }), "en");
  assert.equal(detectImportWizardLanguage({ LANG: "en_US.UTF-8" }), "en");
  assert.equal(detectImportWizardLanguage({}, "zh-CN"), "zh");
});

test("import headings stay within a narrow terminal", () => {
  const width = 40;
  const rendered = columns(
    "Choose target Agents",
    `2 cross-Agent · Target provider: ${"provider".repeat(20)}`,
    width,
  );
  assert.ok(displayWidth(rendered) <= width);
});

test("blocked review identifies sessions and can explicitly exclude them before rerunning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-import-blocked-review-"));
  const targetWorkspace = path.join(root, "research");
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 110;
  output.rows = 18;
  let rendered = "";
  const actions: Array<{ readonly cue: string; readonly keys: string }> = [
    { cue: "Select sessions", keys: "\r" },
    { cue: "Choose target Agents", keys: "\r" },
    { cue: "Workspace paths", keys: "\r" },
    { cue: "BLOCKED · 1 SESSION", keys: "d" },
    { cue: "portable.messages.empty", keys: "e" },
    { cue: "READY · 1 NEW", keys: "\r" },
    { cue: "Confirm import", keys: "\r" },
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
  const requests: Array<{ mode: "dry_run" | "apply"; request: ImportWizardRequest }> = [];
  try {
    await mkdir(targetWorkspace, { recursive: true });
    const entries = [ENTRY, BLOCKED_ENTRY];
    const catalog: ImportCatalog = {
      file: path.join(root, "fixture.agenthist"),
      sizeBytes: 1,
      sha256: "c".repeat(64),
      entries,
      closeSelection(sessionRefs) {
        const selected = new Set(sessionRefs);
        return entries.filter((entry) => selected.has(entry.sessionRef));
      },
      async inspectWorkspaces(sessionRefs) {
        return [{
          source: ENTRY.workspace,
          target: targetWorkspace,
          status: "mapped",
          availability: "available",
          agents: ["codex"],
          sessionRefs,
        }];
      },
      async preview(sessionRef) {
        return { ...entries.find((entry) => entry.sessionRef === sessionRef)!, conversation: [] };
      },
      async close() {},
    };
    const outcome = await runImportWizard({
      catalog,
      input,
      output,
      targetAgent: "codex",
      sessions: [],
      pathMappings: [`${ENTRY.workspace}=${targetWorkspace}`],
      providerPolicy: "current",
      async resolveCodexCurrentProvider() { return "test-provider"; },
      async listCodexProviders() { return []; },
      async execute(mode, request) {
        requests.push({ mode, request });
        return mode === "dry_run" && request.sessions.includes(BLOCKED_ENTRY.sessionRef)
          ? blockedResult(targetWorkspace)
          : result(mode, targetWorkspace);
      },
    });
    input.end();

    assert.equal(outcome.status, "completed");
    assert.equal(actionIndex, actions.length);
    assert.deepEqual(requests.map((item) => item.mode), ["dry_run", "dry_run", "apply"]);
    assert.deepEqual(requests[0]!.request.sessions, [ENTRY.sessionRef, BLOCKED_ENTRY.sessionRef]);
    assert.deepEqual(requests[1]!.request.sessions, [ENTRY.sessionRef]);
    assert.deepEqual(requests[2]!.request.sessions, [ENTRY.sessionRef]);
    assert.match(rendered, /Overview.*Blocked sessions · 1/s);
    assert.match(rendered, /2 selected.*1 blocked/s);
    assert.match(rendered, /Summarize the architecture discussion before changing code/);
    assert.match(rendered, /Route\s+Claude Code -> Codex/);
    assert.match(rendered, /Workspace\s+\/old\/research/);
    assert.match(rendered, /Reason\s+messages missing/);
    assert.match(rendered, /Routes.*Target settings/s);
    assert.match(rendered, /Impact\s+1 blocker/);
    assert.match(rendered, /Sessions.*1\. Review the experiment.*2\. Summarize the architecture discussion before changing code/s);
    assert.match(
      rendered,
      /2\. Summarize the architecture discussion before changing code.*Workspace\s+\/old\/research.*Impact.*Technical details.*portable\.messages\.empty/s,
    );
    assert.match(rendered, /Technical details.*portable.messages.empty/s);
    assert.match(rendered, /\[d\].*Show details/s);
    assert.match(rendered, /\[d\].*Hide details/s);
    assert.match(rendered, /\[e\].*Exclude blocked/s);
    assert.match(rendered, /Excluded 1 blocked session/);
    assert.doesNotMatch(rendered, new RegExp(BLOCKED_ENTRY.sessionRef));
  } finally {
    input.destroy();
    output.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive import explains a preflight compatibility failure without applying", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-import-preflight-"));
  const targetWorkspace = path.join(root, "research");
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 60;
  output.rows = 12;
  let rendered = "";
  const actions: Array<{ readonly cue: string; readonly keys: string }> = [
    { cue: "Select sessions", keys: "\r" },
    { cue: "Choose target Agents", keys: "\r" },
    { cue: "Workspace paths", keys: "\r" },
    { cue: "Preflight failed", keys: "\u001b[B\u001b[B\u001b[B\u001b[B\u0003" },
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
  let executions = 0;
  try {
    await mkdir(targetWorkspace, { recursive: true });
    const catalog: ImportCatalog = {
      file: path.join(root, "fixture.agenthist"),
      sizeBytes: 1,
      sha256: "b".repeat(64),
      entries: [ENTRY],
      closeSelection: () => [ENTRY],
      async inspectWorkspaces() {
        return [{
          source: ENTRY.workspace,
          target: targetWorkspace,
          status: "mapped",
          availability: "available",
          agents: [ENTRY.agent],
          sessionRefs: [ENTRY.sessionRef],
        }];
      },
      async preview() {
        return { ...ENTRY, conversation: [] };
      },
      async close() {},
    };
    const outcome = await runImportWizard({
      catalog,
      input,
      output,
      sessions: [],
      pathMappings: [`${ENTRY.workspace}=${targetWorkspace}`],
      providerPolicy: "current",
      async resolveCodexCurrentProvider() { return "unused"; },
      async listCodexProviders() { return []; },
      async execute() {
        executions++;
        throw new Error("target OpenCode message primary key capability differs");
      },
    });
    input.end();

    assert.equal(outcome.status, "cancelled");
    assert.equal(executions, 1);
    assert.equal(actionIndex, actions.length);
    assert.match(rendered, /selected OpenCode histories could not be combined safely/);
    assert.match(rendered, /Technical detail/);
    assert.match(rendered, /primary key capability differs/);
    assert.match(rendered, /\[Up\/Down\].*Scroll/s);
    assert.match(rendered, /No changes written/);
  } finally {
    input.destroy();
    output.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
