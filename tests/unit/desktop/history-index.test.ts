import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import type { Agent } from "../../../src/domain/agent.js";
import type { AgentSnapshot, ConversationItem, StoredSession } from "../../../src/domain/history.js";
import {
  desktopHistoryIndexPath,
  findInDesktopConversation,
  getDesktopConversationChunk,
  listDesktopHistoryIndex,
  syncDesktopHistoryIndex,
} from "../../../src/desktop/history-index.js";
import {
  createSnapshotWorkspace,
  publishSnapshot,
} from "../../../src/infrastructure/history-store.js";
import { saveLibraryOverlay } from "../../../src/infrastructure/library-store.js";

function reference(agent: Agent, index: number): string {
  return `ahsr1_${agent}_ck1_${index.toString(16).padStart(64, "0")}`;
}

function messages(user: string, assistant = "Completed safely."): readonly ConversationItem[] {
  return [
    {
      kind: "message",
      role: "user",
      text: user,
      timestamp: "2026-09-01T00:00:00.000Z",
    },
    {
      kind: "message",
      role: "assistant",
      text: assistant,
      timestamp: "2026-09-01T00:01:00.000Z",
      model: "fixture-model",
      portableNotes: ["technical fixture detail"],
    },
  ];
}

function fixtureSession(
  agent: Agent,
  index: number,
  options: {
    readonly workspace?: string;
    readonly updatedAt?: string;
    readonly title?: string;
    readonly conversation?: readonly ConversationItem[];
    readonly archived?: boolean;
    readonly deleted?: boolean;
    readonly tags?: readonly string[];
    readonly nativeId?: string;
  } = {},
): StoredSession {
  const sessionRef = reference(agent, index);
  return {
    sessionRef,
    agent,
    nativeId: options.nativeId ?? `native-${agent}-${index}`,
    title: options.title ?? `Conversation ${index}`,
    context: options.workspace ?? `C:\\work spaces\\project-${index % 8}`,
    model: "fixture-model",
    provider: "fixture-provider",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
    nativeArchived: false,
    library: {
      name: "",
      tags: options.tags ?? [],
      archived: options.archived ?? false,
      deleted: options.deleted ?? false,
    },
    conversation: options.conversation ?? messages(`User request ${index}`),
    searchText: [`search-extra-${index}`],
    rawFiles: [],
    native: { fixture: true },
  };
}

