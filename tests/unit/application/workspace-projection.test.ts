import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { planImportWorkspaces } from "../../../src/application/workspace-projection.js";
import { assertPathMappingsConsumed, parsePathMappings } from "../../../src/domain/path-mapping.js";

test("workspace planning distinguishes mapped and unchanged paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-workspace-plan-"));
  const unchanged = path.join(root, "unchanged");
  const sourceRoot = path.join(root, "source-opencode");
  const sourceProject = path.join(sourceRoot, "project");
  const mappedRoot = path.join(root, "mapped");
  const mappedProject = path.join(mappedRoot, "project");
  try {
    await mkdir(unchanged);
    await mkdir(mappedProject, { recursive: true });
    const mappings = parsePathMappings([`${sourceRoot}=${mappedRoot}`]);
    const result = await planImportWorkspaces([
      { agent: "claude", sessionRef: "claude-session", context: unchanged },
      { agent: "opencode", sessionRef: "opencode-session-a", context: sourceProject },
      { agent: "opencode", sessionRef: "opencode-session-b", context: sourceProject },
    ], mappings);

    assertPathMappingsConsumed(mappings);
    assert.deepEqual(result.find((item) => item.source === unchanged), {
      source: unchanged,
      target: unchanged,
      status: "unchanged",
      agents: ["claude"],
      sessionRefs: ["claude-session"],
    });
    assert.deepEqual(result.find((item) => item.source === sourceProject), {
      source: sourceProject,
      target: mappedProject,
      status: "mapped",
      agents: ["opencode"],
      sessionRefs: ["opencode-session-a", "opencode-session-b"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace planning reports every required path that cannot be resolved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-workspace-failure-"));
  const missingClaude = path.join(root, "missing-claude");
  const missingOpenCode = path.join(root, "missing-opencode");
  const missingCodex = path.join(root, "missing-codex");
  try {
    await assert.rejects(
      planImportWorkspaces([
        { agent: "claude", sessionRef: "claude-session", context: missingClaude },
        { agent: "opencode", sessionRef: "opencode-session", context: missingOpenCode },
        { agent: "codex", sessionRef: "codex-session", context: missingCodex },
      ], parsePathMappings([])),
      (error: Error) => {
        assert.match(error.message, /^workspace path resolution failed before import:/);
        assert.match(error.message, new RegExp(missingClaude.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(error.message, new RegExp(missingOpenCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(error.message, new RegExp(missingCodex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(error.message, /use --map-path/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
