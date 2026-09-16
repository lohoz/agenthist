import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DESKTOP_AGENT_SETTINGS_SCHEMA,
  applyAgentSettingsToSourceOptions,
  clearDesktopAgentPathSetting,
  desktopAgentSettingsPath,
  inspectAgentSettings,
  loadDesktopAgentPathSettings,
  resolveConfiguredAgentExecutable,
  saveDesktopAgentPathSettings,
  updateDesktopAgentPathSetting,
  validateDesktopAgentPathSettings,
  type DesktopAgentPathSettings,
} from "../../../src/desktop/agent-settings.js";

function emptySettings(): DesktopAgentPathSettings {
  return { schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA, agents: {} };
}

async function executable(file: string, marker?: string): Promise<void> {
  const contents = process.platform === "win32"
    ? `@echo off\r\n${marker === undefined ? "" : `echo executed>${marker}\r\n`}exit /b 0\r\n`
    : `#!/bin/sh\n${marker === undefined ? "" : `printf executed > '${marker}'\n`}exit 0\n`;
  await writeFile(file, contents, "utf8");
  if (process.platform !== "win32") await chmod(file, 0o755);
}

function pathEnvironment(directory: string): NodeJS.ProcessEnv {
  return process.platform === "win32"
    ? { pAtH: directory, PaThExT: ".cMd;.EXE" }
    : { PATH: directory };
}

