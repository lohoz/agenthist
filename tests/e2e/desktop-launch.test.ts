import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";

import packageMetadata from "../../package.json" with { type: "json" };
import type { AgentHistDesktopApi } from "../../src/desktop/contracts.js";
import { createDesktopHistoryFixture } from "../support/desktop-history-fixture.js";

interface LaunchResult {
  readonly application: ElectronApplication;
  readonly page: Page;
}

test("settings exposes provider unification with preview, native transaction and responsive cards", async ({}, testInfo) => {
  const repository = path.resolve(import.meta.dirname, "..", "..");
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist settings provider "));
  let launched: LaunchResult | undefined;
  try {
    const workspace = path.join(root, "project");
    await mkdir(workspace, { recursive: true });
    await writeCodexCrossAgentSource(root, workspace);
    const config = path.join(root, "agents", "codex", "config.toml");
    await writeFile(config, 'model_provider="unified-ui"\n');
    launched = await launchDesktop(repository, root);
    const page = launched.page;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "开始使用" }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "浅色", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "设置分类" })).toBeVisible();
    await expect(page.getByRole("button", { name: "统一 Provider", exact: true })).toBeVisible();
    expect(await page.locator(".settings-page").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("settings-light.png"), mask: [page.locator(".agent-path-copy code, .terminal-path, .terminal-candidates code, .path-value")], maskColor: "#dfe4eb" });
    await page.getByRole("button", { name: "统一 Provider", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "统一历史 Provider" });
    await expect(dialog.getByText("1 条原生记录", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "预览变更", exact: true }).click();
    await expect(dialog.getByLabel("Provider 变更预览")).toContainText("unified-ui");
    const readProvider = () => {
      const db = new DatabaseSync(path.join(root, "agents", "codex-sqlite", "history-store.sqlite"), { readOnly: true });
      try { return (db.prepare("SELECT model_provider FROM threads").get() as { model_provider: string }).model_provider; }
      finally { db.close(); }
    };
    expect(readProvider()).toBe("openai");
    await page.screenshot({ path: testInfo.outputPath("provider-preview.png") });
    await dialog.getByRole("button", { name: "确认统一", exact: true }).click();
    await expect(dialog.getByText("Provider 已统一", { exact: true })).toBeVisible();
    expect(readProvider()).toBe("unified-ui");
    expect(await readFile(config, "utf8")).toBe('model_provider="unified-ui"\n');
    const transactions = await page.evaluate(async () => {
      const api = (window as unknown as Window & { agentHist: AgentHistDesktopApi }).agentHist;
      return api.listTransactions();
    });
    expect(transactions.ok).toBe(true);
    if (!transactions.ok) throw new Error("missing transaction");
    expect(transactions.value.some((item) => item.operation === "codex_provider_unify" && item.state === "committed")).toBe(true);
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await page.locator(".settings-page").evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath("settings-dark.png"), mask: [page.locator(".agent-path-copy code, .terminal-path, .terminal-candidates code, .path-value")], maskColor: "#39414d" });
    await launched.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(940, 700));
    expect(await page.locator(".settings-page").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "命令行终端" }).click();
    await expect(page.getByRole("heading", { name: "命令行终端", exact: true })).toBeVisible();
    expect(await page.getByLabel("终端默认启动参数").isVisible()).toBe(false);
    await page.getByText("启动参数（高级）", { exact: true }).click();
    await expect(page.getByLabel("终端默认启动参数")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("settings-narrow.png") });
    expect(errors).toEqual([]);
  } finally { await launched?.application.close(); await rm(root, { recursive: true, force: true }); }
});

