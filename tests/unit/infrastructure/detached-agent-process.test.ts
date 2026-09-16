import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  launchDetachedAgentProcess,
  prepareDetachedAgentLaunch,
  type DetachedAgentChildProcess,
  type DetachedAgentSpawnOptions,
} from "../../../src/infrastructure/detached-agent-process.js";

async function executable(file: string): Promise<void> {
  await writeFile(file, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") await chmod(file, 0o755);
}

function pathEnvironment(value: string): NodeJS.ProcessEnv {
  return process.platform === "win32"
    ? { Path: value, PATHEXT: ".CMD;.EXE" }
    : { PATH: value };
}

interface CapturedWindowsLaunchPlan {
  readonly schemaVersion: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly launchExecutable: string;
  readonly launchArguments: string;
  readonly cwd: string;
  readonly acknowledgementPath: string | null;
  readonly previousElectronRunAsNodeEnvironment: {
    readonly name: string;
    readonly value: string;
  } | null;
}

function capturedWindowsLaunchPlan(options: DetachedAgentSpawnOptions): CapturedWindowsLaunchPlan {
  const encoded = Object.entries(options.env).find(([name]) =>
    name.toLowerCase() === "agenthist_desktop_windows_launch_plan")?.[1];
  assert.ok(encoded);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as CapturedWindowsLaunchPlan;
}

async function publishedProbe(file: string): Promise<Record<string, unknown>> {
  const read = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const existing = await read();
  if (existing !== undefined) return existing;
  // fs.watch can abort the Node process in libuv on Windows CI temp-directory
  // aliases. Poll the atomically published probe instead of observing the directory.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await delay(30);
    const value = await read();
    if (value !== undefined) return value;
  }
  throw new Error("Windows terminal probe was not published");
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await delay(20);
  }
  throw new Error("Windows terminal host did not exit after its child completed");
}

