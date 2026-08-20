import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { claudeSessionRef } from "../../../src/agents/claude/identity.js";
import { claudeProjectCarrier } from "../../../src/agents/claude/project.js";
import { validateClaudeSubagentBundles } from "../../../src/agents/claude/sidecars/subagent.js";
import {
  executePreparedClaudeTransaction,
  prepareClaudeTransaction,
} from "../../../src/agents/claude/migration/transaction.js";
import { runCli } from "../../../src/cli/program.js";
import { digestFile } from "../../../src/infrastructure/files.js";
import {
  assertNoPendingTransactions,
  loadTransaction,
} from "../../../src/infrastructure/transaction-store.js";
import {
  nativeFixtureJsonl,
  nativeFixturePath,
  replaceFixtureStrings,
} from "../../support/native-path.js";
import { readScanResult } from "../../support/scan-result.js";

const FIRST_SESSION = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION = "22222222-2222-4222-8222-222222222222";
const THIRD_SESSION = "33333333-3333-4333-8333-333333333333";
const INCREMENTAL_SESSION = "44444444-4444-4444-8444-444444444445";
const BRIDGE_SESSION = "session_native_remote_fixture";
const BRIDGE_ACCOUNT = "55555555-5555-4555-8555-555555555555";
const BRIDGE_ORGANIZATION = "66666666-6666-4666-8666-666666666666";
const NATIVE_SESSION_TAG = "native-session-fixture";
const SUPPRESSION_ACCOUNT = "77777777-7777-4777-8777-777777777777";
const SOURCE_WORK = nativeFixturePath("/source/work");
const SOURCE_RELOCATED_WORK = nativeFixturePath("/source/relocated-work");
const SOURCE_WORK_CARRIER = claudeProjectCarrier(SOURCE_WORK);
const SOURCE_RELOCATED_WORK_CARRIER = claudeProjectCarrier(SOURCE_RELOCATED_WORK);

function incrementalClaudeBytes(answer: string): string {
  return nativeFixtureJsonl([
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "Claude incremental session marker" },
      uuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
      timestamp: "2026-08-09T04:00:00.000Z",
      cwd: "/source/work",
      sessionId: INCREMENTAL_SESSION,
      version: "incremental-capability-fixture",
    }),
    JSON.stringify({
      parentUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
      isSidechain: false,
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        model: "gpt-5.4",
        content: [{ type: "text", text: answer }],
      },
      uuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
      timestamp: "2026-08-09T04:00:01.000Z",
      cwd: "/source/work",
      sessionId: INCREMENTAL_SESSION,
      version: "incremental-capability-fixture",
    }),
    "",
  ].join("\n"));
}

async function assertPreconditionFailureIsTerminal(root: string): Promise<void> {
  const configRoot = path.join(root, "precondition-claude");
  const stateDirectory = path.join(root, "precondition-state");
  const nativeId = "44444444-4444-4444-8444-444444444444";
  const firstRootRecordUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const sessionRef = claudeSessionRef(nativeId, firstRootRecordUuid);
  const source = path.join(root, "planned-claude.jsonl");
  const destination = path.join(configRoot, "projects", "-target-work", `${nativeId}.jsonl`);
  await mkdir(configRoot, { recursive: true });
  await writeFile(source, "planned history bytes\n", { mode: 0o600 });
  const image = { ...(await digestFile(source)), mode: 0o600 };
  const journal = await prepareClaudeTransaction({
    stateDirectory,
    configRoot,
    effects: [{ role: "main-transcript", sessionRef, nativeId, destination, filePath: source, mode: 0o600 }],
    resources: [],
    sessions: [{
      sessionRef,
      nativeId,
      firstRootRecordUuid,
      files: [{ role: "main-transcript", destination, image }],
    }],
    importedLibrary: new Map([[
      sessionRef,
      { name: "", tags: [], archived: false, deleted: false },
    ]]),
  });

  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, "external Agent history\n", { mode: 0o600 });
  await assert.rejects(
    executePreparedClaudeTransaction(stateDirectory, journal),
    /Claude Code transaction did not start/,
  );
  assert.equal(await readFile(destination, "utf8"), "external Agent history\n");
  const failed = await loadTransaction(stateDirectory, journal.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.phase, "failed");
  assert.equal(failed.direction, "forward");
  assert.equal(failed.failure, "claude.target_changed_before_apply");
  await assert.doesNotReject(assertNoPendingTransactions(stateDirectory));
}