test("experience detects the native API and checks its model without launching an Agent CLI", async ({}, testInfo) => {
  const repository = path.resolve(import.meta.dirname, "..", "..");
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist api detection "));
  let status = 200;
  const requests: Array<{ url: string | undefined; authorization: string | undefined; body: any }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.statusCode = status;
    if (status !== 200) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: { message: "private-key-fixture", type: "unavailable" } })); return; }
    response.setHeader("content-type", "text/event-stream");
    const content = requests.at(-1)?.body.text?.format?.name === "agenthist_single_pass_review" ? '{"candidates":[]}' : '{"ok":true}';
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: content }] }], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } })}\n\n`);
  });
  let launched: LaunchResult | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture API unavailable");
    const codexRoot = path.join(root, "agents", "codex");
    const bin = path.join(root, "fake tools");
    await mkdir(codexRoot, { recursive: true });
    await mkdir(bin, { recursive: true });
    const marker = path.join(root, "cli-was-launched");
    await writeFile(path.join(bin, process.platform === "win32" ? "codex.cmd" : "codex"), process.platform === "win32"
      ? `@echo off\r\necho unexpected>"${marker}"\r\nexit /b 1\r\n` : `#!/bin/sh\nprintf unexpected > '${marker}'\nexit 1\n`);
    if (process.platform !== "win32") await chmod(path.join(bin, "codex"), 0o700);
    await writeFile(path.join(codexRoot, "config.toml"), `model="native-api-test-model"\nmodel_provider="fixture"\nmodel_context_window=1000000\n[model_providers.fixture]\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\n`);
    await writeFile(path.join(codexRoot, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "private-key-fixture" }));
    const history = await createDesktopHistoryFixture({ stateDirectory: path.join(root, "state with spaces"), sessionCount: 240 });
    for (const [agent, snapshotId] of history.snapshotIds) {
      const file = path.join(root, "state with spaces", "history", agent, "snapshots", snapshotId, "index.json");
      const snapshot = JSON.parse(await readFile(file, "utf8"));
      for (const session of snapshot.sessions) for (const item of session.conversation) {
        if (item.kind === "message" && item.role === "user") item.text += "整理完整历史，对话内容和证据来源都需要保留。".repeat(70);
      }
      await writeFile(file, JSON.stringify(snapshot));
    }
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    launched = await launchDesktop(repository, root, { [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ""}` });
    const page = launched.page;
    await page.getByRole("button", { name: "开始使用" }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByText("native-api-test-model", { exact: true })).toBeVisible();
    await expect(page.getByText("Responses", { exact: true })).toBeVisible();
    await expect(page.getByText("1,000,000 tokens", { exact: true })).toBeVisible();
    expect(requests.length).toBe(0);
    await page.getByRole("button", { name: "检查模型", exact: true }).click();
    await expect(page.getByText("模型可用", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/v1/responses");
    expect(requests[0]?.authorization).toBe("Bearer private-key-fixture");
    expect(requests[0]?.body.model).toBe("native-api-test-model");
    expect(requests[0]?.body.store).toBe(false);
    expect(requests[0]?.body.input[0].content).toContain("no Agent history");
    await expect(page.locator("body")).not.toContainText("private-key-fixture");
    await expect(stat(marker)).rejects.toThrow();
    status = 503;
    await page.getByRole("button", { name: "检查模型", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "HTTP 503" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("private-key-fixture");
    await page.screenshot({ path: testInfo.outputPath("api-check-status.png") });
    status = 200;
    await page.getByRole("button", { name: "经验", exact: true }).click();
    await page.getByRole("button", { name: "分析历史", exact: true }).click();
    await expect(page.getByText(/只请求模型一次/)).toBeVisible();
    await expect(page.getByText(/全部 240 个对话/)).toBeVisible();
    const preview = await page.evaluate(async () => {
      const api = (window as unknown as Window & { agentHist: AgentHistDesktopApi }).agentHist;
      return api.previewExperience({ scope: "all" });
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("missing full-history preview");
    expect(preview.value.estimatedInputTokens).toBeGreaterThan(50000);
    expect(preview.value.inputLimitExceeded).toBe(false);
    expect(preview.value.modelContextWindow).toBe(1000000);
    await expect(page.locator(".preview-metrics > div").filter({ hasText: "模型请求" })).toHaveText("1模型请求");
    await page.screenshot({ path: testInfo.outputPath("single-pass-preview.png") });
    await launched.application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, root);
    const beforeRun = requests.length;
    await page.getByRole("button", { name: "运行分析", exact: true }).click();
    await expect(page.getByRole("button", { name: "打开输出目录", exact: true })).toBeVisible();
    expect(requests.length - beforeRun).toBe(1);
    expect(requests.at(-1)?.body.text.format.name).toBe("agenthist_single_pass_review");
    expect(JSON.parse(requests.at(-1)?.body.input[0].content).evidence).toHaveLength(240);
    await expect(stat(marker)).rejects.toThrow();
  } finally {
    await launched?.application.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("directory tree unifies mixed agents and subagent conversations in a compact desktop window", async ({}, testInfo) => {
  const repository = path.resolve(import.meta.dirname, "..", "..");
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist directory tree "));
  const stateDirectory = path.join(root, "state with spaces");
  let launched: LaunchResult | undefined;
  try {
    const fixture = await createDesktopHistoryFixture({ stateDirectory, sessionCount: 4 });
    for (const agent of ["codex", "claude", "opencode", "pi"] as const) {
      const file = path.join(stateDirectory, "history", agent, "snapshots", fixture.snapshotIds.get(agent)!, "index.json");
      const snapshot = JSON.parse(await readFile(file, "utf8"));
      const base = snapshot.sessions[0];
      if (agent === "codex") {
        const parent = { ...base, nativeId: "tree-parent", title: "部署服务器并验证连接", context: "\\\\?\\D:\\demo-project", native: {} };
        snapshot.sessions = [parent, ...[1, 2].map((index) => ({
          ...parent,
          nativeId: `tree-child-${index}`,
          sessionRef: `ahsr1_codex_ck1_${String(index).repeat(64)}`,
          native: { lineage: { parentThreadId: parent.nativeId, sessionId: parent.nativeId } },
          conversation: [...parent.conversation, { kind: "message", role: "assistant", text: `子任务 ${index} 完成`, timestamp: `2026-09-01T02:0${index}:00.000Z` }],
        }))];
      } else {
        snapshot.sessions = [{ ...base,
          title: agent === "claude" ? "检查项目配置" : agent === "pi" ? "更新客户端" : "整理文档",
          context: agent === "claude" ? "d:/demo-project/" : agent === "pi" ? "E:\\Tools" : "C:\\Work\\docs",
        }];
      }
      await writeFile(file, JSON.stringify(snapshot), "utf8");
    }
    launched = await launchDesktop(repository, root);
    const page = launched.page;
    await page.getByRole("button", { name: "开始使用" }).click();
    const tree = page.getByRole("tree", { name: "按目录浏览对话" });
    await expect(tree.getByRole("button", { name: "折叠D:" })).toBeVisible();
    await expect(tree.getByRole("button", { name: "折叠demo-project" })).toHaveCount(1);
    await expect(tree.getByText("部署服务器并验证连接", { exact: true })).toHaveCount(1);
    await expect(tree.getByText("检查项目配置", { exact: true })).toBeVisible();
    const chats = await page.evaluate(async () => {
      const api = (window as unknown as Window & { agentHist: AgentHistDesktopApi }).agentHist;
      return api.listChats({ workspace: "D:\\demo-project" });
    });
    expect(chats.ok).toBe(true);
    if (!chats.ok) throw new Error("fixture chats unavailable");
    expect(chats.value.total).toBe(2);
    expect(chats.value.chats.find((chat) => chat.agent === "codex")?.memberSessionRefs).toHaveLength(3);
    await tree.getByText("部署服务器并验证连接", { exact: true }).click();
    await expect(page.getByText("子任务 1 完成", { exact: true })).toBeVisible();
    await expect(page.getByText("子任务 2 完成", { exact: true })).toBeVisible();
    const bounds = await tree.locator(".chat-tree-session").first().boundingBox();
    expect(bounds!.height).toBeLessThanOrEqual(30);
    expect(await tree.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.locator(".agent-filters .agent-logo")).toHaveCount(4);
    expect(await page.locator(".agent-filters").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.locator(".agent-logo").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    const screenshot = testInfo.outputPath("directory-tree.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("compact directory tree", { path: screenshot, contentType: "image/png" });
    await tree.getByRole("button", { name: "折叠D:" }).click();
    await expect(tree.getByText("检查项目配置", { exact: true })).toHaveCount(0);
    await tree.getByRole("button", { name: "展开D:" }).click();
    await expect(tree.getByText("检查项目配置", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "经验", exact: true }).click();
    await page.getByRole("button", { name: "分析历史" }).click();
    await expect(page.getByRole("heading", { name: "分析预览" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "经验分析使用的 Agent" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("experience-native-agents.png") });
    await page.getByRole("button", { name: "对话", exact: true }).click();
    await page.getByRole("button", { name: "经验", exact: true }).click();
    await expect(page.getByRole("heading", { name: "分析预览" })).toBeVisible();
  } finally {
    await launched?.application.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function launchDesktop(
  repository: string,
  root: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
  extraArguments: readonly string[] = [],
): Promise<LaunchResult> {
  const agentRoots = {
    codex: path.join(root, "agents", "codex"),
    codexSqlite: path.join(root, "agents", "codex-sqlite"),
    claude: path.join(root, "agents", "claude"),
    opencode: path.join(root, "agents", "opencode"),
    pi: path.join(root, "agents", "pi"),
  };
  await Promise.all(Object.values(agentRoots).map((directory) => mkdir(directory, { recursive: true })));
  const executablePath = process.platform === "win32"
    ? path.join(repository, "node_modules", "electron", "dist", "electron.exe")
    : path.join(repository, "node_modules", "electron", "dist", "electron");
  const application = await electron.launch({
    executablePath,
    args: [
      path.join(repository, ".build", "src", "desktop", "main.js"),
      `--user-data-dir=${path.join(root, "chromium profile")}`,
      ...extraArguments,
    ],
    cwd: repository,
    env: {
      ...process.env,
      AGENTHIST_DESKTOP_STATE_DIR: path.join(root, "state with spaces"),
      CODEX_HOME: agentRoots.codex,
      CODEX_SQLITE_HOME: agentRoots.codexSqlite,
      CLAUDE_CONFIG_DIR: agentRoots.claude,
      OPENCODE_DB: path.join(agentRoots.opencode, "opencode.db"),
      XDG_DATA_HOME: agentRoots.opencode,
      PI_CODING_AGENT_SESSION_DIR: agentRoots.pi,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      ...extraEnvironment,
    },
  });
  return { application, page: await application.firstWindow() };
}

async function writeSyntheticSnapshot(
  root: string,
  workspace: string,
): Promise<{ readonly nativeId: string; readonly sessionRef: string }> {
  const stateDirectory = path.join(root, "state with spaces");
  const snapshotId = "10000000-0000-4000-8000-000000000001";
  const nativeId = "20000000-0000-4000-8000-000000000002";
  const sessionRef = `ahsr1_codex_ck1_${"3".repeat(64)}`;
  const snapshotRoot = path.join(stateDirectory, "history", "codex", "snapshots", snapshotId);
  await mkdir(path.join(snapshotRoot, "raw"), { recursive: true });
  await writeFile(path.join(snapshotRoot, "index.json"), `${JSON.stringify({
    schemaVersion: "agenthist.history-snapshot/v2",
    snapshotId,
    agent: "codex",
    scannedAt: "2026-09-04T01:00:00.000Z",
    sessions: [{
      sessionRef,
      agent: "codex",
      nativeId,
      title: "E2E resume conversation",
      context: workspace,
      model: "fixture-model",
      provider: "fixture-provider",
      createdAt: "2026-09-04T01:00:00.000Z",
      updatedAt: "2026-09-04T01:02:00.000Z",
      nativeArchived: false,
      library: { name: "", tags: [], archived: false, deleted: false },
      conversation: [
        { kind: "message", role: "user", text: "Can we resume safely?", timestamp: "2026-09-04T01:00:00.000Z" },
        { kind: "message", role: "assistant", text: "Yes, from the original workspace.", timestamp: "2026-09-04T01:01:00.000Z" },
      ],
      searchText: ["resume safely"],
      rawFiles: [],
      native: {},
    }],
    auxiliaryFiles: [],
    warnings: [],
  }, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(stateDirectory, "history", "codex", "head.json"),
    `${JSON.stringify({ schemaVersion: "agenthist.history-head/v1", snapshotId })}\n`,
    "utf8",
  );
  return { nativeId, sessionRef };
}

async function writeCodexCrossAgentSource(root: string, workspace: string): Promise<void> {
  const nativeId = "30000000-0000-4000-8000-000000000003";
  const rollout = path.join(
    root,
    "agents",
    "codex",
    "sessions",
    "2026",
    "09",
    "05",
    `rollout-2026-09-05T01-00-00-${nativeId}.jsonl`,
  );
  await mkdir(path.dirname(rollout), { recursive: true });
  const records = [
    {
      timestamp: "2026-09-05T01:00:00.000Z",
      type: "session_meta",
      payload: {
        id: nativeId,
        timestamp: "2026-09-05T01:00:00.000Z",
        cwd: workspace,
        originator: "codex_cli_rs",
        cli_version: "desktop-e2e",
        model_provider: "openai",
        model: "fixture-model",
      },
    },
    {
      timestamp: "2026-09-05T01:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "E2E cross Agent source" }] },
    },
    {
      timestamp: "2026-09-05T01:00:02.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Portable response for continuation." }] },
    },
  ];
  await writeFile(rollout, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const sqliteHome = path.join(root, "agents", "codex-sqlite");
  await mkdir(sqliteHome, { recursive: true });
  const database = new DatabaseSync(path.join(sqliteHome, "history-store.sqlite"));
  try {
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
    database.prepare(`
      INSERT INTO threads
        (id, rollout_path, created_at, updated_at, model_provider, cwd, title, archived, first_user_message, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nativeId,
      rollout,
      1788570000,
      1788570002,
      "openai",
      workspace,
      "E2E cross Agent source",
      0,
      "E2E cross Agent source",
      "fixture-model",
    );
  } finally {
    database.close();
  }
}

test("desktop launches without a server, completes first run, and restores local state", async ({}, testInfo) => {
  const repository = path.resolve(import.meta.dirname, "..", "..");
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist desktop e2e "));
  const rendererErrors: string[] = [];
  let first: LaunchResult | undefined;
  let second: LaunchResult | undefined;
  try {
    first = await launchDesktop(repository, root);
    first.page.on("pageerror", (error) => rendererErrors.push(error.message));
    expect(first.page.url()).toMatch(/^file:/u);
    await expect(first.page).toHaveTitle("AgentHist");
    await expect(first.page.getByRole("heading", { name: "欢迎使用 AgentHist" })).toBeVisible();
    await expect(first.page.getByLabel("Agent 检测结果").locator(".detection-row")).toHaveCount(4);
    await first.page.getByRole("button", { name: "开始使用" }).click();
    await expect(first.page.getByRole("searchbox", { name: "搜索对话" })).toBeVisible();
    await expect(first.page.getByText("还没有发现编程对话", { exact: true })).toBeVisible();
    await expect(first.page.getByRole("complementary", { name: "主导航" })).toBeVisible();
    await expect(first.page.getByText(`v${packageMetadata.version}`, { exact: true })).toBeVisible();
    const isolation = await first.page.evaluate(() => ({
      nodeProcess: typeof (globalThis as typeof globalThis & { process?: unknown }).process,
      commonJsRequire: typeof (globalThis as typeof globalThis & { require?: unknown }).require,
      apiFrozen: Object.isFrozen(
        (window as unknown as Window & { agentHist: AgentHistDesktopApi }).agentHist,
      ),
      protocol: window.location.protocol,
    }));
    expect(isolation).toEqual({
      nodeProcess: "undefined",
      commonJsRequire: "undefined",
      apiFrozen: true,
      protocol: "file:",
    });
    const screenshot = testInfo.outputPath("desktop-empty-state.png");
    await first.page.screenshot({ path: screenshot });
    await testInfo.attach("desktop empty state", { path: screenshot, contentType: "image/png" });
    await first.page.getByRole("button", { name: "设置", exact: true }).click();
    await first.page.getByRole("button", { name: "深色" }).click();
    await expect(first.page.locator("html")).toHaveAttribute("data-theme", "dark");
    await first.application.close();
    first = undefined;

    second = await launchDesktop(repository, root);
    second.page.on("pageerror", (error) => rendererErrors.push(error.message));
    await expect(second.page.getByRole("heading", { name: "欢迎使用 AgentHist" })).toHaveCount(0);
    await expect(second.page.getByRole("searchbox", { name: "搜索对话" })).toBeVisible();
    await expect(second.page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(rendererErrors).toEqual([]);
  } finally {
    await first?.application.close();
    await second?.application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows DPI scale factors keep the primary layout usable", async ({}, testInfo) => {
  const repository = path.resolve(import.meta.dirname, "..", "..");
  for (const factor of [1.25, 1.5]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `agenthist dpi ${factor} `));
    let launched: LaunchResult | undefined;
    try {
      launched = await launchDesktop(repository, root, {}, [`--force-device-scale-factor=${factor}`]);
      const page = launched.page;
      await page.getByRole("button", { name: "开始使用" }).click();
      await expect(page.getByRole("searchbox", { name: "搜索对话" })).toBeVisible();
      await expect(page.getByRole("complementary", { name: "主导航" })).toBeVisible();
      const metrics = await page.evaluate(() => ({
        ratio: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      }));
      expect(metrics.ratio).toBeCloseTo(factor, 1);
      expect(metrics.innerWidth).toBeGreaterThanOrEqual(920);
      expect(metrics.innerHeight).toBeGreaterThanOrEqual(620);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
      expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.innerHeight);
      if (factor === 1.25) {
        await launched.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.maximize());
        await expect.poll(() => launched!.application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)).toBe(true);
        await launched.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
        await expect.poll(() => launched!.application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false)).toBe(true);
        await launched.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
        await expect.poll(() => launched!.application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isMinimized() ?? true)).toBe(false);
        await launched.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.unmaximize());
        await expect.poll(() => launched!.application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isMaximized() ?? true)).toBe(false);
      }
      const screenshot = testInfo.outputPath(`desktop-dpi-${factor}.png`);
      await page.screenshot({ path: screenshot });
      await testInfo.attach(`desktop ${factor * 100}% scale`, { path: screenshot, contentType: "image/png" });
    } finally {
      await launched?.application.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("synthetic desktop UX remains usable with a long library, conversation, and technical output", async ({}, testInfo) => {
  const repository = path.resolve(import.meta.dirname, "..", "..");
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist ux e2e "));
  const stateDirectory = path.join(root, "state with spaces");
  const fakeBin = path.join(root, "fake agent executables");
  const rendererErrors: string[] = [];
  let launched: LaunchResult | undefined;
  try {
    await mkdir(fakeBin, { recursive: true });
    for (const agent of ["codex", "claude", "opencode", "pi"]) {
      const executable = path.join(fakeBin, process.platform === "win32" ? `${agent}.cmd` : agent);
      await writeFile(executable, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
      if (process.platform !== "win32") await chmod(executable, 0o700);
    }
    const fixture = await createDesktopHistoryFixture({
      stateDirectory,
      sessionCount: 240,
      longToolOutputCharacters: 140 * 1024,
      longConversationMessages: 220,
      longSessionAgent: "pi",
    });
    const target = fixture.sessions("pi")[0]!;
    await mkdir(target.context, { recursive: true });
    const crossAgentWorkspace = path.join(root, "cross Agent workspace");
    await mkdir(crossAgentWorkspace, { recursive: true });
    await writeCodexCrossAgentSource(root, crossAgentWorkspace);
    const pathName = process.platform === "win32" ? "Path" : "PATH";
    const launchEnvironment = {
      [pathName]: `${fakeBin}${path.delimiter}${process.env[pathName] ?? process.env.PATH ?? ""}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };
    launched = await launchDesktop(repository, root, launchEnvironment, ["--force-device-scale-factor=1.25"]);
    let page = launched.page;
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
    await page.getByRole("button", { name: "开始使用" }).click();
    expect(await page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(1.25, 1);
    await expect(page.getByRole("searchbox", { name: "搜索对话" })).toBeVisible();
    await page.getByRole("button", { name: "刷新对话" }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const api = (window as unknown as Window & { agentHist: AgentHistDesktopApi }).agentHist;
      const result = await api.listChats({ limit: 1 });
      return result.ok ? result.value.total : -1;
    })).toBe(181);

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "浅色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await minimumMutedContrast(page)).toBeGreaterThanOrEqual(4.5);
    await page.getByRole("button", { name: "对话" }).click();
    const list = page.getByTestId("chat-list-scroll");
    await expect(list.locator(".chat-list-item").first()).toBeVisible();
    expect(await list.locator(".chat-list-item").count()).toBeLessThan(40);
    const lightScreenshot = testInfo.outputPath("desktop-populated-light.png");
    await page.screenshot({ path: lightScreenshot });
    await testInfo.attach("populated Chats light", { path: lightScreenshot, contentType: "image/png" });

    await expect.poll(async () => {
      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll"));
      });
      return page.getByText("共 181 个对话", { exact: true }).count();
    }).toBe(1);
    expect(await list.locator(".chat-list-item").count()).toBeLessThan(40);

    await page.getByRole("button", { name: "Claude Code", exact: true }).click();
    await expect(page.getByRole("button", { name: "Claude Code", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => list.locator(".chat-list-item").evaluateAll((items) =>
      items.length > 0 && items.every((item) => item.querySelector(".agent-claude") !== null))).toBe(true);
    await page.getByRole("button", { name: "全部", exact: true }).click();
    await expect(page.getByRole("button", { name: "全部", exact: true })).toHaveAttribute("aria-pressed", "true");

    const search = page.getByRole("searchbox", { name: "搜索对话" });
    await search.fill(target.searchText[0]!);
    await list.getByText(target.title, { exact: true }).click();
    await expect(page.getByRole("heading", { name: target.title })).toBeVisible();
    const technicalToggle = page.getByRole("button", { name: "显示技术细节" });
    await technicalToggle.click();
    const toolDetail = page.locator("details.technical-detail-view").filter({ hasText: "Tool history" });
    await toolDetail.locator("summary").click();
    await expect(toolDetail.getByRole("button", { name: "加载更多" })).toBeVisible();
    await toolDetail.getByRole("button", { name: "加载更多" }).click();
    await expect(toolDetail).toContainText("已完整加载");
    const technicalScreenshot = testInfo.outputPath("desktop-technical-detail.png");
    await page.screenshot({ path: technicalScreenshot });
    await testInfo.attach("paged technical detail", { path: technicalScreenshot, contentType: "image/png" });

    await toolDetail.locator("summary").click();
    const codeCopy = page.getByRole("button", { name: "复制代码" });
    await codeCopy.click();
    await expect(codeCopy).toContainText("已复制");
    expect(await launched.application.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('const fixtureClipboard = "AgentHist 🧪";');
    expect(await page.evaluate(async () => {
      try {
        await navigator.clipboard.readText();
        return false;
      } catch {
        return true;
      }
    })).toBe(true);
    const conversation = page.getByTestId("conversation-scroll");
    await expect.poll(async () => {
      await conversation.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll"));
      });
      return page.getByText("Long synthetic message 219", { exact: false }).count();
    }).toBe(1);
    await expect(page.getByText("Long synthetic message 219", { exact: false })).toBeVisible();
    expect(await conversation.locator(".virtual-conversation-row").count()).toBeLessThan(40);

    await page.keyboard.press("Control+f");
    const conversationSearch = page.getByRole("textbox", { name: "在对话中搜索" });
    await conversationSearch.fill("Long synthetic message 219");
    await expect(page.locator(".find-count")).toContainText("1/1");
    await page.getByRole("button", { name: "关闭对话搜索" }).click();

    await search.fill("E2E cross Agent source");
    await page.getByRole("button", { name: /E2E cross Agent source/u }).click();
    await expect(page.getByRole("heading", { name: /E2E cross Agent source/u })).toBeVisible();
    await page.getByRole("button", { name: "使用其他 Agent 继续" }).click();
    await page.getByRole("menuitem", { name: "Claude Code" }).click();
    const resumeDialog = page.getByRole("dialog", { name: "使用 Claude Code 继续" });
    await expect(resumeDialog).toBeVisible();
    await expect(resumeDialog).toContainText("来源");
    await expect(resumeDialog).toContainText("目标");
    await page.getByRole("button", { name: "关闭继续对话窗口" }).click();

    await launched.application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
    });
    await page.getByRole("button", { name: "更多对话操作" }).click();
    await expect(page.getByRole("menuitem", { name: "打开工作区" })).toBeVisible();
    await page.getByRole("menuitem", { name: /导出对话/u }).click();
    await expect(page.locator(".toast-notice")).toContainText("已取消导出");

    const exportDirectory = path.join(root, "exported archives");
    const exportedArchive = path.join(exportDirectory, "Codex to Claude 中文.agenthist");
    await mkdir(exportDirectory, { recursive: true });
    await launched.application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportedArchive);
    await page.getByRole("button", { name: "更多对话操作" }).click();
    await page.getByRole("menuitem", { name: /导出对话/u }).click();
    await expect(page.locator(".toast-notice")).toContainText("已导出对话 · 共 1 条记录");
    expect((await stat(exportedArchive)).size).toBeGreaterThan(0);

    const importArchive = async (): Promise<ReturnType<Page["getByRole"]>> => {
      await launched!.application.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
      }, exportedArchive);
      await page.getByRole("button", { name: "导入与导出" }).click();
      await page.getByRole("menuitem", { name: "导入…" }).click();
      const dialog = page.getByRole("dialog", { name: path.basename(exportedArchive) });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("combobox", { name: "目标 Agent" }).click();
      await page.getByRole("option", { name: "Claude Code" }).click();
      await expect(dialog.getByRole("status")).toContainText("选择或转换方式已更新");
      return dialog;
    };

    let importDialog = await importArchive();
    const firstSummary = importDialog.getByLabel("导入摘要");
    await expect(firstSummary).toContainText("1新增");
    await importDialog.getByRole("button", { name: "确认导入" }).click();
    importDialog = page.getByRole("dialog", { name: "导入完成" });
    await expect(importDialog.getByRole("heading", { name: "导入完成", level: 3 })).toBeVisible();
    await expect(importDialog).toContainText("1 个对话");
    await expect(importDialog).toContainText("1 个可恢复事务");
    await importDialog.getByRole("button", { name: "完成" }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const api = (window as unknown as Window & { agentHist: AgentHistDesktopApi }).agentHist;
      const result = await api.listChats({ query: "E2E cross Agent source", agents: ["claude"], limit: 10 });
      return result.ok ? result.value.total : -1;
    })).toBe(1);

    importDialog = await importArchive();
    const duplicateSummary = importDialog.getByLabel("导入摘要");
    await expect(duplicateSummary).toContainText("0新增");
    await expect(duplicateSummary).toContainText("1已存在");
    await importDialog.getByRole("button", { name: "确认导入" }).click();
    importDialog = page.getByRole("dialog", { name: "导入完成" });
    await expect(importDialog.getByRole("heading", { name: "导入完成", level: 3 })).toBeVisible();
    await expect(importDialog).toContainText("0 个对话");
    await expect(importDialog).toContainText("目标中已有 1 个");
    await importDialog.getByRole("button", { name: "完成" }).click();

    await search.fill(target.searchText[0]!);
    await list.getByText(target.title, { exact: true }).click();
    await expect(page.getByRole("heading", { name: target.title })).toBeVisible();

    await page.keyboard.press("Control+k");
    const quickSearch = page.getByRole("dialog", { name: "快速搜索" });
    await expect(quickSearch).toBeVisible();
    await expect(page.getByLabel("快速搜索对话")).toBeFocused();
    await page.getByLabel("快速搜索对话").fill(target.searchText[0]!);
    await expect(quickSearch.getByRole("option").filter({ hasText: target.title }).first()).toBeVisible();
    const quickSearchScreenshot = testInfo.outputPath("desktop-quick-search.png");
    await page.screenshot({ path: quickSearchScreenshot });
    await testInfo.attach("Quick Search keyboard dialog", { path: quickSearchScreenshot, contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(quickSearch).toHaveCount(0);

    await page.getByRole("button", { name: "经验" }).click();
    await page.getByRole("button", { name: "分析历史" }).click();
    await expect(page.getByRole("heading", { name: "分析预览" })).toBeVisible();
    await expect(page.getByText("尚未发送任何内容", { exact: true })).toBeVisible();
    const experienceScreenshot = testInfo.outputPath("desktop-experience-preview.png");
    await page.screenshot({ path: experienceScreenshot });
    await testInfo.attach("Experience preview", { path: experienceScreenshot, contentType: "image/png" });

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "经验模型" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "命令行终端" })).toBeVisible();
    await expect(page.getByText(/Windows Terminal（自动）|未检测到终端，请先设置/u)).toBeVisible();
    await page.getByRole("button", { name: "深色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await minimumMutedContrast(page)).toBeGreaterThanOrEqual(4.5);
    const recovery = page.getByRole("button", { name: /事务恢复/u });
    await recovery.click();
    const recoveryDialog = page.getByRole("dialog", { name: "事务恢复" });
    await expect(recoveryDialog).toBeVisible();
    expect(await recoveryDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Tab");
    expect(await recoveryDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const recoveryScreenshot = testInfo.outputPath("desktop-recovery-dialog.png");
    await page.screenshot({ path: recoveryScreenshot, animations: "disabled" });
    await testInfo.attach("Recovery dialog focus", { path: recoveryScreenshot, contentType: "image/png" });
    await recoveryDialog.getByRole("button", { name: "回滚" }).first().click();
    await expect(recoveryDialog.getByRole("button", { name: "确认回滚" })).toBeEnabled();
    await recoveryDialog.getByRole("button", { name: "确认回滚" }).click();
    await expect(recoveryDialog.getByRole("status")).toContainText("已安全回滚");
    await page.getByRole("button", { name: "关闭事务恢复" }).click();
    await expect(recoveryDialog).toHaveCount(0);
    await expect.poll(async () => page.evaluate(async () => {
      const api = (window as unknown as Window & { agentHist: AgentHistDesktopApi }).agentHist;
      const refreshed = await api.refresh();
      if (!refreshed.ok) return -1;
      const result = await api.listChats({ query: "E2E cross Agent source", agents: ["claude"], limit: 10 });
      return result.ok ? result.value.total : -1;
    })).toBe(0);

    await page.getByRole("button", { name: /重建索引/u }).click();
    const rebuildDialog = page.getByRole("alertdialog", { name: "要重建本地索引吗？" });
    await expect(rebuildDialog).toBeVisible();
    expect(await rebuildDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(rebuildDialog).toHaveCount(0);
    const darkScreenshot = testInfo.outputPath("desktop-settings-dark.png");
    await page.screenshot({ path: darkScreenshot });
    await testInfo.attach("Settings dark", { path: darkScreenshot, contentType: "image/png" });

    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).not.toMatch(/img-src[^;]*https/iu);

    await page.getByRole("button", { name: "对话" }).click();
    await page.getByRole("searchbox", { name: "搜索对话" }).fill("");
    await page.getByRole("button", { name: "Pi", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pi", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("searchbox", { name: "搜索对话" }).fill(target.searchText[0]!);
    await list.getByText(target.title, { exact: true }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const api = (window as unknown as Window & { agentHist: AgentHistDesktopApi }).agentHist;
      const result = await api.getSettings();
      return result.ok
        ? { agentFilter: result.value.agentFilter, lastSessionRef: result.value.lastSessionRef }
        : {};
    })).toEqual({ agentFilter: "pi", lastSessionRef: target.sessionRef });

    await launched.application.close();
    launched = undefined;
    launched = await launchDesktop(repository, root, launchEnvironment, ["--force-device-scale-factor=1.25"]);
    page = launched.page;
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
    await expect(page.getByRole("heading", { name: "欢迎使用 AgentHist" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pi", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: target.title })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(rendererErrors).toEqual([]);
  } finally {
    await launched?.application.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function minimumMutedContrast(page: Page): Promise<number> {
  return page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    const foreground = styles.getPropertyValue("--text-muted").trim();
    const backgrounds = ["--bg", "--panel", "--panel-subtle", "--panel-raised", "--selected"]
      .map((name) => styles.getPropertyValue(name).trim());
    const luminance = (hex: string): number => {
      const normalized = /^#[0-9a-f]{3}$/iu.test(hex)
        ? `#${[...hex.slice(1)].map((channel) => `${channel}${channel}`).join("")}`
        : hex;
      const channels = normalized.slice(1).match(/.{2}/gu)?.map((channel) => Number.parseInt(channel, 16) / 255);
      if (channels === undefined || channels.length !== 3) throw new Error(`invalid computed theme color: ${JSON.stringify(hex)}`);
      const [red, green, blue] = channels.map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
    };
    const foregroundLuminance = luminance(foreground);
    return Math.min(...backgrounds.map((background) => {
      const backgroundLuminance = luminance(background);
      return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    }));
  });
}

test("Experience previews the local corpus before any model run", async () => {
  const repository = path.resolve(import.meta.dirname, "..", "..");
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist experience e2e "));
  const workspace = path.join(root, "workspace");
  let launched: LaunchResult | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    await writeSyntheticSnapshot(root, workspace);
    launched = await launchDesktop(repository, root);
    const page = launched.page;
    await page.getByRole("button", { name: "开始使用" }).click();
    await page.getByRole("button", { name: "经验" }).click();
    await page.getByRole("button", { name: "分析历史" }).click();
    await expect(page.getByRole("heading", { name: "分析预览" })).toBeVisible();
    await expect(page.getByText("尚未发送任何内容", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "运行分析" })).toBeEnabled();
  } finally {
    await launched?.application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt Agent source is isolated, remains actionable, and recovers without losing healthy chats", async () => {
  const repository = path.resolve(import.meta.dirname, "..", "..");
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist corrupt source e2e "));
  const stateDirectory = path.join(root, "state with healthy snapshots");
  const invalidDatabase = path.join(root, "agents", "opencode", "opencode.db");
  const healthyWorkspace = path.join(root, "healthy Codex workspace");
  const rendererErrors: string[] = [];
  let launched: LaunchResult | undefined;
  try {
    await createDesktopHistoryFixture({ stateDirectory, sessionCount: 8 });
    await mkdir(healthyWorkspace, { recursive: true });
    await writeCodexCrossAgentSource(root, healthyWorkspace);
    await mkdir(invalidDatabase, { recursive: true });
    launched = await launchDesktop(repository, root);
    const page = launched.page;
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
    await page.getByRole("button", { name: "开始使用" }).click();
    await page.getByRole("button", { name: "刷新对话" }).click();

    const warning = page.locator(".compact-warning");
    await expect(warning).toContainText("刷新未完全成功");
    await expect.poll(async () => page.evaluate(async () => {
      const api = (window as unknown as Window & { agentHist: AgentHistDesktopApi }).agentHist;
      const result = await api.listChats({ query: "E2E cross Agent source", agents: ["codex"], limit: 20 });
      return result.ok
        ? { total: result.value.total, unique: new Set(result.value.chats.map((chat) => chat.sessionRef)).size }
        : { total: -1, unique: -1 };
    })).toEqual({ total: 1, unique: 1 });
    await page.getByRole("searchbox", { name: "搜索对话" }).fill("E2E cross Agent source");
    await expect(page.getByRole("button", { name: /E2E cross Agent source/u })).toBeVisible();

    await rm(invalidDatabase, { recursive: true, force: true });
    await warning.getByRole("button", { name: "重试" }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const api = (window as unknown as Window & { agentHist: AgentHistDesktopApi }).agentHist;
      const result = await api.refresh();
      return result.ok ? result.value.partial : true;
    })).toBe(false);
    await expect(warning).toHaveCount(0);
    await expect.poll(async () => page.evaluate(async () => {
      const api = (window as unknown as Window & { agentHist: AgentHistDesktopApi }).agentHist;
      const result = await api.listChats({ query: "E2E cross Agent source", agents: ["codex"], limit: 20 });
      return result.ok ? result.value.total : -1;
    })).toBe(1);
    expect(rendererErrors).toEqual([]);
  } finally {
    await launched?.application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Continue requires terminal setup when no terminal can be detected", async () => {
  const repository = path.resolve(import.meta.dirname, "..", "..");
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist resume e2e "));
  const workspace = path.join(root, "workspace with spaces");
  const trustedBin = path.join(root, "trusted bin");
  const isolatedLocalAppData = path.join(root, "isolated local app data");
  let launched: LaunchResult | undefined;
  try {
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(trustedBin, { recursive: true }),
      mkdir(isolatedLocalAppData, { recursive: true }),
    ]);
    await writeSyntheticSnapshot(root, workspace);
    const command = path.join(trustedBin, process.platform === "win32" ? "codex.cmd" : "codex");
    await writeFile(command, process.platform === "win32"
      ? "@echo off\r\n> \"%AGENTHIST_LAUNCH_MARKER%\" echo %~1^|%~2\r\n"
      : "#!/bin/sh\nprintf '%s|%s' \"$1\" \"$2\" > \"$AGENTHIST_LAUNCH_MARKER\"\n", "utf8");
    if (process.platform !== "win32") await chmod(command, 0o700);
    const pathName = process.platform === "win32" ? "Path" : "PATH";
    launched = await launchDesktop(repository, root, {
      [pathName]: `${trustedBin}${path.delimiter}${process.env[pathName] ?? process.env.PATH ?? ""}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      LOCALAPPDATA: isolatedLocalAppData,
    });
    const page = launched.page;
    await page.getByRole("button", { name: "开始使用" }).click();
    await page.getByRole("button", { name: /E2E resume conversation/u }).click();
    await expect(page.getByRole("heading", { name: "E2E resume conversation" })).toBeVisible();
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("请先在设置中选择终端并检查默认参数");
  } finally {
    await launched?.application.close();
    await rm(root, { recursive: true, force: true });
  }
});
