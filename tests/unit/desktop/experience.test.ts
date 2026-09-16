import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ExperienceDryRunOptions,
  ExperienceDryRunResult,
  ExperienceReviewPack,
  PrepareExperienceReviewOptions,
  PrepareExperienceReviewResult,
} from "../../../src/application/index.js";
import { canonicalDigest } from "../../../src/domain/history-identity.js";
import { createDesktopExperienceService } from "../../../src/desktop/experience.js";
import { publishExperienceReview } from "../../../src/experience/review-writer.js";

function reference(prefix: string, digit: string): string {
  return `${prefix}_${digit.repeat(64)}`;
}

function sessionRef(agent: "codex" | "claude", digit: string): string {
  return `ahsr1_${agent}_ck1_${digit.repeat(64)}`;
}

function evidence(agent: "codex" | "claude", digit: string) {
  return {
    occurrenceRef: reference("ahocc3", digit),
    episodeRef: reference("ahepisode3", digit),
    mentionRefs: [reference("ahmention1", digit)],
    evidenceRef: reference("ahcard1", digit),
    sessionRef: sessionRef(agent, digit),
    sourceRevision: reference("ahrev1", digit),
    agent,
    lineageRef: reference("ahlin1", digit),
    projectKey: reference("ahproj1", digit),
    context: `C:\\历史文本不可作为路径\\项目 ${digit}`,
    timestamp: `2026-09-0${digit}T00:00:00.000Z`,
    turnStart: Number(digit),
    eventIndex: 0,
    basis: "explicit_preference" as const,
    lenses: ["style" as const],
    taskAnchor: "Keep history inert",
    episodeSummary: "User supplied a review preference.",
    observation: "历史内容仅作为证据。",
    userText: `不要打开 C:\\malicious-${digit}；这只是历史文本。`,
    precedingAssistant: [],
    assistant: ["Assistant evidence with Unicode：完成。"],
  };
}

function pack(): ExperienceReviewPack {
  const evidenceItems = [evidence("codex", "1"), evidence("claude", "2")];
  const candidate = (digit: string, lens: "workflow" | "style" | "quality") => ({
    candidateRef: reference("ahcongroup2", digit),
    topic: "project_workflow" as const,
    lens,
    relation: "shared_principle" as const,
    draft: lens === "workflow" ? "保持简洁工作流程" : lens === "style" ? "保留中文表达" : "运行验证",
    evidence: evidenceItems,
    messages: 2,
    episodes: 2,
    sessions: 2,
    lineages: 2,
    projects: 2,
  });
  const source = {
    selection: "all" as const,
    sessions: 2,
    lineages: 2,
    projects: 2,
    cards: 2,
    snapshotRefs: [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ],
  };
  const candidates = [candidate("3", "workflow"), candidate("4", "style"), candidate("5", "quality")];
  const identity = {
    format: "agenthist.experience-review/v1" as const,
    source,
    candidates,
    unrouted: [],
  };
  return {
    ...identity,
    reviewRef: `ahreview1_${canonicalDigest(identity)}`,
    createdAt: "2026-09-04T00:00:00.000Z",
  };
}

function dryResult(snapshotId: string, rebuiltSessions = 0): ExperienceDryRunResult {
  return {
    dryRun: true,
    selection: {
      mode: "all",
      defaultedToCurrentWorkspace: false,
      workspaces: [],
      sessionRefs: [],
    },
    corpus: {
      agents: [{ agent: "codex", snapshotId, sessions: 2, beats: 2, cards: 2 }],
      sessions: 2,
      lineages: 2,
      projects: 2,
      beats: 2,
      cards: 2,
      queuedCards: 2,
      foldedDuplicateCards: 0,
      archivedSessions: 0,
      excludedDeletedSessions: 0,
      excludedOutsideSelectionSessions: 0,
      excludedBeforeSinceSessions: 0,
      duplicateSessions: 0,
    },
    index: {
      parserVersion: "agenthist.experience-parser/v3",
      reusedSessions: rebuiltSessions === 0 ? 2 : 0,
      rebuiltSessions,
      removedSessions: 0,
    },
    plan: {
      totalCards: 2,
      selectedCards: 2,
      remainingCards: 0,
      estimatedFastInputTokens: 1200,
      fastRequests: 1,
      deepInputTokensUpperBound: 4000,
      deepRequestsUpperBound: 2,
      maximumInputTokens: 50_000,
      maximumDeepInputTokens: 128_000,
      requestInputTokens: 64_000,
    },
    model: { configurationRead: false, requests: 0 },
    excludedContent: [],
  };
}

