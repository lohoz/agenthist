import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveSkillInstallLocations,
  resolveSkillRemovalLocations,
} from "../../../src/skill/paths.js";

test("default skill locations cover supported Agents without duplicating OpenCode's Claude-compatible source", () => {
  assert.deepEqual(resolveSkillInstallLocations({
    platform: "linux",
    cwd: "/work",
    home: "/home/alice",
    environment: {},
  }), [
    {
      agents: ["codex"],
      directory: "/home/alice/.codex/skills/agenthist",
      shared: false,
    },
    {
      agents: ["claude", "opencode"],
      directory: "/home/alice/.claude/skills/agenthist",
      shared: true,
    },
    {
      agents: ["pi"],
      directory: "/home/alice/.pi/agent/skills/agenthist",
      shared: false,
    },
  ]);
});

test("skill removal covers shared and Agent-native locations", () => {
  assert.deepEqual(resolveSkillRemovalLocations({
    platform: "linux",
    cwd: "/work",
    home: "/home/alice",
    environment: {},
  }), [
    {
      agents: ["codex"],
      directory: "/home/alice/.codex/skills/agenthist",
      shared: false,
    },
    {
      agents: ["claude", "opencode"],
      directory: "/home/alice/.claude/skills/agenthist",
      shared: true,
    },
    {
      agents: ["pi"],
      directory: "/home/alice/.pi/agent/skills/agenthist",
      shared: false,
    },
    {
      agents: ["opencode"],
      directory: "/home/alice/.config/opencode/skills/agenthist",
      shared: false,
    },
  ]);
});

test("custom roots and disabled compatibility use each Agent's native location", () => {
  assert.deepEqual(resolveSkillInstallLocations({
    platform: "darwin",
    cwd: "/work",
    home: "/Users/alice",
    environment: {
      CODEX_HOME: "/Volumes/config/codex",
      CLAUDE_CONFIG_DIR: "/Volumes/config/claude",
      XDG_CONFIG_HOME: "/Volumes/config/xdg",
      PI_CODING_AGENT_DIR: "/Volumes/config/pi",
    },
  }), [
    {
      agents: ["codex"],
      directory: "/Volumes/config/codex/skills/agenthist",
      shared: false,
    },
    {
      agents: ["claude"],
      directory: "/Volumes/config/claude/skills/agenthist",
      shared: false,
    },
    {
      agents: ["opencode"],
      directory: "/Volumes/config/xdg/opencode/skills/agenthist",
      shared: false,
    },
    {
      agents: ["pi"],
      directory: "/Volumes/config/pi/skills/agenthist",
      shared: false,
    },
  ]);
});

test("Windows skill locations use Windows paths", () => {
  assert.deepEqual(resolveSkillInstallLocations({
    platform: "win32",
    cwd: String.raw`C:\work`,
    home: String.raw`C:\Users\Alice`,
    environment: { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" },
  }), [
    {
      agents: ["codex"],
      directory: String.raw`C:\Users\Alice\.codex\skills\agenthist`,
      shared: false,
    },
    {
      agents: ["claude"],
      directory: String.raw`C:\Users\Alice\.claude\skills\agenthist`,
      shared: false,
    },
    {
      agents: ["opencode"],
      directory: String.raw`C:\Users\Alice\.config\opencode\skills\agenthist`,
      shared: false,
    },
    {
      agents: ["pi"],
      directory: String.raw`C:\Users\Alice\.pi\agent\skills\agenthist`,
      shared: false,
    },
  ]);
});
