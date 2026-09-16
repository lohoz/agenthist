import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  HistorySourceInspectionResult,
  ScanHistoryResult,
} from "../../../src/application/acquisition.js";
import type {
  ConversationResumeConfirmation,
  ConversationResumePlan,
  PlanConversationResumeOptions,
} from "../../../src/application/index.js";
import type { HistorySessionDetail, HistorySessionSummary } from "../../../src/application/history.js";
import { createSnapshotWorkspace, publishSnapshot } from "../../../src/infrastructure/history-store.js";
import type { Agent } from "../../../src/domain/agent.js";
import type { AgentSnapshot, StoredSession } from "../../../src/domain/history.js";
import { claudeSessionRef } from "../../../src/agents/claude/identity.js";
import { codexSessionRef } from "../../../src/agents/codex/identity.js";
import {
  DEFAULT_DESKTOP_SETTINGS,
  createDesktopService,
  type DesktopAgentSettingsDependencies,
  type DesktopApplicationDependencies,
  type DesktopProcessDependencies,
  type DesktopResumeDependencies,
  type DesktopExperienceSettingsFacade,
  type DesktopTransactionFacade,
} from "../../../src/desktop/service.js";
import type {
  ExperienceCandidateDetailDto,
  ExperiencePreviewDto,
  ExperienceReviewDto,
  ImportPlanDto,
  ScanProgressDto,
} from "../../../src/desktop/contracts.js";
import type { DesktopExperienceService } from "../../../src/desktop/experience.js";
import type { DesktopTransferService } from "../../../src/desktop/transfer.js";
import type { DesktopTransferServiceOptions } from "../../../src/desktop/transfer.js";
import type {
  DesktopTransactionPlan,
  DesktopTransactionSummary,
} from "../../../src/desktop/transactions.js";

const CODEX_NATIVE_ID = "11111111-1111-4111-8111-111111111111";
const CLAUDE_NATIVE_ID = "22222222-2222-4222-8222-222222222222";
const CLAUDE_ROOT_ID = "33333333-3333-4333-8333-333333333333";
const CODEX_REF = codexSessionRef(CODEX_NATIVE_ID);
const CLAUDE_REF = claudeSessionRef(CLAUDE_NATIVE_ID, CLAUDE_ROOT_ID);

function storedSession(options: {
  readonly agent: "codex" | "claude";
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly title: string;
  readonly workspace: string;
  readonly updatedAt: string;
  readonly conversation?: StoredSession["conversation"];
}): StoredSession {
  return {
    sessionRef: options.sessionRef,
    agent: options.agent,
    nativeId: options.nativeId,
    title: options.title,
    context: options.workspace,
    model: `${options.agent}-model`,
    provider: options.agent === "codex" ? "openai" : "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: options.updatedAt,
    nativeArchived: false,
    library: { name: "", tags: [], archived: false, deleted: false },
    conversation: options.conversation ?? [],
    searchText: [],
    rawFiles: [],
    native: null,
  };
}

async function publishSessions(
  stateDirectory: string,
  agent: "codex" | "claude",
  sessions: readonly StoredSession[],
): Promise<void> {
  const workspace = await createSnapshotWorkspace(stateDirectory, agent);
  const snapshot: AgentSnapshot = {
    schemaVersion: "agenthist.history-snapshot/v2",
    snapshotId: workspace.id,
    agent,
    scannedAt: "2026-01-03T00:00:00.000Z",
    sessions,
    auxiliaryFiles: [],
    warnings: [],
  };
  await publishSnapshot(stateDirectory, workspace, snapshot);
}

function notDetected(agent: Agent): HistorySourceInspectionResult {
  return {
    schemaVersion: "agenthist.doctor/v1",
    status: "not_detected",
    agents: [{ agent, status: "not_detected", locations: [], findings: [] }],
  };
}

const PLAN_REF_A = `ahresumeplan1_${"1".repeat(64)}`;
const PLAN_REF_B = `ahresumeplan1_${"2".repeat(64)}`;
const IMPORT_HANDLE = `ahimport1_${"3".repeat(64)}`;
const IMPORT_PLAN_REF = `ahimportplan1_${"4".repeat(64)}`;
const EXPERIENCE_HANDLE = `ahexpreview1_${"7".repeat(64)}`;
const EXPERIENCE_PREVIEW_REF = `ahexppreview1_${"8".repeat(64)}`;
const EXPERIENCE_CANDIDATE_REF = `ahcongroup2_${"9".repeat(64)}`;
const TRANSACTION_REF = "ahtx1_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRANSACTION_PLAN_REF = `ahtxplan1_${"b".repeat(64)}`;

function conversationResumePlan(
  overrides: Partial<ConversationResumePlan> = {},
): ConversationResumePlan {
  const base: ConversationResumePlan = {
    planRef: PLAN_REF_A,
    source: {
      sessionRef: CODEX_REF,
      agent: "codex",
      nativeId: CODEX_NATIVE_ID,
      title: "Resume source",
      workspace: "D:\\trusted\\source",
      model: "codex-model",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      nativeArchived: false,
      libraryState: "active",
      tags: ["daily"],
      resourceCount: 0,
    },
    targetAgent: "codex",
    route: "native",
    quality: "native",
    findings: [],
    workspace: {
      source: "D:\\trusted\\source",
      target: "D:\\trusted\\source",
      status: "unchanged",
    },
    blocked: false,
    needsWrite: false,
    targetSessionRef: CODEX_REF,
    targetNativeId: CODEX_NATIVE_ID,
    classification: "already_present",
  };
  return { ...base, ...overrides };
}

function successfulIndexSync(stateDirectory: string) {
  return {
    file: path.join(stateDirectory, "desktop", "history-index.sqlite"),
    rebuilt: false,
    sessions: 1,
    updatedAgents: [],
    reusedAgents: [],
    removedAgents: [],
    issues: [],
  } as const;
}

function importPlan(overrides: Partial<ImportPlanDto> = {}): ImportPlanDto {
  const base: ImportPlanDto = {
    handle: IMPORT_HANDLE,
    planRef: IMPORT_PLAN_REF,
    fileName: "fixture.agenthist",
    status: "ready",
    selectedSessions: 1,
    newSessions: 1,
    alreadyPresent: 0,
    blocked: 0,
    conflicts: 0,
    routes: [],
    workspaces: [],
    sessions: [{
      sessionRef: CODEX_REF,
      memberSessionRefs: [CODEX_REF],
      sourceAgent: "codex",
      title: "Fixture",
      workspace: "C:\\workspace",
      updatedAt: "2026-01-01T00:00:00.000Z",
      selected: true,
    }],
    transactionRequired: true,
  };
  return { ...base, ...overrides };
}

function fakeTransfer(overrides: Partial<DesktopTransferService> = {}): DesktopTransferService {
  return {
    async exportHistory() { return { status: "cancelled" }; },
    async openImport() { return { status: "cancelled" }; },
    async replanImport() { return importPlan(); },
    async mapImportWorkspace() { return { status: "planned", plan: importPlan() }; },
    async applyImport() { return { status: "blocked", plan: importPlan({ status: "blocked" }) }; },
    async cancelImport() { return { closed: true }; },
    async dispose() {},
    ...overrides,
  };
}

function experiencePreview(overrides: Partial<ExperiencePreviewDto> = {}): ExperiencePreviewDto {
  return {
    previewRef: EXPERIENCE_PREVIEW_REF,
    scope: "all",
    sessions: 2,
    lineages: 2,
    projects: 1,
    cards: 4,
    queuedCards: 3,
    reusedSessions: 1,
    rebuiltSessions: 1,
    estimatedInputTokens: 100,
    evidenceRequests: 1,
    candidateRequestsUpperBound: 1,
    ...overrides,
  };
}

function experienceReview(): ExperienceReviewDto {
  return {
    handle: EXPERIENCE_HANDLE,
    reviewRef: `ahreview1_${"a".repeat(64)}`,
    createdAt: "2026-09-04T00:00:00.000Z",
    directoryName: "agenthist-experience-fixture",
    sessions: 2,
    lineages: 2,
    projects: 1,
    candidates: [{
      candidateRef: EXPERIENCE_CANDIDATE_REF,
      category: "requirement",
      topic: "Safety",
      lens: "requirement",
      draft: "Keep operations safe.",
      evidence: 1,
      sessions: 1,
      projects: 1,
    }],
    unroutedEvidence: 0,
  };
}

function experienceCandidate(): ExperienceCandidateDetailDto {
  return {
    ...experienceReview().candidates[0]!,
    relation: "recurring requirement",
    evidenceItems: [{
      occurrenceRef: `ahocc1_${"b".repeat(64)}`,
      sessionRef: CODEX_REF,
      agent: "codex",
      workspace: "D:\\trusted\\source",
      timestamp: "2026-09-03T00:00:00.000Z",
      observation: "Safety was requested.",
      userText: "Keep this safe.",
      assistant: ["Validated first."],
    }],
  };
}

function fakeExperience(overrides: Partial<DesktopExperienceService> = {}): DesktopExperienceService {
  return {
    async previewExperience() { return experiencePreview(); },
    async runExperience() { return { status: "partial", remainingCards: 1 }; },
    async loadExperienceReview() { return { status: "cancelled" }; },
    async getExperienceCandidate() { return experienceCandidate(); },
    async openExperienceOutput() { return { opened: true }; },
    async closeExperienceReview() { return { closed: true }; },
    async dispose() {},
    ...overrides,
  };
}

function transactionSummary(overrides: Partial<DesktopTransactionSummary> = {}): DesktopTransactionSummary {
  return {
    transactionRef: TRANSACTION_REF,
    operation: "history_import",
    agents: ["codex"],
    state: "needs_recovery",
    phase: "native_write",
    direction: "forward",
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    items: 1,
    ...overrides,
  };
}

