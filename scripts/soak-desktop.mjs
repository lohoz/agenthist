import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { _electron as electron } from "playwright";

const AGENTS = ["codex", "claude", "opencode", "pi"];

function positiveInteger(name, raw, maximum) {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} requires a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return value;
}

function argumentsValue() {
  const arguments_ = process.argv.slice(2);
  let rounds = 10;
  let sessions = 1_000;
  if (arguments_.length === 2 && arguments_.every((value) => /^[1-9][0-9]*$/.test(value))) {
    rounds = positiveInteger("--rounds", arguments_[0], 100);
    sessions = positiveInteger("--sessions", arguments_[1], 10_000);
  } else {
    const seen = new Set();
    for (let index = 0; index < arguments_.length;) {
      const argument = arguments_[index];
      const equals = argument?.indexOf("=") ?? -1;
      const name = equals < 0 ? argument : argument.slice(0, equals);
      if (name !== "--rounds" && name !== "--sessions" || seen.has(name)) {
        throw new Error(`unsupported or repeated argument: ${argument}`);
      }
      seen.add(name);
      const value = equals < 0 ? arguments_[index + 1] : argument.slice(equals + 1);
      if (name === "--rounds") rounds = positiveInteger(name, value, 100);
      else sessions = positiveInteger(name, value, 10_000);
      index += equals < 0 ? 2 : 1;
    }
  }
  if (sessions < AGENTS.length) throw new Error(`--sessions must be at least ${AGENTS.length}`);
  return { rounds, sessions };
}

async function fakeExecutable(file) {
  await writeFile(file, process.platform === "win32"
    ? "@echo off\r\nexit /b 0\r\n"
    : "#!/bin/sh\nexit 0\n", "utf8");
  if (process.platform !== "win32") await chmod(file, 0o700);
}

async function launchDesktop(repository, root, stateDirectory, fakeBin, errors, diagnostics) {
  const executablePath = process.platform === "win32"
    ? path.join(repository, "node_modules", "electron", "dist", "electron.exe")
    : path.join(repository, "node_modules", "electron", "dist", "electron");
  const agentRoot = path.join(root, "synthetic agent roots");
  const roots = Object.fromEntries(AGENTS.map((agent) => [agent, path.join(agentRoot, agent)]));
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const application = await electron.launch({
    executablePath,
    args: [
      path.join(repository, ".build", "src", "desktop", "main.js"),
      `--user-data-dir=${path.join(root, "chromium profile")}`,
    ],
    cwd: repository,
    env: {
      ...process.env,
      AGENTHIST_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_HOME: roots.codex,
      CODEX_SQLITE_HOME: path.join(agentRoot, "codex sqlite"),
      CLAUDE_CONFIG_DIR: roots.claude,
      XDG_DATA_HOME: roots.opencode,
      OPENCODE_DB: path.join(roots.opencode, "opencode.db"),
      PI_CODING_AGENT_SESSION_DIR: roots.pi,
      [pathKey]: `${fakeBin}${path.delimiter}${process.env[pathKey] ?? process.env.PATH ?? ""}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  try {
    const child = application.process();
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text === "") return;
      if (/error|failed|unhandled|exception|fatal/iu.test(text)) errors.push(`main stderr: ${text}`);
      else diagnostics.push(`main stderr: ${text}`);
    });
    const page = await application.firstWindow();
    page.on("pageerror", (error) => errors.push(`renderer pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`renderer console: ${message.text()}`);
    });
    const settings = await page.evaluate(() => window.agentHist.getSettings());
    if (!settings.ok) throw new Error(`${settings.error.code}: ${settings.error.message}`);
    if (!settings.value.firstRunComplete) {
      await page.getByRole("button", { name: "开始使用", exact: true }).click();
    }
    await page.getByRole("searchbox", { name: "搜索对话" }).waitFor();
    await page.getByTestId("chat-list-scroll").waitFor();
    return { application, page };
  } catch (error) {
    await application.close().catch(() => undefined);
    throw error;
  }
}

async function allChats(page) {
  return page.evaluate(async () => {
    const api = window.agentHist;
    const chats = [];
    let offset = 0;
    while (true) {
      const result = await api.listChats({ offset, limit: 500 });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      chats.push(...result.value.chats);
      if (result.value.nextOffset === undefined) break;
      if (result.value.nextOffset <= offset) throw new Error("chat pagination did not advance");
      offset = result.value.nextOffset;
    }
    return chats;
  });
}

