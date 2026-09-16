import assert from "node:assert/strict";
import test from "node:test";

import type { AgentLaunchSpec } from "../../../src/agents/contracts.js";
import {
  confirmConversationResume,
  planConversationResume,
  type ConversationResumeDependencies,
  type PlanConversationResumeOptions,
} from "../../../src/application/conversation-resume.js";
import type { HistoryCatalogEntry, HistorySelectionCatalog } from "../../../src/application/history-catalog.js";
import type { ImportHistoryResult } from "../../../src/application/history-import.js";
import type { Agent } from "../../../src/domain/agent.js";
import type { ConversionFinding } from "../../../src/domain/conversion.js";

function sessionRef(agent: Agent, digit: string): string {
  return `ahsr1_${agent}_ck1_${digit.repeat(64)}`;
}

function entry(agent: Agent, digit: string, workspace: string): HistoryCatalogEntry {
  return {
    sessionRef: sessionRef(agent, digit),
    agent,
    nativeId: `${agent}-native-${digit}`,
    title: `${agent} conversation`,
    workspace,
    model: "fixture-model",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    nativeArchived: false,
    libraryState: "active",
    tags: [],
    resourceCount: 0,
  };
}

function catalog(entries: readonly HistoryCatalogEntry[]): HistorySelectionCatalog {
  return {
    entries,
    closeSelection(references) {
      const selected = entries.filter((item) => references.includes(item.sessionRef));
      if (selected.length !== new Set(references).size) throw new Error("missing fixture session");
      return selected;
    },
    async preview(reference) {
      const selected = entries.find((item) => item.sessionRef === reference);
      if (selected === undefined) throw new Error("missing fixture session");
      return { ...selected, conversation: [] };
    },
  };
}

const degradedFinding: ConversionFinding = {
  code: "fixture.reconstructed",
  disposition: "synthesized",
  count: 1,
};

function readyResult(
  mode: "dry_run" | "apply",
  source: HistoryCatalogEntry,
  target: HistoryCatalogEntry,
  quality: "exact" | "degraded" = "degraded",
  classification: "new" | "already_present" = "new",
): ImportHistoryResult {
  const findings = quality === "degraded" ? [degradedFinding] : [];
  return {
    mode,
    status: mode === "dry_run" ? "ready" : "completed",
    selectedSessions: 1,
    newSessions: classification === "new" ? 1 : 0,
    written: mode === "apply" && classification === "new" ? 1 : 0,
    alreadyPresent: classification === "already_present" ? 1 : 0,
    blocked: 0,
    blockedSessions: [],
    routes: [{
      sourceAgent: source.agent,
      targetAgent: target.agent,
      quality,
      sessions: 1,
      findings,
    }],
    agents: [{
      agent: target.agent,
      target: { root: "C:\\agents\\target" },
      newSessions: classification === "new" ? 1 : 0,
      written: mode === "apply" && classification === "new" ? 1 : 0,
      alreadyPresent: classification === "already_present" ? 1 : 0,
      ...(mode === "apply" && classification === "new" ? { transactionRef: "ahtx1_00000000-0000-4000-8000-000000000001" } : {}),
    }],
    workspaces: [{
      source: source.workspace,
      target: target.workspace,
      status: source.workspace === target.workspace ? "unchanged" : "mapped",
      agents: [target.agent],
      sessions: 1,
    }],
    items: [{
      sourceAgent: source.agent,
      targetAgent: target.agent,
      sourceSessionRef: source.sessionRef,
      targetSessionRef: target.sessionRef,
      targetNativeId: target.nativeId,
      quality,
      findings,
      classification,
      destination: "C:\\agents\\target\\session.jsonl",
      provider: "fixture-provider",
      sourceCwd: source.workspace,
      cwd: target.workspace,
      workspaceStatus: source.workspace === target.workspace ? "unchanged" : "mapped",
    }],
    resources: [],
  };
}

