import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { codexSessionRef } from "../../../src/agents/codex/identity.js";
import { claudeSessionRef } from "../../../src/agents/claude/identity.js";
import { openCodeSessionRef } from "../../../src/agents/opencode/identity.js";
import { piSessionRef } from "../../../src/agents/pi/identity.js";
import { dryRunExperienceReview } from "../../../src/application/index.js";
import {
  buildSessionExperienceIndex,
  planExperienceBudget,
  resolveExperienceLineages,
  splitExperienceText,
  type DiscoveryCard,
} from "../../../src/experience/corpus.js";
import { sourceRevision } from "../../../src/domain/history-identity.js";
import type {
  AgentSnapshot,
  ConversationItem,
  JsonValue,
  LibraryMetadata,
  StoredSession,
} from "../../../src/domain/history.js";
import { createSnapshotWorkspace, publishSnapshot } from "../../../src/infrastructure/history-store.js";
import { runCli } from "../../../src/cli/program.js";
import { nativeFixturePath } from "../../support/native-path.js";

const ACTIVE: LibraryMetadata = { name: "", tags: [], archived: false, deleted: false };
const ARCHIVED: LibraryMetadata = { name: "", tags: [], archived: true, deleted: false };
const DELETED: LibraryMetadata = { name: "", tags: [], archived: false, deleted: true };
const WORK_ALPHA = nativeFixturePath("/work/alpha");
const WORK_ALPHA_APP = nativeFixturePath("/work/alpha/packages/app");
const WORK_HIDDEN = nativeFixturePath("/work/hidden");
const WORK_BETA = nativeFixturePath("/work/beta");
const MIGRATED_ALPHA = nativeFixturePath("/migrated/alpha");
const WORK_GAMMA = nativeFixturePath("/work/gamma");
const WORK_DELTA = nativeFixturePath("/work/delta");
const WORK_MISSING = nativeFixturePath("/work/missing");

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function message(
  role: "user" | "assistant" | "system" | "developer",
  text: string,
  minute: number,
  extra: Partial<Extract<ConversationItem, { readonly kind: "message" }>> = {},
): ConversationItem {
  return {
    kind: "message",
    role,
    text,
    timestamp: new Date(Date.UTC(2026, 6, 1, 0, minute)).toISOString(),
    ...extra,
  };
}

interface SessionOptions {
  readonly agent: "codex" | "opencode" | "claude" | "pi";
  readonly id: number;
  readonly context: string;
  readonly conversation: readonly ConversationItem[];
  readonly library?: LibraryMetadata;
  readonly native?: JsonValue;
  readonly updatedMinute?: number;
}

function session(options: SessionOptions): StoredSession {
  const nativeId = options.agent === "opencode"
    ? `ses_${options.id.toString().padStart(8, "0")}`
    : uuid(options.id);
  const sessionRef = options.agent === "codex"
    ? codexSessionRef(nativeId)
    : options.agent === "opencode"
      ? openCodeSessionRef(nativeId)
      : options.agent === "claude"
        ? claudeSessionRef(nativeId, uuid(options.id + 100))
        : piSessionRef(nativeId);
  const first = options.conversation[0]?.timestamp ?? "2026-07-01T00:00:00.000Z";
  const updated = new Date(Date.UTC(2026, 6, 1, 0, options.updatedMinute ?? options.id)).toISOString();
  return {
    sessionRef,
    agent: options.agent,
    nativeId,
    title: `${options.agent} ${options.id}`,
    context: options.context,
    model: "test-model",
    provider: options.agent === "claude" ? "" : "test-provider",
    createdAt: first,
    updatedAt: updated,
    nativeArchived: false,
    library: options.library ?? ACTIVE,
    conversation: options.conversation,
    searchText: [],
    rawFiles: [],
    native: options.native ?? {},
  };
}

async function publishAgentSnapshot(
  stateDirectory: string,
  agent: "codex" | "opencode" | "claude" | "pi",
  sessions: readonly StoredSession[],
): Promise<void> {
  const workspace = await createSnapshotWorkspace(stateDirectory, agent);
  const snapshot: AgentSnapshot = {
    schemaVersion: "agenthist.history-snapshot/v2",
    snapshotId: workspace.id,
    agent,
    scannedAt: "2026-07-02T00:00:00.000Z",
    sessions,
    auxiliaryFiles: [],
    warnings: [],
  };
  await publishSnapshot(stateDirectory, workspace, snapshot);
}