function preparedResult(
  review: PrepareExperienceReviewResult["review"] | undefined,
  remainingCards: number,
): PrepareExperienceReviewResult {
  return {
    dryRun: false,
    stage: "experience_review_preparation",
    selection: {
      mode: "all",
      defaultedToCurrentWorkspace: false,
      workspaces: [],
      sessionRefs: [],
    },
    corpus: dryResult("00000000-0000-4000-8000-000000000001").corpus,
    index: dryResult("00000000-0000-4000-8000-000000000001").index,
    plan: { totalCards: 2, selectedCards: 2 - remainingCards, remainingCards },
    fast: {
      status: remainingCards === 0 ? "completed" : "partial",
      model: "fixture-fast",
      backend: "openai-compatible-chat",
      endpointFingerprint: "fixture-endpoint",
      profileFingerprint: "fixture-profile",
      totalCards: 2,
      selectedCards: 2 - remainingCards,
      availableCards: 2 - remainingCards,
      cachedCards: 0,
      newlyProcessedCards: 2 - remainingCards,
      remainingCards,
      evidenceEvents: 2 - remainingCards,
      batches: 1,
      requests: 1,
      repairRequests: 0,
      discardedUnrequestedDiscoveries: 0,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    },
    consolidation: {
      model: "fixture-deep",
      backend: "openai-compatible-chat",
      endpointFingerprint: "fixture-endpoint",
      profileFingerprint: "fixture-profile",
      status: review === undefined ? "waiting_for_fast" : "completed",
      evidenceOccurrences: 0,
      plannedRequests: 0,
      cachedRequests: 0,
      newlyProcessedRequests: 0,
      pendingRequests: 0,
      pendingBudgetRequests: 0,
      pendingRequestLimitRequests: 0,
      groups: review?.pack.candidates.length ?? 0,
      groupedOccurrences: 0,
      unroutedOccurrences: 0,
      requests: 0,
      repairRequests: 0,
      estimatedNewInputTokens: 0,
      maximumInputTokens: 128_000,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      requestExecutions: [],
      unroutedAudits: [],
      routing: { occurrences: [], groups: [], unrouted: [] },
    },
    evidenceCards: [],
    discoveries: [],
    ...(review === undefined ? {} : { review }),
  };
}

