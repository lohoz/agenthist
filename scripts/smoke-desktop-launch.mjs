import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { chromium } from "playwright";
import waitOn from "wait-on";

const repository = path.resolve(import.meta.dirname, "..");
const release = path.join(repository, "release");
const candidates = (await Promise.all((await readdir(release)).map(async (name) => (await stat(path.join(release, name))).isDirectory() ? name : "")))
  .filter((name) => process.platform === "darwin" ? /^mac(?:-|$)/u.test(name) : process.platform === "linux" ? /^linux.*unpacked$/u.test(name) : name === "win-unpacked");
assert.equal(candidates.length, 1, "Expected one native unpacked application");
const executable = path.join(release, candidates[0], ...(process.platform === "darwin" ? ["AgentHist.app", "Contents", "MacOS", "AgentHist"] : [process.platform === "win32" ? "AgentHist.exe" : "agenthist"]));
const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-release-smoke-"));
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|AGENTHIST_DESKTOP_STATE_DIR)$/iu.test(key)) delete environment[key];
for (const directory of ["codex", "claude", "opencode", "pi", "home", "config", "data"]) await mkdir(path.join(root, directory));
Object.assign(environment, {
  AGENTHIST_DESKTOP_STATE_DIR: path.join(root, "state"),
  CODEX_HOME: path.join(root, "codex"), CODEX_SQLITE_HOME: path.join(root, "codex"),
  CLAUDE_CONFIG_DIR: path.join(root, "claude"), PI_CODING_AGENT_SESSION_DIR: path.join(root, "pi"),
  OPENCODE_DB: path.join(root, "opencode", "opencode.db"), XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"),
  HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
});
let child;
let browser;
try {
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, "chromium")}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])], {
    cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-16000); });
  await waitOn({ resources: [`http-get://127.0.0.1:${port}/json/version`], timeout: 30000, interval: 250 }).catch((error) => { throw new Error(`${error.message}\n${diagnostics}`); });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  await page.getByRole("button", { name: "开始使用", exact: true }).click();
  await page.getByRole("heading", { name: "对话", exact: true }).waitFor();
  const result = await page.evaluate(async () => ({ chats: await window.agentHist.listChats({ limit: 1 }), settings: await window.agentHist.getSettings() }));
  assert.equal(result.chats.ok, true);
  assert.equal(result.settings.ok, true);
  assert.equal(result.chats.value.total, 0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "统一 Provider", exact: true }).waitFor();
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, packagedDesktop: "passed", renderer: "file://", isolatedHistory: true }));
  await page.evaluate(() => window.close());
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) {
    try { await once(child, "exit", { signal: AbortSignal.timeout(10000) }); }
    catch { child.kill(); await once(child, "exit", { signal: AbortSignal.timeout(5000) }).catch(() => {}); }
  }
  if (path.dirname(root) !== os.tmpdir()) throw new Error("Unexpected smoke-test root");
  await rm(root, { recursive: true, force: true });
}