async function focusAndRefresh(application, page) {
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.blur();
    window?.focus();
  });
  const result = await page.evaluate(() => window.agentHist.refresh());
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function waitForTotal(page, expected) {
  await page.waitForFunction(async (total) => {
    const result = await window.agentHist.listChats({ limit: 1 });
    return result.ok && result.value.total === total;
  }, expected);
}

async function exerciseUi(page, round, fixture) {
  const search = page.getByRole("searchbox", { name: "搜索对话" });
  const sessions = fixture.sessions();
  const chosen = sessions[(round * 7919) % sessions.length];
  const marker = chosen.searchText[0];
  await search.fill(marker);
  const filteredChat = page.getByTestId("chat-list-scroll").getByText(chosen.title, { exact: true });
  await filteredChat.waitFor();
  await filteredChat.click();
  await page.getByRole("heading", { name: chosen.title, exact: true }).waitFor();
  await search.fill("");

  for (const agent of AGENTS) {
    const label = agent === "claude" ? "Claude Code" : agent === "opencode" ? "OpenCode" : agent[0].toUpperCase() + agent.slice(1);
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByTestId("chat-list-scroll").waitFor();
  }
  await page.getByRole("button", { name: "全部", exact: true }).click();

  const firstChat = page.locator(".chat-list-item").first();
  await firstChat.waitFor();
  await firstChat.click();
  await page.getByLabel("对话详情").waitFor();
  const scroll = page.getByTestId("conversation-scroll");
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });

  await page.keyboard.press("Control+f");
  const conversationSearch = page.getByLabel("在对话中搜索");
  await conversationSearch.fill("synthetic");
  await page.waitForFunction(() => {
    const count = document.querySelector(".find-count")?.textContent ?? "";
    return /\/|无匹配/u.test(count);
  });
  await page.getByRole("button", { name: "关闭对话搜索" }).click();

  const technical = page.getByRole("button", { name: "显示技术细节" });
  if (await technical.getAttribute("aria-pressed") !== "true") await technical.click();
  const detail = page.locator("details.technical-detail-view").first();
  if (await detail.count() > 0) {
    await detail.locator("summary").click();
    await detail.locator(".technical-detail-content").waitFor();
  }

  await page.keyboard.press("Control+k");
  const quick = page.getByLabel("快速搜索对话");
  await quick.waitFor();
  await quick.fill(marker);
  const options = page.getByRole("listbox", { name: "对话搜索结果" }).getByRole("option");
  const targetOption = options.filter({ hasText: chosen.title }).first();
  await targetOption.waitFor();
  const titles = await options.locator("strong").allTextContents();
  const targetIndex = titles.indexOf(chosen.title);
  if (targetIndex < 0) throw new Error(`Quick Search omitted ${chosen.title}`);
  for (let index = 0; index < targetIndex; index++) await quick.press("ArrowDown");
  if (await targetOption.getAttribute("aria-selected") !== "true") {
    throw new Error(`Quick Search did not select ${chosen.title}`);
  }
  await quick.press("Enter");
  await page.getByRole("heading", { name: chosen.title, exact: true }).waitFor();
}

async function mutate(round, fixture, stateDirectory, root) {
  const mode = round % 6;
  if (mode === 0) {
    const added = await fixture.addSession("codex");
    return { kind: "add", marker: added.searchText[0] };
  }
  if (mode === 1) {
    const agent = AGENTS.find((candidate) => fixture.sessions(candidate).length > 0);
    if (agent === undefined) throw new Error("synthetic fixture has no session to grow");
    const grown = await fixture.growSession(agent);
    return { kind: "grow", marker: grown.searchText.at(-1) };
  }
  if (mode === 2) {
    const agent = AGENTS.find((candidate) => fixture.sessions(candidate).length > 1) ??
      AGENTS.find((candidate) => fixture.sessions(candidate).length > 0);
    if (agent === undefined) throw new Error("synthetic fixture has no session to delete");
    const removed = await fixture.deleteSession(agent);
    return { kind: "delete", removed };
  }
  if (mode === 3) {
    await fixture.corruptAgentHead("pi");
    return { kind: "corrupt", agent: "pi" };
  }
  if (mode === 4) {
    await writeFile(path.join(stateDirectory, "desktop", "history-index.sqlite"), "synthetic index mismatch", "utf8");
    return { kind: "index_mismatch" };
  }
  const source = path.join(stateDirectory, "history", "pi");
  const missing = path.join(stateDirectory, "history", "pi.temporarily-missing");
  await rename(source, missing);
  return { kind: "directory_missing", source, missing };
}

