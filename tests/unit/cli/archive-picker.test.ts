import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { listArchiveFiles, selectArchiveFile } from "../../../src/cli/archive-picker.js";
import { cleanTerminalText } from "../../../src/cli/import-wizard/terminal.js";

function terminal(): {
  readonly input: PassThrough & { isTTY: boolean };
  readonly output: PassThrough & { isTTY: boolean; columns: number; rows: number };
} {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 100;
  output.rows = 24;
  return { input, output };
}

test("archive discovery uses regular .agenthist files and sorts newest first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-archive-picker-"));
  try {
    const older = path.join(root, "older.agenthist");
    const newer = path.join(root, "newer.agenthist");
    await writeFile(older, "old");
    await writeFile(newer, "new archive");
    await writeFile(path.join(root, "notes.txt"), "ignored");
    await mkdir(path.join(root, "directory.agenthist"));
    await utimes(older, new Date("2026-08-20T01:00:00.000Z"), new Date("2026-08-20T01:00:00.000Z"));
    await utimes(newer, new Date("2026-08-20T02:00:00.000Z"), new Date("2026-08-20T02:00:00.000Z"));

    const files = await listArchiveFiles(root);
    assert.deepEqual(files.map((file) => file.name), ["newer.agenthist", "older.agenthist"]);
    assert.deepEqual(files.map((file) => file.sizeBytes), [11, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a single archive is selected directly without opening the terminal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-archive-picker-"));
  const { input, output } = terminal();
  let rendered = "";
  output.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  try {
    const archive = path.join(root, "only.agenthist");
    await writeFile(archive, "archive");
    const outcome = await selectArchiveFile({ action: "import", cwd: root, input, output });
    assert.deepEqual(outcome, { status: "selected", file: archive });
    assert.equal(rendered, "");
  } finally {
    input.destroy();
    output.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("the archive picker switches language and selects from the newest-first list", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-archive-picker-"));
  const { input, output } = terminal();
  let rendered = "";
  let action = 0;
  let searchFrom = 0;
  const actions = [
    { cue: "Choose an AgentHist file", keys: "l" },
    { cue: "选择 AgentHist 文件", keys: "\u001b[B\r" },
  ];
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString("utf8");
    const plain = cleanTerminalText(rendered);
    const next = actions[action];
    if (next !== undefined && plain.slice(searchFrom).includes(next.cue)) {
      action++;
      searchFrom = plain.length;
      setImmediate(() => input.write(next.keys));
    }
  });
  try {
    const older = path.join(root, "older.agenthist");
    const newer = path.join(root, "newer.agenthist");
    await writeFile(older, "old");
    await writeFile(newer, "new");
    await utimes(older, new Date("2026-08-20T01:00:00.000Z"), new Date("2026-08-20T01:00:00.000Z"));
    await utimes(newer, new Date("2026-08-20T02:00:00.000Z"), new Date("2026-08-20T02:00:00.000Z"));

    const outcome = await selectArchiveFile({
      action: "inspect",
      cwd: root,
      input,
      output,
      color: true,
      language: "en",
    });
    assert.deepEqual(outcome, { status: "selected", file: older });
    assert.equal(action, actions.length);
    const plain = cleanTerminalText(rendered);
    assert.match(plain, /newer\.agenthist/);
    assert.match(plain, /older\.agenthist/);
    assert.match(plain, /AgentHist 检查/);
  } finally {
    input.destroy();
    output.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
