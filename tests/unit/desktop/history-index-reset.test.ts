import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Agent } from "../../../src/domain/agent.js";
import type { AgentSnapshot, StoredSession } from "../../../src/domain/history.js";
import {
  desktopHistoryIndexPath,
  listDesktopHistoryIndex,
  rebuildDesktopHistoryIndex,
  syncDesktopHistoryIndex,
} from "../../../src/desktop/history-index.js";
import { createSnapshotWorkspace, publishSnapshot } from "../../../src/infrastructure/history-store.js";
import { saveLibraryOverlay } from "../../../src/infrastructure/library-store.js";

function reference(agent: Agent, digit: string): string {
  return `ahsr1_${agent}_ck1_${digit.repeat(64)}`;
}

function session(agent: Agent, digit: string, title: string): StoredSession {
  return {
    sessionRef: reference(agent, digit),
    agent,
    nativeId: `${agent}-native-${digit}`,
    title,
    context: `C:\\项目 空格\\${agent}`,
    model: "fixture-model",
    provider: "fixture-provider",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: `2026-09-0${digit}T00:00:00.000Z`,
    nativeArchived: false,
    library: { name: "", tags: [], archived: false, deleted: false },
    conversation: [{
      kind: "message",
      role: "user",
      text: `Unicode 对话 ${digit}`,
      timestamp: "2026-09-01T00:00:00.000Z",
    }],
    searchText: [`search-${digit}`],
    rawFiles: [],
    native: { fixture: true },
  };
}

async function publish(
  stateDirectory: string,
  agent: Agent,
  sessions: readonly StoredSession[],
): Promise<{ readonly head: string; readonly snapshot: string }> {
  const workspace = await createSnapshotWorkspace(stateDirectory, agent);
  const snapshot: AgentSnapshot = {
    schemaVersion: "agenthist.history-snapshot/v2",
    snapshotId: workspace.id,
    agent,
    scannedAt: "2026-09-04T00:00:00.000Z",
    sessions,
    auxiliaryFiles: [],
    warnings: [],
  };
  await publishSnapshot(stateDirectory, workspace, snapshot);
  return {
    head: path.join(stateDirectory, "history", agent, "head.json"),
    snapshot: path.join(stateDirectory, "history", agent, "snapshots", workspace.id, "index.json"),
  };
}

