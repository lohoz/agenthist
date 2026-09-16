import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDesktopTerminalSettingsService } from "../../../src/desktop/terminal-settings.js";

test("POSIX terminal discovery and saved paths preserve native separators", async (context) => {
  if (process.platform === "win32") { context.skip("POSIX executable permissions"); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-posix-terminal-"));
  try {
    const bin = path.join(root, "bin"); await mkdir(bin);
    const terminal = path.join(bin, "wezterm"); await writeFile(terminal, "#!/bin/sh\nexit 0\n"); await chmod(terminal, 0o700);
    const service = createDesktopTerminalSettingsService({ stateDirectory: path.join(root, "state"), platform: "linux", environment: { PATH: bin }, chooseExecutable: async () => terminal });
    const automatic = await service.inspect();
    const resolvedTerminal = await realpath(terminal);
    assert.equal(automatic.effectiveExecutablePath, resolvedTerminal);
    assert.equal(automatic.requiresSetup, false);
    await service.select({ candidateId: "wezterm" });
    const reopened = createDesktopTerminalSettingsService({ stateDirectory: path.join(root, "state"), platform: "linux", environment: { PATH: bin }, chooseExecutable: async () => undefined });
    assert.deepEqual(await reopened.resolveLaunchConfiguration(), { executablePath: resolvedTerminal, arguments: ["start", "--cwd", "{cwd}", "--", "{command}"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminal settings detect, persist, customize, and reset a Windows terminal", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows terminal discovery is Windows-specific");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-terminal-settings-"));
  const stateDirectory = path.join(root, "state");
  const bin = path.join(root, "terminal bin");
  const wt = path.join(bin, "wt.exe");
  const wezterm = path.join(bin, "wezterm-gui.exe");
  try {
    await mkdir(bin, { recursive: true });
    await writeFile(wt, "fixture");
    await writeFile(wezterm, "fixture");
    let custom = wezterm;
    const service = createDesktopTerminalSettingsService({
      stateDirectory,
      platform: "win32",
      environment: { Path: bin, PATHEXT: ".EXE" },
      chooseExecutable: async () => custom,
    });

    const automatic = await service.inspect();
    assert.equal(automatic.mode, "auto");
    assert.equal(automatic.effectiveLabel, "Windows Terminal（自动）");
    assert.equal(automatic.effectiveExecutablePath?.toLowerCase(), wt.toLowerCase());
    assert.deepEqual(automatic.candidates.map((item) => item.id), ["windows-terminal", "wezterm"]);

    const selected = await service.select({ candidateId: "wezterm" });
    assert.equal(selected.mode, "configured");
    assert.equal(selected.effectiveExecutablePath?.toLowerCase(), wezterm.toLowerCase());
    assert.deepEqual(selected.arguments, ["start", "--cwd", "{cwd}", "--", "{command}"]);

    const updated = await service.updateArguments({ arguments: ["start", "--cwd", "{cwd}", "{command}"] });
    assert.deepEqual(updated.arguments, ["start", "--cwd", "{cwd}", "{command}"]);
    const launch = await service.resolveLaunchConfiguration();
    assert.equal(launch.executablePath.toLowerCase(), wezterm.toLowerCase());
    assert.deepEqual(launch.arguments, ["start", "--cwd", "{cwd}", "{command}"]);

    custom = wt;
    const customSelected = await service.select({ candidateId: "custom" });
    assert.equal(customSelected.effectiveLabel, "Windows Terminal");
    assert.deepEqual(customSelected.arguments, ["-w", "new", "new-tab", "--startingDirectory", "{cwd}", "{command}"]);
    await assert.rejects(
      service.updateArguments({ arguments: ["--cwd", "{cwd}"] }),
      /terminal arguments are invalid/,
    );

    const reset = await service.select({ candidateId: "auto" });
    assert.equal(reset.mode, "auto");
    assert.equal(reset.effectiveLabel, "Windows Terminal（自动）");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal settings require explicit setup when auto detection finds nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-terminal-settings-empty-"));
  try {
    const service = createDesktopTerminalSettingsService({
      stateDirectory: path.join(root, "state"),
      platform: "win32",
      environment: { Path: path.join(root, "empty-bin"), PATHEXT: ".EXE" },
      chooseExecutable: async () => undefined,
    });
    const settings = await service.inspect();
    assert.equal(settings.effectiveLabel, "未检测到终端，请先设置");
    assert.equal(settings.requiresSetup, true);
    assert.equal(settings.effectiveExecutablePath, undefined);
    await assert.rejects(service.resolveLaunchConfiguration(), /configure it in settings/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal settings repair the legacy direct Windows Terminal template", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows terminal template repair is Windows-specific");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-terminal-template-repair-"));
  const stateDirectory = path.join(root, "state");
  const terminal = path.join(root, "terminal bin", "wt.exe");
  const expected = ["-w", "new", "new-tab", "--startingDirectory", "{cwd}", "{command}"];
  try {
    await Promise.all([
      mkdir(path.dirname(terminal), { recursive: true }),
      mkdir(path.join(stateDirectory, "desktop"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(terminal, "fixture"),
      writeFile(path.join(stateDirectory, "desktop", "terminal.json"), `${JSON.stringify({
        schemaVersion: "agenthist.desktop-terminal/v1",
        mode: "configured",
        executablePath: terminal,
        label: "Windows Terminal",
        arguments: ["{cwd}", "{command}"],
      }, null, 2)}\n`, "utf8"),
    ]);
    const service = createDesktopTerminalSettingsService({
      stateDirectory,
      platform: "win32",
      environment: { Path: path.dirname(terminal), PATHEXT: ".EXE" },
      chooseExecutable: async () => undefined,
    });

    assert.deepEqual((await service.inspect()).arguments, expected);
    assert.deepEqual((await service.resolveLaunchConfiguration()).arguments, expected);
    assert.deepEqual(
      (await service.updateArguments({ arguments: ["{cwd}", "{commandLine}"] })).arguments,
      expected,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal settings reject a linked Desktop state directory without writing through it", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-terminal-settings-link-"));
  const stateDirectory = path.join(root, "state");
  const outside = path.join(root, "outside");
  const linkedDesktop = path.join(stateDirectory, "desktop");
  const escapedSettings = path.join(outside, "terminal.json");
  try {
    await Promise.all([mkdir(stateDirectory), mkdir(outside)]);
    try {
      await symlink(outside, linkedDesktop, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EACCES", "ENOSYS", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip("directory link creation is unavailable in this environment");
        return;
      }
      throw error;
    }
    const service = createDesktopTerminalSettingsService({
      stateDirectory,
      platform: "win32",
      environment: { Path: "", PATHEXT: ".EXE" },
      chooseExecutable: async () => undefined,
    });

    await assert.rejects(
      service.select({ candidateId: "auto" }),
      /terminal settings directory is not a private real directory/iu,
    );
    await assert.rejects(access(escapedSettings), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("versioned Windows Terminal package paths migrate to the stable system execution alias", async (context) => {
  if (process.platform !== "win32") { context.skip("Windows execution alias migration"); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-terminal-alias-"));
  const stateDirectory = path.join(root, "state");
  const localAppData = path.join(root, "LocalAppData");
  const alias = path.join(localAppData, "Microsoft", "WindowsApps", "wt.exe");
  const packageLauncher = path.join(
    root,
    "WindowsApps",
    "Microsoft.WindowsTerminal_1.24.11911.0_x64__8wekyb3d8bbwe",
    "wt.exe",
  );
  try {
    await Promise.all([
      mkdir(path.dirname(alias), { recursive: true }),
      mkdir(path.dirname(packageLauncher), { recursive: true }),
      mkdir(path.join(stateDirectory, "desktop"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(alias, "execution alias fixture"),
      writeFile(packageLauncher, "package launcher fixture"),
      writeFile(path.join(stateDirectory, "desktop", "terminal.json"), `${JSON.stringify({
        schemaVersion: "agenthist.desktop-terminal/v1",
        mode: "configured",
        executablePath: packageLauncher,
        label: "Windows Terminal",
        arguments: ["-w", "new", "new-tab", "--startingDirectory", "{cwd}", "{command}"],
      }, null, 2)}\n`, "utf8"),
    ]);
    const service = createDesktopTerminalSettingsService({
      stateDirectory,
      platform: "win32",
      environment: { LOCALAPPDATA: localAppData, Path: "", PATHEXT: ".EXE" },
      chooseExecutable: async () => undefined,
    });
    const settings = await service.inspect();
    assert.equal(settings.effectiveExecutablePath?.toLowerCase(), alias.toLowerCase());
    assert.equal(settings.requiresSetup, false);
    assert.equal((await service.resolveLaunchConfiguration()).executablePath.toLowerCase(), alias.toLowerCase());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