async function writeClaudeHistory(configRoot: string): Promise<{
  firstBytes: string;
  secondBytes: string;
  subagentBytes: string;
  subagentMetadata: string;
  toolResultBytes: string;
  toolResultPath: string;
  sidecarBytes: string;
  sidecarSubpath: readonly [string, string];
  checkpointBytes: string;
  checkpointName: string;
  checkpointMode: number;
  taskOneBytes: string;
  taskTwoBytes: string;
  taskHighwatermark: string;
}> {
  const project = path.join(configRoot, "projects", SOURCE_WORK_CARRIER);
  const relocatedProject = path.join(configRoot, "projects", SOURCE_RELOCATED_WORK_CARRIER);
  await mkdir(project, { recursive: true });
  await mkdir(relocatedProject, { recursive: true });
  const firstBytes = nativeFixtureJsonl([
    JSON.stringify({
      type: "mode",
      mode: "coordinator",
      sessionId: FIRST_SESSION,
    }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "Claude persisted search marker" },
      uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      timestamp: "2026-08-09T01:00:00.000Z",
      cwd: "/source/work",
      sessionId: FIRST_SESSION,
      version: "future-compatible-build-one",
    }),
    JSON.stringify({
      parentUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      isSidechain: false,
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Claude readable response" }],
      },
      uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      timestamp: "2026-08-09T01:00:01.000Z",
      cwd: "/source/work",
      sessionId: FIRST_SESSION,
      version: "a-different-compatible-build",
    }),
    JSON.stringify({
      type: "last-prompt",
      lastPrompt: "Claude persisted search marker",
      leafUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      sessionId: FIRST_SESSION,
    }),
    "",
  ].join("\n"));
  await writeFile(path.join(project, `${FIRST_SESSION}.jsonl`), firstBytes, { mode: 0o600 });

  const secondBytes = nativeFixtureJsonl([
    JSON.stringify({ type: "custom-title", customTitle: "Claude sidecar conversation", sessionId: SECOND_SESSION }),
    JSON.stringify({
      type: "worktree-state",
      sessionId: SECOND_SESSION,
      worktreeSession: {
        originalCwd: "/source/work",
        worktreePath: "/source/work/.claude/worktrees/native-migration-fixture",
        worktreeName: "native-migration-fixture",
        worktreeBranch: "worktree-native-migration-fixture",
        originalBranch: "main",
        originalHeadCommit: "0123456789abcdef0123456789abcdef01234567",
        sessionId: SECOND_SESSION,
        tmuxSessionName: "source_native_migration_fixture",
        hookBased: false,
        preEnterOriginalCwd: "/source/work",
        enteredExisting: true,
      },
    }),
    JSON.stringify({
      type: "permission-mode",
      permissionMode: "acceptEdits",
      sessionId: SECOND_SESSION,
    }),
    JSON.stringify({
      type: "agent-name",
      agentName: "Native migrated worker",
      sessionId: SECOND_SESSION,
    }),
    JSON.stringify({
      type: "agent-color",
      agentColor: "cyan",
      sessionId: SECOND_SESSION,
    }),
    JSON.stringify({
      type: "agent-setting",
      agentSetting: "project:history-reviewer",
      sessionId: SECOND_SESSION,
    }),
    JSON.stringify({
      type: "mode",
      mode: "normal",
      sessionId: SECOND_SESSION,
    }),
    JSON.stringify({
      type: "isolation-latch",
      side: "web",
      sessionId: SECOND_SESSION,
    }),
    JSON.stringify({
      type: "tag",
      tag: NATIVE_SESSION_TAG,
      sessionId: SECOND_SESSION,
    }),
    JSON.stringify({
      type: "bridge-session",
      sessionId: SECOND_SESSION,
      bridgeSessionId: BRIDGE_SESSION,
      lastSequenceNum: 7,
      declaredDialogKinds: ["human"],
      sessionGroupingId: "sgrp_native_remote_fixture",
      noHistoryBackfill: true,
      ownerAccountUuid: BRIDGE_ACCOUNT,
      ownerOrganizationUuid: BRIDGE_ORGANIZATION,
    }),
    JSON.stringify({
      type: "history-suppression",
      sessionId: SECOND_SESSION,
      cause: "restored_owner_mismatch",
      vetoedAgainstAccountUuid: SUPPRESSION_ACCOUNT,
      ts: "2026-08-09T01:59:59.000Z",
    }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "second Claude prompt" }] },
      uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      timestamp: "2026-08-09T02:00:00.000Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      type: "file-history-snapshot",
      messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      snapshot: {
        messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
        trackedFileBackups: {},
        timestamp: "2026-08-09T02:00:00.100Z",
      },
      isSnapshotUpdate: false,
    }),
    JSON.stringify({
      parentUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      isSidechain: false,
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        model: "gpt-5.4",
        content: [{
          type: "tool_use",
          id: "toolu_checkpoint_fixture",
          name: "Write",
          input: { file_path: "/source/work/checkpoint-target.txt", content: "updated\n" },
        }],
      },
      uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      timestamp: "2026-08-09T02:00:01.000Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      type: "file-history-delta",
      messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      snapshotMessageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      trackingPath: "checkpoint-target.txt",
      backup: {
        backupFileName: "fixture-backup@v1",
        version: 1,
        backupTime: "2026-08-09T02:00:01.100Z",
        realParentDir: "/source/work",
      },
      timestamp: "2026-08-09T02:00:01.100Z",
    }),
    JSON.stringify({
      parentUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      isSidechain: false,
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_checkpoint_fixture",
          content: "checkpoint target updated",
          is_error: false,
        }],
      },
      uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
      timestamp: "2026-08-09T02:00:01.200Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      parentUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
      isSidechain: false,
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        model: "gpt-5.4",
        content: [{
          type: "tool_use",
          id: "toolu_subagent_fixture",
          name: "Agent",
          input: { description: "fixture", prompt: "read the marker" },
        }],
      },
      uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
      timestamp: "2026-08-09T02:00:01.300Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      parentUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
      isSidechain: false,
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_subagent_fixture",
          content: "subagent fixture completed",
          is_error: false,
        }],
      },
      uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5",
      timestamp: "2026-08-09T02:00:01.400Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      parentUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5",
      isSidechain: false,
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Claude response before compaction" }],
      },
      uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6",
      timestamp: "2026-08-09T02:00:01.500Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      parentUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6",
      isSidechain: false,
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      isMeta: false,
      level: "info",
      logicalParentUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6",
      compactMetadata: {
        trigger: "manual",
        preTokens: 4096,
        userContext: "",
        messagesSummarized: 6,
      },
      uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7",
      timestamp: "2026-08-09T02:00:01.600Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      parentUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7",
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "Claude compact summary marker" },
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8",
      timestamp: "2026-08-09T02:00:01.700Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      parentUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8",
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "Claude prompt after compaction" },
      uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9",
      timestamp: "2026-08-09T02:00:01.800Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      parentUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9",
      isSidechain: false,
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Claude response after compaction" }],
      },
      uuid: "bbbbbbbb-bbbb-4bbb-8bbb-1234567890ab",
      timestamp: "2026-08-09T02:00:01.900Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      type: "relocated",
      relocatedCwd: "/source/relocated-work",
      sessionId: SECOND_SESSION,
    }),
    "",
  ].join("\n"));
  await writeFile(path.join(relocatedProject, `${SECOND_SESSION}.jsonl`), secondBytes, { mode: 0o600 });
  const subagents = path.join(relocatedProject, SECOND_SESSION, "subagents");
  const toolResults = path.join(relocatedProject, SECOND_SESSION, "tool-results");
  const toolResultPath = path.join(toolResults, "fixture-output.txt");
  await mkdir(subagents, { recursive: true });
  const subagentBytes = nativeFixtureJsonl([
    JSON.stringify({
      parentUuid: null,
      isSidechain: true,
      type: "user",
      message: { role: "user", content: "subagent raw search marker" },
      uuid: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      timestamp: "2026-08-09T02:00:01.100Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      agentId: "fixture",
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      parentUuid: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      isSidechain: true,
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        model: "gpt-5.4",
        content: [{
          type: "tool_use",
          id: "call_fixture_output",
          name: "Bash",
          input: { command: "fixture-output" },
        }],
      },
      uuid: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
      timestamp: "2026-08-09T02:00:01.200Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      agentId: "fixture",
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      parentUuid: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
      isSidechain: true,
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_fixture_output",
          content: "retained Claude output marker\nfull persisted output\n",
          is_error: false,
        }],
      },
      uuid: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
      timestamp: "2026-08-09T02:00:01.300Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      agentId: "fixture",
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      type: "content-replacement",
      sessionId: SECOND_SESSION,
      agentId: "fixture",
      replacements: [{
        kind: "tool-result",
        toolUseId: "call_fixture_output",
        replacement: [
          "<persisted-output>",
          `Output too large (58.6KB). Full output saved to: ${toolResultPath}`,
          "",
          "Preview (first 2KB):",
          "retained Claude output preview",
          "...",
          "</persisted-output>",
        ].join("\n"),
      }],
    }),
    JSON.stringify({
      parentUuid: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
      isSidechain: true,
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        model: "gpt-5.4",
        content: [{ type: "text", text: "subagent fixture response" }],
      },
      uuid: "cccccccc-cccc-4ccc-8ccc-ccccccccccc4",
      timestamp: "2026-08-09T02:00:01.400Z",
      cwd: "/source/work",
      sessionId: SECOND_SESSION,
      agentId: "fixture",
      version: "no-version-allowlist",
    }),
    "",
  ].join("\n"));
  const subagentMetadata = `${JSON.stringify({
    agentType: "general-purpose",
    description: "native metadata only marker",
    spawnDepth: 1,
    toolUseId: "toolu_subagent_fixture",
  }, null, 2)}\n`;
  await writeFile(path.join(subagents, "agent-fixture.jsonl"), subagentBytes, { mode: 0o600 });
  await writeFile(path.join(subagents, "agent-fixture.meta.json"), subagentMetadata, { mode: 0o600 });
  const toolResultBytes = "retained Claude output marker\nfull persisted output\n";
  await mkdir(toolResults, { recursive: true });
  await writeFile(toolResultPath, toolResultBytes, { mode: 0o600 });
  const sidecarSubpath = ["runtime", "opaque-state.jsonl"] as const;
  const sidecarBytes = '{"opaque":"session-owned native state"}\n';
  const sidecarPath = path.join(relocatedProject, SECOND_SESSION, ...sidecarSubpath);
  await mkdir(path.dirname(sidecarPath), { recursive: true });
  await writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
  const checkpointName = "fixture-backup@v1";
  const checkpointBytes = "checkpoint bytes before the edit\n";
  const checkpointMode = 0o640;
  const checkpointPath = path.join(configRoot, "file-history", SECOND_SESSION, checkpointName);
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeFile(checkpointPath, checkpointBytes, { mode: checkpointMode });
  await chmod(checkpointPath, checkpointMode);
  const taskDirectory = path.join(configRoot, "tasks", SECOND_SESSION);
  const taskOneBytes = JSON.stringify({
    id: "1",
    subject: "Claude task native search marker",
    description: "Preserve the selected session task list",
    activeForm: "Preserving the selected session task list",
    status: "in_progress",
    blocks: ["2"],
    blockedBy: [],
    metadata: { source: "fixture" },
  }, null, 2);
  const taskTwoBytes = JSON.stringify({
    id: "2",
    subject: "Verify migrated task state",
    description: "Read the task list after native resume",
    status: "pending",
    blocks: [],
    blockedBy: ["1"],
  }, null, 2);
  const taskHighwatermark = "5";
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(path.join(taskDirectory, "1.json"), taskOneBytes, { mode: 0o600 });
  await writeFile(path.join(taskDirectory, "2.json"), taskTwoBytes, { mode: 0o600 });
  await writeFile(path.join(taskDirectory, ".highwatermark"), taskHighwatermark, { mode: 0o600 });
  await writeFile(path.join(taskDirectory, ".lock"), "", { mode: 0o600 });

  const thirdBytes = nativeFixtureJsonl([
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "third Claude prompt" },
      uuid: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      timestamp: "2026-08-09T03:00:00.000Z",
      cwd: "/source/work",
      sessionId: THIRD_SESSION,
      version: "no-version-allowlist",
    }),
    JSON.stringify({
      parentUuid: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      isSidechain: false,
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        model: "gpt-5.4",
        content: [{ type: "text", text: "third Claude response" }],
      },
      uuid: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
      timestamp: "2026-08-09T03:00:01.000Z",
      cwd: "/source/work",
      sessionId: THIRD_SESSION,
      version: "no-version-allowlist",
    }),
    "",
  ].join("\n"));
  await writeFile(path.join(project, `${THIRD_SESSION}.jsonl`), thirdBytes, { mode: 0o600 });
  const invalidTaskDirectory = path.join(configRoot, "tasks", THIRD_SESSION);
  await mkdir(invalidTaskDirectory, { recursive: true });
  await writeFile(path.join(invalidTaskDirectory, "1.json"), JSON.stringify({
    id: "2",
    subject: "invalid task",
    description: "filename and task ID disagree",
    status: "pending",
    blocks: [],
    blockedBy: [],
  }), { mode: 0o600 });

  await writeFile(path.join(configRoot, "history.jsonl"), "global prompt history\n", { mode: 0o600 });
  await writeFile(path.join(configRoot, ".credentials.json"), "CREDENTIAL_MUST_NOT_BE_CAPTURED\n", { mode: 0o600 });
  await writeFile(path.join(configRoot, "settings.json"), "SETTINGS_MUST_NOT_BE_CAPTURED\n", { mode: 0o600 });
  const memory = path.join(project, "memory");
  await mkdir(memory, { recursive: true });
  await writeFile(path.join(memory, "MEMORY.md"), "MEMORY_MUST_NOT_BE_CAPTURED\n", { mode: 0o600 });
  return {
    firstBytes,
    secondBytes,
    subagentBytes,
    subagentMetadata,
    toolResultBytes,
    toolResultPath,
    sidecarBytes,
    sidecarSubpath,
    checkpointBytes,
    checkpointName,
    checkpointMode,
    taskOneBytes,
    taskTwoBytes,
    taskHighwatermark,
  };
}

