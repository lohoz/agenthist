import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_IPC, type DesktopResult, type ScanProgressDto } from "../../../src/desktop/contracts.js";
import { registerDesktopIpc } from "../../../src/desktop/ipc.js";
import type { DesktopService } from "../../../src/desktop/service.js";

type Handler = (_event: unknown, ...args: unknown[]) => Promise<DesktopResult<unknown>>;

class FakeIpcMain {
  readonly handlers = new Map<string, Handler>();
  readonly trustedEvent = {};

  handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<DesktopResult<unknown>> {
    return this.invokeFrom(this.trustedEvent, channel, ...args);
  }

  async invokeFrom(event: unknown, channel: string, ...args: unknown[]): Promise<DesktopResult<unknown>> {
    const handler = this.handlers.get(channel);
    assert.notEqual(handler, undefined);
    return handler!(event, ...args);
  }
}

const EMPTY_PAGE = {
  total: 0,
  offset: 0,
  limit: 50,
  returned: 0,
  remaining: 0,
  chats: [],
} as const;

const SETTINGS = {
  theme: "system",
  agentFilter: "all",
  autoRefresh: false,
  showTechnicalDetails: false,
  firstRunComplete: false,
} as const;

function fakeService(overrides: Partial<DesktopService> = {}): DesktopService {
  return {
    async listCodexProviders() { return { ok: true, value: { currentProvider: "openai", totalSessions: 0, providers: [] } }; },
    async previewCodexProviderUnify() { return { ok: false, error: { code: "fixture", message: "No provider changes", retryable: false } }; },
    async confirmCodexProviderUnify() { return { ok: false, error: { code: "fixture", message: "No provider changes", retryable: false } }; },
    async bootstrap() {
      return {
        ok: true,
        value: {
          version: "test",
          stateDirectory: "C:\\state",
          settings: SETTINGS,
          agents: [],
          agentSettings: [],
          chats: EMPTY_PAGE,
        },
      };
    },
    async listChats() { return { ok: true, value: EMPTY_PAGE }; },
    async getConversation(request) {
      return {
        ok: true,
        value: {
          chat: {
            sessionRef: request.sessionRef,
            memberSessionRefs: [request.sessionRef],
            agent: "codex",
            title: "",
            workspace: "",
            workspaceName: "",
            updatedAt: "2026-01-01T00:00:00.000Z",
            libraryState: "active",
            tags: [],
          },
          model: "",
          provider: "",
          total: 0,
          offset: 0,
          limit: 100,
          returned: 0,
          remaining: 0,
          items: [],
        },
      };
    },
    async getTechnicalDetail() {
      return {
        ok: false,
        error: { code: "not_configured", message: "Not configured.", retryable: false },
      };
    },
    async findInConversation(request) {
      return { ok: true, value: { query: request.query, matches: [] } };
    },
    async refresh(onProgress) {
      const result = { agents: [], sessions: 0, partial: false } as const;
      onProgress?.({ phase: "detecting" });
      onProgress?.({ phase: "complete", result });
      return { ok: true, value: result };
    },
    async rebuildHistoryIndex() {
      return { ok: true, value: { rebuilt: true, removed: false, sessions: 0, issues: 0 } };
    },
    async updateChat(request) {
      return { ok: true, value: { sessionRef: request.sessionRef, changed: false, state: "active" } };
    },
    async planResume() {
      return {
        ok: false,
        error: { code: "not_configured", message: "Not configured.", retryable: false },
      };
    },
    async confirmResume() {
      return {
        ok: false,
        error: { code: "not_configured", message: "Not configured.", retryable: false },
      };
    },
    async openWorkspace() {
      return {
        ok: false,
        error: { code: "not_configured", message: "Not configured.", retryable: false },
      };
    },
    async exportHistory() {
      return { ok: true, value: { status: "cancelled" } };
    },
    async openImport() {
      return { ok: true, value: { status: "cancelled" } };
    },
    async replanImport() {
      return {
        ok: false,
        error: { code: "not_configured", message: "Not configured.", retryable: false },
      };
    },
    async mapImportWorkspace() {
      return {
        ok: false,
        error: { code: "not_configured", message: "Not configured.", retryable: false },
      };
    },
    async applyImport() {
      return {
        ok: false,
        error: { code: "not_configured", message: "Not configured.", retryable: false },
      };
    },
    async cancelImport() {
      return { ok: true, value: { closed: true } };
    },
    async previewExperience() {
      return {
        ok: false,
        error: { code: "not_configured", message: "Not configured.", retryable: false },
      };
    },
    async runExperience(_request, onProgress) {
      onProgress?.({ phase: "indexing" });
      onProgress?.({ phase: "extracting", currentBatch: 1, totalBatches: 1 });
      return { ok: true, value: { status: "partial", remainingCards: 1 } };
    },
    async loadExperienceReview() {
      return { ok: true, value: { status: "cancelled" } };
    },
    async getExperienceCandidate() {
      return {
        ok: false,
        error: { code: "not_configured", message: "Not configured.", retryable: false },
      };
    },
    async openExperienceOutput() {
      return { ok: true, value: { opened: true } };
    },
    async closeExperienceReview() {
      return { ok: true, value: { closed: true } };
    },
    async inspectExperienceConfig() {
      return {
        ok: true,
        value: {
          status: "not_configured",
          configFile: "C:\\state\\desktop\\experience\\.env.agenthist",
          error: { code: "configuration_missing", retryable: false, stage: "configuration" },
        },
      };
    },
    async checkExperienceConfig() {
      return {
        ok: true,
        value: {
          status: "not_configured",
          configFile: "C:\\state\\desktop\\experience\\.env.agenthist",
          historySent: false,
          requests: 0,
          error: { code: "configuration_missing", retryable: false, stage: "configuration" },
        },
      };
    },
    async openExperienceConfig() {
      return { ok: true, value: { opened: true } };
    },
    async getAgentSettings() {
      return { ok: true, value: [] };
    },
    async chooseAgentPath() {
      return { ok: true, value: { status: "cancelled" } };
    },
    async clearAgentPath() {
      return { ok: true, value: { settings: [] } };
    },
    async getTerminalSettings() {
      return {
        ok: true,
        value: {
          mode: "auto",
          effectiveLabel: "未检测到终端，请先设置",
          arguments: ["{command}"],
          candidates: [],
          requiresSetup: true,
        },
      };
    },
    async selectTerminal() {
      return this.getTerminalSettings();
    },
    async updateTerminalArguments() {
      return this.getTerminalSettings();
    },
    async listTransactions() {
      return { ok: true, value: [] };
    },
    async planTransaction() {
      return {
        ok: false,
        error: { code: "not_configured", message: "Not configured.", retryable: false },
      };
    },
    async confirmTransaction() {
      return {
        ok: false,
        error: { code: "not_configured", message: "Not configured.", retryable: false },
      };
    },
    async getSettings() { return { ok: true, value: SETTINGS }; },
    async updateSettings(settings) { return { ok: true, value: settings }; },
    async dispose() {},
    ...overrides,
  };
}

