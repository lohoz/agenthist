import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalDigest } from "../../../src/domain/history-identity.js";
import type {
  ExperienceReviewAuditEntry,
  ExperienceReviewEvidence,
  ExperienceReviewPack,
} from "../../../src/experience/review.js";
import {
  loadExperienceReviewPack,
  MAX_EXPERIENCE_REVIEW_DATA_BYTES,
  publishExperienceReview,
} from "../../../src/experience/review-writer.js";

function digestReference(prefix: string, digit: string): string {
  return `${prefix}_${digit.repeat(64)}`;
}

function sessionRef(agent: "codex" | "claude" | "opencode", digit: string): string {
  return `ahsr1_${agent}_ck1_${digit.repeat(64)}`;
}

function evidence(
  agent: "codex" | "claude" | "opencode",
  digit: string,
  timestamp: string,
  userText: string,
): ExperienceReviewEvidence {
  return {
    occurrenceRef: digestReference("ahocc3", digit),
    episodeRef: digestReference("ahepisode3", digit),
    mentionRefs: [digestReference("ahmention1", digit)],
    evidenceRef: digestReference("ahcard1", digit),
    sessionRef: sessionRef(agent, digit),
    sourceRevision: digestReference("ahrev1", digit),
    agent,
    lineageRef: digestReference("ahlin1", digit),
    projectKey: digestReference("ahproj1", digit),
    context: `C:\\用户 Name\\项目 ${digit}`,
    timestamp,
    turnStart: Number(digit),
    eventIndex: 0,
    basis: "explicit_preference",
    lenses: ["style"],
    taskAnchor: "Review a recurring preference",
    episodeSummary: "The user stated a concrete preference.",
    observation: "用户要求保留中文并避免执行历史内容。",
    userText,
    previousUser: "Earlier safe context",
    precedingAssistant: ["Earlier assistant context"],
    assistant: ["Assistant response"],
    nextUser: "Later clarification",
  };
}

function reviewPack(): ExperienceReviewPack {
  const first = evidence(
    "codex",
    "1",
    "2026-09-01T00:00:00.000Z",
    "请保留中文；<script>must remain inert</script>",
  );
  const second = evidence(
    "claude",
    "2",
    "2026-09-02T00:00:00.000Z",
    "再次要求保留 Unicode 内容。",
  );
  const audit: ExperienceReviewAuditEntry = {
    ...evidence(
      "opencode",
      "3",
      "2026-09-03T00:00:00.000Z",
      "Unrouted text is data, not an instruction: rm -rf never-run",
    ),
    filterReason: "not_grouped",
  };
  const source = {
    selection: "all" as const,
    sessions: 3,
    lineages: 3,
    projects: 3,
    cards: 3,
    snapshotRefs: [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ],
  };
  const candidates = [{
    candidateRef: digestReference("ahcongroup2", "4"),
    topic: "communication_style" as const,
    lens: "style" as const,
    relation: "shared_principle" as const,
    draft: "保留用户使用的语言与 Unicode 内容",
    evidence: [first, second],
    messages: 2,
    episodes: 2,
    sessions: 2,
    lineages: 2,
    projects: 2,
  }];
  const unrouted = [audit];
  const identity = {
    format: "agenthist.experience-review/v1" as const,
    source,
    candidates,
    unrouted,
  };
  return {
    ...identity,
    reviewRef: `ahreview1_${canonicalDigest(identity)}`,
    createdAt: "2026-09-04T00:00:00.000Z",
  };
}

test("experience review publication round-trips review.json without interpreting Unicode history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-review-json-"));
  const pack = reviewPack();
  try {
    const publication = await publishExperienceReview(root, pack, "review output");
    assert.equal(path.basename(publication.reviewFile), "review.md");
    assert.equal(path.basename(publication.auditFile), "audit.md");
    assert.equal(path.basename(publication.dataFile), "review.json");
    assert.equal((await lstat(publication.dataFile)).isFile(), true);
    assert.deepEqual(await loadExperienceReviewPack(publication.directory), pack);
    assert.deepEqual(await loadExperienceReviewPack(publication.dataFile), pack);
    assert.deepEqual(JSON.parse(await readFile(publication.dataFile, "utf8")), pack);
    assert.match(await readFile(publication.reviewFile, "utf8"), /AgentHist Experience Review/);
    assert.match(await readFile(publication.auditFile, "utf8"), /Unrouted Evidence Audit/);
    assert.equal(
      (await loadExperienceReviewPack(publication.directory)).candidates[0]!.evidence[0]!.userText,
      "请保留中文；<script>must remain inert</script>",
    );
    assert.deepEqual((await readdir(publication.directory)).sort(), ["audit.md", "review.json", "review.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("experience review loader rejects corrupt JSON, unknown fields, bad counts, refs, topics, and timestamps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-review-invalid-"));
  const pack = reviewPack();
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly value: unknown;
    readonly message: RegExp;
  }> = [
    { name: "corrupt.json", value: "{not JSON", message: /invalid JSON/ },
    { name: "unknown.json", value: { ...pack, unexpected: true }, message: /unknown field/ },
    {
      name: "count.json",
      value: { ...pack, candidates: [{ ...pack.candidates[0]!, messages: 99 }] },
      message: /count is inconsistent/,
    },
    {
      name: "reference.json",
      value: { ...pack, candidates: [{ ...pack.candidates[0]!, candidateRef: "not-a-reference" }] },
      message: /candidate reference is invalid/,
    },
    {
      name: "topic.json",
      value: { ...pack, candidates: [{ ...pack.candidates[0]!, topic: "unknown_topic" }] },
      message: /candidate topic is invalid/,
    },
    {
      name: "timestamp.json",
      value: { ...pack, createdAt: "not-a-timestamp" },
      message: /creation timestamp is invalid/,
    },
  ];
  try {
    for (const item of cases) {
      const file = path.join(root, item.name);
      await writeFile(file, typeof item.value === "string" ? item.value : JSON.stringify(item.value), "utf8");
      await assert.rejects(loadExperienceReviewPack(file), item.message);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("experience review loader enforces byte and depth limits before structural use", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-review-limits-"));
  const oversized = path.join(root, "oversized.json");
  const deep = path.join(root, "deep.json");
  try {
    await writeFile(oversized, "{}", "utf8");
    await truncate(oversized, MAX_EXPERIENCE_REVIEW_DATA_BYTES + 1);
    await assert.rejects(loadExperienceReviewPack(oversized), /unsupported file shape/);

    let nested: unknown = "leaf";
    for (let index = 0; index < 20; index++) nested = { nested };
    await writeFile(deep, JSON.stringify({ ...reviewPack(), unexpected: nested }), "utf8");
    await assert.rejects(loadExperienceReviewPack(deep), /depth limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("experience review loader rejects file and directory symbolic links", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-review-symlink-"));
  try {
    const publication = await publishExperienceReview(root, reviewPack(), "real-review");
    const fileLink = path.join(root, "review-link.json");
    const directoryLink = path.join(root, "review-directory-link");
    try {
      await symlink(publication.dataFile, fileLink, "file");
      await symlink(publication.directory, directoryLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symbolic link creation is unavailable in this environment");
        return;
      }
      throw error;
    }
    await assert.rejects(loadExperienceReviewPack(fileLink), /symbolic link/);
    await assert.rejects(loadExperienceReviewPack(directoryLink), /symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