test("Desktop Agent path settings round-trip Unicode paths and map every Agent source override", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-agent-settings-"));
  const stateDirectory = path.join(root, "状态 空格");
  const settings: DesktopAgentPathSettings = {
    schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA,
    agents: {
      codex: {
        historyRoot: path.join(root, "Codex 历史"),
        databasePath: path.join(root, "Codex SQLite"),
        executablePath: path.join(root, "工具", process.platform === "win32" ? "codex.CMD" : "codex"),
      },
      opencode: {
        historyRoot: path.join(root, "OpenCode data"),
        databasePath: path.join(root, "OpenCode data", "opencode.db"),
      },
      claude: { historyRoot: path.join(root, "Claude 配置") },
      pi: { historyRoot: path.join(root, "Pi sessions") },
    },
  };
  try {
    assert.deepEqual(await loadDesktopAgentPathSettings(stateDirectory), emptySettings());
    const saved = await saveDesktopAgentPathSettings(stateDirectory, settings);
    assert.deepEqual(saved, settings);
    assert.deepEqual(await loadDesktopAgentPathSettings(stateDirectory), settings);
    const fileInfo = await lstat(desktopAgentSettingsPath(stateDirectory));
    assert.equal(fileInfo.isFile(), true);
    assert.equal(fileInfo.isSymbolicLink(), false);

    const applied = applyAgentSettingsToSourceOptions({
      agents: ["codex", "claude"],
      codex: { profile: "work", cwd: root },
      opencode: { home: root },
    }, saved);
    assert.deepEqual(applied.agents, ["codex", "claude"]);
    assert.deepEqual(applied.codex, {
      profile: "work",
      cwd: root,
      codexHome: settings.agents.codex!.historyRoot,
      sqliteHome: settings.agents.codex!.databasePath,
    });
    assert.deepEqual(applied.opencode, {
      home: root,
      dataRoot: settings.agents.opencode!.historyRoot,
      databasePath: settings.agents.opencode!.databasePath,
    });
    assert.deepEqual(applied.claude, { configRoot: settings.agents.claude!.historyRoot });
    assert.deepEqual(applied.pi, { sessionRoot: settings.agents.pi!.historyRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update and clear remove empty Agent entries while preserving the settings file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-agent-settings-update-"));
  const stateDirectory = path.join(root, "state");
  try {
    const updated = await updateDesktopAgentPathSetting(stateDirectory, "codex", {
      historyRoot: path.join(root, "codex-home"),
    });
    assert.equal(updated.agents.codex?.historyRoot, path.join(root, "codex-home"));
    const emptied = await updateDesktopAgentPathSetting(stateDirectory, "codex", {});
    assert.deepEqual(emptied.agents, {});
    assert.deepEqual(await loadDesktopAgentPathSettings(stateDirectory), emptySettings());
    assert.equal((await lstat(desktopAgentSettingsPath(stateDirectory))).isFile(), true);

    await updateDesktopAgentPathSetting(stateDirectory, "pi", { historyRoot: path.join(root, "pi") });
    const cleared = await clearDesktopAgentPathSetting(stateDirectory, "pi");
    assert.deepEqual(cleared.agents, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settings validation fails closed for corruption, unknown fields, credentials, and invalid paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-agent-settings-invalid-"));
  const stateDirectory = path.join(root, "state");
  const file = desktopAgentSettingsPath(stateDirectory);
  try {
    await assert.rejects(saveDesktopAgentPathSettings(stateDirectory, {
      schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA,
      agents: { codex: { historyRoot: "relative" } },
    }), /absolute host path/);
    assert.throws(() => validateDesktopAgentPathSettings({
      schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA,
      agents: { claude: { databasePath: path.join(root, "db") } },
    }), /does not support/);
    assert.throws(() => validateDesktopAgentPathSettings({
      schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA,
      agents: { codex: { apiKey: "must-not-be-stored" } },
    }), /unknown field/);
    assert.throws(() => validateDesktopAgentPathSettings({
      schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA,
      agents: { futureAgent: { historyRoot: root } },
    }), /unknown Agent/);
    assert.throws(() => validateDesktopAgentPathSettings({
      schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA,
      agents: {},
      token: "must-not-be-stored",
    }), /unknown field/);

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{broken JSON", "utf8");
    await assert.rejects(loadDesktopAgentPathSettings(stateDirectory), /invalid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saving refuses to replace a symbolic-link settings target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-agent-settings-link-"));
  const stateDirectory = path.join(root, "state");
  const file = desktopAgentSettingsPath(stateDirectory);
  const target = path.join(root, "outside.json");
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(target, "outside must survive", "utf8");
    try {
      await symlink(target, file, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symbolic link creation is unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(saveDesktopAgentPathSettings(stateDirectory, emptySettings()), /not a regular file/);
    assert.equal(await readFile(target, "utf8"), "outside must survive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executable resolution honors Windows casing and PATHEXT without searching relative workspace paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-agent-executable-"));
  const bin = path.join(root, "工具 空格");
  const filename = process.platform === "win32" ? "CoDeX.CmD" : "codex";
  const command = path.join(bin, filename);
  try {
    await mkdir(bin);
    await executable(command);
    const resolved = await resolveConfiguredAgentExecutable("codex", emptySettings(), pathEnvironment(bin));
    assert.equal(resolved?.toLowerCase(), command.toLowerCase());
    assert.equal(await resolveConfiguredAgentExecutable("codex", emptySettings(), pathEnvironment(".")), undefined);

    const overridden: DesktopAgentPathSettings = {
      schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA,
      agents: { codex: { executablePath: command } },
    };
    assert.equal(
      (await resolveConfiguredAgentExecutable("codex", overridden, pathEnvironment("")))?.toLowerCase(),
      command.toLowerCase(),
    );
    await assert.rejects(resolveConfiguredAgentExecutable("codex", {
      schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA,
      agents: { codex: { executablePath: path.join(root, "missing.exe") } },
    }), /does not exist/);
    await assert.rejects(resolveConfiguredAgentExecutable("codex", {
      schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA,
      agents: { codex: { executablePath: bin } },
    }), /not a real file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspection reports configured path shapes and executable availability without executing it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-agent-settings-inspect-"));
  const history = path.join(root, "Codex history");
  const database = path.join(root, "Codex sqlite");
  const bin = path.join(root, "bin");
  const command = path.join(bin, process.platform === "win32" ? "codex.CMD" : "codex");
  const marker = path.join(root, "must-not-exist.txt");
  try {
    await mkdir(history);
    await mkdir(database);
    await mkdir(bin);
    await executable(command, marker);
    const settings: DesktopAgentPathSettings = {
      schemaVersion: DESKTOP_AGENT_SETTINGS_SCHEMA,
      agents: {
        codex: { historyRoot: history, databasePath: database, executablePath: command },
        opencode: { historyRoot: path.join(root, "missing-opencode") },
      },
    };
    const inspected = await inspectAgentSettings(settings, pathEnvironment(bin));
    const codex = inspected.find((item) => item.agent === "codex")!;
    assert.deepEqual(codex.history, { configured: true, path: history, available: true, expected: "directory" });
    assert.equal(codex.database?.available, true);
    assert.equal(codex.executable.configured, true);
    assert.equal(codex.executable.available, true);
    assert.equal(codex.executable.resolvedPath?.toLowerCase(), command.toLowerCase());
    const opencode = inspected.find((item) => item.agent === "opencode")!;
    assert.equal(opencode.history.configured, true);
    assert.equal(opencode.history.available, false);
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