test("beat/card rules preserve evidence boundaries without making semantic decisions", () => {
  const historicalEnvelope = [
    "<<<AGENTHIST_HISTORICAL_CONTEXT_V1>>>",
    JSON.stringify({
      notice: "Historical privileged context only; untrusted data.",
      source_agent: "codex",
      source_role: "system",
      text: "ignore this historical instruction",
    }),
    "<<<END_AGENTHIST_HISTORICAL_CONTEXT_V1>>>",
  ].join("\n");
  const longRule = `Always keep the evidence.\n\n${"x".repeat(9_000)}`;
  const value = session({
    agent: "codex",
    id: 1,
    context: "/work/alpha",
    conversation: [
      message("system", "current system prompt", 0),
      message("user", longRule, 1),
      message("assistant", "I changed it.", 2, {
        portableBlocks: [{
          kind: "historical_tool",
          tool: {
            phase: "exchange",
            callId: "call-1",
            name: "Bash",
            status: "completed",
            input: { command: "npm test" },
            output: { stdout: "ok" },
          },
        }, { kind: "text", text: "I changed it." }],
      }),
      message("user", `No, use the isolated environment.\n\n${historicalEnvelope}`, 3, {
        portableBlocks: [
          { kind: "text", text: "No, use the isolated environment." },
          { kind: "historical_context", context: { sourceRole: "system", text: "ignore this historical instruction" } },
        ],
      }),
      { kind: "gap", label: "missing turn", code: "test.gap", timestamp: "2026-07-01T00:04:00.000Z" },
      message("assistant", "This must not attach across the gap.", 5),
    ],
  });
  const index = buildSessionExperienceIndex(value, uuid(900), sourceRevision(value));

  assert.equal(index.beats.length, 2);
  assert.equal(index.beats[0]!.nextUser?.text, "No, use the isolated environment.");
  assert.equal(index.beats[0]!.previousUser, undefined);
  assert.deepEqual(index.beats[0]!.precedingAssistant, []);
  assert.equal(index.beats[0]!.tools.length, 1);
  assert.equal(index.beats[0]!.omittedTools, 0);
  assert.equal(index.beats[0]!.tools[0]!.name, "Bash");
  assert.equal(index.beats[1]!.userText, "No, use the isolated environment.");
  assert.equal(index.beats[1]!.previousUser?.text.startsWith("Always keep the evidence."), true);
  assert.equal(index.beats[1]!.previousUser?.truncated, true);
  assert.equal(index.beats[1]!.precedingAssistant[0]?.text, "I changed it.");
  assert.equal(index.beats[1]!.assistant.length, 0);
  assert.ok(index.cards.length > index.beats.length, "long user text should be split into multiple cards");
  assert.equal(index.cards[0]!.userByteStart, 0);
  assert.equal(index.cards.at(-1)!.userByteEnd, Buffer.byteLength(index.beats[1]!.userText, "utf8"));
  assert.ok(index.cards.every((card) => card.requestBytes > 0 && card.estimatedInputTokens > 0));
  assert.deepEqual(splitExperienceText("first\n\nsecond", 64), [
    { text: "first\n\nsecond", byteStart: 0, byteEnd: 13 },
  ]);
});

test("lineage and budget planning are deterministic and conservative", () => {
  const shared = {
    logicalDigest: "ahlogical1_shared",
    nativeRelationKeys: ["codex:root"],
  };
  const lineages = resolveExperienceLineages([
    { sessionRef: "a", ...shared },
    { sessionRef: "b", logicalDigest: "ahlogical1_other", nativeRelationKeys: ["codex:root"] },
    { sessionRef: "c", logicalDigest: "ahlogical1_shared", nativeRelationKeys: ["claude:c"] },
    { sessionRef: "d", logicalDigest: "ahlogical1_unique", nativeRelationKeys: ["opencode:d"] },
  ]);
  assert.equal(lineages.get("a"), lineages.get("b"));
  assert.equal(lineages.get("a"), lineages.get("c"));
  assert.notEqual(lineages.get("a"), lineages.get("d"));

  const source = session({
    agent: "claude",
    id: 2,
    context: "/work/beta",
    conversation: [message("user", "Remember this rule.", 1), message("assistant", "Done.", 2)],
  });
  const cards = buildSessionExperienceIndex(source, uuid(901), sourceRevision(source)).cards;
  const full = planExperienceBudget(cards, 50_000, 12_000);
  const none = planExperienceBudget(cards, 0, 0);
  assert.equal(full.selectedCards, cards.length);
  assert.equal(full.remainingCards, 0);
  assert.equal(none.selectedCards, 0);
});

