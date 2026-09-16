import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";
import waitOn from "wait-on";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
const commandArguments = process.argv.slice(2);
const defaultState = commandArguments.includes("--default-state");
const portableCdp = commandArguments.includes("--portable-cdp");
const executableArgument = commandArguments.find((argument) =>
  argument !== "--default-state" && argument !== "--portable-cdp");
const sourceExecutable = path.resolve(
  repository,
  executableArgument ?? path.join("release", "win-unpacked", "AgentHist.exe"),
);
await access(sourceExecutable);

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("could not reserve a CDP port");
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}

async function waitForProcessExit(child) {
  if (child === undefined || child.exitCode !== null) return;
  try {
    await once(child, "exit", { signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
    child.kill();
    await once(child, "exit", { signal: AbortSignal.timeout(10_000) });
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "agenthist packaged smoke "));
let executable = sourceExecutable;
const roots = {
  codex: path.join(root, "agents", "codex"),
  codexSqlite: path.join(root, "agents", "codex-sqlite"),
  claude: path.join(root, "agents", "claude"),
  opencode: path.join(root, "agents", "opencode"),
  pi: path.join(root, "agents", "pi"),
};
const stateDirectory = path.join(root, "state 中文 with spaces");
const localAppData = path.join(root, "Local AppData 用户 Name");
const effectiveStateDirectory = defaultState ? path.join(localAppData, "AgentHist") : stateDirectory;
const workspaceRoot = path.join(root, "Program Files style 工作区");
const fakeBin = path.join(root, "isolated tools without Node");
const isolatedEnvironment = { ...process.env };
for (const name of Object.keys(isolatedEnvironment)) {
  if ([
    "path",
    "node_options",
    "node_path",
    "node_extra_ca_certs",
    "electron_run_as_node",
    "electron_no_asar",
    "agenthist_desktop_state_dir",
    "localappdata",
  ].includes(name.toLowerCase())) delete isolatedEnvironment[name];
}
let browser;
let packagedProcess;
let page;
try {
  if (executableArgument === undefined) {
    const isolatedApplication = path.join(root, "standalone application 中文");
    await cp(path.dirname(sourceExecutable), isolatedApplication, { recursive: true });
    executable = path.join(isolatedApplication, path.basename(sourceExecutable));
    await access(executable);
  }
  await Promise.all([
    ...Object.values(roots).map((directory) => mkdir(directory, { recursive: true })),
    mkdir(fakeBin, { recursive: true }),
  ]);
  const fixtureModule = await import(pathToFileURL(
    path.join(repository, ".build", "tests", "support", "desktop-history-fixture.js"),
  ).href);
  const fixture = await fixtureModule.createDesktopHistoryFixture({
    stateDirectory: effectiveStateDirectory,
    workspaceRoot,
    sessionCount: 4,
  });
  const target = fixture.sessions("codex")[0];
  assert.ok(target);
  await mkdir(target.context, { recursive: true });
  const fakeCodex = path.join(fakeBin, "codex.cmd");
  await writeFile(
    fakeCodex,
    "@echo off\r\n> \"%AGENTHIST_LAUNCH_MARKER%\" echo %~1^|%~2\r\n",
    "utf8",
  );
  const pathName = process.platform === "win32" ? "Path" : "PATH";
  const applicationEnvironment = {
    ...isolatedEnvironment,
    ...(defaultState
      ? { LOCALAPPDATA: localAppData }
      : { AGENTHIST_DESKTOP_STATE_DIR: effectiveStateDirectory }),
    CODEX_HOME: roots.codex,
    CODEX_SQLITE_HOME: roots.codexSqlite,
    CLAUDE_CONFIG_DIR: roots.claude,
    OPENCODE_DB: path.join(roots.opencode, "opencode.db"),
    XDG_DATA_HOME: roots.opencode,
    PI_CODING_AGENT_SESSION_DIR: roots.pi,
    [pathName]: fakeBin,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  };
  const userDataArgument = `--user-data-dir=${path.join(root, "chromium profile")}`;
  if (portableCdp) assert.match(path.basename(sourceExecutable), /-Portable\.exe$/iu);
  const port = await availableLoopbackPort();
  packagedProcess = spawn(executable, [userDataArgument, `--remote-debugging-port=${port}`], {
    cwd: root,
    env: applicationEnvironment,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const earlyExit = new Promise((_, reject) => {
    packagedProcess.once("error", reject);
    packagedProcess.once("exit", (code) => reject(new Error(`packaged application exited before CDP was ready (${String(code)})`)));
  });
  await Promise.race([
    waitOn({ resources: [`http-get://127.0.0.1:${port}/json/version`], timeout: 30_000 }),
    earlyExit,
  ]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  assert.ok(page, "packaged application CDP exposed no renderer page");
  assert.match(page.url(), /^file:/u);
  assert.equal(await page.title(), "AgentHist");
  await page.getByRole("heading", { name: "欢迎使用 AgentHist" }).waitFor();
  await page.getByRole("button", { name: "开始使用" }).click();
  await page.getByRole("searchbox", { name: "搜索对话" }).waitFor();
  const bootstrap = await page.evaluate(() => window.agentHist.bootstrap());
  assert.equal(bootstrap.ok, true);
  if (bootstrap.ok) {
    assert.equal(bootstrap.value.stateDirectory, effectiveStateDirectory);
    assert.equal(bootstrap.value.version, packageMetadata.version);
  }
  await page.getByRole("button", { name: target.title }).click();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByText("请先在设置中选择终端并检查默认参数", { exact: false }).waitFor();
  const runtime = await page.evaluate(() => ({ userAgent: navigator.userAgent }));
  assert.match(page.url(), /resources\/app\.asar\/.build\/desktop-renderer\/index\.html$/iu);
  assert.match(runtime.userAgent, /Electron\/44\.1\.1/iu);
  process.stdout.write(`${JSON.stringify({
    sourceExecutable,
    executable,
    renderer: page.url(),
    terminalSetupGuard: target.nativeId,
    isolatedPath: fakeBin,
    stateMode: defaultState ? "LOCALAPPDATA-default" : "explicit-test-directory",
    launchMode: portableCdp ? "portable-cdp" : "packaged-cdp",
    ...runtime,
  })}\n`);
} finally {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await waitForProcessExit(packagedProcess);
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