test("rebuild replaces only the derived SQLite index and preserves every authoritative sibling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-index-rebuild-only-"));
  const stateDirectory = path.join(root, "状态 空格");
  try {
    const source = await publish(stateDirectory, "codex", [session("codex", "1", "Original")]);
    await saveLibraryOverlay(stateDirectory, [{
      sessionRef: reference("codex", "1"),
      name: "Library title",
      tags: ["保留"],
      archived: false,
      deleted: false,
    }]);
    await syncDesktopHistoryIndex(stateDirectory);
    const agentSettings = path.join(stateDirectory, "desktop", "agents.json");
    const experience = path.join(stateDirectory, "desktop", "experience", "keep.txt");
    await writeFile(agentSettings, "agent settings sibling", "utf8");
    await mkdir(path.dirname(experience), { recursive: true });
    await writeFile(experience, "experience sibling", "utf8");
    const before = {
      head: await readFile(source.head, "utf8"),
      snapshot: await readFile(source.snapshot, "utf8"),
      library: await readFile(path.join(stateDirectory, "history", "library.json"), "utf8"),
    };

    const rebuilt = await rebuildDesktopHistoryIndex(stateDirectory);
    assert.equal(rebuilt.removed, true);
    assert.equal(rebuilt.sessions, 1);
    const listed = await listDesktopHistoryIndex({ stateDirectory });
    assert.equal(listed.sessions[0]!.title, "Library title");
    assert.deepEqual(listed.sessions[0]!.tags, ["保留"]);
    assert.equal(await readFile(source.head, "utf8"), before.head);
    assert.equal(await readFile(source.snapshot, "utf8"), before.snapshot);
    assert.equal(await readFile(path.join(stateDirectory, "history", "library.json"), "utf8"), before.library);
    assert.equal(await readFile(agentSettings, "utf8"), "agent settings sibling");
    assert.equal(await readFile(experience, "utf8"), "experience sibling");
    const desktopEntries = await readdir(path.join(stateDirectory, "desktop"));
    assert.equal(desktopEntries.some((name) => name.includes(".rebuild-")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuild creates a valid empty derived index when no snapshots exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-index-rebuild-empty-"));
  const stateDirectory = path.join(root, "state");
  try {
    const rebuilt = await rebuildDesktopHistoryIndex(stateDirectory);
    assert.equal(rebuilt.removed, false);
    assert.equal(rebuilt.sessions, 0);
    const info = await lstat(desktopHistoryIndexPath(stateDirectory));
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuild replaces a corrupt derived index from untouched snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-index-rebuild-corrupt-"));
  const stateDirectory = path.join(root, "state");
  try {
    await publish(stateDirectory, "claude", [session("claude", "2", "Recovered from snapshot")]);
    await syncDesktopHistoryIndex(stateDirectory);
    await writeFile(desktopHistoryIndexPath(stateDirectory), "not SQLite", "utf8");
    const rebuilt = await rebuildDesktopHistoryIndex(stateDirectory);
    assert.equal(rebuilt.removed, true);
    const listed = await listDesktopHistoryIndex({ stateDirectory, agents: ["claude"] });
    assert.equal(listed.sessions[0]!.title, "Recovered from snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuild rejects symbolic-link index targets without touching their destination", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-index-rebuild-link-"));
  const stateDirectory = path.join(root, "state");
  const index = desktopHistoryIndexPath(stateDirectory);
  const outside = path.join(root, "outside.sqlite");
  try {
    await mkdir(path.dirname(index), { recursive: true });
    await writeFile(outside, "outside survives", "utf8");
    try {
      await symlink(outside, index, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symbolic link creation is unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(rebuildDesktopHistoryIndex(stateDirectory), /target is unsafe/);
    assert.equal(await readFile(outside, "utf8"), "outside survives");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed synchronization restores the prior index and leaves the broken overlay untouched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-index-rebuild-restore-"));
  const stateDirectory = path.join(root, "state");
  const library = path.join(stateDirectory, "history", "library.json");
  try {
    await publish(stateDirectory, "pi", [session("pi", "3", "Prior index")]);
    await syncDesktopHistoryIndex(stateDirectory);
    const index = desktopHistoryIndexPath(stateDirectory);
    const previous = await readFile(index);
    await writeFile(library, "{broken overlay", "utf8");
    await assert.rejects(rebuildDesktopHistoryIndex(stateDirectory), /rebuild was incomplete/);
    assert.deepEqual(await readFile(index), previous);
    assert.equal(await readFile(library, "utf8"), "{broken overlay");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent rebuilds coalesce and list waits for the rebuilt index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-index-rebuild-concurrent-"));
  const stateDirectory = path.join(root, "state");
  try {
    await publish(stateDirectory, "opencode", [session("opencode", "4", "Concurrent")]);
    await syncDesktopHistoryIndex(stateDirectory);
    const first = rebuildDesktopHistoryIndex(stateDirectory);
    const second = rebuildDesktopHistoryIndex(stateDirectory);
    assert.equal(first, second);
    const listed = listDesktopHistoryIndex({ stateDirectory, agents: ["opencode"] });
    const [rebuilt, page] = await Promise.all([first, listed]);
    assert.equal(rebuilt.sessions, 1);
    assert.equal(page.sessions[0]!.title, "Concurrent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuild requires a strict absolute state path", async () => {
  await assert.rejects(rebuildDesktopHistoryIndex("relative-state"), /absolute valid state directory/);
  await assert.rejects(rebuildDesktopHistoryIndex(`C:\\bad\nstate`), /absolute valid state directory/);
});
