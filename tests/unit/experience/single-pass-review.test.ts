import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSnapshotWorkspace, publishSnapshot } from "../../../src/infrastructure/history-store.js";
import { agentApiAnalysisConfiguration } from "../../../src/experience/agent-api-configuration.js";
import { dryRunSinglePassExperienceReview, prepareSinglePassExperienceReview } from "../../../src/experience/single-pass-review.js";
import { createDesktopExperienceService } from "../../../src/desktop/experience.js";
import { canonicalDigest } from "../../../src/domain/history-identity.js";

const configuration = agentApiAnalysisConfiguration({ protocol: "openai-responses", baseUrl: "https://fixture.invalid/v1", model: "fixture-model", headers: { authorization: "Bearer synthetic-key" }, source: "fixture" });
async function fixture(root: string, count = 24, extraText = "") {
  const workspace = await createSnapshotWorkspace(root, "codex");
  await publishSnapshot(root, workspace, { schemaVersion: "agenthist.history-snapshot/v2", snapshotId: workspace.id, agent: "codex", scannedAt: "2026-09-01T00:00:00.000Z", auxiliaryFiles: [], warnings: [],
    sessions: Array.from({ length: count }, (_, index) => ({ sessionRef: `ahsr1_codex_ck1_${String(index + 1).padStart(64, "0")}`, agent: "codex", nativeId: `single-pass-${index}`, context: path.join(root, `project-${index}`),
      title: `Independent task ${index}`, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:01:00.000Z", model: "fixture", provider: "fixture", nativeArchived: false,
      library: { name: "", tags: [], archived: false, deleted: false }, searchText: [], rawFiles: [], native: {},
      conversation: [{ kind: "message", role: "user", text: `Task ${index}: always run the relevant tests before reporting completion.${extraText}`, timestamp: "2026-09-01T00:00:00.000Z" }],
    })),
  });
}
function response(content: string) {
  return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: content }] }], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } }), { headers: { "content-type": "application/json" } });
}