async function assertUnknownSubagentMetadataIsRejected(configRoot: string): Promise<void> {
  const projectCarrier = SOURCE_RELOCATED_WORK_CARRIER;
  const project = path.join(configRoot, "projects", projectCarrier);
  const subagents = path.join(project, SECOND_SESSION, "subagents");
  const metadataPath = path.join(subagents, "agent-fixture.meta.json");
  const original = await readFile(metadataPath, "utf8");
  const metadata = JSON.parse(original) as Record<string, unknown>;
  await writeFile(metadataPath, `${JSON.stringify({ ...metadata, futureField: true })}\n`, { mode: 0o600 });
  try {
    await assert.rejects(validateClaudeSubagentBundles({
      mainTranscriptPath: path.join(project, `${SECOND_SESSION}.jsonl`),
      sessionId: SECOND_SESSION,
      projectCarrier,
      allowedCwds: [SOURCE_WORK],
      files: [
        {
          relativePath: `projects/${projectCarrier}/${SECOND_SESSION}/subagents/agent-fixture.jsonl`,
          role: "subagent-transcript",
          filePath: path.join(subagents, "agent-fixture.jsonl"),
        },
        {
          relativePath: `projects/${projectCarrier}/${SECOND_SESSION}/subagents/agent-fixture.meta.json`,
          role: "subagent-metadata",
          filePath: metadataPath,
        },
      ],
    }), /metadata is incomplete/);
  } finally {
    await writeFile(metadataPath, original, { mode: 0o600 });
  }
}

