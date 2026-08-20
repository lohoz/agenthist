import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { codexSessionRef } from "../../../src/agents/codex/identity.js";
import { runCli } from "../../../src/cli/program.js";
import type { ArchiveEntry, ArchiveManifest } from "../../../src/domain/archive.js";
import { writeArchive } from "../../../src/infrastructure/archive.js";

const sessionId = "019f1252-70b9-7e02-b1be-0ffcf51019de";
const objectId = "o000001";
const relativePath = `sessions/2026/08/20/rollout-${sessionId}.jsonl`;
const plainWorkspace = String.raw`D:\Netcatty`;
const verbatimWorkspace = String.raw`\\?\D:\Netcatty`;

function rollout(): string {
  return `${JSON.stringify({
    timestamp: "2026-08-20T07:00:00.000Z",
    type: "session_meta",
    payload: {
      session_id: sessionId,
      id: sessionId,
      timestamp: "2026-08-20T07:00:00.000Z",
      cwd: plainWorkspace,
      originator: "codex_cli_rs",
      cli_version: "format-compatible-fixture",
      model_provider: "test-provider",
      model: "gpt-5.4",
    },
  })}\n`;
}

function entry(context: string): ArchiveEntry {
  return {
    kind: "history",
    agent: "codex",
    sessionRef: codexSessionRef(sessionId),
    nativeId: sessionId,
    title: "Windows path fixture",
    context,
    model: "gpt-5.4",
    provider: "test-provider",
    createdAt: "2026-08-20T07:00:00.000Z",
    updatedAt: "2026-08-20T07:00:00.000Z",
    nativeArchived: false,
    library: { name: "", tags: [], archived: false, deleted: false },
    objects: [{ id: objectId, role: "rollout", relativePath }],
    resources: [],
    native: {
      thread: {},
      dynamicTools: [],
      goal: null,
      section: null,
      rollout: { relativePath, archived: false },
      lineage: {
        historyMode: "legacy",
        sessionId,
        subagentHistoryStartOrdinal: null,
        forkedFromId: null,
        parentThreadId: null,
        historyBase: null,
      },
      spawn: { incoming: null, componentNativeIds: [sessionId], relationStatus: "valid" },
      unsupportedRelationStatus: "empty",
    },
  };
}

async function archive(file: string, rolloutFile: string, context: string): Promise<void> {
  await writeArchive(file, [{ id: objectId, kind: "codex.rollout", filePath: rolloutFile }],
    (objects): ArchiveManifest => ({
      schemaVersion: "agenthist.archive/v1",
      createdAt: "2026-08-20T07:00:00.000Z",
      pathFlavor: "windows",
      entries: [entry(context)],
      objects,
    }));
}

test("inspect compares Codex archive workspaces using the source path flavor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-codex-windows-archive-"));
  try {
    const rolloutFile = path.join(root, "rollout.jsonl");
    await writeFile(rolloutFile, rollout());
    const runtime = { environment: { HOME: root }, cwd: root, home: root };

    const equivalent = path.join(root, "equivalent.agenthist");
    await archive(equivalent, rolloutFile, verbatimWorkspace);
    const inspected = await runCli(["--json", "inspect", equivalent], runtime);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    assert.equal((JSON.parse(inspected.stdout) as { data: { total_entries: number } }).data.total_entries, 1);

    const different = path.join(root, "different.agenthist");
    await archive(different, rolloutFile, String.raw`\\?\D:\Other`);
    const rejected = await runCli(["--json", "inspect", different], runtime);
    assert.equal(rejected.exitCode, 3);
    assert.match(rejected.stdout, /Codex archive metadata disagrees with its rollout/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