test("desktop IPC registers narrow handlers, forwards progress, and cleans up", async () => {
  const ipcMain = new FakeIpcMain();
  const progress: ScanProgressDto[] = [];
  const experienceProgress: Array<{ readonly phase: string }> = [];
  const themes: string[] = [];
  const cleanup = registerDesktopIpc({
    ipcMain: ipcMain as never,
    service: fakeService(),
    authorizeSender: (event) => event === ipcMain.trustedEvent,
    onProgress: (item) => { progress.push(item); },
    onExperienceProgress: (item) => { experienceProgress.push(item); },
    onThemeChanged: (theme) => { themes.push(theme); },
  });

  assert.equal(ipcMain.handlers.size, 40);
  assert.equal((await ipcMain.invoke(DESKTOP_IPC.listCodexProviders)).ok, true);
  assert.equal((await ipcMain.invoke(DESKTOP_IPC.listCodexProviders, { path: "untrusted" })).ok, false);
  assert.equal((await ipcMain.invoke(DESKTOP_IPC.previewCodexProviderUnify)).ok, false);
  assert.equal((await ipcMain.invokeFrom({}, DESKTOP_IPC.confirmCodexProviderUnify, { targetProvider: "openai" })).ok, false);
  const bootstrapped = await ipcMain.invoke(DESKTOP_IPC.bootstrap, undefined);
  assert.equal(bootstrapped.ok, true);
  const rejectedSender = await ipcMain.invokeFrom({}, DESKTOP_IPC.bootstrap, undefined);
  assert.equal(rejectedSender.ok, false);
  if (!rejectedSender.ok) assert.equal(rejectedSender.error.code, "ipc_sender_rejected");
  const listed = await ipcMain.invoke(DESKTOP_IPC.listChats, {});
  assert.deepEqual(listed, { ok: true, value: EMPTY_PAGE });
  assert.equal((await ipcMain.invoke(DESKTOP_IPC.getTechnicalDetail)).ok, false);
  const refreshed = await ipcMain.invoke(DESKTOP_IPC.refresh);
  assert.equal(refreshed.ok, true);
  assert.deepEqual(progress.map((item) => item.phase), ["detecting", "complete"]);
  assert.deepEqual(await ipcMain.invoke(DESKTOP_IPC.rebuildHistoryIndex, undefined), {
    ok: true,
    value: { rebuilt: true, removed: false, sessions: 0, issues: 0 },
  });
  const importPicker = await ipcMain.invoke(DESKTOP_IPC.openImport, undefined);
  assert.deepEqual(importPicker, { ok: true, value: { status: "cancelled" } });
  const missingExportRequest = await ipcMain.invoke(DESKTOP_IPC.exportHistory);
  assert.equal(missingExportRequest.ok, false);
  const extraApplyArgument = await ipcMain.invoke(
    DESKTOP_IPC.applyImport,
    { handle: `ahimport1_${"c".repeat(64)}`, expectedPlanRef: `ahimportplan1_${"d".repeat(64)}` },
    "extra",
  );
  assert.equal(extraApplyArgument.ok, false);
  const experienceRun = await ipcMain.invoke(DESKTOP_IPC.runExperience, {
    scope: { scope: "all" },
    expectedPreviewRef: `ahexppreview1_${"e".repeat(64)}`,
  });
  assert.equal(experienceRun.ok, true);
  assert.deepEqual(experienceProgress.map((item) => item.phase), ["indexing", "extracting"]);
  assert.deepEqual(await ipcMain.invoke(DESKTOP_IPC.loadExperienceReview, undefined), {
    ok: true,
    value: { status: "cancelled" },
  });
  const inspectedExperience = await ipcMain.invoke(DESKTOP_IPC.inspectExperienceConfig, undefined);
  assert.equal(inspectedExperience.ok, true);
  assert.equal((await ipcMain.invoke(DESKTOP_IPC.checkExperienceConfig, "extra")).ok, false);
  assert.equal((await ipcMain.invoke(DESKTOP_IPC.getExperienceCandidate)).ok, false);
  assert.deepEqual(await ipcMain.invoke(DESKTOP_IPC.getAgentSettings, undefined), {
    ok: true,
    value: [],
  });
  assert.equal((await ipcMain.invoke(DESKTOP_IPC.chooseAgentPath)).ok, false);
  assert.equal((await ipcMain.invoke(
    DESKTOP_IPC.clearAgentPath,
    { agent: "codex" },
    "extra",
  )).ok, false);
  assert.equal((await ipcMain.invoke(DESKTOP_IPC.getTerminalSettings, undefined)).ok, true);
  assert.equal((await ipcMain.invoke(DESKTOP_IPC.selectTerminal)).ok, false);
  assert.equal((await ipcMain.invoke(DESKTOP_IPC.updateTerminalArguments, { arguments: ["{command}"] })).ok, true);
  assert.deepEqual(await ipcMain.invoke(DESKTOP_IPC.listTransactions, undefined), {
    ok: true,
    value: [],
  });
  assert.equal((await ipcMain.invoke(DESKTOP_IPC.planTransaction)).ok, false);
  const themeResult = await ipcMain.invoke(DESKTOP_IPC.updateSettings, { ...SETTINGS, theme: "dark" });
  assert.equal(themeResult.ok, true);
  assert.deepEqual(themes, ["dark"]);

  const missingResumeRequest = await ipcMain.invoke(DESKTOP_IPC.planResume);
  assert.equal(missingResumeRequest.ok, false);
  if (!missingResumeRequest.ok) assert.equal(missingResumeRequest.error.code, "invalid_request");
  const extraWorkspaceRequest = await ipcMain.invoke(
    DESKTOP_IPC.openWorkspace,
    { sessionRef: `ahsr1_codex_ck1_${"a".repeat(64)}` },
    "extra",
  );
  assert.equal(extraWorkspaceRequest.ok, false);

  const extraArgument = await ipcMain.invoke(DESKTOP_IPC.bootstrap, "unexpected");
  assert.equal(extraArgument.ok, false);
  if (!extraArgument.ok) assert.equal(extraArgument.error.code, "invalid_request");

  cleanup();
  cleanup();
  assert.equal(ipcMain.handlers.size, 0);
});