function blockedResult(source: HistoryCatalogEntry, targetAgent: Agent): ImportHistoryResult {
  const finding: ConversionFinding = {
    code: "fixture.unsupported",
    disposition: "blocked",
    count: 1,
  };
  return {
    mode: "dry_run",
    status: "blocked",
    selectedSessions: 1,
    newSessions: 0,
    written: 0,
    alreadyPresent: 0,
    blocked: 1,
    blockedSessions: [{
      sourceAgent: source.agent,
      targetAgent,
      sourceSessionRef: source.sessionRef,
      findings: [finding],
    }],
    routes: [{
      sourceAgent: source.agent,
      targetAgent,
      quality: "blocked",
      sessions: 1,
      findings: [finding],
    }],
    agents: [],
    workspaces: [{
      source: source.workspace,
      target: "C:\\mapped workspace",
      status: "mapped",
      agents: [targetAgent],
      sessions: 1,
    }],
    items: [],
    resources: [],
  };
}

function fixtureDependencies(
  catalogs: Readonly<Record<Agent, HistorySelectionCatalog>>,
  overrides: Partial<ConversationResumeDependencies> = {},
): ConversationResumeDependencies {
  return {
    async openHistoryCatalog(_stateDirectory, agents) {
      const agent = agents?.[0];
      if (agent === undefined) throw new Error("fixture requires one Agent catalog");
      return catalogs[agent];
    },
    async findExistingHistoryTransfer() { return undefined; },
    async transferHistorySession() { throw new Error("unexpected fixture transfer"); },
    prepareResumeLaunch(options): AgentLaunchSpec {
      return { command: options.agent, args: ["resume", options.nativeId], cwd: options.cwd };
    },
    ...overrides,
  };
}

function request(source: HistoryCatalogEntry, targetAgent: Agent): PlanConversationResumeOptions {
  return {
    stateDirectory: "C:\\AgentHist State",
    sessionRef: source.sessionRef,
    targetAgent,
    environment: { PATH: "C:\\trusted tools" },
  };
}

test("native resume plans and confirms without entering transfer code", async () => {
  const source = entry("codex", "1", "C:\\projects\\native");
  let transferCalls = 0;
  const deps = fixtureDependencies({
    codex: catalog([source]),
    claude: catalog([]),
    opencode: catalog([]),
    pi: catalog([]),
  }, {
    async findExistingHistoryTransfer() { throw new Error("native resume queried conversion state"); },
    async transferHistorySession() { transferCalls++; throw new Error("native resume attempted a transfer"); },
  });
  const options = request(source, "codex");
  const plan = await planConversationResume(options, deps);
  assert.equal(plan.route, "native");
  assert.equal(plan.quality, "native");
  assert.equal(plan.blocked, false);
  assert.equal(plan.needsWrite, false);
  assert.equal(plan.targetNativeId, source.nativeId);
  assert.deepEqual(plan.workspace, {
    source: source.workspace,
    target: source.workspace,
    status: "unchanged",
  });

  const confirmed = await confirmConversationResume({ ...options, expectedPlanRef: plan.planRef }, deps);
  assert.equal(confirmed.status, "ready");
  if (confirmed.status !== "ready") return;
  assert.deepEqual(confirmed.launch, {
    command: "codex",
    args: ["resume", source.nativeId],
    cwd: source.workspace,
  });
  assert.deepEqual(confirmed.transactionRefs, []);
  assert.equal(confirmed.transferResult, undefined);
  assert.equal(transferCalls, 0);
});

test("cross-Agent resume reuses a deterministic existing target without a dry-run", async () => {
  const source = entry("codex", "2", "C:\\projects\\source");
  const target = entry("claude", "3", "D:\\moved project");
  let transferCalls = 0;
  const deps = fixtureDependencies({
    codex: catalog([source]),
    claude: catalog([target]),
    opencode: catalog([]),
    pi: catalog([]),
  }, {
    async findExistingHistoryTransfer() {
      return {
        sourceSessionRef: source.sessionRef,
        targetAgent: "claude",
        targetSessionRef: target.sessionRef,
        targetNativeId: target.nativeId,
        quality: "degraded",
        findings: [degradedFinding],
      };
    },
    async transferHistorySession() { transferCalls++; throw new Error("existing target was transferred"); },
  });
  const plan = await planConversationResume(request(source, "claude"), deps);
  assert.equal(plan.route, "existing");
  assert.equal(plan.quality, "degraded");
  assert.equal(plan.needsWrite, false);
  assert.equal(plan.targetSessionRef, target.sessionRef);
  assert.equal(plan.workspace.target, target.workspace);
  assert.equal(plan.workspace.status, "mapped");
  assert.equal(transferCalls, 0);
});