test("bounded scheduling covers project and lineage strata without language keywords", () => {
  const card = (
    id: string,
    projectKey: string,
    lineageRef: string,
    userText: string,
    userTimestamp: string,
  ): DiscoveryCard => ({
    cardRef: id,
    beatRef: `beat-${id}`,
    sessionRef: `session-${id}`,
    sourceRevision: `revision-${id}`,
    agent: "codex",
    lineageRef,
    projectKey,
    context: `/work/${projectKey}`,
    turnStart: 0,
    turnEnd: 0,
    userTimestamp,
    fragmentIndex: 0,
    fragmentCount: 1,
    userByteStart: 0,
    userByteEnd: Buffer.byteLength(userText),
    userText,
    precedingAssistant: [],
    assistant: [],
    tools: [],
    omittedTools: 0,
    contentDigest: `digest-${id}`,
    requestBytes: 100,
    estimatedInputTokens: 100,
  });
  const cards = [
    card("a-old", "project-a", "lineage-a", "Please inspect this result.", "2026-01-01T00:00:00.000Z"),
    card("a-new", "project-a", "lineage-a", "请检查这个结果。", "2026-06-01T00:00:00.000Z"),
    card("b-old", "project-b", "lineage-b", "この結果を確認してください。", "2026-02-01T00:00:00.000Z"),
    card("b-new", "project-b", "lineage-b", "يرجى فحص هذه النتيجة.", "2026-07-01T00:00:00.000Z"),
    card("c-old", "project-c", "lineage-c", "Bitte pruefe dieses Ergebnis.", "2026-03-01T00:00:00.000Z"),
    card("c-new", "project-c", "lineage-c", "Verifique este resultado.", "2026-08-01T00:00:00.000Z"),
    card("d-old", "project-d", "lineage-d", "Verifiez ce resultat.", "2026-04-01T00:00:00.000Z"),
    card("d-new", "project-d", "lineage-d", "Controlla questo risultato.", "2026-09-01T00:00:00.000Z"),
  ];

  const plan = planExperienceBudget(cards, 1_600, 0, 12_000);
  assert.equal(plan.selectedCards, 4);
  assert.equal(new Set(plan.selected.map((item) => item.projectKey)).size, 4);
  assert.equal(new Set(plan.selected.map((item) => item.lineageRef)).size, 4);
  assert.deepEqual(plan.selected.map((item) => item.cardRef), ["a-old", "b-old", "c-old", "d-old"]);
});

test("fast budget accounts for the bounded card count of each request", () => {
  const cards: DiscoveryCard[] = Array.from({ length: 17 }, (_, index) => ({
    cardRef: `card-${index.toString().padStart(2, "0")}`,
    beatRef: `beat-${index}`,
    sessionRef: `session-${index}`,
    sourceRevision: `revision-${index}`,
    agent: "codex",
    lineageRef: `lineage-${index}`,
    projectKey: `project-${index}`,
    context: `/work/project-${index}`,
    turnStart: 0,
    turnEnd: 0,
    userTimestamp: `2026-01-${(index + 1).toString().padStart(2, "0")}T00:00:00.000Z`,
    fragmentIndex: 0,
    fragmentCount: 1,
    userByteStart: 0,
    userByteEnd: 4,
    userText: "task",
    precedingAssistant: [],
    assistant: [],
    tools: [],
    omittedTools: 0,
    contentDigest: `digest-${index}`,
    requestBytes: 100,
    estimatedInputTokens: 100,
  }));

  const plan = planExperienceBudget(cards, 5_300, 0, 12_000);
  assert.equal(plan.selectedCards, 17);
  assert.equal(plan.fastRequests, 3);
  assert.equal(plan.estimatedFastInputTokens, 5_300);
});