test("detached launcher resolves only trusted PATH and preserves every argument literally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-detached-launch-"));
  const workspace = path.join(root, "workspace with spaces");
  const trustedBin = path.join(root, "trusted tools");
  const filename = process.platform === "win32" ? "codex.CMD" : "codex";
  const trustedExecutable = path.join(trustedBin, filename);
  const shadowExecutable = path.join(workspace, filename);
  const literalArgs = [
    "resume",
    'native id with spaces & "quotes" $(never-execute)',
    "--literal=semi;colon|pipe",
  ];
  let captured: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly options: DetachedAgentSpawnOptions;
  } | undefined;
  let unrefCalled = false;
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(trustedBin, { recursive: true });
    await executable(trustedExecutable);
    await executable(shadowExecutable);
    const launched = await launchDetachedAgentProcess({
      command: "codex",
      args: literalArgs,
      cwd: workspace,
    }, {
      environment: pathEnvironment(`${workspace}${path.delimiter}${trustedBin}`),
      spawn(command, args, options) {
        captured = { executable: command, args: [...args], options };
        const emitter = new EventEmitter();
        const child = emitter as unknown as DetachedAgentChildProcess;
        Object.defineProperty(child, "pid", { value: 4242, enumerable: true });
        child.unref = () => { unrefCalled = true; };
        queueMicrotask(() => emitter.emit("spawn"));
        return child;
      },
    });
    assert.equal(launched.pid, 4242);
    assert.equal(launched.executable, trustedExecutable);
    assert.deepEqual(launched.args, literalArgs);
    assert.equal(unrefCalled, true);
    assert.ok(captured);
    if (process.platform === "win32") {
      assert.match(captured.executable, /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);
      assert.equal(captured.args.includes("-EncodedCommand"), true);
      assert.equal(JSON.stringify(captured.args).includes(literalArgs[1]!), false);
      const plan = capturedWindowsLaunchPlan(captured.options);
      assert.equal(plan.schemaVersion, "agenthist.windows-terminal-launch/v1");
      assert.equal(plan.executable, trustedExecutable);
      assert.deepEqual(plan.arguments, literalArgs);
      assert.match(plan.launchExecutable, /\\cmd\.exe$/iu);
      assert.match(plan.launchArguments, /^\/d \/s \/c /u);
      assert.equal(plan.cwd, workspace);
    } else {
      assert.equal(captured.executable, trustedExecutable);
      assert.deepEqual(captured.args, literalArgs);
    }
    assert.equal(captured.options.cwd, workspace);
    assert.equal(captured.options.shell, false);
    assert.equal(captured.options.detached, process.platform !== "win32");
    assert.equal(captured.options.stdio, "ignore");
    assert.equal(captured.options.windowsHide, false);
    const childPath = Object.entries(captured.options.env)
      .find(([name]) => name.toLowerCase() === "path")?.[1] ?? "";
    assert.equal(childPath.split(path.delimiter).includes(workspace), false);
    assert.equal(childPath.split(path.delimiter).includes(trustedBin), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("POSIX terminal launch keeps session arguments literal and uses the selected terminal", async (context) => {
  if (process.platform === "win32") { context.skip("POSIX terminal launch"); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-posix-launch-"));
  const terminal = path.join(root, "terminal");
  const agent = path.join(root, "agent");
  let captured: { command: string; args: readonly string[] } | undefined;
  try {
    await executable(terminal); await executable(agent);
    const args = ["resume", "literal ; $(never) ' quoted"];
    await launchDetachedAgentProcess({ command: agent, args, cwd: root }, {
      terminal: { executablePath: terminal, arguments: ["--working-directory={cwd}", "--", "{command}"] },
      spawn(command, launchArgs) {
        captured = { command, args: launchArgs };
        const emitter = new EventEmitter(); const child = emitter as unknown as DetachedAgentChildProcess;
        Object.defineProperty(child, "pid", { value: 4242 }); child.unref = () => {};
        queueMicrotask(() => emitter.emit("spawn")); return child;
      },
    });
    assert.deepEqual(captured, { command: terminal, args: [`--working-directory=${root}`, "--", agent, ...args] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configured Windows terminal launches the resolved Agent without a packaged GUI runner", async (context) => {
  if (process.platform !== "win32") {
    context.skip("configured Windows terminal launch is Windows-specific");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-configured-terminal-"));
  const workspace = path.join(root, "workspace with spaces");
  const terminal = path.join(root, "electron-terminal.exe");
  const agent = path.join(root, "agent.exe");
  let captured: { readonly executable: string; readonly args: readonly string[]; readonly options: DetachedAgentSpawnOptions } | undefined;
  try {
    await mkdir(workspace);
    await writeFile(terminal, "fixture");
    await writeFile(agent, "fixture");
    await launchDetachedAgentProcess({ command: agent, args: ["resume", "literal & value"], cwd: workspace }, {
      platform: "win32",
      terminal: {
        executablePath: terminal,
        arguments: ["new-tab", "--cwd", "{cwd}", "{command}"],
      },
      environment: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "preserved-user-value",
      },
      spawn(executablePath, args, options) {
        captured = { executable: executablePath, args: [...args], options };
        const emitter = new EventEmitter();
        const child = emitter as unknown as DetachedAgentChildProcess;
        Object.defineProperty(child, "pid", { value: 5252 });
        child.unref = () => undefined;
        queueMicrotask(() => {
          const plan = capturedWindowsLaunchPlan(options);
          void (plan.acknowledgementPath === null
            ? Promise.resolve()
            : writeFile(plan.acknowledgementPath, "ready", { flag: "wx" }))
            .then(() => emitter.emit("spawn"));
        });
        return child;
      },
    });
    assert.ok(captured);
    assert.equal(captured.executable, terminal);
    assert.deepEqual(captured.args.slice(0, 3), ["new-tab", "--cwd", workspace]);
    assert.match(captured.args[3]!, /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);
    assert.equal(captured.args.includes("-EncodedCommand"), true);
    assert.equal(JSON.stringify(captured.args).includes("literal & value"), false);
    const encodedIndex = captured.args.indexOf("-EncodedCommand");
    const bootstrap = Buffer.from(captured.args[encodedIndex + 1]!, "base64").toString("utf16le");
    assert.match(bootstrap, /\$launchExecutable/u);
    assert.doesNotMatch(bootstrap, /\$nodeHost/u);
    assert.doesNotMatch(bootstrap, /SetEnvironmentVariable\('ELECTRON_RUN_AS_NODE', '1'/u);
    assert.equal(Object.keys(captured.options.env).some((name) =>
      name.toLowerCase() === "electron_run_as_node"), false);
    const plan = capturedWindowsLaunchPlan(captured.options);
    assert.equal(plan.executable, agent);
    assert.deepEqual(plan.arguments, ["resume", "literal & value"]);
    assert.equal(plan.launchExecutable, agent);
    assert.equal(plan.launchArguments, "resume \"literal & value\"");
    assert.deepEqual(plan.previousElectronRunAsNodeEnvironment, {
      name: "ELECTRON_RUN_AS_NODE",
      value: "preserved-user-value",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid configured terminal arguments do not leave a credential-bearing bootstrap file", async (context) => {
  if (process.platform !== "win32") {
    context.skip("configured Windows terminal launch is Windows-specific");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-configured-terminal-validation-"));
  const workspace = path.join(root, "workspace");
  const terminal = path.join(root, "electron-terminal.exe");
  const agent = path.join(root, "agent.exe");
  const bootstrapFiles = async (): Promise<Set<string>> => new Set(
    (await readdir(os.tmpdir())).filter((entry) =>
      /^agenthist-terminal-[0-9a-f-]{36}\.json$/iu.test(entry)),
  );
  const before = await bootstrapFiles();
  try {
    await mkdir(workspace);
    await writeFile(terminal, "fixture");
    await writeFile(agent, "fixture");
    await assert.rejects(
      launchDetachedAgentProcess({ command: agent, args: [], cwd: workspace }, {
        platform: "win32",
        terminal: {
          executablePath: terminal,
          arguments: ["{command}", "invalid\0argument"],
        },
        environment: {
          AGENTHIST_TEST_SECRET: "must-not-remain-on-disk",
        },
      }),
      /configured terminal argument is invalid/,
    );
    assert.deepEqual(await bootstrapFiles(), before);
  } finally {
    const after = await bootstrapFiles();
    await Promise.all([...after]
      .filter((entry) => !before.has(entry))
      .map((entry) => rm(path.join(os.tmpdir(), entry), { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows terminal host gives an npm-style cmd shim a real console and literal arguments", async () => {
  if (process.platform !== "win32") {
    const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-native-terminal-"));
    const workspace = path.join(root, "workspace");
    const target = path.join(root, "agent");
    let captured: {
      readonly executable: string;
      readonly args: readonly string[];
      readonly stdio: DetachedAgentSpawnOptions["stdio"];
    } | undefined;
    try {
      await mkdir(workspace);
      await executable(target);
      await launchDetachedAgentProcess({ command: target, args: ["literal & argument"], cwd: workspace }, {
        environment: pathEnvironment(""),
        spawn(command, args, options) {
          captured = { executable: command, args: [...args], stdio: options.stdio };
          const emitter = new EventEmitter();
          const child = emitter as unknown as DetachedAgentChildProcess;
          Object.defineProperty(child, "pid", { value: 4243 });
          child.unref = () => undefined;
          queueMicrotask(() => emitter.emit("spawn"));
          return child;
        },
      });
      assert.deepEqual(captured, {
        executable: target,
        args: ["literal & argument"],
        stdio: "ignore",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-interactive-terminal-"));
  const workspace = path.join(root, "workspace with spaces");
  const shim = path.join(root, "agent probe.cmd");
  const probeScript = path.join(root, "terminal-probe.ps1");
  const output = path.join(root, "terminal-probe.json");
  const temporaryOutput = `${output}.pending`;
  const literalArgs = [
    "resume",
    'native id with spaces & "quotes"',
    "literal&exit 91",
    "--literal=semi;colon|pipe",
  ];
  try {
    await mkdir(workspace);
    await writeFile(probeScript, `
$probe = [ordered]@{
    args = @($args)
    cwd = [Environment]::CurrentDirectory
    stdin = -not [Console]::IsInputRedirected
    stdout = -not [Console]::IsOutputRedirected
    stderr = -not [Console]::IsErrorRedirected
    preserved = $env:AGENTHIST_DESKTOP_WINDOWS_LAUNCH_PLAN
}
$json = ConvertTo-Json -InputObject $probe -Compress
[IO.File]::WriteAllText(
    $env:AGENTHIST_TERMINAL_PROBE_TEMPORARY,
    $json,
    [Text.UTF8Encoding]::new($false))
[IO.File]::Move(
    $env:AGENTHIST_TERMINAL_PROBE_TEMPORARY,
    $env:AGENTHIST_TERMINAL_PROBE_OUTPUT)
`, "utf8");
    await writeFile(
      shim,
      `@ECHO OFF\r\nSETLOCAL DisableDelayedExpansion\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${probeScript}" %*\r\n`,
      "utf8",
    );
    const launched = await launchDetachedAgentProcess({
      command: shim,
      args: literalArgs,
      cwd: workspace,
    }, {
      environment: {
        ...process.env,
        AGENTHIST_TERMINAL_PROBE_OUTPUT: output,
        AGENTHIST_TERMINAL_PROBE_TEMPORARY: temporaryOutput,
        AGENTHIST_DESKTOP_WINDOWS_LAUNCH_PLAN: "preserved-user-value",
      },
      platform: "win32",
    });
    const probe = await publishedProbe(output);
    assert.deepEqual(probe.args, literalArgs);
    assert.equal(await realpath(String(probe.cwd)), await realpath(workspace));
    assert.equal(probe.stdin, true);
    assert.equal(probe.stdout, true);
    assert.equal(probe.stderr, true);
    assert.equal(probe.preserved, "preserved-user-value");
    await waitForProcessExit(launched.pid);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("workspace command shadowing is rejected unless the executable path is explicit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-detached-shadow-"));
  const workspace = path.join(root, "workspace");
  const filename = process.platform === "win32" ? "claude.CMD" : "claude";
  const shadow = path.join(workspace, filename);
  try {
    await mkdir(workspace);
    await executable(shadow);
    await assert.rejects(
      prepareDetachedAgentLaunch({ command: "claude", args: ["--resume", "literal"], cwd: workspace }, {
        environment: pathEnvironment("."),
      }),
      /not installed or is not available on trusted PATH/,
    );
    const explicit = await prepareDetachedAgentLaunch({
      command: shadow,
      args: ["--resume", "literal"],
      cwd: workspace,
    }, { environment: pathEnvironment("") });
    assert.equal(explicit.executable, shadow);
    assert.deepEqual(explicit.args, ["--resume", "literal"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detached launcher reports a missing command before spawning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-detached-missing-"));
  const workspace = path.join(root, "workspace");
  let spawnCalled = false;
  try {
    await mkdir(workspace);
    await assert.rejects(
      launchDetachedAgentProcess({
        command: "agenthist-command-that-does-not-exist",
        args: ["argument with spaces & metacharacters"],
        cwd: workspace,
      }, {
        environment: pathEnvironment(""),
        spawn() {
          spawnCalled = true;
          throw new Error("spawn should not be reached");
        },
      }),
      /not installed or is not available on trusted PATH/,
    );
    assert.equal(spawnCalled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detached launcher rejects relative executable paths and unsafe workspaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-detached-validation-"));
  const workspace = path.join(root, "workspace");
  try {
    await mkdir(workspace);
    await assert.rejects(
      prepareDetachedAgentLaunch({ command: `.${path.sep}codex`, args: [], cwd: workspace }),
      /trusted PATH name or an absolute path/,
    );
    await assert.rejects(
      prepareDetachedAgentLaunch({ command: "codex", args: [], cwd: "relative-workspace" }),
      /workspace must be absolute/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
