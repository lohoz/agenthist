import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { colorizeHuman, renderBoundedHumanDetails } from "../../../src/cli/command-support.js";
import { runCli, VERSION } from "../../../src/cli/program.js";

test("human detail rendering is bounded without changing the complete result", () => {
  const items = Array.from({ length: 52 }, (_, index) => index);
  const rendered = renderBoundedHumanDetails(items, (item) => `item ${item}\n`, "item");

  assert.match(rendered, /^item 0\n/);
  assert.match(rendered, /item 49\n/);
  assert.doesNotMatch(rendered, /item 50\n/);
  assert.match(rendered, /\.\.\. 2 more items; use --json for complete details\.\n$/);
  assert.equal(items.length, 52);
});

test("human status colors degrade to plain text", () => {
  assert.equal(colorizeHuman("= unchanged", "success", false), "= unchanged");
  assert.equal(colorizeHuman("> mapped", "info", true), "\u001b[36m> mapped\u001b[0m");
  assert.equal(colorizeHuman("! missing", "error", true), "\u001b[31m! missing\u001b[0m");
});

test("root help exposes the intended user actions without legacy surfaces", async () => {
  const result = await runCli(["--help"]);

  assert.equal(result.exitCode, 0);
  for (const command of [
    "doctor", "scan", "history", "experience", "skill", "export", "inspect", "import", "transaction",
  ]) {
    assert.match(result.stdout, new RegExp(`^  ${command}\\s`, "m"));
  }
  assert.doesNotMatch(result.stdout, /\.ahb|connection|TUI/);
  assert.doesNotMatch(result.stdout, /^  ui\s/m);
  assert.equal(result.stderr, "");

  const importHelp = await runCli(["help", "import"]);
  assert.equal(importHelp.exitCode, 0);
  assert.match(importHelp.stdout, /^Usage:\n  agenthist import/m);
  assert.match(importHelp.stdout, /every archive entry by default/i);
  assert.match(importHelp.stdout, /do not create duplicate conversations/i);
  assert.match(importHelp.stdout, /workspace paths remain unchanged/i);
  assert.match(importHelp.stdout, /--to <agent>/i);
  assert.match(importHelp.stdout, /--dry-run.*--apply/s);
  assert.match(importHelp.stdout, /opens the import guide/i);
  assert.match(importHelp.stdout, /--language <en\|zh>/i);
  assert.match(importHelp.stdout, /Non-interactive output remains English/i);
  assert.match(importHelp.stdout, /scripts and --json must choose one explicitly/i);
  assert.match(importHelp.stdout, /Every selected Agent's\s+final workspace must exist/i);
  assert.doesNotMatch(importHelp.stdout, /credential|\.ahb/i);

  const inspectHelp = await runCli(["help", "inspect"]);
  assert.equal(inspectHelp.exitCode, 0);
  assert.match(inspectHelp.stdout, /workspace summary lists every source path/i);

  const historyHelp = await runCli(["history", "list", "--help"]);
  assert.equal(historyHelp.exitCode, 0);
  assert.match(historyHelp.stdout, /overlay/);
  assert.match(historyHelp.stdout, /never modifies the Agent's native history/);
  assert.match(historyHelp.stdout, /--offset <count>.*--limit <count>/s);
  assert.match(historyHelp.stdout, /default to active,\s+offset 0, and limit 50/);
  assert.match(historyHelp.stdout, /remaining count, and next offset/);

  assert.doesNotMatch(result.stdout, /^  convert\s/m);
  assert.doesNotMatch(importHelp.stdout, /accept-loss|loss-report-digest/i);

  const experienceHelp = await runCli(["experience", "--help"]);
  assert.equal(experienceHelp.exitCode, 0);
  assert.match(experienceHelp.stdout, /agenthist experience \[--dry-run\]/);
  assert.match(experienceHelp.stdout, /experience model check/);
  assert.doesNotMatch(experienceHelp.stdout, /experience prepare/);
  assert.doesNotMatch(experienceHelp.stdout, /experience (?:apply|list)|decisions\.json|experience library/i);
  assert.match(experienceHelp.stdout, /current\s+directory as its workspace/);
  assert.match(experienceHelp.stdout, /--workspace.*--session.*--all/s);
  assert.match(experienceHelp.stdout, /without model\s+configuration, output files, or network requests/);

  const skillHelp = await runCli(["skill", "install", "--help"]);
  assert.equal(skillHelp.exitCode, 0);
  assert.match(skillHelp.stdout, /skill install.*--agent.*--force/);
  assert.match(skillHelp.stdout, /skill uninstall/);
  assert.match(skillHelp.stdout, /default is every supported Agent/);

  const removedPrepare = await runCli(["experience", "prepare", "--dry-run"]);
  assert.equal(removedPrepare.exitCode, 2);
  assert.match(removedPrepare.stderr, /unknown experience flag: prepare/);

  const colored = await runCli(["--help"], { color: true });
  assert.match(colored.stdout, /\u001b\[/);
  assert.match(colored.stdout, /AgentHist/);
  assert.doesNotMatch(result.stdout, /\u001b\[/);
});

test("version, doctor, malformed journals, and unsupported commands have stable process results", async () => {
  assert.deepEqual(await runCli(["--version"]), {
    exitCode: 0,
    stdout: `${VERSION}\n`,
    stderr: "",
  });
  assert.deepEqual(await runCli(["version"]), {
    exitCode: 0,
    stdout: `${VERSION}\n`,
    stderr: "",
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-ts-doctor-"));
  const codexHome = path.join(root, "codex");
  const sqliteHome = path.join(root, "sqlite");
  const state = path.join(root, "state-must-not-exist");
  try {
    await mkdir(path.join(codexHome, "sessions"), { recursive: true });
    await mkdir(sqliteHome, { recursive: true });
    await writeFile(path.join(codexHome, "sessions", "carrier.jsonl"), "not read by doctor\n");
    const args = [
      "--json",
      "--state-dir", state,
      "--codex-home", codexHome,
      "--codex-sqlite-home", sqliteHome,
      "doctor",
      "--agent", "codex",
    ];
    const ready = await runCli(args, { environment: { HOME: root }, cwd: root, home: root, color: true });
    assert.equal(ready.exitCode, 0, ready.stderr);
    assert.equal((JSON.parse(ready.stdout) as { data: { status: string } }).data.status, "ready");
    assert.doesNotMatch(ready.stdout, /\u001b\[/);
    await assert.rejects(lstat(state), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    const humanReady = await runCli(args.filter((argument) => argument !== "--json"), {
      environment: { HOME: root },
      cwd: root,
      home: root,
      color: true,
    });
    assert.equal(humanReady.exitCode, 0, humanReady.stderr);
    assert.match(humanReady.stdout, /\u001b\[[0-9;]+mAgentHist doctor\u001b\[0m/);
    assert.match(humanReady.stdout, /\u001b\[32mREADY\u001b\[0m/);
    assert.ok(humanReady.stdout.includes(`\u001b[2m${codexHome}\u001b[0m`));
    assert.ok(humanReady.stdout.includes(`\u001b[2m${sqliteHome}\u001b[0m`));

    await rm(codexHome, { recursive: true });
    const absent = await runCli(args, { environment: { HOME: root }, cwd: root, home: root });
    assert.equal(absent.exitCode, 3, absent.stderr);
    assert.equal((JSON.parse(absent.stdout) as { data: { status: string } }).data.status, "not_detected");

    const transactionId = "123e4567-e89b-42d3-a456-426614174000";
    const malformedState = path.join(root, "malformed-state");
    const transactionRoot = path.join(malformedState, "transactions", transactionId);
    await mkdir(transactionRoot, { recursive: true });
    await writeFile(path.join(transactionRoot, "journal.json"), `${JSON.stringify({
      schemaVersion: "agenthist.transaction/v1",
      id: transactionId,
      operation: "history_import",
      agents: ["codex"],
      state: "committed",
      phase: "applying_native",
      direction: "forward",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      itemCount: 1,
      payload: null,
    }, null, 2)}\n`, { mode: 0o600 });
    const malformed = await runCli([
      "--json", "--state-dir", malformedState, "transaction", "list",
    ], { environment: { HOME: root }, cwd: root, home: root });
    assert.equal(malformed.exitCode, 3);
    assert.equal(malformed.stderr, "");
    assert.equal(
      (JSON.parse(malformed.stdout) as { error: { code: string } }).error.code,
      "operation_failed",
    );
    assert.equal(
      (JSON.parse(malformed.stdout) as { error: { message: string } }).error.message,
      "transaction journal lifecycle is invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const humanFailure = await runCli(["convert"]);
  assert.equal(humanFailure.exitCode, 2);
  assert.equal(humanFailure.stdout, "");
  assert.match(humanFailure.stderr, /^agenthist: unknown command: convert/);

  const coloredFailure = await runCli(["convert"], { color: true });
  assert.match(coloredFailure.stderr, /^\u001b\[1;31magenthist:\u001b\[0m unknown command: convert/);

  const jsonFailure = await runCli(["--json", "convert"]);
  assert.equal(jsonFailure.exitCode, 2);
  assert.equal(jsonFailure.stderr, "");
  assert.deepEqual(JSON.parse(jsonFailure.stdout), {
    schema_version: "agenthist.output/v1",
    command: "convert",
    error: { code: "invalid_arguments", message: "unknown command: convert" },
  });

  const nonInteractiveImport = await runCli(["import", "fixture.agenthist"]);
  assert.equal(nonInteractiveImport.exitCode, 2);
  assert.match(nonInteractiveImport.stderr, /interactive import requires a terminal; use --dry-run or --apply/);

  const nonInteractiveLanguage = await runCli([
    "import", "fixture.agenthist", "--dry-run", "--language", "zh",
  ]);
  assert.equal(nonInteractiveLanguage.exitCode, 2);
  assert.match(nonInteractiveLanguage.stderr, /--language is only available for interactive import/);

  const unsupported = await runCli(["--json", "ui"]);
  assert.equal(unsupported.exitCode, 2);
  assert.deepEqual((JSON.parse(unsupported.stdout) as { error: unknown }).error, {
    code: "invalid_arguments",
    message: "unknown command: ui",
  });
});