test("Experience preview uses the private configuration cwd and stable canonical identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-experience-preview-"));
  const stateDirectory = path.join(root, "state with spaces");
  const calls: ExperienceDryRunOptions[] = [];
  try {
    const service = createDesktopExperienceService({
      stateDirectory,
      chooseOutputParent: async () => undefined,
      chooseReviewPath: async () => undefined,
      openPath: async () => undefined,
      async dryRunExperienceReview(options) {
        calls.push(options);
        const result = dryResult("00000000-0000-4000-8000-000000000001", calls.length === 1 ? 2 : 0);
        return options.sessionRefs === undefined ? result : {
          ...result,
          selection: {
            mode: "session",
            defaultedToCurrentWorkspace: false,
            workspaces: [],
            sessionRefs: options.sessionRefs,
          },
        };
      },
      async prepareExperienceReview() { throw new Error("preview called a model"); },
    });
    const first = await service.previewExperience({ scope: "all" });
    const second = await service.previewExperience({ scope: "all" });
    assert.equal(first.previewRef, second.previewRef);
    assert.equal(first.rebuiltSessions, 2);
    assert.equal(second.reusedSessions, 2);
    const privateCwd = path.join(stateDirectory, "desktop", "experience");
    assert.equal(calls[0]!.cwd, privateCwd);
    const info = await lstat(privateCwd);
    assert.equal(info.isDirectory(), true);
    assert.equal(info.isSymbolicLink(), false);

    const scoped = await service.previewExperience({
      scope: "sessions",
      sessionRefs: [sessionRef("claude", "2"), sessionRef("codex", "1")],
    });
    assert.equal(scoped.scope, "sessions");
    assert.deepEqual(calls.at(-1)!.sessionRefs, [sessionRef("claude", "2"), sessionRef("codex", "1")]);
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partial Experience runs reuse the chosen output parent on continuation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-experience-continue-"));
  let pickerCalls = 0;
  let modelCalls = 0;
  const service = createDesktopExperienceService({
    stateDirectory: path.join(root, "state"),
    chooseOutputParent: async () => { pickerCalls++; return root; },
    chooseReviewPath: async () => undefined,
    openPath: async () => undefined,
    dryRunExperienceReview: async () => dryResult("00000000-0000-4000-8000-000000000001"),
    prepareExperienceReview: async () => { modelCalls++; return preparedResult(undefined, 1); },
  });
  try {
    const preview = await service.previewExperience({ scope: "all" });
    const request = { scope: { scope: "all" as const }, expectedPreviewRef: preview.previewRef };
    assert.equal((await service.runExperience(request)).status, "partial");
    assert.equal((await service.runExperience(request)).status, "partial");
    assert.equal(pickerCalls, 1);
    assert.equal(modelCalls, 2);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Experience run replans or cancels before any model request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-experience-confirm-"));
  let snapshot = "00000000-0000-4000-8000-000000000001";
  let modelCalls = 0;
  let pickerCalls = 0;
  try {
    const service = createDesktopExperienceService({
      stateDirectory: path.join(root, "state"),
      chooseOutputParent: async () => { pickerCalls++; return undefined; },
      chooseReviewPath: async () => undefined,
      openPath: async () => undefined,
      dryRunExperienceReview: async () => dryResult(snapshot),
      async prepareExperienceReview() { modelCalls++; throw new Error("unexpected model call"); },
    });
    const preview = await service.previewExperience({ scope: "all" });
    snapshot = "00000000-0000-4000-8000-000000000002";
    const changed = await service.runExperience({ scope: { scope: "all" }, expectedPreviewRef: preview.previewRef });
    assert.equal(changed.status, "replan_required");
    assert.equal(modelCalls, 0);
    assert.equal(pickerCalls, 0);

    if (changed.status !== "replan_required") return;
    const cancelled = await service.runExperience({
      scope: { scope: "all" },
      expectedPreviewRef: changed.preview.previewRef,
    });
    assert.deepEqual(cancelled, { status: "cancelled" });
    assert.equal(modelCalls, 0);
    assert.equal(pickerCalls, 1);
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Experience partial run reports remaining cards and maps progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-experience-partial-"));
  const progress: string[] = [];
  try {
    const service = createDesktopExperienceService({
      stateDirectory: path.join(root, "state"),
      chooseOutputParent: async () => root,
      chooseReviewPath: async () => undefined,
      openPath: async () => undefined,
      dryRunExperienceReview: async () => dryResult("00000000-0000-4000-8000-000000000001"),
      async prepareExperienceReview(options) {
        options.onProgress?.({ phase: "indexing" });
        options.onProgress?.({ phase: "extracting", currentBatch: 1, totalBatches: 2 });
        options.onProgress?.({ phase: "finalizing" });
        return preparedResult(undefined, 1);
      },
    });
    const preview = await service.previewExperience({ scope: "all" });
    const result = await service.runExperience(
      { scope: { scope: "all" }, expectedPreviewRef: preview.previewRef },
      (item) => progress.push(item.phase),
    );
    assert.deepEqual(result, { status: "partial", remainingCards: 1 });
    assert.deepEqual(progress, ["indexing", "extracting", "finalizing"]);
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed Experience run registers bounded summaries, evidence, and authoritative output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-experience-complete-"));
  const reviewPack = pack();
  let openedPath = "";
  try {
    const service = createDesktopExperienceService({
      stateDirectory: path.join(root, "state"),
      chooseOutputParent: async () => root,
      chooseReviewPath: async () => undefined,
      openPath: async (directory) => { openedPath = directory; },
      dryRunExperienceReview: async () => dryResult("00000000-0000-4000-8000-000000000001"),
      async prepareExperienceReview(options: PrepareExperienceReviewOptions) {
        const publication = await publishExperienceReview(options.cwd, reviewPack, options.outputDirectory);
        return preparedResult({ pack: reviewPack, publication }, 0);
      },
    });
    const preview = await service.previewExperience({ scope: "all" });
    const completed = await service.runExperience({
      scope: { scope: "all" },
      expectedPreviewRef: preview.previewRef,
    });
    assert.equal(completed.status, "completed");
    if (completed.status !== "completed") return;
    assert.equal(completed.review.directoryName.startsWith("agenthist-experience-"), true);
    assert.deepEqual(
      completed.review.candidates.map((candidate) => candidate.category),
      ["working_method", "preference", "requirement"],
    );
    assert.equal(JSON.stringify(completed.review).includes(root), false);

    const candidate = await service.getExperienceCandidate({
      handle: completed.review.handle,
      candidateRef: completed.review.candidates[0]!.candidateRef,
    });
    assert.equal(candidate.evidenceItems.length, 2);
    assert.match(candidate.evidenceItems[0]!.userText, /只是历史文本/);
    assert.match(candidate.evidenceItems[0]!.workspace, /历史文本不可作为路径/);

    assert.deepEqual(await service.openExperienceOutput({ handle: completed.review.handle }), { opened: true });
    assert.equal(path.dirname(openedPath), root);
    assert.notEqual(openedPath, candidate.evidenceItems[0]!.workspace);
    assert.equal(await readFile(path.join(openedPath, "review.json"), "utf8").then((text) => text.includes(reviewPack.reviewRef)), true);
    assert.deepEqual(await service.closeExperienceReview({ handle: completed.review.handle }), { closed: true });
    await assert.rejects(
      service.getExperienceCandidate({
        handle: completed.review.handle,
        candidateRef: completed.review.candidates[0]!.candidateRef,
      }),
      /invalid or expired/,
    );
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Experience review loading keeps picker paths private and enforces handle TTL and concurrency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-experience-load-"));
  const publication = await publishExperienceReview(root, pack(), "已保存 review 空格");
  let now = 0;
  let openedPath = "";
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  try {
    const service = createDesktopExperienceService({
      stateDirectory: path.join(root, "state"),
      chooseOutputParent: async () => undefined,
      chooseReviewPath: async () => publication.dataFile,
      openPath: async (directory) => {
        openedPath = directory;
        entered?.();
        await new Promise<void>((resolve) => { release = resolve; });
      },
      now: () => now,
      reviewHandleTtlMs: 1_000,
    });
    const loaded = await service.loadExperienceReview();
    assert.equal(loaded.status, "loaded");
    if (loaded.status !== "loaded") return;
    assert.equal(loaded.review.directoryName, path.basename(publication.directory));
    assert.equal(JSON.stringify(loaded).includes(root), false);
    await assert.rejects(
      service.openExperienceOutput({ handle: `ahexpreview1_${"0".repeat(64)}` }),
      /invalid or expired/,
    );

    const started = new Promise<void>((resolve) => { entered = resolve; });
    const opening = service.openExperienceOutput({ handle: loaded.review.handle });
    await started;
    await assert.rejects(
      service.closeExperienceReview({ handle: loaded.review.handle }),
      /operation in progress/,
    );
    release?.();
    await opening;
    assert.equal(openedPath, publication.directory);

    now = 1_001;
    await assert.rejects(
      service.getExperienceCandidate({
        handle: loaded.review.handle,
        candidateRef: loaded.review.candidates[0]!.candidateRef,
      }),
      /invalid or expired/,
    );
    await service.dispose();
    assert.equal((await lstat(publication.directory)).isDirectory(), true);
  } finally {
    release?.();
    await rm(root, { recursive: true, force: true });
  }
});