function transactionPlan(overrides: Partial<DesktopTransactionPlan> = {}): DesktopTransactionPlan {
  return {
    planRef: TRANSACTION_PLAN_REF,
    summary: transactionSummary(),
    action: "recover",
    ready: true,
    findings: [{
      sessionRef: CODEX_REF,
      row: "after",
      section: "unchanged",
      file: "after",
      resources: "after",
      goal: "unchanged",
    }],
    ...overrides,
  };
}

test("desktop bootstrap and list are useful before the first snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-empty-"));
  try {
    const service = createDesktopService({
      stateDirectory: root,
      version: "test-version",
      application: { detectHistorySources: async (options) => notDetected(options.agents![0]!) },
    });
    assert.deepEqual(await service.getSettings(), { ok: true, value: DEFAULT_DESKTOP_SETTINGS });
    const listed = await service.listChats({});
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.deepEqual(listed.value, {
      total: 0,
      offset: 0,
      limit: 50,
      returned: 0,
      remaining: 0,
      chats: [],
    });

    const bootstrapped = await service.bootstrap();
    assert.equal(bootstrapped.ok, true);
    if (!bootstrapped.ok) return;
    assert.equal(bootstrapped.value.version, "test-version");
    assert.equal(bootstrapped.value.agents.length, 4);
    assert.equal(bootstrapped.value.chats.total, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap Agent settings show detected default source paths when no override exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-agent-defaults-"));
  try {
    const locations = {
      codex: [
        { role: "history_root" as const, path: "C:\\defaults\\codex" },
        { role: "native_state_root" as const, path: "C:\\defaults\\codex-db" },
      ],
      claude: [{ role: "config_root" as const, path: "C:\\defaults\\claude" }],
      opencode: [
        { role: "data_root" as const, path: "C:\\defaults\\opencode" },
        { role: "database" as const, path: "C:\\defaults\\opencode\\opencode.db" },
      ],
      pi: [{ role: "history_root" as const, path: "C:\\defaults\\pi" }],
    };
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      application: {
        async detectHistorySources(options) {
          const agent = options.agents![0]!;
          return {
            schemaVersion: "agenthist.doctor/v1",
            status: "ready",
            agents: [{ agent, status: "ready", locations: locations[agent], findings: [] }],
          };
        },
      },
      agentSettings: {
        async inspectAgentSettings() {
          return (["codex", "claude", "opencode", "pi"] as const).map((agent) => ({
            agent,
            history: { configured: false, available: false, expected: "directory" as const },
            ...(agent === "codex" || agent === "opencode"
              ? { database: { configured: false, available: false, expected: agent === "codex" ? "directory" as const : "file" as const } }
              : {}),
            executable: { configured: false, available: false },
          }));
        },
      },
    });
    const result = await service.bootstrap();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const byAgent = new Map(result.value.agentSettings.map((item) => [item.agent, item]));
    assert.deepEqual(byAgent.get("codex")?.history, {
      configured: false,
      path: "C:\\defaults\\codex",
      available: true,
      expected: "directory",
    });
    assert.deepEqual(byAgent.get("codex")?.database, {
      configured: false,
      path: "C:\\defaults\\codex-db",
      available: true,
      expected: "directory",
    });
    assert.equal(byAgent.get("claude")?.history.path, "C:\\defaults\\claude");
    assert.equal(byAgent.get("opencode")?.database?.path, "C:\\defaults\\opencode\\opencode.db");
    assert.equal(byAgent.get("pi")?.history.available, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent history and database overrides refresh immediately and rebuild the production transfer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-agent-reconfigure-"));
  try {
    const baseCodex = path.join(root, "base-codex");
    const baseDatabase = path.join(root, "base-codex-db");
    const overrideCodex = path.join(root, "override-codex");
    const openCodeDatabase = path.join(root, "override-opencode.db");
    await Promise.all([
      mkdir(baseCodex, { recursive: true }),
      mkdir(baseDatabase, { recursive: true }),
      mkdir(overrideCodex, { recursive: true }),
      writeFile(openCodeDatabase, "sqlite fixture", "utf8"),
    ]);
    let selected: string | undefined;
    let pickerCalls = 0;
    let transferDisposals = 0;
    const transferOptions: DesktopTransferServiceOptions[] = [];
    const detected: Array<{ readonly agent: Agent; readonly options: HistorySourceInspectionResult | unknown }> = [];
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      sourceOptions: { codex: { codexHome: baseCodex, sqliteHome: baseDatabase } },
      agentSettings: {
        async choosePath() { pickerCalls++; return selected; },
        createTransferService(options) {
          transferOptions.push(options);
          return fakeTransfer({ async dispose() { transferDisposals++; } });
        },
      },
      application: {
        async detectHistorySources(options) {
          const agent = options.agents![0]!;
          detected.push({ agent, options });
          return notDetected(agent);
        },
      },
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) { return successfulIndexSync(stateDirectory); },
      },
      experience: fakeExperience(),
    });

    assert.deepEqual(await service.chooseAgentPath({ agent: "codex", kind: "history" }), {
      ok: true,
      value: { status: "cancelled" },
    });
    assert.equal(transferOptions.length, 0);
    assert.equal(detected.length, 0);

    selected = overrideCodex;
    const updated = await service.chooseAgentPath({ agent: "codex", kind: "history" });
    assert.equal(updated.ok, true);
    assert.equal(transferOptions.length, 1);
    assert.equal(transferOptions[0]!.importOptions?.codexHome, overrideCodex);
    assert.equal(transferOptions[0]!.importOptions?.sqliteHome, baseDatabase);
    const latestCodexDetection = [...detected].reverse().find((item) => item.agent === "codex")!;
    assert.equal((latestCodexDetection.options as { codex?: { codexHome?: string } }).codex?.codexHome, overrideCodex);

    selected = openCodeDatabase;
    const database = await service.chooseAgentPath({ agent: "opencode", kind: "database" });
    assert.equal(database.ok, true);
    assert.equal(transferOptions.length, 2);
    assert.equal(transferDisposals, 1);
    assert.equal(transferOptions[1]!.importOptions?.opencodeDatabase, openCodeDatabase);

    const pickerCallsBeforeInvalid = pickerCalls;
    const invalidDatabase = await service.chooseAgentPath({ agent: "claude", kind: "database" } as never);
    assert.equal(invalidDatabase.ok, false);
    assert.equal(pickerCalls, pickerCallsBeforeInvalid);

    const clearedDatabase = await service.clearAgentPath({ agent: "opencode", kind: "database" });
    assert.equal(clearedDatabase.ok, true);
    assert.equal(transferOptions.length, 3);
    assert.equal(transferDisposals, 2);
    assert.equal(transferOptions[2]!.importOptions?.opencodeDatabase, undefined);

    const clearedAgent = await service.clearAgentPath({ agent: "codex" });
    assert.equal(clearedAgent.ok, true);
    assert.equal(transferOptions.at(-1)!.importOptions?.codexHome, baseCodex);
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop service retains an injected application fallback when the derived index is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-fallback-"));
  try {
    const summary: HistorySessionSummary = {
      sessionRef: CODEX_REF,
      agent: "codex",
      title: "Fallback chat",
      context: "D:\\fallback\\workspace",
      model: "fallback-model",
      provider: "openai",
      updatedAt: "2026-01-02T00:00:00.000Z",
      nativeArchived: false,
      libraryState: "active",
      tags: [],
    };
    const detail: HistorySessionDetail = {
      ...summary,
      libraryName: "",
      conversation: [{
        kind: "message",
        role: "user",
        text: "fallback needle",
        timestamp: "2026-01-02T00:00:00.000Z",
      }],
    };
    const application: Partial<DesktopApplicationDependencies> = {
      async listHistory(options) {
        const sessions = options.agents?.includes("codex") === true ? [summary] : [];
        return {
          total: sessions.length,
          offset: options.offset ?? 0,
          limit: options.limit ?? 50,
          returned: sessions.length,
          remaining: 0,
          sessions,
        };
      },
      async searchHistory(options, query) {
        const matches = options.agents?.includes("codex") === true && query === "needle";
        return {
          query,
          total: matches ? 1 : 0,
          offset: options.offset ?? 0,
          limit: options.limit ?? 50,
          returned: matches ? 1 : 0,
          remaining: 0,
          hits: matches ? [{ session: summary, field: "content", snippet: "fallback needle" }] : [],
        };
      },
      async showHistory(_stateDirectory, sessionRef) {
        if (sessionRef !== CODEX_REF) throw new Error("missing synthetic session");
        return detail;
      },
    };
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      application,
      historyIndex: {
        async syncDesktopHistoryIndex() { throw new Error("synthetic index unavailable"); },
      },
    });
    const listed = await service.listChats({ query: "needle" });
    assert.equal(listed.ok, true);
    if (listed.ok) assert.equal(listed.value.chats[0]!.sessionRef, CODEX_REF);
    const conversation = await service.getConversation({ sessionRef: CODEX_REF });
    assert.equal(conversation.ok, true);
    if (conversation.ok) assert.equal(conversation.value.items[0]!.index, 0);
    const found = await service.findInConversation({ sessionRef: CODEX_REF, query: "needle" });
    assert.equal(found.ok, true);
    if (found.ok) assert.deepEqual(found.value.matches.map((match) => match.index), [0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop settings are atomically persisted and strictly read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-settings-"));
  try {
    const service = createDesktopService({ stateDirectory: root, version: "test" });
    const settings = {
      theme: "dark",
      agentFilter: "codex",
      autoRefresh: true,
      showTechnicalDetails: true,
      firstRunComplete: true,
      lastSessionRef: CODEX_REF,
    } as const;
    assert.deepEqual(await service.updateSettings(settings), { ok: true, value: settings });
    const file = path.join(root, "desktop", "settings.json");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), settings);
    assert.deepEqual(await service.getSettings(), { ok: true, value: settings });
    assert.equal((await readdir(path.dirname(file))).some((name) => name.includes(".tmp-")), false);

    const { autoRefresh: _removed, ...legacySettings } = settings;
    await writeFile(file, JSON.stringify(legacySettings), "utf8");
    assert.deepEqual(await service.getSettings(), {
      ok: true,
      value: { ...legacySettings, autoRefresh: false },
    });

    const invalid = await service.updateSettings({ ...settings, extra: "secret" } as never);
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.error.code, "invalid_settings");
      assert.equal(JSON.stringify(invalid).includes("secret"), false);
    }

    await writeFile(file, "{private-path:C:\\Users\\secret}", "utf8");
    const corrupt = await service.getSettings();
    assert.equal(corrupt.ok, false);
    assert.equal(JSON.stringify(corrupt).includes("Users"), false);
    assert.equal(JSON.stringify(corrupt).includes("secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop chat list supports search, Agent and workspace filters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-list-"));
  try {
    await publishSessions(root, "codex", [storedSession({
      agent: "codex",
      sessionRef: CODEX_REF,
      nativeId: CODEX_NATIVE_ID,
      title: "Needle in Codex",
      workspace: "D:\\work\\alpha",
      updatedAt: "2026-01-02T00:00:00.000Z",
      conversation: [{
        kind: "message",
        role: "user",
        text: "find the needle here",
        timestamp: "2026-01-02T00:00:00.000Z",
      }],
    })]);
    await publishSessions(root, "claude", [storedSession({
      agent: "claude",
      sessionRef: CLAUDE_REF,
      nativeId: CLAUDE_NATIVE_ID,
      title: "Newer Claude chat",
      workspace: "D:\\work\\beta",
      updatedAt: "2026-01-03T00:00:00.000Z",
    })]);
    const service = createDesktopService({ stateDirectory: root, version: "test" });

    const first = await service.listChats({ limit: 1 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.total, 2);
    assert.equal(first.value.nextOffset, 1);
    assert.equal(first.value.chats[0]!.sessionRef, CLAUDE_REF);
    assert.equal(first.value.chats[0]!.workspaceName, "beta");

    const codex = await service.listChats({ agents: ["codex"] });
    assert.equal(codex.ok, true);
    if (codex.ok) assert.deepEqual(codex.value.chats.map((chat) => chat.sessionRef), [CODEX_REF]);

    const workspace = await service.listChats({ workspace: "d:\\WORK\\ALPHA" });
    assert.equal(workspace.ok, true);
    if (workspace.ok) assert.deepEqual(workspace.value.chats.map((chat) => chat.sessionRef), [CODEX_REF]);

    const searched = await service.listChats({ query: "needle" });
    assert.equal(searched.ok, true);
    if (searched.ok) {
      assert.deepEqual(searched.value.chats.map((chat) => chat.sessionRef), [CODEX_REF]);
      assert.match(searched.value.chats[0]!.preview ?? "", /needle/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop service uses the derived index without application history reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-index-service-"));
  try {
    await publishSessions(root, "codex", [storedSession({
      agent: "codex",
      sessionRef: CODEX_REF,
      nativeId: CODEX_NATIVE_ID,
      title: "Indexed daily chat",
      workspace: "D:\\work\\indexed",
      updatedAt: "2026-01-03T00:00:00.000Z",
      conversation: [{
        kind: "message",
        role: "user",
        text: "indexed-needle conversation",
        timestamp: "2026-01-03T00:00:00.000Z",
      }],
    })]);
    const forbidden = async (): Promise<never> => {
      throw new Error("application history fallback must not be used");
    };
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      application: {
        listHistory: forbidden,
        searchHistory: forbidden,
        showHistory: forbidden,
      },
    });
    const listed = await service.listChats({ query: "indexed-needle", agents: ["codex"] });
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.value.chats[0]!.preview, "indexed-needle conversation");
    const conversation = await service.getConversation({ sessionRef: CODEX_REF, limit: 1 });
    assert.equal(conversation.ok, true);
    if (conversation.ok) assert.equal(conversation.value.items[0]!.index, 0);
    const found = await service.findInConversation({ sessionRef: CODEX_REF, query: "needle" });
    assert.equal(found.ok, true);
    if (found.ok) assert.equal(found.value.matches[0]!.index, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop conversation is paged, exposes technical DTOs, and supports in-session search", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-conversation-"));
  try {
    await publishSessions(root, "codex", [storedSession({
      agent: "codex",
      sessionRef: CODEX_REF,
      nativeId: CODEX_NATIVE_ID,
      title: "Technical chat",
      workspace: "D:\\work\\alpha",
      updatedAt: "2026-01-03T00:00:00.000Z",
      conversation: [
        {
          kind: "message",
          role: "user",
          text: "start",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          kind: "message",
          role: "assistant",
          text: "completed the operation",
          timestamp: "2026-01-01T00:00:01.000Z",
          contentKinds: ["function_call"],
          portableBlocks: [{
            kind: "historical_tool",
            tool: {
              phase: "exchange",
              callId: "call-1",
              name: "shell",
              input: { command: "build" },
              output: "done",
            },
          }],
          portableNotes: ["codex.tool_metadata.skipped"],
        },
        {
          kind: "gap",
          label: "native boundary",
          code: "codex.boundary",
          timestamp: "2026-01-01T00:00:02.000Z",
        },
      ],
    })]);
    const service = createDesktopService({ stateDirectory: root, version: "test" });
    const conversation = await service.getConversation({ sessionRef: CODEX_REF, offset: 1, limit: 1 });
    assert.equal(conversation.ok, true);
    if (!conversation.ok) return;
    assert.equal(conversation.value.total, 3);
    assert.equal(conversation.value.nextOffset, 2);
    assert.equal(conversation.value.items[0]!.index, 1);
    const message = conversation.value.items[0]!;
    assert.equal(message.kind, "message");
    if (message.kind === "message") {
      assert.equal(message.technical.some((item) => item.label === "Tool history"), true);
      assert.equal(message.technical.some((item) => item.summary.includes("shell")), true);
      assert.equal(message.technical.some((item) => item.summary === "codex.tool_metadata.skipped"), true);
    }

    const found = await service.findInConversation({ sessionRef: CODEX_REF, query: "shell" });
    assert.equal(found.ok, true);
    if (found.ok) assert.deepEqual(found.value.matches.map((match) => match.index), [1]);

    const oversized = await service.getConversation({ sessionRef: CODEX_REF, limit: 201 });
    assert.equal(oversized.ok, false);
    if (!oversized.ok) assert.equal(oversized.error.code, "invalid_request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("technical detail previews and Unicode chunks share stable indexes with snapshot fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-technical-detail-"));
  try {
    const fullDetail = "汉😀".repeat(40_000);
    await publishSessions(root, "codex", [storedSession({
      agent: "codex",
      sessionRef: CODEX_REF,
      nativeId: CODEX_NATIVE_ID,
      title: "Large technical detail",
      workspace: "D:\\work\\technical",
      updatedAt: "2026-01-03T00:00:00.000Z",
      conversation: [{
        kind: "message",
        role: "assistant",
        text: "summary",
        timestamp: "2026-01-03T00:00:00.000Z",
        portableNotes: [fullDetail],
      }, {
        kind: "gap",
        label: "not a message",
        timestamp: "2026-01-03T00:00:01.000Z",
      }],
    })]);
    const service = createDesktopService({ stateDirectory: root, version: "test" });
    const conversation = await service.getConversation({ sessionRef: CODEX_REF, limit: 1 });
    assert.equal(conversation.ok, true);
    if (!conversation.ok || conversation.value.items[0]?.kind !== "message") return;
    const summary = conversation.value.items[0].technical[0]!;
    assert.equal(summary.detailIndex, 0);
    assert.equal(summary.truncated, true);
    assert.equal(summary.available, true);
    assert.equal(summary.totalCharacters, 80_000);

    let offset = 0;
    let reconstructed = "";
    while (true) {
      const chunk = await service.getTechnicalDetail({
        sessionRef: CODEX_REF,
        itemIndex: 0,
        detailIndex: 0,
        offset,
        limit: 20_000,
      });
      assert.equal(chunk.ok, true);
      if (!chunk.ok || chunk.value.status !== "available") return;
      reconstructed += chunk.value.text;
      if (chunk.value.nextOffset === undefined) break;
      offset = chunk.value.nextOffset;
    }
    assert.equal(reconstructed, fullDetail);

    const fallback = createDesktopService({
      stateDirectory: root,
      version: "test",
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) { return successfulIndexSync(stateDirectory); },
        async getDesktopConversationChunk() { throw new Error("derived index unavailable"); },
      },
    });
    const fallbackChunk = await fallback.getTechnicalDetail({
      sessionRef: CODEX_REF,
      itemIndex: 0,
      detailIndex: 0,
      offset: 0,
      limit: 7,
    });
    assert.equal(fallbackChunk.ok, true);
    if (fallbackChunk.ok && fallbackChunk.value.status === "available") {
      assert.equal(fallbackChunk.value.text, [...fullDetail].slice(0, 7).join(""));
    }
    const nonMessage = await service.getTechnicalDetail({
      sessionRef: CODEX_REF,
      itemIndex: 1,
      detailIndex: 0,
    });
    assert.equal(nonMessage.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop chat archive and delete overlays are recoverable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-overlay-"));
  try {
    await publishSessions(root, "codex", [storedSession({
      agent: "codex",
      sessionRef: CODEX_REF,
      nativeId: CODEX_NATIVE_ID,
      title: "Recoverable",
      workspace: "D:\\work\\alpha",
      updatedAt: "2026-01-03T00:00:00.000Z",
    })]);
    const service = createDesktopService({ stateDirectory: root, version: "test" });
    const archived = await service.updateChat({ sessionRef: CODEX_REF, operation: "archive" });
    assert.deepEqual(archived, {
      ok: true,
      value: { sessionRef: CODEX_REF, changed: true, state: "archived" },
    });
    assert.equal((await service.updateChat({ sessionRef: CODEX_REF, operation: "delete" })).ok, true);

    const deletedList = await service.listChats({});
    assert.equal(deletedList.ok, true);
    if (deletedList.ok) assert.equal(deletedList.value.total, 0);

    const hiddenList = await service.listChats({ libraryState: "deleted" });
    assert.equal(hiddenList.ok, true);
    if (hiddenList.ok) {
      assert.equal(hiddenList.value.total, 1);
      assert.equal(hiddenList.value.chats[0]!.sessionRef, CODEX_REF);
      assert.equal(hiddenList.value.chats[0]!.libraryState, "deleted");
    }

    const fallback = createDesktopService({
      stateDirectory: root,
      version: "test",
      historyIndex: {
        async listDesktopHistoryIndex() { throw new Error("derived index unavailable"); },
      },
    });
    const fallbackHidden = await fallback.listChats({ libraryState: "deleted" });
    assert.equal(fallbackHidden.ok, true);
    if (fallbackHidden.ok) assert.deepEqual(
      fallbackHidden.value.chats.map((chat) => chat.sessionRef),
      [CODEX_REF],
    );
    const fallbackSearch = await fallback.listChats({ libraryState: "deleted", query: "Recoverable" });
    assert.equal(fallbackSearch.ok, true);
    if (fallbackSearch.ok) assert.deepEqual(
      fallbackSearch.value.chats.map((chat) => chat.sessionRef),
      [CODEX_REF],
    );
    await fallback.dispose();

    const undeleted = await service.updateChat({ sessionRef: CODEX_REF, operation: "undelete" });
    assert.deepEqual(undeleted, {
      ok: true,
      value: { sessionRef: CODEX_REF, changed: true, state: "archived" },
    });
    const archivedList = await service.listChats({});
    assert.equal(archivedList.ok, true);
    if (archivedList.ok) assert.equal(archivedList.value.total, 0);
    const noLongerHidden = await service.listChats({ libraryState: "deleted" });
    assert.equal(noLongerHidden.ok, true);
    if (noLongerHidden.ok) assert.equal(noLongerHidden.value.total, 0);
    const active = await service.updateChat({ sessionRef: CODEX_REF, operation: "unarchive" });
    assert.deepEqual(active, {
      ok: true,
      value: { sessionRef: CODEX_REF, changed: true, state: "active" },
    });
    const restoredList = await service.listChats({});
    assert.equal(restoredList.ok, true);
    if (restoredList.ok) assert.equal(restoredList.value.chats[0]!.sessionRef, CODEX_REF);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop resume planning maps source settings and keeps CLI availability advisory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-resume-plan-"));
  try {
    const plannedOptions: PlanConversationResumeOptions[] = [];
    const preparedSpecs: Array<{ readonly command: string; readonly args: readonly string[]; readonly cwd: string }> = [];
    const degraded = conversationResumePlan({
      targetAgent: "claude",
      route: "conversion",
      quality: "degraded",
      findings: [{ code: "fixture.loss", disposition: "degraded", count: 1 }],
      workspace: {
        source: "D:\\trusted\\source",
        target: "D:\\trusted\\target",
        status: "mapped",
      },
      needsWrite: true,
      targetSessionRef: `ahsr1_claude_ck1_${"4".repeat(64)}`,
      targetNativeId: "target-native",
      classification: "new",
    });
    const resume: Partial<DesktopResumeDependencies> = {
      async planConversationResume(options) {
        plannedOptions.push(options);
        return options.targetAgent === "codex" ? conversationResumePlan() : degraded;
      },
      prepareResumeLaunch(options) {
        return {
          command: options.agent,
          args: ["literal-resume", options.nativeId],
          cwd: options.cwd,
        };
      },
    };
    const processDependencies: Partial<DesktopProcessDependencies> = {
      async prepareDetachedAgentLaunch(spec) {
        preparedSpecs.push(spec);
        if (spec.command === "claude") throw new Error("Claude CLI missing at C:\\secret");
        return {
          ...spec,
          executable: `C:\\trusted-tools\\${spec.command}.cmd`,
          platform: "win32",
        };
      },
    };
    const environment = { PATH: "C:\\trusted-tools" };
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      sourceOptions: {
        codex: {
          codexHome: "C:\\profiles\\codex",
          sqliteHome: "C:\\profiles\\codex-db",
          profile: "daily",
          cwd: "D:\\launcher",
          home: "C:\\Users\\fixture",
          environment,
        },
        claude: {
          configRoot: "C:\\profiles\\claude",
          cwd: "D:\\launcher",
          home: "C:\\Users\\fixture",
          environment,
        },
      },
      resume,
      process: processDependencies,
    });

    const native = await service.planResume({ sessionRef: CODEX_REF, targetAgent: "codex" });
    assert.equal(native.ok, true);
    if (native.ok) {
      assert.equal(native.value.route, "native");
      assert.equal(native.value.quality, "native");
      assert.equal(native.value.targetAvailable, true);
      assert.equal(native.value.needsWrite, false);
    }

    const converted = await service.planResume({
      sessionRef: CODEX_REF,
      targetAgent: "claude",
      pathMappings: ["D:\\trusted\\source=D:\\trusted\\target"],
    });
    assert.equal(converted.ok, true);
    if (converted.ok) {
      assert.equal(converted.value.route, "conversion");
      assert.equal(converted.value.quality, "degraded");
      assert.equal(converted.value.targetAvailable, false);
      assert.equal(converted.value.workspaceStatus, "mapped");
      assert.equal(converted.value.findings[0]!.code, "fixture.loss");
    }
    assert.equal(JSON.stringify(converted).includes("secret"), false);
    assert.equal(preparedSpecs[1]!.cwd, "D:\\trusted\\target");
    assert.deepEqual(plannedOptions[1], {
      stateDirectory: path.resolve(root),
      sessionRef: CODEX_REF,
      targetAgent: "claude",
      pathMappings: ["D:\\trusted\\source=D:\\trusted\\target"],
      codexHome: "C:\\profiles\\codex",
      sqliteHome: "C:\\profiles\\codex-db",
      profile: "daily",
      claudeConfigRoot: "C:\\profiles\\claude",
      environment,
      cwd: "D:\\launcher",
      home: "C:\\Users\\fixture",
    });

    const injectedCommand = await service.planResume({
      sessionRef: CODEX_REF,
      targetAgent: "codex",
      command: "cmd.exe",
      cwd: "C:\\attacker",
    } as never);
    assert.equal(injectedCommand.ok, false);
    assert.equal(plannedOptions.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop resume confirmation handles blocked and replan states before launching a literal core spec", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-resume-confirm-"));
  try {
    await mkdir(path.join(root, "desktop"), { recursive: true });
    await writeFile(path.join(root, "desktop", "terminal.json"), JSON.stringify({ schemaVersion: "agenthist.desktop-terminal/v1", mode: "configured",
      executablePath: process.execPath, label: "Synthetic terminal", arguments: ["{command}"] }));
    const replan = conversationResumePlan({ planRef: PLAN_REF_B });
    const blockedWithTarget = conversationResumePlan({
      targetAgent: "claude",
      route: "conversion",
      quality: "blocked",
      findings: [{ code: "fixture.blocked", disposition: "blocked", count: 1 }],
      blocked: true,
      needsWrite: false,
    });
    const {
      targetSessionRef: _blockedTargetSessionRef,
      targetNativeId: _blockedTargetNativeId,
      classification: _blockedClassification,
      ...blocked
    } = blockedWithTarget;
    const readyPlan = conversationResumePlan({
      targetAgent: "claude",
      route: "conversion",
      quality: "degraded",
      findings: [{ code: "fixture.degraded", disposition: "degraded", count: 1 }],
      workspace: {
        source: "D:\\trusted\\source",
        target: "D:\\trusted\\target",
        status: "mapped",
      },
      needsWrite: true,
      targetSessionRef: `ahsr1_claude_ck1_${"5".repeat(64)}`,
      targetNativeId: "core-target-native",
      classification: "new",
    });
    const literalLaunch = {
      command: "claude",
      args: ["--resume", "core-target-native"],
      cwd: "D:\\trusted\\target",
    } as const;
    let confirmation: ConversationResumeConfirmation = { status: "replan_required", plan: replan };
    const confirmOptions: Array<PlanConversationResumeOptions & { readonly expectedPlanRef: string }> = [];
    const launchedSpecs: typeof literalLaunch[] = [];
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      resume: {
        async confirmConversationResume(options) {
          confirmOptions.push(options);
          return confirmation;
        },
        prepareResumeLaunch(options) {
          return { command: options.agent, args: ["availability", options.nativeId], cwd: options.cwd };
        },
      },
      process: {
        async prepareDetachedAgentLaunch(spec) {
          return { ...spec, executable: `C:\\tools\\${spec.command}.cmd`, platform: "win32" };
        },
        async launchDetachedAgentProcess(spec) {
          launchedSpecs.push(spec as typeof literalLaunch);
          return { ...spec, executable: "C:\\tools\\claude.cmd", platform: "win32", pid: 4242 };
        },
      },
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) { return successfulIndexSync(stateDirectory); },
      },
    });

    const request = { sessionRef: CODEX_REF, targetAgent: "claude", expectedPlanRef: PLAN_REF_A } as const;
    const replanResult = await service.confirmResume(request);
    assert.equal(replanResult.ok, true);
    if (replanResult.ok) assert.equal(replanResult.value.status, "replan_required");
    assert.equal(launchedSpecs.length, 0);

    confirmation = { status: "blocked", plan: blocked };
    const blockedResult = await service.confirmResume(request);
    assert.equal(blockedResult.ok, true);
    if (blockedResult.ok) {
      assert.equal(blockedResult.value.status, "blocked");
      assert.equal(blockedResult.value.plan.quality, "blocked");
    }
    assert.equal(launchedSpecs.length, 0);

    confirmation = {
      status: "ready",
      plan: readyPlan,
      launch: literalLaunch,
      targetAgent: "claude",
      targetSessionRef: readyPlan.targetSessionRef!,
      targetNativeId: readyPlan.targetNativeId!,
      workspace: readyPlan.workspace.target,
      transactionRefs: ["ahtx1_fixture"],
    };
    const launched = await service.confirmResume(request);
    assert.equal(launched.ok, true);
    if (launched.ok && launched.value.status === "launched") {
      assert.equal(launched.value.pid, 4242);
      assert.deepEqual(launched.value.transactionRefs, ["ahtx1_fixture"]);
      assert.equal(launched.value.plan.targetAvailable, true);
      assert.equal(launched.value.workspace, "D:\\trusted\\target");
    }
    assert.deepEqual(launchedSpecs, [literalLaunch]);
    assert.equal(confirmOptions.length, 3);
    assert.equal(confirmOptions.every((item) => item.expectedPlanRef === PLAN_REF_A), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop resume waits for the active refresh without retrying its plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-refresh-resume-"));
  try {
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    let reportScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { reportScanStarted = resolve; });
    const events: string[] = [];
    let planCalls = 0;
    let confirmCalls = 0;
    const nativePlan = conversationResumePlan();
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      application: {
        async detectHistorySources(options) {
          const agent = options.agents![0]!;
          if (agent !== "codex") return notDetected(agent);
          return {
            schemaVersion: "agenthist.doctor/v1",
            status: "ready",
            agents: [{ agent, status: "ready", locations: [], findings: [] }],
          };
        },
        async scanHistory(options) {
          const agent = options.agents![0]!;
          events.push("scan:start");
          reportScanStarted();
          await scanGate;
          events.push("scan:end");
          return {
            status: "scanned",
            stateDirectory: options.stateDirectory,
            inspections: [],
            agents: [{
              agent,
              sessions: 1,
              reusedSessions: 0,
              rebuiltSessions: 1,
              removedSessions: 0,
              warnings: [],
            }],
            sessions: 1,
            warnings: [],
          };
        },
      },
      resume: {
        async planConversationResume() {
          planCalls++;
          events.push("plan");
          return nativePlan;
        },
        async confirmConversationResume() {
          confirmCalls++;
          events.push("confirm");
          return { status: "replan_required", plan: nativePlan };
        },
        prepareResumeLaunch(options) {
          return { command: "codex", args: ["resume", options.nativeId], cwd: options.cwd };
        },
      },
      process: {
        async prepareDetachedAgentLaunch(spec) {
          return { ...spec, executable: "C:\\tools\\codex.cmd", platform: "win32" };
        },
      },
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) { return successfulIndexSync(stateDirectory); },
      },
    });

    const refresh = service.refresh();
    await scanStarted;
    const plan = service.planResume({ sessionRef: CODEX_REF, targetAgent: "codex" });
    const confirmation = service.confirmResume({
      sessionRef: CODEX_REF,
      targetAgent: "codex",
      expectedPlanRef: PLAN_REF_A,
    });

    // Both methods have entered their explicit refresh barrier. No timer,
    // polling, lock-message matching, or planning attempt is involved.
    assert.equal(planCalls, 0);
    assert.equal(confirmCalls, 0);
    assert.deepEqual(events, ["scan:start"]);

    releaseScan();
    const [refreshResult, planResult, confirmationResult] = await Promise.all([
      refresh,
      plan,
      confirmation,
    ]);
    assert.equal(refreshResult.ok, true);
    assert.equal(planResult.ok, true);
    assert.equal(confirmationResult.ok, true);
    assert.equal(planCalls, 1);
    assert.equal(confirmCalls, 1);
    assert.equal(events.indexOf("plan") > events.indexOf("scan:end"), true);
    assert.equal(events.indexOf("confirm") > events.indexOf("scan:end"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop opens only the authoritative indexed workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-open-workspace-"));
  try {
    const authoritativeWorkspace = path.join(root, "trusted workspace");
    const executableInsteadOfWorkspace = path.join(root, "not-a-workspace.exe");
    await mkdir(authoritativeWorkspace, { recursive: true });
    await writeFile(executableInsteadOfWorkspace, "not executable fixture data", "utf8");
    let indexedWorkspace = authoritativeWorkspace;
    const opened: string[] = [];
    let platformFailure = "";
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) { return successfulIndexSync(stateDirectory); },
        async getDesktopConversationChunk(options) {
          assert.equal(options.sessionRef, CODEX_REF);
          return {
            session: {
              sessionRef: CODEX_REF,
              memberSessionRefs: [CODEX_REF],
              agent: "codex",
              nativeId: CODEX_NATIVE_ID,
              title: "Workspace chat",
              workspace: indexedWorkspace,
              workspaceName: "workspace",
              model: "codex-model",
              provider: "openai",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
              nativeArchived: false,
              libraryName: "",
              libraryState: "active",
              tags: [],
              preview: "",
              conversationItems: 0,
            },
            total: 0,
            offset: 0,
            limit: 1,
            returned: 0,
            remaining: 0,
            items: [],
          };
        },
      },
      platform: {
        async openPath(workspace) {
          opened.push(workspace);
          return platformFailure;
        },
      },
    });

    const rejected = await service.openWorkspace({
      sessionRef: CODEX_REF,
      path: "D:\\attacker",
    } as never);
    assert.equal(rejected.ok, false);
    assert.deepEqual(opened, []);

    const result = await service.openWorkspace({ sessionRef: CODEX_REF });
    assert.deepEqual(result, {
      ok: true,
      value: { workspace: authoritativeWorkspace, opened: true },
    });
    assert.deepEqual(opened, [authoritativeWorkspace]);

    indexedWorkspace = executableInsteadOfWorkspace;
    const nonDirectory = await service.openWorkspace({ sessionRef: CODEX_REF });
    assert.equal(nonDirectory.ok, false);
    assert.deepEqual(opened, [authoritativeWorkspace]);

    indexedWorkspace = authoritativeWorkspace;
    platformFailure = "Cannot open C:\\private\\secret";
    const failure = await service.openWorkspace({ sessionRef: CODEX_REF });
    assert.equal(failure.ok, false);
    assert.equal(JSON.stringify(failure).includes("private"), false);
    assert.equal(JSON.stringify(failure).includes("secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop transfer surfaces picker cancellation, opaque plans, blocked replans, and disposes handles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-transfer-service-"));
  try {
    const privateSource = "C:\\private\\selected-source.agenthist";
    let openCalls = 0;
    let exportCalls = 0;
    let applyCalls = 0;
    let disposeCalls = 0;
    let detectionCalls = 0;
    const readyPlan = importPlan();
    const replanned = importPlan({ planRef: `ahimportplan1_${"5".repeat(64)}` });
    const blocked = importPlan({
      planRef: `ahimportplan1_${"6".repeat(64)}`,
      status: "blocked",
      blocked: 1,
      transactionRequired: false,
    });
    const transfer = fakeTransfer({
      async exportHistory() {
        exportCalls++;
        return exportCalls === 1
          ? { status: "cancelled" }
          : {
              status: "completed",
              file: "D:\\exports\\daily.agenthist",
              sizeBytes: 100,
              sha256: "a".repeat(64),
              entries: 1,
              objects: 1,
              resources: 0,
              agents: [{ agent: "codex", sessions: 1 }],
              skipped: [],
            };
      },
      async openImport() {
        openCalls++;
        return openCalls === 1 ? { status: "cancelled" } : { status: "planned", plan: readyPlan };
      },
      async replanImport() { return blocked; },
      async applyImport() {
        applyCalls++;
        return applyCalls === 1
          ? { status: "replan_required", plan: replanned }
          : { status: "blocked", plan: blocked };
      },
      async dispose() { disposeCalls++; },
    });
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      transfer,
      application: {
        async detectHistorySources(options) {
          detectionCalls++;
          return notDetected(options.agents![0]!);
        },
      },
    });

    assert.deepEqual(await service.exportHistory({ scope: "all" }), {
      ok: true,
      value: { status: "cancelled" },
    });
    const exported = await service.exportHistory({ scope: "sessions", sessionRefs: [CODEX_REF] });
    assert.equal(exported.ok, true);
    if (exported.ok) assert.equal(exported.value.status, "completed");

    assert.deepEqual(await service.openImport(), { ok: true, value: { status: "cancelled" } });
    const opened = await service.openImport();
    assert.equal(opened.ok, true);
    assert.equal(JSON.stringify(opened).includes(privateSource), false);
    if (opened.ok && opened.value.status === "planned") {
      assert.equal(opened.value.plan.fileName, "fixture.agenthist");
      assert.equal(Object.hasOwn(opened.value.plan, "sourceFile"), false);
    }

    const replan = await service.replanImport({ handle: IMPORT_HANDLE, targetAgent: "claude" });
    assert.equal(replan.ok, true);
    if (replan.ok) assert.equal(replan.value.status, "blocked");
    const changed = await service.applyImport({ handle: IMPORT_HANDLE, expectedPlanRef: IMPORT_PLAN_REF });
    assert.equal(changed.ok, true);
    if (changed.ok) assert.equal(changed.value.status, "replan_required");
    const blockedResult = await service.applyImport({ handle: IMPORT_HANDLE, expectedPlanRef: replanned.planRef });
    assert.equal(blockedResult.ok, true);
    if (blockedResult.ok) assert.equal(blockedResult.value.status, "blocked");
    assert.equal(detectionCalls, 0);
    assert.deepEqual(await service.cancelImport({ handle: IMPORT_HANDLE }), {
      ok: true,
      value: { closed: true },
    });

    await service.dispose();
    await service.dispose();
    assert.equal(disposeCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace mapping takes only an authoritative source and a system-picked real target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-map-workspace-"));
  try {
    const target = path.join(root, "mapped target");
    const unsafe = path.join(root, "not-a-directory.txt");
    await mkdir(target, { recursive: true });
    await writeFile(unsafe, "file", "utf8");
    let selection: string | undefined;
    const calls: Array<{ readonly source: string; readonly target: string }> = [];
    const authoritativeSource = "/home/source project";
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      transfer: fakeTransfer({
        async mapImportWorkspace(request, targetDirectory) {
          if (request.source !== authoritativeSource) throw new Error("source is not in the private plan");
          calls.push({ source: request.source, target: targetDirectory });
          return { status: "planned", plan: importPlan({ status: "ready", blocked: 0 }) };
        },
      }),
      chooseImportWorkspaceDirectory: async () => selection,
      experience: fakeExperience(),
    });

    assert.deepEqual(await service.mapImportWorkspace({
      handle: IMPORT_HANDLE,
      source: authoritativeSource,
    }), { ok: true, value: { status: "cancelled" } });
    assert.deepEqual(calls, []);

    selection = target;
    const mapped = await service.mapImportWorkspace({ handle: IMPORT_HANDLE, source: authoritativeSource });
    assert.equal(mapped.ok, true);
    if (mapped.ok) assert.equal(mapped.value.status, "planned");
    assert.deepEqual(calls, [{ source: authoritativeSource, target }]);

    const forged = await service.mapImportWorkspace({ handle: IMPORT_HANDLE, source: "/forged/source" });
    assert.equal(forged.ok, false);
    assert.equal(JSON.stringify(forged).includes("private plan"), false);

    selection = unsafe;
    const unsafeResult = await service.mapImportWorkspace({ handle: IMPORT_HANDLE, source: authoritativeSource });
    assert.equal(unsafeResult.ok, false);
    assert.equal(calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop transfer operations wait on the active refresh barrier without timers or retries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-transfer-refresh-"));
  try {
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    let reportScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { reportScanStarted = resolve; });
    const transferCalls: string[] = [];
    const transfer = fakeTransfer({
      async exportHistory() { transferCalls.push("export"); return { status: "cancelled" }; },
      async openImport() { transferCalls.push("open"); return { status: "cancelled" }; },
      async replanImport() { transferCalls.push("replan"); return importPlan(); },
      async mapImportWorkspace() {
        transferCalls.push("map");
        return { status: "planned", plan: importPlan() };
      },
      async applyImport() {
        transferCalls.push("apply");
        return { status: "blocked", plan: importPlan({ status: "blocked" }) };
      },
    });
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      transfer,
      chooseImportWorkspaceDirectory: async () => root,
      application: {
        async detectHistorySources(options) {
          const agent = options.agents![0]!;
          return agent === "codex"
            ? {
                schemaVersion: "agenthist.doctor/v1",
                status: "ready",
                agents: [{ agent, status: "ready", locations: [], findings: [] }],
              }
            : notDetected(agent);
        },
        async scanHistory(options) {
          const agent = options.agents![0]!;
          reportScanStarted();
          await scanGate;
          return {
            status: "scanned",
            stateDirectory: options.stateDirectory,
            inspections: [],
            agents: [{
              agent,
              sessions: 0,
              reusedSessions: 0,
              rebuiltSessions: 0,
              removedSessions: 0,
              warnings: [],
            }],
            sessions: 0,
            warnings: [],
          };
        },
      },
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) { return successfulIndexSync(stateDirectory); },
      },
    });

    const refresh = service.refresh();
    await scanStarted;
    const operations = [
      service.exportHistory({ scope: "all" }),
      service.openImport(),
      service.replanImport({ handle: IMPORT_HANDLE }),
      service.mapImportWorkspace({ handle: IMPORT_HANDLE, source: "/missing/source" }),
      service.applyImport({ handle: IMPORT_HANDLE, expectedPlanRef: IMPORT_PLAN_REF }),
    ] as const;
    assert.deepEqual(transferCalls, []);
    releaseScan();
    await refresh;
    await Promise.all(operations);
    assert.deepEqual(transferCalls, ["export", "open", "replan", "map", "apply"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed import excludes a later refresh and satisfies it with one successful post-apply scan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-import-refresh-"));
  try {
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    let reportApplyStarted!: () => void;
    const applyStarted = new Promise<void>((resolve) => { reportApplyStarted = resolve; });
    let releaseDetection!: () => void;
    const detectionGate = new Promise<void>((resolve) => { releaseDetection = resolve; });
    let reportDetectionStarted!: () => void;
    const detectionStarted = new Promise<void>((resolve) => { reportDetectionStarted = resolve; });
    let detectionCalls = 0;
    let indexSyncs = 0;
    const progress: ScanProgressDto[] = [];
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      transfer: fakeTransfer({
        async applyImport() {
          reportApplyStarted();
          await applyGate;
          return {
            status: "completed",
            fileName: "fixture.agenthist",
            written: 1,
            alreadyPresent: 0,
            transactionRefs: ["ahtx1_import"],
          };
        },
      }),
      application: {
        async detectHistorySources(options) {
          detectionCalls++;
          if (detectionCalls === 1) {
            reportDetectionStarted();
            await detectionGate;
          }
          return notDetected(options.agents![0]!);
        },
      },
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) {
          indexSyncs++;
          return successfulIndexSync(stateDirectory);
        },
      },
    });

    const apply = service.applyImport({ handle: IMPORT_HANDLE, expectedPlanRef: IMPORT_PLAN_REF });
    await applyStarted;
    const refresh = service.refresh((item) => { progress.push(item); });
    assert.equal(detectionCalls, 0);
    releaseApply();
    await detectionStarted;
    assert.equal(detectionCalls, 1);
    releaseDetection();
    const [applied, refreshed] = await Promise.all([apply, refresh]);
    assert.equal(applied.ok, true);
    if (applied.ok) assert.equal(applied.value.status, "completed");
    assert.equal(refreshed.ok, true);
    if (refreshed.ok) assert.equal(refreshed.value.partial, false);
    assert.equal(detectionCalls, 4);
    assert.equal(indexSyncs, 1);
    assert.deepEqual(progress.map((item) => item.phase), [
      "detecting", "scanning", "scanning", "scanning", "scanning", "complete",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-apply indexing queues a fresh sync behind an older derived-index read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-import-index-order-"));
  try {
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    let reportApplyStarted!: () => void;
    const applyStarted = new Promise<void>((resolve) => { reportApplyStarted = resolve; });
    let releaseFirstSync!: () => void;
    const firstSyncGate = new Promise<void>((resolve) => { releaseFirstSync = resolve; });
    let reportFirstSyncStarted!: () => void;
    const firstSyncStarted = new Promise<void>((resolve) => { reportFirstSyncStarted = resolve; });
    let releaseSecondSync!: () => void;
    const secondSyncGate = new Promise<void>((resolve) => { releaseSecondSync = resolve; });
    let reportSecondSyncStarted!: () => void;
    const secondSyncStarted = new Promise<void>((resolve) => { reportSecondSyncStarted = resolve; });
    let indexSyncs = 0;
    let applySettled = false;
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      transfer: fakeTransfer({
        async applyImport() {
          reportApplyStarted();
          await applyGate;
          return {
            status: "completed",
            fileName: "fixture.agenthist",
            written: 1,
            alreadyPresent: 0,
            transactionRefs: ["ahtx1_import"],
          };
        },
      }),
      application: {
        async detectHistorySources(options) { return notDetected(options.agents![0]!); },
      },
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) {
          indexSyncs++;
          if (indexSyncs === 1) {
            reportFirstSyncStarted();
            await firstSyncGate;
          } else if (indexSyncs === 2) {
            reportSecondSyncStarted();
            await secondSyncGate;
          }
          return successfulIndexSync(stateDirectory);
        },
      },
    });

    const apply = service.applyImport({ handle: IMPORT_HANDLE, expectedPlanRef: IMPORT_PLAN_REF });
    void apply.then(() => { applySettled = true; });
    await applyStarted;
    const listing = service.listChats({});
    await firstSyncStarted;
    releaseApply();
    assert.equal(indexSyncs, 1);
    releaseFirstSync();
    await secondSyncStarted;
    assert.equal(applySettled, false);
    releaseSecondSync();
    assert.equal((await apply).ok, true);
    assert.equal((await listing).ok, true);
    assert.equal(indexSyncs, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduler-style refresh requests coalesce at one fair FIFO state turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-refresh-fifo-"));
  try {
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    let reportApplyStarted!: () => void;
    const applyStarted = new Promise<void>((resolve) => { reportApplyStarted = resolve; });
    let releaseDetection!: () => void;
    const detectionGate = new Promise<void>((resolve) => { releaseDetection = resolve; });
    let reportDetectionStarted!: () => void;
    const detectionStarted = new Promise<void>((resolve) => { reportDetectionStarted = resolve; });
    const events: string[] = [];
    let detectionCalls = 0;
    let planCalls = 0;
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      transfer: fakeTransfer({
        async applyImport() {
          events.push("apply:start");
          reportApplyStarted();
          await applyGate;
          events.push("apply:end");
          return { status: "blocked", plan: importPlan({ status: "blocked" }) };
        },
      }),
      application: {
        async detectHistorySources(options) {
          detectionCalls++;
          if (detectionCalls === 1) {
            events.push("refresh:start");
            reportDetectionStarted();
            await detectionGate;
          }
          return notDetected(options.agents![0]!);
        },
      },
      transactions: {
        async planDesktopTransaction() {
          planCalls++;
          events.push("plan");
          return transactionPlan();
        },
      },
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) { return successfulIndexSync(stateDirectory); },
      },
    });

    const apply = service.applyImport({ handle: IMPORT_HANDLE, expectedPlanRef: IMPORT_PLAN_REF });
    await applyStarted;
    const refreshA = service.refresh();
    const refreshB = service.refresh();
    const plan = service.planTransaction({ transactionRef: TRANSACTION_REF, action: "recover" });
    assert.equal(detectionCalls, 0);
    assert.equal(planCalls, 0);

    releaseApply();
    await detectionStarted;
    assert.equal(planCalls, 0);
    releaseDetection();
    const [, firstRefresh, secondRefresh, planned] = await Promise.all([
      apply,
      refreshA,
      refreshB,
      plan,
    ]);
    assert.equal(firstRefresh.ok, true);
    assert.equal(secondRefresh.ok, true);
    assert.equal(planned.ok, true);
    assert.equal(detectionCalls, 4);
    assert.equal(planCalls, 1);
    assert.deepEqual(events, ["apply:start", "apply:end", "refresh:start", "plan"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop Experience integration preserves all result states and forwards progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-experience-service-"));
  try {
    let runCalls = 0;
    let detectionCalls = 0;
    const progress: string[] = [];
    const review = experienceReview();
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      experience: fakeExperience({
        async runExperience(_request, onProgress) {
          runCalls++;
          onProgress?.({ phase: "indexing" });
          onProgress?.({ phase: "extracting", currentBatch: 1, totalBatches: 2 });
          if (runCalls === 1) {
            return { status: "replan_required", preview: experiencePreview({ previewRef: `ahexppreview1_${"c".repeat(64)}` }) };
          }
          if (runCalls === 2) return { status: "partial", remainingCards: 2 };
          return { status: "completed", review };
        },
        async loadExperienceReview() { return { status: "loaded", review }; },
      }),
      application: {
        async detectHistorySources(options) {
          detectionCalls++;
          return notDetected(options.agents![0]!);
        },
      },
    });

    const preview = await service.previewExperience({
      scope: "sessions",
      sessionRefs: [CLAUDE_REF, CODEX_REF],
    });
    assert.equal(preview.ok, true);
    if (preview.ok) assert.equal(preview.value.sessions, 2);

    const runRequest = { scope: { scope: "all" } as const, expectedPreviewRef: EXPERIENCE_PREVIEW_REF };
    const replanned = await service.runExperience(runRequest, (item) => { progress.push(item.phase); });
    assert.equal(replanned.ok, true);
    if (replanned.ok) assert.equal(replanned.value.status, "replan_required");
    const partial = await service.runExperience(runRequest, (item) => { progress.push(item.phase); });
    assert.equal(partial.ok, true);
    if (partial.ok) assert.deepEqual(partial.value, { status: "partial", remainingCards: 2 });
    const completed = await service.runExperience(runRequest, (item) => { progress.push(item.phase); });
    assert.equal(completed.ok, true);
    if (completed.ok && completed.value.status === "completed") {
      assert.equal(completed.value.review.handle, EXPERIENCE_HANDLE);
    }
    assert.equal(detectionCalls, 0);
    assert.deepEqual(progress, [
      "indexing", "extracting", "indexing", "extracting", "indexing", "extracting",
    ]);

    const loaded = await service.loadExperienceReview();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.value.status, "loaded");
    const candidate = await service.getExperienceCandidate({
      handle: EXPERIENCE_HANDLE,
      candidateRef: EXPERIENCE_CANDIDATE_REF,
    });
    assert.equal(candidate.ok, true);
    if (candidate.ok) assert.equal(candidate.value.evidenceItems[0]!.sessionRef, CODEX_REF);
    assert.deepEqual(await service.openExperienceOutput({ handle: EXPERIENCE_HANDLE }), {
      ok: true,
      value: { opened: true },
    });
    assert.deepEqual(await service.closeExperienceReview({ handle: EXPERIENCE_HANDLE }), {
      ok: true,
      value: { closed: true },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Experience configuration inspection, check, and open expose only safe authoritative data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-experience-config-"));
  try {
    const configFile = path.join(root, "desktop", "experience", ".env.agenthist");
    let configured = false;
    let failCheck = false;
    const opened: string[] = [];
    const profile = {
      tier: "fast" as const,
      backend: "openai-compatible-chat" as const,
      model: "safe-model",
      modelConfigured: true,
      endpoint: { kind: "remote" as const, label: "https://api.example.test" },
    };
    const experienceSettings: Partial<DesktopExperienceSettingsFacade> = {
      async inspectExperienceConfig() {
        return configured
          ? {
              status: "configured",
              configFile,
              backend: profile.backend,
              deepBinding: "fast",
              fast: profile,
              deep: { ...profile, tier: "deep" },
            }
          : {
              status: "not_configured",
              configFile,
              error: { code: "configuration_missing", retryable: false, stage: "configuration" },
            };
      },
      async checkExperienceConfig() {
        if (failCheck) throw new Error("AGENTHIST_EXPERIENCE_API_KEY=private-secret");
        return {
          status: "checked",
          configFile,
          historySent: false,
          requests: 1,
          profiles: [{
            ...profile,
            binding: "configured",
            requestMade: true,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }],
        };
      },
    };
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      experience: fakeExperience(),
      transfer: fakeTransfer(),
      experienceSettings,
      platform: {
        async openPath(directory) { opened.push(directory); return ""; },
      },
    });
    const missing = await service.inspectExperienceConfig();
    assert.equal(missing.ok, true);
    if (missing.ok) assert.equal(missing.value.status, "not_configured");
    configured = true;
    const inspection = await service.inspectExperienceConfig();
    assert.equal(inspection.ok, true);
    assert.equal(JSON.stringify(inspection).includes("API_KEY"), false);
    const checked = await service.checkExperienceConfig();
    assert.equal(checked.ok, true);
    if (checked.ok && checked.value.status === "checked") {
      assert.equal(checked.value.historySent, false);
      assert.equal(checked.value.profiles[0]!.endpoint.label, "https://api.example.test");
    }
    assert.deepEqual(await service.openExperienceConfig(), { ok: true, value: { opened: true } });
    assert.deepEqual(opened, [path.join(root, "desktop", "experience")]);

    failCheck = true;
    const failed = await service.checkExperienceConfig();
    assert.equal(failed.ok, false);
    assert.equal(JSON.stringify(failed).includes("private-secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Experience configuration check fails busy instead of crossing an active run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-experience-config-busy-"));
  try {
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
    let reportRunStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => { reportRunStarted = resolve; });
    let checkCalls = 0;
    let detectionCalls = 0;
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      transfer: fakeTransfer(),
      experience: fakeExperience({
        async runExperience() {
          reportRunStarted();
          await runGate;
          return { status: "partial", remainingCards: 1 };
        },
      }),
      experienceSettings: {
        async checkExperienceConfig() {
          checkCalls++;
          throw new Error("must not run concurrently");
        },
      },
      application: {
        async detectHistorySources(options) {
          detectionCalls++;
          return notDetected(options.agents![0]!);
        },
      },
    });
    const running = service.runExperience({
      scope: { scope: "all" },
      expectedPreviewRef: EXPERIENCE_PREVIEW_REF,
    });
    await runStarted;
    const refresh = service.refresh();
    assert.equal(detectionCalls, 0);
    const checked = await service.checkExperienceConfig();
    assert.equal(checked.ok, false);
    assert.equal(checkCalls, 0);
    releaseRun();
    assert.equal((await running).ok, true);
    assert.equal((await refresh).ok, true);
    assert.equal(detectionCalls, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Experience preview, run, and load wait for the active refresh barrier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-experience-refresh-"));
  try {
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    let reportScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { reportScanStarted = resolve; });
    const experienceCalls: string[] = [];
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      experience: fakeExperience({
        async previewExperience() { experienceCalls.push("preview"); return experiencePreview(); },
        async runExperience() {
          experienceCalls.push("run");
          return { status: "partial", remainingCards: 1 };
        },
        async loadExperienceReview() { experienceCalls.push("load"); return { status: "cancelled" }; },
      }),
      experienceSettings: {
        async inspectExperienceConfig() {
          experienceCalls.push("config");
          return {
            status: "not_configured",
            configFile: path.join(root, "desktop", "experience", ".env.agenthist"),
            error: { code: "configuration_missing", retryable: false, stage: "configuration" },
          };
        },
      },
      application: {
        async detectHistorySources(options) {
          const agent = options.agents![0]!;
          return agent === "codex"
            ? {
                schemaVersion: "agenthist.doctor/v1",
                status: "ready",
                agents: [{ agent, status: "ready", locations: [], findings: [] }],
              }
            : notDetected(agent);
        },
        async scanHistory(options) {
          const agent = options.agents![0]!;
          reportScanStarted();
          await scanGate;
          return {
            status: "scanned",
            stateDirectory: options.stateDirectory,
            inspections: [],
            agents: [{
              agent,
              sessions: 0,
              reusedSessions: 0,
              rebuiltSessions: 0,
              removedSessions: 0,
              warnings: [],
            }],
            sessions: 0,
            warnings: [],
          };
        },
      },
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) { return successfulIndexSync(stateDirectory); },
      },
    });

    const refresh = service.refresh();
    await scanStarted;
    const preview = service.previewExperience({ scope: "all" });
    const run = service.runExperience({
      scope: { scope: "all" },
      expectedPreviewRef: EXPERIENCE_PREVIEW_REF,
    });
    const load = service.loadExperienceReview();
    const config = service.inspectExperienceConfig();
    assert.deepEqual(experienceCalls, []);
    releaseScan();
    await refresh;
    await Promise.all([preview, run, load, config]);
    assert.deepEqual(experienceCalls.toSorted(), ["config", "load", "preview", "run"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop dispose attempts transfer and Experience cleanup before aggregating failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-dispose-"));
  try {
    let transferDisposals = 0;
    let experienceDisposals = 0;
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      transfer: fakeTransfer({
        async dispose() {
          transferDisposals++;
          throw new Error("private transfer handle cleanup failed");
        },
      }),
      experience: fakeExperience({
        async dispose() {
          experienceDisposals++;
          throw new Error("private Experience handle cleanup failed");
        },
      }),
    });
    await assert.rejects(
      () => service.dispose(),
      (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
    );
    assert.equal(transferDisposals, 1);
    assert.equal(experienceDisposals, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop dispose closes admission and drains an active state operation before cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-dispose-drain-"));
  try {
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    let reportApplyStarted!: () => void;
    const applyStarted = new Promise<void>((resolve) => { reportApplyStarted = resolve; });
    let transferDisposals = 0;
    let experienceDisposals = 0;
    let detectionCalls = 0;
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      transfer: fakeTransfer({
        async applyImport() {
          reportApplyStarted();
          await applyGate;
          return { status: "blocked", plan: importPlan({ status: "blocked" }) };
        },
        async dispose() { transferDisposals++; },
      }),
      experience: fakeExperience({ async dispose() { experienceDisposals++; } }),
      application: {
        async detectHistorySources(options) {
          detectionCalls++;
          return notDetected(options.agents![0]!);
        },
      },
    });

    const apply = service.applyImport({ handle: IMPORT_HANDLE, expectedPlanRef: IMPORT_PLAN_REF });
    await applyStarted;
    const disposing = service.dispose();
    assert.equal(transferDisposals, 0);
    assert.equal(experienceDisposals, 0);

    const rejectedRefresh = await service.refresh();
    assert.equal(rejectedRefresh.ok, false);
    assert.equal(detectionCalls, 0);
    releaseApply();
    assert.equal((await apply).ok, true);
    await disposing;
    assert.equal(transferDisposals, 1);
    assert.equal(experienceDisposals, 1);

    const rejectedPlan = await service.planTransaction({
      transactionRef: TRANSACTION_REF,
      action: "recover",
    });
    assert.equal(rejectedPlan.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop transaction facade maps findings and syncs the index only after completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-transactions-"));
  try {
    let confirmCalls = 0;
    let indexSyncs = 0;
    const older = transactionSummary({
      transactionRef: "ahtx1_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    const transactions: Partial<DesktopTransactionFacade> = {
      async listDesktopTransactions() { return [transactionSummary(), older]; },
      async planDesktopTransaction(_stateDirectory, request) {
        return transactionPlan({ action: request.action });
      },
      async confirmDesktopTransaction(_stateDirectory, request) {
        confirmCalls++;
        const plan = transactionPlan({ action: request.action });
        if (confirmCalls === 1) return { status: "replan_required", plan };
        if (confirmCalls === 2) return { status: "blocked", plan: { ...plan, ready: false } };
        return {
          status: "completed",
          plan,
          summary: transactionSummary({ state: "committed", phase: "complete" }),
        };
      },
    };
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      transactions,
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) {
          indexSyncs++;
          return successfulIndexSync(stateDirectory);
        },
      },
      experience: fakeExperience(),
      transfer: fakeTransfer(),
    });

    const listed = await service.listTransactions();
    assert.equal(listed.ok, true);
    if (listed.ok) assert.deepEqual(listed.value.map((item) => item.transactionRef), [TRANSACTION_REF, older.transactionRef]);
    const rollback = await service.planTransaction({ transactionRef: TRANSACTION_REF, action: "rollback" });
    assert.equal(rollback.ok, true);
    if (rollback.ok) {
      assert.equal(rollback.value.action, "rollback");
      assert.deepEqual(rollback.value.findings[0], {
        sessionRef: CODEX_REF,
        row: "after",
        section: "unchanged",
        file: "after",
        resources: "after",
        goal: "unchanged",
      });
    }
    const confirmation = { transactionRef: TRANSACTION_REF, action: "recover" as const, expectedPlanRef: TRANSACTION_PLAN_REF };
    const replanned = await service.confirmTransaction(confirmation);
    assert.equal(replanned.ok, true);
    if (replanned.ok) assert.equal(replanned.value.status, "replan_required");
    const blocked = await service.confirmTransaction(confirmation);
    assert.equal(blocked.ok, true);
    if (blocked.ok) assert.equal(blocked.value.status, "blocked");
    assert.equal(indexSyncs, 0);
    const completed = await service.confirmTransaction(confirmation);
    assert.equal(completed.ok, true);
    if (completed.ok && completed.value.status === "completed") {
      assert.equal(completed.value.summary.state, "committed");
    }
    assert.equal(indexSyncs, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transaction list, plan, and confirmation wait for an active refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-transaction-refresh-"));
  try {
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    let reportScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { reportScanStarted = resolve; });
    const calls: string[] = [];
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      transactions: {
        async listDesktopTransactions() { calls.push("list"); return []; },
        async planDesktopTransaction() { calls.push("plan"); return transactionPlan(); },
        async confirmDesktopTransaction() {
          calls.push("confirm");
          return { status: "blocked", plan: transactionPlan({ ready: false }) };
        },
      },
      application: {
        async detectHistorySources(options) {
          const agent = options.agents![0]!;
          return agent === "codex"
            ? {
                schemaVersion: "agenthist.doctor/v1",
                status: "ready",
                agents: [{ agent, status: "ready", locations: [], findings: [] }],
              }
            : notDetected(agent);
        },
        async scanHistory(options) {
          const agent = options.agents![0]!;
          reportScanStarted();
          await scanGate;
          return {
            status: "scanned",
            stateDirectory: options.stateDirectory,
            inspections: [],
            agents: [{ agent, sessions: 0, reusedSessions: 0, rebuiltSessions: 0, removedSessions: 0, warnings: [] }],
            sessions: 0,
            warnings: [],
          };
        },
      },
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) { return successfulIndexSync(stateDirectory); },
      },
      experience: fakeExperience(),
      transfer: fakeTransfer(),
    });
    const refresh = service.refresh();
    await scanStarted;
    const pending = [
      service.listTransactions(),
      service.planTransaction({ transactionRef: TRANSACTION_REF, action: "recover" }),
      service.confirmTransaction({
        transactionRef: TRANSACTION_REF,
        action: "recover",
        expectedPlanRef: TRANSACTION_PLAN_REF,
      }),
    ];
    assert.deepEqual(calls, []);
    releaseScan();
    await refresh;
    await Promise.all(pending);
    assert.deepEqual(calls.toSorted(), ["confirm", "list", "plan"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history-index rebuild is derived-only, reports issues, and waits for refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-rebuild-barrier-"));
  try {
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    let reportScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { reportScanStarted = resolve; });
    let rebuildCalls = 0;
    let scanCalls = 0;
    let failRebuild = false;
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      application: {
        async detectHistorySources(options) {
          const agent = options.agents![0]!;
          return agent === "codex"
            ? {
                schemaVersion: "agenthist.doctor/v1",
                status: "ready",
                agents: [{ agent, status: "ready", locations: [], findings: [] }],
              }
            : notDetected(agent);
        },
        async scanHistory(options) {
          scanCalls++;
          const agent = options.agents![0]!;
          reportScanStarted();
          await scanGate;
          return {
            status: "scanned",
            stateDirectory: options.stateDirectory,
            inspections: [],
            agents: [{ agent, sessions: 0, reusedSessions: 0, rebuiltSessions: 0, removedSessions: 0, warnings: [] }],
            sessions: 0,
            warnings: [],
          };
        },
      },
      historyIndex: {
        async syncDesktopHistoryIndex(stateDirectory) { return successfulIndexSync(stateDirectory); },
        async rebuildDesktopHistoryIndex(stateDirectory) {
          rebuildCalls++;
          if (failRebuild) throw new Error("C:\\private\\derived-index failure");
          return {
            ...successfulIndexSync(stateDirectory),
            rebuilt: true,
            removed: true,
            sessions: 7,
            issues: [
              { scope: "index", code: "index_rebuilt", message: "rebuilt" },
              { scope: "agent", agent: "codex", code: "snapshot_unavailable", message: "missing" },
            ],
          };
        },
      },
      transfer: fakeTransfer(),
      experience: fakeExperience(),
    });
    const refresh = service.refresh();
    await scanStarted;
    const rebuilding = service.rebuildHistoryIndex();
    assert.equal(rebuildCalls, 0);
    releaseScan();
    await refresh;
    const rebuilt = await rebuilding;
    assert.deepEqual(rebuilt, {
      ok: true,
      value: { rebuilt: true, removed: true, sessions: 7, issues: 2 },
    });
    assert.equal(scanCalls, 1);

    failRebuild = true;
    const failed = await service.rebuildHistoryIndex();
    assert.equal(failed.ok, false);
    assert.equal(JSON.stringify(failed).includes("private"), false);
    assert.equal(scanCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop refresh isolates all four Agents and emits bounded progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-refresh-"));
  try {
    const detectionCalls: Agent[] = [];
    const scanCalls: Agent[] = [];
    const application: Partial<DesktopApplicationDependencies> = {
      async detectHistorySources(options): Promise<HistorySourceInspectionResult> {
        const agent = options.agents![0]!;
        detectionCalls.push(agent);
        if (agent === "pi") return notDetected(agent);
        return {
          schemaVersion: "agenthist.doctor/v1",
          status: "ready",
          agents: [{ agent, status: "ready", locations: [], findings: [] }],
        };
      },
      async scanHistory(options): Promise<ScanHistoryResult> {
        const agent = options.agents![0]!;
        scanCalls.push(agent);
        if (agent === "claude") throw new Error("C:\\private\\history bearer-secret");
        const sessions = agent === "codex" ? 2 : 3;
        return {
          status: "scanned",
          stateDirectory: options.stateDirectory,
          inspections: [],
          agents: [{
            agent,
            sessions,
            reusedSessions: 1,
            rebuiltSessions: sessions - 1,
            removedSessions: 0,
            warnings: [],
          }],
          sessions,
          warnings: [],
        };
      },
    };
    const service = createDesktopService({
      stateDirectory: root,
      version: "test",
      sourceOptions: { codex: { codexHome: "D:\\synthetic\\codex" } },
      application,
    });
    const progress: ScanProgressDto[] = [];
    const refreshed = await service.refresh((item) => { progress.push(item); });
    assert.equal(refreshed.ok, true);
    if (!refreshed.ok) return;
    assert.deepEqual(detectionCalls, ["codex", "claude", "opencode", "pi"]);
    assert.deepEqual(scanCalls, ["codex", "claude", "opencode"]);
    assert.deepEqual(refreshed.value.agents.map((item) => item.status), [
      "scanned", "failed", "scanned", "not_detected",
    ]);
    assert.equal(refreshed.value.sessions, 5);
    assert.equal(refreshed.value.partial, true);
    assert.equal(JSON.stringify(refreshed).includes("private"), false);
    assert.equal(JSON.stringify(refreshed).includes("secret"), false);
    assert.deepEqual(progress.map((item) => item.phase), [
      "detecting", "scanning", "scanning", "scanning", "scanning", "complete",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