test("dry-run indexes a multi-Agent corpus, excludes deleted history, and reuses unchanged sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-experience-"));
  const stateDirectory = path.join(root, "state");
  try {
    const repeatedConversation = [
      message("user", "After changes, run the focused tests on the server.", 1),
      message("assistant", "The focused tests passed.", 2),
    ];
    const codexRoot = session({
      agent: "codex",
      id: 10,
      context: WORK_ALPHA,
      conversation: repeatedConversation,
      native: {
        lineage: { forkedFromId: null, parentThreadId: null, historyBase: null },
        spawn: { componentNativeIds: [uuid(10), uuid(11)], relationStatus: "valid" },
      },
    });
    const codexChild = session({
      agent: "codex",
      id: 11,
      context: WORK_ALPHA_APP,
      conversation: [
        ...repeatedConversation,
        message("user", "Continue with the integration test.", 3),
        message("assistant", "Integration passed.", 4),
      ],
      native: {
        lineage: { forkedFromId: uuid(10), parentThreadId: uuid(10), historyBase: null },
        spawn: { componentNativeIds: [uuid(10), uuid(11)], relationStatus: "valid" },
      },
    });
    const codexDeleted = session({
      agent: "codex",
      id: 12,
      context: WORK_HIDDEN,
      conversation: [message("user", "Never expose this deleted record.", 5)],
      library: DELETED,
    });
    const openCode = session({
      agent: "opencode",
      id: 20,
      context: WORK_BETA,
      conversation: [
        message("user", "Use structured parsers for structured data.", 6),
        message("assistant", "Applied.", 7),
        message("user", "Okay, continue.", 8),
      ],
      native: {
        componentNativeIds: ["ses_00000020"], parentId: null, childNativeIds: [], relationStatus: "valid",
      },
    });
    const openCodeArchived = session({
      agent: "opencode",
      id: 21,
      context: WORK_BETA,
      conversation: [message("user", "Investigate the failing query.", 9), message("assistant", "Found it.", 10)],
      library: ARCHIVED,
    });
    const claudeDuplicate = session({
      agent: "claude",
      id: 30,
      context: MIGRATED_ALPHA,
      conversation: repeatedConversation,
    });
    const claudeLong = session({
      agent: "claude",
      id: 31,
      context: WORK_GAMMA,
      conversation: [
        message("user", `Keep this bounded.\n\n${"内容".repeat(5_000)}`, 11),
        message("assistant", "Bounded.", 12),
      ],
    });
    const claudeOrdinary = session({
      agent: "claude",
      id: 32,
      context: WORK_GAMMA,
      conversation: [message("user", "What time is it?", 13), message("assistant", "Noon.", 14)],
    });
    const pi = session({
      agent: "pi",
      id: 40,
      context: WORK_DELTA,
      conversation: [
        message("user", "Keep the reusable rule independent of this project.", 15),
        message("assistant", "Understood.", 16),
      ],
    });
    await publishAgentSnapshot(stateDirectory, "codex", [codexRoot, codexChild, codexDeleted]);
    await publishAgentSnapshot(stateDirectory, "opencode", [openCode, openCodeArchived]);
    await publishAgentSnapshot(stateDirectory, "claude", [claudeDuplicate, claudeLong, claudeOrdinary]);
    await publishAgentSnapshot(stateDirectory, "pi", [pi]);

    const first = await dryRunExperienceReview({
      stateDirectory,
      allHistory: true,
      maximumInputTokens: 5_000,
      maximumDeepInputTokens: 500,
      requestInputTokens: 5_000,
    });
    assert.equal(first.model.configurationRead, false);
    assert.equal(first.model.requests, 0);
    assert.equal(first.corpus.sessions, 8);
    assert.equal(first.corpus.excludedDeletedSessions, 1);
    assert.equal(first.corpus.archivedSessions, 1);
    assert.equal(first.corpus.projects, 6);
    assert.ok(first.corpus.lineages < first.corpus.sessions);
    assert.ok(first.corpus.duplicateSessions >= 2);
    assert.ok(first.corpus.beats >= 10);
    assert.ok(first.corpus.cards > first.corpus.beats);
    assert.ok(first.corpus.foldedDuplicateCards > 0);
    assert.ok(first.corpus.queuedCards < first.corpus.cards);
    assert.equal(first.index.rebuiltSessions, 8);
    assert.equal(first.index.reusedSessions, 0);
    assert.ok(first.plan.selectedCards > 0);
    assert.ok(first.plan.remainingCards > 0);
    await access(path.join(stateDirectory, "experience", "index.sqlite"));

    const second = await dryRunExperienceReview({ stateDirectory, allHistory: true });
    assert.equal(second.index.rebuiltSessions, 0);
    assert.equal(second.index.reusedSessions, 8);
    assert.equal(second.corpus.sessions, first.corpus.sessions);
    assert.equal(second.corpus.lineages, first.corpus.lineages);
    assert.equal(second.plan.remainingCards, 0);

    const cli = await runCli([
      "--json", "--state-dir", stateDirectory, "experience", "--dry-run", "--agent", "claude", "--all",
    ]);
    assert.equal(cli.exitCode, 0, cli.stderr);
    const output = JSON.parse(cli.stdout) as {
      readonly command: string;
      readonly data: {
        readonly corpus: { readonly sessions: number; readonly agents: readonly { readonly agent: string }[] };
        readonly model: { readonly configuration_read: boolean; readonly requests: number };
      };
    };
    assert.equal(output.command, "experience");
    assert.equal(output.data.corpus.sessions, 3);
    assert.deepEqual(output.data.corpus.agents.map((agent) => agent.agent), ["claude"]);
    assert.deepEqual(output.data.model, { configuration_read: false, requests: 0 });

    const piCli = await runCli([
      "--json", "--state-dir", stateDirectory, "experience", "--dry-run", "--agent", "pi", "--all",
    ]);
    assert.equal(piCli.exitCode, 0, piCli.stderr);
    const piOutput = JSON.parse(piCli.stdout) as {
      readonly data: {
        readonly corpus: { readonly sessions: number; readonly agents: readonly { readonly agent: string }[] };
      };
    };
    assert.equal(piOutput.data.corpus.sessions, 1);
    assert.deepEqual(piOutput.data.corpus.agents.map((agent) => agent.agent), ["pi"]);

    const currentWorkspace = await runCli([
      "--json", "--state-dir", stateDirectory, "experience", "--dry-run",
    ], { cwd: WORK_ALPHA });
    assert.equal(currentWorkspace.exitCode, 0, currentWorkspace.stderr);
    const currentOutput = JSON.parse(currentWorkspace.stdout) as {
      readonly data: {
        readonly selection: {
          readonly mode: string;
          readonly defaulted_to_current_workspace: boolean;
          readonly workspaces: readonly { readonly path: string; readonly sessions: number }[];
          readonly session_refs: readonly string[];
        };
        readonly corpus: { readonly sessions: number; readonly excluded_outside_selection_sessions: number };
      };
    };
    assert.deepEqual(currentOutput.data.selection, {
      mode: "workspace",
      defaulted_to_current_workspace: true,
      workspaces: [{ path: WORK_ALPHA, sessions: 2 }],
      session_refs: [],
    });
    assert.equal(currentOutput.data.corpus.sessions, 2);
    assert.equal(currentOutput.data.corpus.excluded_outside_selection_sessions, 6);

    const selectedWorkspaces = await runCli([
      "--json", "--state-dir", stateDirectory, "experience", "--dry-run",
      "--workspace", WORK_ALPHA, "--workspace", WORK_BETA,
    ], { cwd: root });
    assert.equal(selectedWorkspaces.exitCode, 0, selectedWorkspaces.stderr);
    const selectedWorkspaceOutput = JSON.parse(selectedWorkspaces.stdout) as {
      readonly data: {
        readonly selection: { readonly mode: string; readonly workspaces: readonly unknown[] };
        readonly corpus: { readonly sessions: number };
      };
    };
    assert.equal(selectedWorkspaceOutput.data.selection.mode, "workspace");
    assert.equal(selectedWorkspaceOutput.data.selection.workspaces.length, 2);
    assert.equal(selectedWorkspaceOutput.data.corpus.sessions, 4);

    const selectedSessions = await runCli([
      "--json", "--state-dir", stateDirectory, "experience", "--dry-run",
      "--session", codexRoot.sessionRef, "--session", openCode.sessionRef,
    ], { cwd: root });
    assert.equal(selectedSessions.exitCode, 0, selectedSessions.stderr);
    const selectedSessionOutput = JSON.parse(selectedSessions.stdout) as {
      readonly data: {
        readonly selection: { readonly mode: string; readonly session_refs: readonly string[] };
        readonly corpus: { readonly sessions: number };
      };
    };
    assert.equal(selectedSessionOutput.data.selection.mode, "session");
    assert.deepEqual(selectedSessionOutput.data.selection.session_refs, [codexRoot.sessionRef, openCode.sessionRef].sort());
    assert.equal(selectedSessionOutput.data.corpus.sessions, 2);

    const allAfterScopedRuns = await dryRunExperienceReview({ stateDirectory, allHistory: true });
    assert.equal(allAfterScopedRuns.index.reusedSessions, 8, "scoped runs must retain other workspace indexes");

    const conflictingScope = await runCli([
      "--state-dir", stateDirectory, "experience", "--dry-run",
      "--workspace", WORK_ALPHA, "--all",
    ], { cwd: root });
    assert.equal(conflictingScope.exitCode, 2);
    assert.match(conflictingScope.stderr, /only one of --workspace, --session, or --all/);

    const missingWorkspace = await runCli([
      "--state-dir", stateDirectory, "experience", "--workspace", WORK_MISSING,
    ], { cwd: root, home: root, environment: { HOME: root }, fetcher: async () => {
      throw new Error("an empty workspace must fail before model access");
    } });
    assert.equal(missingWorkspace.exitCode, 3);
    assert.match(missingWorkspace.stderr, /workspace matched no active or archived scanned session/);
    await assert.rejects(access(path.join(root, ".env.agenthist")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