test("confirmed cross-Agent resume replans, applies once, and returns launch and transaction data", async () => {
  const source = entry("opencode", "4", "C:\\projects\\source project");
  const target = entry("pi", "5", "D:\\mapped project");
  const modes: string[] = [];
  const deps = fixtureDependencies({
    codex: catalog([]),
    claude: catalog([]),
    opencode: catalog([source]),
    pi: catalog([]),
  }, {
    async transferHistorySession(options) {
      modes.push(options.mode);
      return readyResult(options.mode, source, target);
    },
  });
  const options = request(source, "pi");
  const plan = await planConversationResume(options, deps);
  assert.equal(plan.route, "conversion");
  assert.equal(plan.quality, "degraded");
  assert.equal(plan.needsWrite, true);
  assert.equal(plan.classification, "new");
  assert.equal(plan.provider, "fixture-provider");
  assert.equal(plan.destination, "C:\\agents\\target\\session.jsonl");
  assert.deepEqual(plan.findings, [degradedFinding]);

  const confirmed = await confirmConversationResume({ ...options, expectedPlanRef: plan.planRef }, deps);
  assert.equal(confirmed.status, "ready");
  if (confirmed.status !== "ready") return;
  assert.deepEqual(modes, ["dry_run", "dry_run", "apply"]);
  assert.equal(confirmed.targetSessionRef, target.sessionRef);
  assert.equal(confirmed.targetNativeId, target.nativeId);
  assert.equal(confirmed.workspace, target.workspace);
  assert.deepEqual(confirmed.launch.args, ["resume", target.nativeId]);
  assert.deepEqual(confirmed.transactionRefs, ["ahtx1_00000000-0000-4000-8000-000000000001"]);
  assert.equal(confirmed.transferResult?.status, "completed");
});

test("blocked conversion remains a no-write structured plan", async () => {
  const source = entry("pi", "6", "C:\\projects\\blocked");
  let applyCalls = 0;
  const lossyOptions: Array<boolean | undefined> = [];
  const deps = fixtureDependencies({
    codex: catalog([]),
    claude: catalog([source]),
    opencode: catalog([]),
    pi: catalog([source]),
  }, {
    async transferHistorySession(options) {
      lossyOptions.push(options.allowLossyConversion);
      if (options.mode === "apply") applyCalls++;
      return blockedResult(source, "claude");
    },
  });
  const options = { ...request(source, "claude"), allowLossyConversion: true };
  const plan = await planConversationResume(options, deps);
  assert.equal(plan.quality, "blocked");
  assert.equal(plan.blocked, true);
  assert.equal(plan.needsWrite, false);
  assert.equal(plan.workspace.target, "C:\\mapped workspace");
  assert.equal(plan.findings[0]!.disposition, "blocked");
  const confirmed = await confirmConversationResume({ ...options, expectedPlanRef: plan.planRef }, deps);
  assert.equal(confirmed.status, "blocked");
  assert.equal(applyCalls, 0);
  assert.deepEqual(lossyOptions, [true, true]);
});

test("confirmation returns a changed plan before applying when conversion evidence changed", async () => {
  const source = entry("codex", "7", "C:\\projects\\changing");
  const target = entry("opencode", "8", "C:\\projects\\changing");
  let dryRuns = 0;
  let applyCalls = 0;
  const deps = fixtureDependencies({
    codex: catalog([source]),
    claude: catalog([]),
    opencode: catalog([]),
    pi: catalog([]),
  }, {
    async transferHistorySession(options) {
      if (options.mode === "apply") {
        applyCalls++;
        return readyResult("apply", source, target);
      }
      dryRuns++;
      return readyResult("dry_run", source, target, dryRuns === 1 ? "exact" : "degraded");
    },
  });
  const options = request(source, "opencode");
  const first = await planConversationResume(options, deps);
  assert.equal(first.quality, "exact");
  const confirmed = await confirmConversationResume({ ...options, expectedPlanRef: first.planRef }, deps);
  assert.equal(confirmed.status, "replan_required");
  assert.equal(confirmed.plan.quality, "degraded");
  assert.notEqual(confirmed.plan.planRef, first.planRef);
  assert.equal(applyCalls, 0);
});
