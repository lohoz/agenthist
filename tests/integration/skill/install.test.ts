import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../../../src/cli/program.js";

test("skill install and uninstall manage only AgentHist-owned content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-skill-"));
  const runtime = { environment: { HOME: root }, cwd: root, home: root };
  const codexSkill = path.join(root, ".codex", "skills", "agenthist");
  const claudeSkill = path.join(root, ".claude", "skills", "agenthist");
  const openCodeSkill = path.join(root, ".config", "opencode", "skills", "agenthist");
  const piSkill = path.join(root, ".pi", "agent", "skills", "agenthist");
  try {
    const installed = await runCli(["--json", "skill", "install"], runtime);
    assert.equal(installed.exitCode, 0, installed.stderr);
    const payload = JSON.parse(installed.stdout) as {
      data: { targets: readonly { agents: readonly string[]; status: string; shared: boolean }[] };
    };
    assert.deepEqual(payload.data.targets.map((target) => ({
      agents: target.agents,
      status: target.status,
      shared: target.shared,
    })), [
      { agents: ["codex"], status: "installed", shared: false },
      { agents: ["claude", "opencode"], status: "installed", shared: true },
      { agents: ["pi"], status: "installed", shared: false },
    ]);
    const skillContents = await readFile(path.join(codexSkill, "SKILL.md"), "utf8");
    assert.match(skillContents, /^---\nname: agenthist\ndescription:/);
    assert.match(skillContents, /agenthist help <command>/);
    await access(path.join(codexSkill, "references", "workflows.md"));
    await access(path.join(claudeSkill, "references", "semantics.md"));
    await access(path.join(piSkill, "references", "semantics.md"));
    await assert.rejects(access(openCodeSkill), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    const unchanged = await runCli(["--json", "skill", "install"], runtime);
    assert.equal(unchanged.exitCode, 0, unchanged.stderr);
    assert.deepEqual(
      (JSON.parse(unchanged.stdout) as { data: { targets: readonly { status: string }[] } }).data.targets
        .map((target) => target.status),
      ["unchanged", "unchanged", "unchanged"],
    );

    await writeFile(path.join(codexSkill, "SKILL.md"), "user-owned skill\n");
    const conflict = await runCli(["skill", "install", "--agent", "codex"], runtime);
    assert.equal(conflict.exitCode, 3);
    assert.match(conflict.stderr, /not managed by AgentHist/);
    assert.equal(await readFile(path.join(codexSkill, "SKILL.md"), "utf8"), "user-owned skill\n");

    const replaced = await runCli([
      "--json", "skill", "install", "--agent", "codex", "--force",
    ], runtime);
    assert.equal(replaced.exitCode, 0, replaced.stderr);
    assert.equal(
      (JSON.parse(replaced.stdout) as { data: { targets: readonly { status: string }[] } }).data.targets[0]?.status,
      "replaced",
    );
    assert.match(await readFile(path.join(codexSkill, "SKILL.md"), "utf8"), /name: agenthist/);

    await mkdir(openCodeSkill, { recursive: true });
    await writeFile(path.join(openCodeSkill, "SKILL.md"), "user-owned skill\n");
    const uninstalled = await runCli(["--json", "skill", "uninstall"], runtime);
    assert.equal(uninstalled.exitCode, 0, uninstalled.stderr);
    assert.deepEqual(
      (JSON.parse(uninstalled.stdout) as {
        data: {
          operation: string;
          targets: readonly {
            agents: readonly string[];
            directory: string;
            shared: boolean;
            status: string;
          }[];
        };
      }).data,
      {
        operation: "uninstall",
        targets: [
          { agents: ["codex"], directory: codexSkill, shared: false, status: "removed" },
          { agents: ["claude", "opencode"], directory: claudeSkill, shared: true, status: "removed" },
          { agents: ["pi"], directory: piSkill, shared: false, status: "removed" },
          { agents: ["opencode"], directory: openCodeSkill, shared: false, status: "preserved" },
        ],
      },
    );
    await assert.rejects(access(codexSkill), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await assert.rejects(access(claudeSkill), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await assert.rejects(access(piSkill), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.equal(await readFile(path.join(openCodeSkill, "SKILL.md"), "utf8"), "user-owned skill\n");

    const repeated = await runCli(["--json", "skill", "uninstall"], runtime);
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    assert.deepEqual(
      (JSON.parse(repeated.stdout) as { data: { targets: readonly { status: string }[] } }).data.targets
        .map((target) => target.status),
      ["absent", "absent", "absent", "preserved"],
    );

    const invalid = await runCli(["skill", "uninstall", "--force"], runtime);
    assert.equal(invalid.exitCode, 2);
    assert.match(invalid.stderr, /unknown skill uninstall flag: --force/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