test("Claude readable history migrates validated native closures and opaque session sidecars", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-ts-claude-"));
  const configRoot = path.join(root, "claude-config");
  const state = path.join(root, "state");
  try {
    await assertPreconditionFailureIsTerminal(root);
    await mkdir(configRoot, { recursive: true });
    const fixture = await writeClaudeHistory(configRoot);
    await assertUnknownSubagentMetadataIsRejected(configRoot);
    const runtime = { environment: { HOME: root }, cwd: root, home: root };
    const scanned = await runCli([
      "--json", "--state-dir", state, "--claude-config-dir", configRoot,
      "scan", "--agent", "claude",
    ], runtime);
    assert.equal(scanned.exitCode, 0, scanned.stderr);
    const scanData = readScanResult(scanned.stdout, "claude");
    assert.equal(scanData.sessions, 3);
    assert.equal(scanData.agent.reusedSessions, 0);
    assert.equal(scanData.agent.rebuiltSessions, 3);
    assert.equal(scanData.agent.removedSessions, 0);
    assert.equal(
      scanData.warnings.some((warning) => warning.includes("subagent_bundle_unverified")),
      false,
      scanData.warnings.join("\n"),
    );
    assert.equal(
      scanData.warnings.some((warning) => warning.includes("checkpoint_closure_unverified")),
      false,
      scanData.warnings.join("\n"),
    );
    assert.equal(scanData.warnings.some((warning) => warning.includes("task_list_unverified")), true);

    const rescanned = await runCli([
      "--json", "--state-dir", state, "--claude-config-dir", configRoot,
      "scan", "--agent", "claude",
    ], runtime);
    assert.equal(rescanned.exitCode, 0, rescanned.stderr);
    const rescanAgent = readScanResult(rescanned.stdout, "claude").agent;
    assert.equal(rescanAgent.reusedSessions, 3);
    assert.equal(rescanAgent.rebuiltSessions, 0);
    assert.equal(rescanAgent.removedSessions, 0);

    const incrementalPath = path.join(
      configRoot,
      "projects",
      SOURCE_WORK_CARRIER,
      `${INCREMENTAL_SESSION}.jsonl`,
    );
    await writeFile(incrementalPath, incrementalClaudeBytes("Claude incremental initial answer"), { mode: 0o600 });
    const addedScan = await runCli([
      "--json", "--state-dir", state, "--claude-config-dir", configRoot,
      "scan", "--agent", "claude",
    ], runtime);
    assert.equal(addedScan.exitCode, 0, addedScan.stderr);
    const addedMetrics = readScanResult(addedScan.stdout, "claude").agent;
    assert.deepEqual(
      [addedMetrics.reusedSessions, addedMetrics.rebuiltSessions, addedMetrics.removedSessions],
      [3, 1, 0],
    );

    await writeFile(
      incrementalPath,
      incrementalClaudeBytes("Claude incremental updated answer with changed content"),
      { mode: 0o600 },
    );
    const changedScan = await runCli([
      "--json", "--state-dir", state, "--claude-config-dir", configRoot,
      "scan", "--agent", "claude",
    ], runtime);
    assert.equal(changedScan.exitCode, 0, changedScan.stderr);
    const changedMetrics = readScanResult(changedScan.stdout, "claude").agent;
    assert.deepEqual(
      [changedMetrics.reusedSessions, changedMetrics.rebuiltSessions, changedMetrics.removedSessions],
      [3, 1, 0],
    );
    const changedSearch = await runCli([
      "--json", "--state-dir", state, "history", "search", "Claude incremental updated answer",
    ], runtime);
    assert.equal(changedSearch.exitCode, 0, changedSearch.stderr);
    assert.equal((JSON.parse(changedSearch.stdout) as { data: { total_hits: number } }).data.total_hits, 1);

    await rm(incrementalPath);
    const removedScan = await runCli([
      "--json", "--state-dir", state, "--claude-config-dir", configRoot,
      "scan", "--agent", "claude",
    ], runtime);
    assert.equal(removedScan.exitCode, 0, removedScan.stderr);
    const removedMetrics = readScanResult(removedScan.stdout, "claude").agent;
    assert.deepEqual(
      [removedMetrics.reusedSessions, removedMetrics.rebuiltSessions, removedMetrics.removedSessions],
      [3, 0, 1],
    );
    const removedSearch = await runCli([
      "--json", "--state-dir", state, "history", "search", "Claude incremental updated answer",
    ], runtime);
    assert.equal(removedSearch.exitCode, 0, removedSearch.stderr);
    assert.equal((JSON.parse(removedSearch.stdout) as { data: { total_hits: number } }).data.total_hits, 0);

    const head = JSON.parse(await readFile(path.join(state, "history", "claude", "head.json"), "utf8")) as {
      snapshotId: string;
    };
    const rawRoot = path.join(state, "history", "claude", "snapshots", head.snapshotId, "raw", "claude");
    assert.equal(
      await readFile(path.join(rawRoot, "projects", SOURCE_WORK_CARRIER, `${FIRST_SESSION}.jsonl`), "utf8"),
      fixture.firstBytes,
    );
    assert.equal(await readFile(path.join(rawRoot, "tasks", SECOND_SESSION, "1.json"), "utf8"), fixture.taskOneBytes);
    assert.equal(
      await readFile(path.join(rawRoot, "tasks", SECOND_SESSION, ".highwatermark"), "utf8"),
      fixture.taskHighwatermark,
    );
    assert.equal(
      await readFile(path.join(rawRoot, "projects", SOURCE_RELOCATED_WORK_CARRIER, `${SECOND_SESSION}.jsonl`), "utf8"),
      fixture.secondBytes,
    );
    assert.equal(
      await readFile(path.join(
        rawRoot,
        "projects",
        SOURCE_RELOCATED_WORK_CARRIER,
        SECOND_SESSION,
        ...fixture.sidecarSubpath,
      ), "utf8"),
      fixture.sidecarBytes,
    );
    await assert.rejects(readFile(path.join(rawRoot, ".credentials.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(rawRoot, "settings.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(rawRoot, "projects", SOURCE_WORK_CARRIER, "memory", "MEMORY.md")), { code: "ENOENT" });

    await rm(configRoot, { recursive: true });
    const listed = await runCli([
      "--json", "--state-dir", state, "history", "list", "--agent", "claude", "--view", "all",
    ], runtime);
    assert.equal(listed.exitCode, 0, listed.stderr);
    const sessions = (JSON.parse(listed.stdout) as {
      data: { sessions: Array<{ session_ref: string; title: string; model: string; tags: string[] }> };
    }).data.sessions;
    assert.equal(sessions.length, 3);
    assert.equal(sessions.some((session) => session.title === "Claude sidecar conversation"), true);
    assert.equal(sessions.every((session) => session.model === "gpt-5.4"), true);
    assert.equal(sessions.every((session) => session.tags.length === 0), true);

    const firstReference = claudeSessionRef(FIRST_SESSION, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
    assert.equal(sessions.some((session) => session.session_ref === firstReference), true);
    const coordinatorExport = await runCli([
      "--json", "--state-dir", state, "export", "--session", firstReference,
      "-o", path.join(root, "coordinator.agenthist"),
    ], runtime);
    assert.equal(coordinatorExport.exitCode, 3);
    assert.match((JSON.parse(coordinatorExport.stdout) as { error: { message: string } }).error.message,
      /coordinator session cannot be exported without team runtime state/);
    assert.equal(
      claudeSessionRef(
        "abcdef01-2345-4abc-8def-0123456789ab",
        "fedcba98-7654-4321-8abc-ba9876543210",
      ),
      "ahsr1_claude_ck1_9ce17916d182ed9b86714ee1d2e77afc41d7cbe465028f8c6ae1eaa4acaa8ad2",
    );

    const searched = await runCli([
      "--json", "--state-dir", state, "history", "search", "subagent raw search marker",
      "--agent", "claude", "--view", "all",
    ], runtime);
    assert.equal(searched.exitCode, 0, searched.stderr);
    assert.equal((JSON.parse(searched.stdout) as { data: { total_hits: number } }).data.total_hits, 1);
    const taskSearched = await runCli([
      "--json", "--state-dir", state, "history", "search", "task native search marker",
      "--agent", "claude", "--view", "all",
    ], runtime);
    assert.equal(taskSearched.exitCode, 0, taskSearched.stderr);
    assert.equal((JSON.parse(taskSearched.stdout) as { data: { total_hits: number } }).data.total_hits, 1);
    const metadataOnly = await runCli([
      "--json", "--state-dir", state, "history", "search", "native metadata only marker",
      "--agent", "claude", "--view", "all",
    ], runtime);
    assert.equal(metadataOnly.exitCode, 0, metadataOnly.stderr);
    assert.equal((JSON.parse(metadataOnly.stdout) as { data: { total_hits: number } }).data.total_hits, 0);

    const shown = await runCli(["--json", "--state-dir", state, "history", "show", firstReference], runtime);
    assert.equal(shown.exitCode, 0, shown.stderr);
    const conversation = (JSON.parse(shown.stdout) as {
      data: { conversation: Array<{ kind: string; role?: string; text?: string }> };
    }).data.conversation;
    assert.deepEqual(
      conversation.filter((item) => item.kind === "message").map((item) => [item.role, item.text]),
      [["user", "Claude persisted search marker"], ["assistant", "Claude readable response"]],
    );

    const migratedReference = claudeSessionRef(SECOND_SESSION, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1");
    const migratedShown = await runCli([
      "--json", "--state-dir", state, "history", "show", migratedReference,
    ], runtime);
    assert.equal(migratedShown.exitCode, 0, migratedShown.stderr);
    const migratedConversation = (JSON.parse(migratedShown.stdout) as {
      data: { conversation: Array<{ kind: string; role?: string; text?: string; contentKinds?: string[] }> };
    }).data.conversation;
    assert.equal(migratedConversation.some((item) =>
      item.kind === "message" && item.role === "system" && item.text === "Claude compact summary marker" &&
      item.contentKinds?.length === 1 && item.contentKinds[0] === "compact_summary"), true);
    assert.equal(migratedConversation.some((item) =>
      item.role === "user" && item.text === "Claude compact summary marker"), false);
    const archive = path.join(root, "claude-selected.agenthist");
    const exported = await runCli([
      "--json", "--state-dir", state, "export", "--session", migratedReference, "-o", archive,
    ], runtime);
    assert.equal(exported.exitCode, 0, exported.stderr);
    const exportedData = (JSON.parse(exported.stdout) as { data: { entries: number; objects: number } }).data;
    assert.equal(exportedData.entries, 1);
    assert.equal(exportedData.objects, 9);
    const inspected = await runCli(["--json", "inspect", archive], runtime);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    const inspectedEntries = (JSON.parse(inspected.stdout) as {
      data: { entries: Array<{ agent: string; session_ref: string }> };
    }).data.entries;
    assert.deepEqual(inspectedEntries.map((entry) => [entry.agent, entry.session_ref]), [["claude", migratedReference]]);

    const blockedReference = claudeSessionRef(THIRD_SESSION, "dddddddd-dddd-4ddd-8ddd-ddddddddddd1");
    const blocked = await runCli([
      "--json", "--state-dir", state, "export", "--session", blockedReference,
      "-o", path.join(root, "blocked.agenthist"),
    ], runtime);
    assert.equal(blocked.exitCode, 3);
    assert.equal(blocked.stderr, "");
    assert.match((JSON.parse(blocked.stdout) as { error: { message: string } }).error.message,
      /cannot be exported without losing native history/);

    const mixedArchive = path.join(root, "claude-mixed.agenthist");
    const mixedExport = await runCli([
      "--json", "--state-dir", state, "export", "--agent", "claude", "-o", mixedArchive,
    ], runtime);
    assert.equal(mixedExport.exitCode, 0, mixedExport.stderr);
    const mixedData = (JSON.parse(mixedExport.stdout) as {
      data: {
        entries: number;
        skipped_sessions: Array<{ session_ref: string; reason: string }>;
      };
    }).data;
    assert.equal(mixedData.entries, 1);
    assert.deepEqual(
      mixedData.skipped_sessions.map((session) => session.session_ref).sort(),
      [firstReference, blockedReference].sort(),
    );
    assert.match(
      mixedData.skipped_sessions.find((session) => session.session_ref === firstReference)!.reason,
      /coordinator session/,
    );
    assert.match(
      mixedData.skipped_sessions.find((session) => session.session_ref === blockedReference)!.reason,
      /cannot be exported without losing native history/,
    );
    const mixedInspect = await runCli(["--json", "inspect", mixedArchive], runtime);
    assert.equal(mixedInspect.exitCode, 0, mixedInspect.stderr);
    assert.deepEqual((JSON.parse(mixedInspect.stdout) as {
      data: { entries: Array<{ session_ref: string }> };
    }).data.entries.map((entry) => entry.session_ref), [migratedReference]);

    const targetConfig = path.join(root, "target-claude");
    const targetWork = path.join(root, "target-work");
    const targetHistoricalWork = path.join(root, "target-historical-work");
    const targetState = path.join(root, "target-state");
    await mkdir(targetConfig, { recursive: true });
    await mkdir(targetWork, { recursive: true });
    await mkdir(targetHistoricalWork, { recursive: true });
    const importArguments = [
      "--json", "--state-dir", targetState,
      "import", archive,
      "--target", `claude=${targetConfig}`,
      "--map-path", `${SOURCE_RELOCATED_WORK}=${targetWork}`,
      "--map-path", `${SOURCE_WORK}=${targetHistoricalWork}`,
    ];
    const dryRun = await runCli([...importArguments, "--dry-run"], runtime);
    assert.equal(dryRun.exitCode, 0, dryRun.stderr);
    const dryRunData = (JSON.parse(dryRun.stdout) as {
      data: { new_sessions: number; written: number };
    }).data;
    assert.equal(dryRunData.new_sessions, 1);
    assert.equal(dryRunData.written, 0);

    const imported = await runCli([...importArguments, "--apply"], runtime);
    assert.equal(imported.exitCode, 0, imported.stderr);
    const importedData = (JSON.parse(imported.stdout) as {
      data: {
        written: number;
        already_present: number;
        agents: Array<{ transaction_ref?: string }>;
        items: Array<{ destination: string }>;
      };
    }).data;
    assert.equal(importedData.written, 1);
    assert.equal(importedData.already_present, 0);
    const importedReference = importedData.agents[0]!.transaction_ref!;
    assert.match(importedReference, /^ahtx1_/);
    const destination = importedData.items[0]!.destination;
    const targetBytes = await readFile(destination, "utf8");
    const projectedSourceBytes = fixture.secondBytes.split("\n").map((line) => {
      if (line === "") return line;
      const value = JSON.parse(line) as Record<string, unknown>;
      const projected = value.type === "worktree-state"
        ? { ...value, worktreeSession: null }
        : value.type === "bridge-session"
          ? {
            type: "bridge-session",
            sessionId: SECOND_SESSION,
            bridgeSessionId: "",
            lastSequenceNum: 0,
          }
          : value;
      return JSON.stringify(replaceFixtureStrings(projected, [
        [SOURCE_RELOCATED_WORK, targetWork],
        [SOURCE_WORK, targetHistoricalWork],
      ]));
    }).join("\n");
    assert.equal(
      targetBytes,
      projectedSourceBytes,
    );
    const targetWorktreeStates = targetBytes.split("\n").filter((line) => line !== "").map((line) =>
      JSON.parse(line) as Record<string, unknown>).filter((value) => value.type === "worktree-state");
    assert.deepEqual(targetWorktreeStates.map((value) => value.worktreeSession), [null]);
    const targetBridgeSessions = targetBytes.split("\n").filter((line) => line !== "").map((line) =>
      JSON.parse(line) as Record<string, unknown>).filter((value) => value.type === "bridge-session");
    assert.deepEqual(targetBridgeSessions, [{
      type: "bridge-session",
      sessionId: SECOND_SESSION,
      bridgeSessionId: "",
      lastSequenceNum: 0,
    }]);
    assert.equal(targetBytes.includes(BRIDGE_SESSION), false);
    assert.equal(targetBytes.includes(BRIDGE_ACCOUNT), false);
    assert.equal(targetBytes.includes(BRIDGE_ORGANIZATION), false);
    const targetPermissionModes = targetBytes.split("\n").filter((line) => line !== "").map((line) =>
      JSON.parse(line) as Record<string, unknown>).filter((value) => value.type === "permission-mode");
    assert.deepEqual(targetPermissionModes, [{
      type: "permission-mode",
      permissionMode: "acceptEdits",
      sessionId: SECOND_SESSION,
    }]);
    assert.equal(targetBytes.includes(`"tag":"${NATIVE_SESSION_TAG}"`), true);
    assert.equal(targetBytes.includes(`"vetoedAgainstAccountUuid":"${SUPPRESSION_ACCOUNT}"`), true);
    assert.equal(targetBytes.includes("native-migration-fixture"), false);
    assert.equal(targetBytes.includes(`"realParentDir":${JSON.stringify(targetHistoricalWork)}`), true);
    assert.equal(targetBytes.includes(`"realParentDir":${JSON.stringify(SOURCE_WORK)}`), false);
    assert.equal(targetBytes.includes(`"relocatedCwd":${JSON.stringify(targetWork)}`), true);
    assert.equal(targetBytes.includes(`"relocatedCwd":${JSON.stringify(SOURCE_RELOCATED_WORK)}`), false);
    const targetSubagents = path.join(path.dirname(destination), SECOND_SESSION, "subagents");
    const targetSubagentTranscript = path.join(targetSubagents, "agent-fixture.jsonl");
    const targetSubagentMetadata = path.join(targetSubagents, "agent-fixture.meta.json");
    const targetToolResult = path.join(path.dirname(destination), SECOND_SESSION, "tool-results", "fixture-output.txt");
    const targetCheckpoint = path.join(targetConfig, "file-history", SECOND_SESSION, fixture.checkpointName);
    const targetTaskDirectory = path.join(targetConfig, "tasks", SECOND_SESSION);
    const targetTaskOne = path.join(targetTaskDirectory, "1.json");
    const targetTaskTwo = path.join(targetTaskDirectory, "2.json");
    const targetTaskHighwatermark = path.join(targetTaskDirectory, ".highwatermark");
    const targetSidecar = path.join(path.dirname(destination), SECOND_SESSION, ...fixture.sidecarSubpath);
    const targetSubagentBytes = fixture.subagentBytes.split("\n").map((line) => line === ""
      ? ""
      : JSON.stringify(replaceFixtureStrings(JSON.parse(line), [
        [SOURCE_WORK, targetHistoricalWork],
        [fixture.toolResultPath, targetToolResult],
      ]))).join("\n");
    assert.equal(
      await readFile(targetSubagentTranscript, "utf8"),
      targetSubagentBytes,
    );
    assert.equal(await readFile(targetSubagentMetadata, "utf8"), fixture.subagentMetadata);
    assert.equal(await readFile(targetToolResult, "utf8"), fixture.toolResultBytes);
    assert.equal(await readFile(targetCheckpoint, "utf8"), fixture.checkpointBytes);
    if (process.platform !== "win32") {
      assert.equal((await stat(targetCheckpoint)).mode & 0o777, fixture.checkpointMode);
    }
    assert.equal(await readFile(targetTaskOne, "utf8"), fixture.taskOneBytes);
    assert.equal(await readFile(targetTaskTwo, "utf8"), fixture.taskTwoBytes);
    assert.equal(await readFile(targetTaskHighwatermark, "utf8"), fixture.taskHighwatermark);
    assert.equal(await readFile(targetSidecar, "utf8"), fixture.sidecarBytes);
    await assert.rejects(readFile(path.join(targetTaskDirectory, ".lock")), { code: "ENOENT" });

    const repeated = await runCli([...importArguments, "--apply"], runtime);
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    const repeatedData = (JSON.parse(repeated.stdout) as {
      data: { written: number; already_present: number; agents: Array<{ transaction_ref?: string }> };
    }).data;
    assert.equal(repeatedData.written, 0);
    assert.equal(repeatedData.already_present, 1);
    assert.equal(repeatedData.agents[0]!.transaction_ref, undefined);

    const rollback = await runCli([
      "--json", "--state-dir", targetState,
      "transaction", "rollback", importedReference, "--apply",
    ], runtime);
    assert.equal(rollback.exitCode, 0, rollback.stderr);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
    await assert.rejects(readFile(targetSubagentTranscript), { code: "ENOENT" });
    await assert.rejects(readFile(targetSubagentMetadata), { code: "ENOENT" });
    await assert.rejects(readFile(targetToolResult), { code: "ENOENT" });
    await assert.rejects(readFile(targetCheckpoint), { code: "ENOENT" });
    await assert.rejects(readFile(targetTaskOne), { code: "ENOENT" });
    await assert.rejects(readFile(targetTaskTwo), { code: "ENOENT" });
    await assert.rejects(readFile(targetTaskHighwatermark), { code: "ENOENT" });
    await assert.rejects(readFile(targetSidecar), { code: "ENOENT" });

    const reimported = await runCli([...importArguments, "--apply"], runtime);
    assert.equal(reimported.exitCode, 0, reimported.stderr);
    const reimportedReference = (JSON.parse(reimported.stdout) as {
      data: { agents: Array<{ transaction_ref?: string }> };
    }).data.agents[0]!.transaction_ref!;
    const transactionId = reimportedReference.slice("ahtx1_".length);
    const journalPath = path.join(targetState, "transactions", transactionId, "journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    journal.state = "needs_recovery";
    journal.phase = "needs_recovery";
    journal.failure = "claude.commit_response_lost";
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    const recovered = await runCli([
      "--json", "--state-dir", targetState,
      "transaction", "recover", reimportedReference, "--apply",
    ], runtime);
    assert.equal(recovered.exitCode, 0, recovered.stderr);
    const finalRollback = await runCli([
      "--json", "--state-dir", targetState,
      "transaction", "rollback", reimportedReference, "--apply",
    ], runtime);
    assert.equal(finalRollback.exitCode, 0, finalRollback.stderr);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
    await assert.rejects(readFile(targetSubagentTranscript), { code: "ENOENT" });
    await assert.rejects(readFile(targetSubagentMetadata), { code: "ENOENT" });
    await assert.rejects(readFile(targetToolResult), { code: "ENOENT" });
    await assert.rejects(readFile(targetCheckpoint), { code: "ENOENT" });
    await assert.rejects(readFile(targetTaskOne), { code: "ENOENT" });
    await assert.rejects(readFile(targetTaskTwo), { code: "ENOENT" });
    await assert.rejects(readFile(targetTaskHighwatermark), { code: "ENOENT" });
    await assert.rejects(readFile(targetSidecar), { code: "ENOENT" });

    await mkdir(targetSubagents, { recursive: true });
    await writeFile(destination, targetBytes, { mode: 0o600 });
    await writeFile(targetSubagentTranscript, targetSubagentBytes, { mode: 0o600 });
    const repaired = await runCli([...importArguments, "--apply"], runtime);
    assert.equal(repaired.exitCode, 0, repaired.stderr);
    const repairData = (JSON.parse(repaired.stdout) as {
      data: { written: number; agents: Array<{ transaction_ref?: string }> };
    }).data;
    assert.equal(repairData.written, 1);
    const repairRollback = await runCli([
      "--json", "--state-dir", targetState,
      "transaction", "rollback", repairData.agents[0]!.transaction_ref!, "--apply",
    ], runtime);
    assert.equal(repairRollback.exitCode, 0, repairRollback.stderr);
    assert.equal(await readFile(destination, "utf8"), targetBytes);
    assert.equal(await readFile(targetSubagentTranscript, "utf8"), targetSubagentBytes);
    await assert.rejects(readFile(targetSubagentMetadata), { code: "ENOENT" });
    await assert.rejects(readFile(targetToolResult), { code: "ENOENT" });
    await assert.rejects(readFile(targetCheckpoint), { code: "ENOENT" });
    await assert.rejects(readFile(targetTaskOne), { code: "ENOENT" });
    await assert.rejects(readFile(targetTaskTwo), { code: "ENOENT" });
    await assert.rejects(readFile(targetTaskHighwatermark), { code: "ENOENT" });
    await assert.rejects(readFile(targetSidecar), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