test("desktop index merges split records that belong to one native session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-merge-session-"));
  const stateDirectory = path.join(root, "state");
  const sharedNativeId = "same-native-session";
  const sharedAssistant: ConversationItem = {
    kind: "message",
    role: "assistant",
    text: "共享回答",
    timestamp: "2026-09-01T00:01:00.000Z",
  };
  const first = fixtureSession("claude", 41, {
    nativeId: sharedNativeId,
    updatedAt: "2026-09-01T00:01:00.000Z",
    conversation: [
      { kind: "message", role: "user", text: "第一段", timestamp: "2026-09-01T00:00:00.000Z" },
      sharedAssistant,
    ],
  });
  const second = fixtureSession("claude", 42, {
    nativeId: sharedNativeId,
    updatedAt: "2026-09-01T00:03:00.000Z",
    conversation: [
      sharedAssistant,
      { kind: "message", role: "user", text: "第二段", timestamp: "2026-09-01T00:02:00.000Z" },
    ],
  });
  try {
    await publishAgentSnapshot(stateDirectory, "claude", [first, second]);
    const synced = await syncDesktopHistoryIndex(stateDirectory);
    assert.equal(synced.sessions, 1);
    const listed = await listDesktopHistoryIndex({ stateDirectory });
    assert.equal(listed.total, 1);
    assert.equal(listed.sessions[0]!.sessionRef, second.sessionRef);
    assert.deepEqual(listed.sessions[0]!.memberSessionRefs, [first.sessionRef, second.sessionRef]);
    const conversation = await getDesktopConversationChunk({
      stateDirectory,
      sessionRef: second.sessionRef,
      limit: 10,
    });
    assert.deepEqual(conversation.items.map((item) => item.item.kind === "message" ? item.item.text : item.item.label), [
      "第一段",
      "共享回答",
      "第二段",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop index presents a Codex task and its subagents once while preserving independent forks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-task-family-"));
  const stateDirectory = path.join(root, "state");
  const parent = fixtureSession("codex", 101, {
    workspace: "D:\\demo-project", title: "Deploy the server", nativeId: "parent",
    conversation: messages("Deploy the server"),
  });
  const child = {
    ...fixtureSession("codex", 102, {
      workspace: "\\\\?\\D:\\demo-project", title: parent.title, nativeId: "child",
      conversation: [...parent.conversation, ...messages("Child-only diagnostic", "Child result")],
    }),
    native: { lineage: { parentThreadId: "parent", forkedFromId: "parent", sessionId: "parent" } },
  };
  const grandchild = {
    ...fixtureSession("codex", 103, { workspace: "d:/demo-project/", nativeId: "grandchild" }),
    native: { spawn: { relationStatus: "valid", incoming: { parent_thread_id: "child", child_thread_id: "grandchild" } } },
  };
  const independent = {
    ...fixtureSession("codex", 104, { workspace: "D:\\demo-project", title: parent.title, nativeId: "fork" }),
    native: { lineage: { forkedFromId: "parent" } },
  };
  const orphan = {
    ...fixtureSession("codex", 105, { workspace: "D:\\demo-project", nativeId: "orphan" }),
    native: { lineage: { parentThreadId: "missing" } },
  };
  try {
    await publishAgentSnapshot(stateDirectory, "codex", [grandchild, child, parent, independent, orphan]);
    assert.equal((await syncDesktopHistoryIndex(stateDirectory)).sessions, 3);
    const listed = await listDesktopHistoryIndex({ stateDirectory });
    const merged = listed.sessions.find((session) => session.sessionRef === parent.sessionRef)!;
    assert.deepEqual(merged.memberSessionRefs, [parent.sessionRef, child.sessionRef, grandchild.sessionRef].sort());
    assert.equal(merged.workspace, "D:\\demo-project");
    const chunk = await getDesktopConversationChunk({ stateDirectory, sessionRef: child.sessionRef });
    assert.equal(chunk.session.sessionRef, parent.sessionRef);
    const texts = chunk.items.flatMap(({ item }) => item.kind === "message" ? [item.text] : []);
    assert.equal(texts.filter((text) => text === "Deploy the server").length, 1);
    assert.ok(texts.includes("Child-only diagnostic"));
    assert.ok(texts.includes("User request 103"));
    const search = await listDesktopHistoryIndex({ stateDirectory, query: "diagnostic" });
    assert.equal(search.total, 1);
    assert.equal(search.sessions[0]!.sessionRef, parent.sessionRef);
    assert.equal((await findInDesktopConversation({ stateDirectory, sessionRef: grandchild.sessionRef, query: "diagnostic" })).total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace filters combine path aliases and select complete subtrees across agents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-workspace-tree-"));
  const stateDirectory = path.join(root, "state");
  try {
    await publishAgentSnapshot(stateDirectory, "codex", [
      fixtureSession("codex", 1, { workspace: "\\\\?\\D:\\demo-project" }),
      fixtureSession("codex", 2, { workspace: "D:\\demo-project\\nested" }),
      fixtureSession("codex", 3, { workspace: "D:\\demo-project-other" }),
      fixtureSession("codex", 4, { workspace: "/work/Project" }),
      fixtureSession("codex", 5, { workspace: "/work/project" }),
    ]);
    await publishAgentSnapshot(stateDirectory, "claude", [fixtureSession("claude", 1, { workspace: "d:/demo-project/" })]);
    await syncDesktopHistoryIndex(stateDirectory);
    assert.equal((await listDesktopHistoryIndex({ stateDirectory, workspace: "D:\\DEMO-PROJECT\\" })).total, 2);
    const subtree = await listDesktopHistoryIndex({ stateDirectory, workspace: "D:\\demo-project", workspaceDescendants: true, limit: 1 });
    assert.equal(subtree.total, 3);
    assert.equal(subtree.nextOffset, 1);
    assert.equal((await listDesktopHistoryIndex({ stateDirectory, workspace: "D:\\", workspaceDescendants: true })).total, 4);
    assert.equal((await listDesktopHistoryIndex({ stateDirectory, workspace: "/work/Project" })).total, 1);
    assert.equal((await listDesktopHistoryIndex({ stateDirectory, workspace: "/work/project/" })).total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function publishAgentSnapshot(
  stateDirectory: string,
  agent: Agent,
  sessions: readonly StoredSession[],
): Promise<{ readonly snapshotId: string; readonly indexFile: string }> {
  const workspace = await createSnapshotWorkspace(stateDirectory, agent);
  const snapshot: AgentSnapshot = {
    schemaVersion: "agenthist.history-snapshot/v2",
    snapshotId: workspace.id,
    agent,
    scannedAt: new Date().toISOString(),
    sessions,
    auxiliaryFiles: [],
    warnings: [],
  };
  await publishSnapshot(stateDirectory, workspace, snapshot);
  return {
    snapshotId: workspace.id,
    indexFile: path.join(stateDirectory, "history", agent, "snapshots", workspace.id, "index.json"),
  };
}

test("desktop history index supports Unicode search, filters, overlay refresh, and stable chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-index-"));
  const stateDirectory = path.join(root, "state with spaces");
  const unicodeWorkspace = "C:\\用户 Name\\项目 空格";
  const first = fixtureSession("codex", 1, {
    workspace: unicodeWorkspace,
    updatedAt: "2026-09-03T03:00:00.000Z",
    title: "Unicode conversation",
    conversation: [
      ...messages("修复中文路径 scan behavior", "已修复，并验证 Unicode。"),
      { kind: "gap", label: "tool output omitted", timestamp: "2026-09-03T03:02:00.000Z", code: "fixture_gap" },
    ],
  });
  const second = fixtureSession("codex", 2, {
    workspace: "C:\\other\\project",
    updatedAt: "2026-09-02T03:00:00.000Z",
  });
  const archived = fixtureSession("claude", 3, {
    workspace: unicodeWorkspace,
    updatedAt: "2026-09-01T03:00:00.000Z",
    archived: true,
  });
  try {
    await publishAgentSnapshot(stateDirectory, "codex", [first, second]);
    await publishAgentSnapshot(stateDirectory, "claude", [archived]);
    const synced = await syncDesktopHistoryIndex(stateDirectory);
    assert.equal(synced.sessions, 3);
    assert.deepEqual(synced.updatedAgents, ["codex", "claude"]);
    assert.deepEqual(synced.issues, []);

    const recent = await listDesktopHistoryIndex({ stateDirectory });
    assert.deepEqual(recent.sessions.map((session) => session.sessionRef), [first.sessionRef, second.sessionRef]);
    assert.equal(recent.sessions[0]!.workspaceName, "项目 空格");
    assert.equal(recent.sessions[0]!.preview, "修复中文路径 scan behavior");

    const unicode = await listDesktopHistoryIndex({
      stateDirectory,
      query: "中文路径",
      agents: ["codex"],
      workspace: unicodeWorkspace,
    });
    assert.equal(unicode.total, 1);
    assert.equal(unicode.sessions[0]!.sessionRef, first.sessionRef);

    for (const literalQuery of ['"', "*", "NEAR(", '路径" OR deleted', "C++"]) {
      await assert.doesNotReject(listDesktopHistoryIndex({ stateDirectory, query: literalQuery }));
    }

    const includingArchived = await listDesktopHistoryIndex({
      stateDirectory,
      workspace: unicodeWorkspace,
      libraryStates: ["active", "archived"],
    });
    assert.deepEqual(
      includingArchived.sessions.map((session) => session.sessionRef),
      [first.sessionRef, archived.sessionRef],
    );

    const chunk = await getDesktopConversationChunk({
      stateDirectory,
      sessionRef: first.sessionRef,
      offset: 1,
      limit: 1,
    });
    assert.equal(chunk.total, 3);
    assert.equal(chunk.returned, 1);
    assert.equal(chunk.items[0]!.ordinal, 1);
    assert.equal(chunk.items[0]!.item.kind, "message");
    assert.equal(chunk.nextOffset, 2);

    const matches = await findInDesktopConversation({
      stateDirectory,
      sessionRef: first.sessionRef,
      query: "Unicode",
    });
    assert.equal(matches.total, 1);
    assert.equal(matches.matches[0]!.ordinal, 1);
    assert.equal(matches.matches[0]!.snippet, "已修复，并验证 Unicode。");

    await saveLibraryOverlay(stateDirectory, [{
      sessionRef: first.sessionRef,
      name: "常用修复会话",
      tags: ["常用", "路径"],
      archived: false,
      deleted: false,
    }]);
    const overlaySync = await syncDesktopHistoryIndex(stateDirectory);
    assert.deepEqual(overlaySync.updatedAgents, []);
    assert.deepEqual(overlaySync.reusedAgents, ["codex", "claude"]);
    const byTag = await listDesktopHistoryIndex({ stateDirectory, query: "常用" });
    assert.equal(byTag.total, 1);
    assert.equal(byTag.sessions[0]!.title, "常用修复会话");
    assert.deepEqual(byTag.sessions[0]!.tags, ["常用", "路径"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental sync skips unchanged snapshot bodies and isolates a damaged Agent snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-incremental-"));
  const stateDirectory = path.join(root, "state");
  const oldCodex = fixtureSession("codex", 10, { title: "Old Codex" });
  const oldClaude = fixtureSession("claude", 20, { title: "Old Claude" });
  try {
    await publishAgentSnapshot(stateDirectory, "codex", [oldCodex]);
    await publishAgentSnapshot(stateDirectory, "claude", [oldClaude]);
    await syncDesktopHistoryIndex(stateDirectory);

    const newCodex = fixtureSession("codex", 11, { title: "New Codex" });
    const corrupt = await publishAgentSnapshot(stateDirectory, "codex", [newCodex]);
    await writeFile(corrupt.indexFile, "{not valid json", "utf8");
    const newClaude = fixtureSession("claude", 21, { title: "New Claude" });
    await publishAgentSnapshot(stateDirectory, "claude", [newClaude]);

    const partial = await syncDesktopHistoryIndex(stateDirectory);
    assert.deepEqual(partial.updatedAgents, ["claude"]);
    assert.equal(partial.issues.length, 1);
    assert.equal(partial.issues[0]!.agent, "codex");
    assert.equal(partial.issues[0]!.code, "snapshot_invalid");
    const afterPartial = await listDesktopHistoryIndex({ stateDirectory, agents: ["codex", "claude"] });
    assert.deepEqual(
      afterPartial.sessions.map((session) => session.title).sort(),
      ["New Claude", "Old Codex"],
    );

    const repairedCodex = fixtureSession("codex", 12, { title: "Repaired Codex" });
    const repaired = await publishAgentSnapshot(stateDirectory, "codex", [repairedCodex]);
    const repairedSync = await syncDesktopHistoryIndex(stateDirectory);
    assert.deepEqual(repairedSync.updatedAgents, ["codex"]);

    // If the head is unchanged, the desktop index must not reopen or parse the full snapshot body.
    await writeFile(repaired.indexFile, "{broken after successful indexing", "utf8");
    const unchanged = await syncDesktopHistoryIndex(stateDirectory);
    assert.ok(unchanged.reusedAgents.includes("codex"));
    assert.equal(unchanged.issues.some((issue) => issue.agent === "codex"), false);
    const preserved = await listDesktopHistoryIndex({ stateDirectory, agents: ["codex"] });
    assert.equal(preserved.sessions[0]!.title, "Repaired Codex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt derived SQLite index is quarantined, rebuilt, and never affects outside files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-rebuild-"));
  const stateDirectory = path.join(root, "state");
  const outside = path.join(root, "native-history-sentinel.txt");
  const session = fixtureSession("pi", 30, { title: "Rebuilt session" });
  try {
    await writeFile(outside, "native history must remain untouched", "utf8");
    await publishAgentSnapshot(stateDirectory, "pi", [session]);
    await syncDesktopHistoryIndex(stateDirectory);
    await writeFile(desktopHistoryIndexPath(stateDirectory), "this is not SQLite", "utf8");

    const rebuilt = await syncDesktopHistoryIndex(stateDirectory);
    assert.equal(rebuilt.rebuilt, true);
    assert.equal(rebuilt.issues.some((issue) => issue.code === "index_rebuilt"), true);
    assert.equal(rebuilt.sessions, 1);
    const listed = await listDesktopHistoryIndex({ stateDirectory, agents: ["pi"] });
    assert.equal(listed.sessions[0]!.title, "Rebuilt session");
    assert.equal(await readFile(outside, "utf8"), "native history must remain untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("10k-session index keeps recent and FTS queries bounded", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-10k-"));
  const stateDirectory = path.join(root, "state");
  const count = 10_000;
  const sessions = Array.from({ length: count }, (_, index) => fixtureSession("opencode", index + 1000, {
    workspace: `C:\\大型 历史\\workspace ${index % 20}`,
    updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    conversation: messages(index === 9_876
      ? "Unicode 性能 uniqueneedle9876"
      : `ordinary indexed conversation ${index}`),
  }));
  try {
    await publishAgentSnapshot(stateDirectory, "opencode", sessions);
    const syncStarted = performance.now();
    const sync = await syncDesktopHistoryIndex(stateDirectory);
    const syncDuration = performance.now() - syncStarted;
    assert.equal(sync.sessions, count);
    assert.ok(syncDuration < 60_000, `10k sync took ${Math.round(syncDuration)}ms`);

    const recentStarted = performance.now();
    const recent = await listDesktopHistoryIndex({
      stateDirectory,
      agents: ["opencode"],
      limit: 50,
    });
    const recentDuration = performance.now() - recentStarted;
    assert.equal(recent.total, count);
    assert.equal(recent.returned, 50);
    assert.equal(recent.sessions[0]!.sessionRef, sessions.at(-1)!.sessionRef);
    assert.ok(recentDuration < 5_000, `10k recent query took ${Math.round(recentDuration)}ms`);

    const searchStarted = performance.now();
    const found = await listDesktopHistoryIndex({
      stateDirectory,
      query: "uniqueneedle9876",
      agents: ["opencode"],
      workspace: "C:\\大型 历史\\workspace 16",
    });
    const searchDuration = performance.now() - searchStarted;
    assert.equal(found.total, 1);
    assert.equal(found.sessions[0]!.sessionRef, sessions[9_876]!.sessionRef);
    assert.ok(searchDuration < 10_000, `10k FTS query took ${Math.round(searchDuration)}ms`);

    const incrementalStarted = performance.now();
    const incremental = await syncDesktopHistoryIndex(stateDirectory);
    const incrementalDuration = performance.now() - incrementalStarted;
    assert.deepEqual(incremental.updatedAgents, []);
    assert.ok(incremental.reusedAgents.includes("opencode"));
    assert.ok(incrementalDuration < 5_000, `unchanged 10k sync took ${Math.round(incrementalDuration)}ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