test("desktop extraction includes more than eight cards in exactly one model request and publishes grounded final experience", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-single-pass-"));
  let requests = 0;
  let pickerCalls = 0;
  const progress: string[] = [];
  const service = createDesktopExperienceService({ stateDirectory: root,
    getAnalysisConfiguration: async () => configuration, chooseOutputParent: async () => { pickerCalls++; return root; }, chooseReviewPath: async () => undefined, openPath: async () => undefined,
    fetcher: async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.text.format.name, "agenthist_single_pass_review");
      const input = JSON.parse(body.input[0].content);
      assert.equal(input.evidence.length, 24);
      const first = input.evidence[0];
      const second = input.evidence.find((item: any) => item.task !== first.task);
      return response(JSON.stringify({ candidates: [{ draft: "Run relevant tests before reporting completion.", topic: "software_testing", lens: "verification", relation: "shared_principle",
        evidence: [first, second].map((item) => ({ id: item.id, quote: "always run the relevant tests", basis: "stated_workflow" })) }] }));
    },
  });
  try {
    await fixture(root);
    const preview = await service.previewExperience({ scope: "all" });
    assert.equal(preview.singleRequest, true);
    assert.equal(preview.evidenceRequests, 1);
    assert.equal(preview.candidateRequestsUpperBound, 0);
    assert.equal(preview.inputLimitExceeded, false);
    assert.equal(requests, 0);
    const result = await service.runExperience({ scope: { scope: "all" }, expectedPreviewRef: preview.previewRef }, (event) => progress.push(event.phase));
    assert.equal(requests, 1);
    assert.equal(pickerCalls, 1);
    assert.equal(result.status, "completed");
    assert.deepEqual(progress, ["indexing", "configuring", "extracting", "publishing"]);
    if (result.status !== "completed") throw new Error("missing review");
    assert.equal(result.review.candidates.length, 1);
    const detail = await service.getExperienceCandidate({ handle: result.review.handle, candidateRef: result.review.candidates[0]!.candidateRef });
    assert.equal(detail.evidenceItems.length, 2);
    assert.ok(detail.evidenceItems.every((item) => item.userText.includes("always run the relevant tests")));
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("all-history analysis uses the native context capacity and includes hundreds of long conversations in one request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-whole-library-"));
  const largeConfiguration = { ...configuration,
    fast: { ...configuration.fast, contextWindow: 1_000_000 }, deep: { ...configuration.deep, contextWindow: 1_000_000 },
  };
  let requests = 0;
  const service = createDesktopExperienceService({ stateDirectory: root, getAnalysisConfiguration: async () => largeConfiguration,
    chooseOutputParent: async () => root, chooseReviewPath: async () => undefined, openPath: async () => undefined,
    fetcher: async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      const input = JSON.parse(body.input[0].content);
      assert.equal(input.evidence.length, 240);
      const users = input.evidence.map((item: any) => item.user ?? input.text_table[item.user_ref]);
      for (let index = 0; index < 240; index++) {
        assert.ok(users.some((user: string) => user.startsWith(`Task ${index}:`)), `missing conversation ${index}`);
      }
      return response('{"candidates":[]}');
    },
  });
  try {
    await fixture(root, 240, " Full conversation evidence must remain available.".repeat(55));
    const preview = await service.previewExperience({ scope: "all" });
    assert.equal(preview.sessions, 240);
    assert.equal(preview.queuedCards, 240);
    assert.ok(preview.estimatedInputTokens > 128_000);
    assert.equal(preview.modelContextWindow, 1_000_000);
    assert.equal(preview.inputTokenLimit, 891_808);
    assert.equal(preview.inputBudgetSource, "agent");
    assert.equal(preview.inputLimitExceeded, false);
    assert.equal(requests, 0);
    const result = await service.runExperience({ scope: { scope: "all" }, expectedPreviewRef: preview.previewRef });
    assert.equal(result.status, "completed");
    assert.equal(requests, 1);
    if (result.status !== "completed") throw new Error("missing full review");
    assert.equal(result.review.sessions, 240);
    assert.equal(result.review.unroutedEvidence, 240);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("text-table compaction retains every user message and its independent evidence identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-lossless-input-"));
  const repeated = "Always run the relevant tests before reporting completion. ".repeat(35);
  const originalUsers: string[] = [];
  try {
    const workspace = await createSnapshotWorkspace(root, "codex");
    await publishSnapshot(root, workspace, { schemaVersion: "agenthist.history-snapshot/v2", snapshotId: workspace.id, agent: "codex", scannedAt: "2026-09-01T00:00:00.000Z", auxiliaryFiles: [], warnings: [],
      sessions: Array.from({ length: 20 }, (_, index) => ({ sessionRef: `ahsr1_codex_ck1_${String(index + 1).padStart(64, "0")}`, agent: "codex", nativeId: `compaction-${index}`, context: path.join(root, `project-${index}`),
        title: `Task ${index}`, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:01:00.000Z", model: "fixture", provider: "fixture", nativeArchived: false,
        library: { name: "", tags: [], archived: false, deleted: false }, searchText: [], rawFiles: [], native: {},
        conversation: [0, 1, 2].map((turn) => {
          const user = turn === 1 ? `Task ${index}: correct the example. 中文😀` : repeated;
          originalUsers.push(user);
          return { kind: "message", role: "user", text: user, timestamp: `2026-09-01T00:00:0${turn}.000Z` };
        }),
      })),
    });
    const preview = await dryRunSinglePassExperienceReview({ stateDirectory: root, cwd: root, allHistory: true });
    assert.equal(preview.inputPreparation?.compression, "text_dictionary");
    assert.ok(preview.plan.estimatedFastInputTokens < preview.inputPreparation!.originalTokens / 2);
    let requests = 0;
    let sent: any;
    const result = await prepareSinglePassExperienceReview({ stateDirectory: root, cwd: root, environment: {}, allHistory: true, analysisConfiguration: configuration,
      fetcher: async (_url, init) => {
        requests++;
        const input = JSON.parse(JSON.parse(String(init?.body)).input[0].content);
        sent = input;
        const first = input.evidence.find((item: any) => input.text_table[item.user_ref].includes("Always run the relevant tests"));
        const second = input.evidence.find((item: any) => item.task !== first.task && input.text_table[item.user_ref].includes("Always run the relevant tests"));
        return response(JSON.stringify({ candidates: [{ draft: "Run relevant tests.", topic: "software_testing", lens: "verification", relation: "shared_principle",
          evidence: [first, second].map((item) => ({ id: item.id, quote: "Always run the relevant tests", basis: "stated_workflow" })) }] }));
      },
    });
    assert.ok(Array.isArray(sent.text_table));
    const users = sent.evidence.map((item: any) => sent.text_table[item.user_ref]);
    assert.deepEqual(users.map((user: string) => canonicalDigest(user.trim())).sort(), originalUsers.map((user) => canonicalDigest(user.trim())).sort());
    assert.equal(requests, 1);
    assert.equal(result.review!.pack.candidates.length, 1);
    assert.equal(result.review!.pack.candidates[0]!.lineages, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("single-pass failures never trigger repair, consolidation or a second API request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-single-pass-failure-"));
  try {
    await fixture(root);
    for (const kind of ["malformed", "ungrounded", "http"] as const) {
      let requests = 0;
      await assert.rejects(prepareSinglePassExperienceReview({ stateDirectory: root, cwd: root, environment: {}, allHistory: true, analysisConfiguration: configuration,
        fetcher: async () => {
          requests++;
          if (kind === "http") return new Response("unavailable", { status: 503 });
          if (kind === "malformed") return response("not-json");
          return response(JSON.stringify({ candidates: [{ draft: "Invented rule", topic: "general", lens: "scope", relation: "shared_principle", evidence: [
            { id: "e0", quote: "not in the actual history", basis: "explicit_preference" }, { id: "e99999", quote: "invented", basis: "explicit_preference" },
          ] }] }));
        },
      }));
      assert.equal(requests, 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("over-budget history is reported before any API call rather than silently skipped or split", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-single-pass-budget-"));
  let requests = 0;
  try {
    await fixture(root);
    const options = { stateDirectory: root, cwd: root, allHistory: true, maximumInputTokens: 100 };
    const preview = await dryRunSinglePassExperienceReview(options);
    assert.equal(preview.plan.fastRequests, 1);
    assert.equal(preview.plan.remainingCards, 24);
    assert.equal(preview.plan.selectedCards, 0);
    await assert.rejects(prepareSinglePassExperienceReview({ ...options, environment: {}, analysisConfiguration: configuration,
      fetcher: async () => { requests++; throw new Error("unexpected model request"); },
    }), (error: any) => error.details.reason === "single_pass_input_too_large");
    assert.equal(requests, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