test("desktop IPC redacts an unexpected service exception", async () => {
  const ipcMain = new FakeIpcMain();
  registerDesktopIpc({
    ipcMain: ipcMain as never,
    authorizeSender: (event) => event === ipcMain.trustedEvent,
    service: fakeService({
      async bootstrap() {
        throw new Error("C:\\private\\history token=secret");
      },
    }),
  });
  const result = await ipcMain.invoke(DESKTOP_IPC.bootstrap);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("desktop IPC rejects an untrusted or indeterminate sender before invoking service code", async () => {
  const ipcMain = new FakeIpcMain();
  let calls = 0;
  let authorizationThrows = false;
  registerDesktopIpc({
    ipcMain: ipcMain as never,
    authorizeSender() {
      if (authorizationThrows) throw new Error("sender frame disappeared");
      return false;
    },
    service: fakeService({
      async bootstrap() {
        calls++;
        throw new Error("must not run");
      },
    }),
  });
  const rejected = await ipcMain.invoke(DESKTOP_IPC.bootstrap);
  assert.equal(rejected.ok, false);
  authorizationThrows = true;
  const indeterminate = await ipcMain.invoke(DESKTOP_IPC.bootstrap);
  assert.equal(indeterminate.ok, false);
  assert.equal(calls, 0);
});