async function memorySample(application, page, round) {
  const main = await application.evaluate(() => process.memoryUsage());
  const renderer = await page.evaluate(() => {
    const memory = performance.memory;
    return memory === undefined ? null : {
      usedJSHeapSize: memory.usedJSHeapSize,
      totalJSHeapSize: memory.totalJSHeapSize,
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
    };
  });
  return { round, main, renderer };
}

async function main() {
  const { rounds, sessions } = argumentsValue();
  const repository = path.resolve(import.meta.dirname, "..");
  const entry = path.join(repository, ".build", "src", "desktop", "main.js");
  await stat(entry);
  const { createDesktopHistoryFixture } = await import(
    pathToFileURL(path.join(repository, ".build", "tests", "support", "desktop-history-fixture.js")).href
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist desktop soak "));
  const stateDirectory = path.join(root, "state 中文 with spaces");
  const fakeBin = path.join(root, "fake agent executables");
  const errors = [];
  const diagnostics = [];
  const memory = [];
  const roundResults = [];
  let launched;
  try {
    await mkdir(fakeBin, { recursive: true });
    for (const agent of AGENTS) {
      await fakeExecutable(path.join(fakeBin, process.platform === "win32" ? `${agent}.cmd` : agent));
    }
    const fixture = await createDesktopHistoryFixture({ stateDirectory, sessionCount: sessions });
    launched = await launchDesktop(repository, root, stateDirectory, fakeBin, errors, diagnostics);
    await waitForTotal(launched.page, fixture.sessions().length);

    for (let round = 0; round < rounds; round++) {
      await exerciseUi(launched.page, round, fixture);
      const mutation = await mutate(round, fixture, stateDirectory, root);
      const expected = fixture.sessions().length;
      await focusAndRefresh(launched.application, launched.page);
      if (mutation.kind === "corrupt") {
        await fixture.restoreAgentHead(mutation.agent);
        await focusAndRefresh(launched.application, launched.page);
      }
      if (mutation.kind === "directory_missing") {
        await rename(mutation.missing, mutation.source);
        await focusAndRefresh(launched.application, launched.page);
      }
      await waitForTotal(launched.page, expected);
      if (mutation.marker !== undefined) {
        await launched.page.waitForFunction(async (query) => {
          const result = await window.agentHist.listChats({ query, limit: 1 });
          return result.ok && result.value.total > 0;
        }, mutation.marker);
      }
      const chats = await allChats(launched.page);
      const references = chats.map((chat) => chat.sessionRef);
      const duplicates = references.length - new Set(references).size;
      const expectedRefs = new Set(fixture.sessions().map((item) => item.sessionRef));
      const stale = references.filter((reference) => !expectedRefs.has(reference));
      const missing = [...expectedRefs].filter((reference) => !references.includes(reference));
      if (duplicates !== 0 || stale.length !== 0 || missing.length !== 0) {
        errors.push(`round ${round}: duplicates=${duplicates}, stale=${stale.length}, missing=${missing.length}`);
      }
      memory.push(await memorySample(launched.application, launched.page, round));
      roundResults.push({ round, mutation: mutation.kind, sessions: chats.length, duplicates, stale: stale.length, missing: missing.length });

      if ((round + 1) % 3 === 0 && round + 1 < rounds) {
        await launched.application.close();
        launched = await launchDesktop(repository, root, stateDirectory, fakeBin, errors, diagnostics);
        await waitForTotal(launched.page, expected);
      }
    }
    const summary = {
      schemaVersion: "agenthist.desktop-soak/v1",
      rounds,
      initialSessions: sessions,
      finalSessions: fixture.sessions().length,
      errors,
      diagnostics,
      memory,
      results: roundResults,
      passed: errors.length === 0,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (errors.length !== 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await launched?.application.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

await main();
