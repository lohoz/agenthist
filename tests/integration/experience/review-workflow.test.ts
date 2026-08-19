import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { codexSessionRef } from "../../../src/agents/codex/identity.js";
import { runCli } from "../../../src/cli/program.js";
import type { AgentSnapshot, ConversationItem, StoredSession } from "../../../src/domain/history.js";
import { createSnapshotWorkspace, publishSnapshot } from "../../../src/infrastructure/history-store.js";

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function message(role: "user" | "assistant", text: string, minute: number): ConversationItem {
  return {
    kind: "message",
    role,
    text,
    timestamp: new Date(Date.UTC(2026, 7, 1, 0, minute)).toISOString(),
  };
}

function session(index: number, userText: string, minute: number): StoredSession {
  const nativeId = uuid(index);
  const conversation = [
    message("user", userText, minute),
    message("assistant", "Understood.", minute + 1),
  ];
  return {
    sessionRef: codexSessionRef(nativeId),
    agent: "codex",
    nativeId,
    title: `experience fixture ${index}`,
    context: "/work/research",
    model: "gpt-5.4",
    provider: "test-provider",
    createdAt: conversation[0]!.timestamp,
    updatedAt: conversation.at(-1)!.timestamp,
    nativeArchived: false,
    library: { name: "", tags: [], archived: false, deleted: false },
    conversation,
    searchText: [],
    rawFiles: [],
    native: {},
  };
}

async function publishHistory(stateDirectory: string): Promise<void> {
  const workspace = await createSnapshotWorkspace(stateDirectory, "codex");
  const snapshot: AgentSnapshot = {
    schemaVersion: "agenthist.history-snapshot/v2",
    snapshotId: workspace.id,
    agent: "codex",
    scannedAt: "2026-08-01T01:00:00.000Z",
    sessions: [
      session(70, "科研写作中不要使用不是而是的刻意对立句式。", 0),
      session(71, "这里又写成了不是……而是……，请改成更自然、克制的科研表达。", 10),
    ],
    auxiliaryFiles: [],
    warnings: [],
  };
  await publishSnapshot(stateDirectory, workspace, snapshot);
}

function runtime(root: string, fetcher: typeof fetch) {
  return {
    cwd: root,
    home: root,
    environment: {
      HOME: root,
      AGENTHIST_EXPERIENCE_BASE_URL: "https://models.example.test/v1",
      AGENTHIST_EXPERIENCE_API_KEY: "fixture-key",
      AGENTHIST_EXPERIENCE_FAST_MODEL: "fast-model",
      AGENTHIST_EXPERIENCE_DEEP_MODEL: "organizer-model",
    },
    fetcher,
  };
}

function completion(content: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function requestPayload(init: RequestInit | undefined): Record<string, unknown> {
  const request = JSON.parse(String(init?.body)) as {
    readonly messages: readonly { readonly role: string; readonly content: string }[];
  };
  return JSON.parse(request.messages.find((item) => item.role === "user")!.content) as Record<string, unknown>;
}

test("experience extraction forms one cached workflow and stops at handoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-review-"));
  const stateDirectory = path.join(root, "state");
  const reviewDirectory = path.join(root, "review");
  try {
    await publishHistory(stateDirectory);
    let requests = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      requests++;
      const payload = requestPayload(init);
      if (payload.task === "agenthist_fast_discovery") {
        const cards = payload.discoveries as Array<{
          readonly discovery_key: string;
          readonly user_evidence: readonly { readonly quote_id: string; readonly text: string }[];
        }>;
        return completion({
          discoveries: Object.fromEntries(cards.map((card) => [card.discovery_key, {
            task_anchor: "revise research prose",
            episode_summary: "The user rejects a contrastive rhetorical construction in research writing.",
            events: [{
              topic: "research_writing",
              basis: "explicit_preference",
              lenses: ["style", "correction"],
              observation: "用户要求避免使用“不是……而是……”式的刻意对立表达。",
              behavior_signature: {
                situation: "when revising research prose",
                behavior: "avoid forced not-but contrast",
                target: "research writing style",
              },
              user_quote_ids: [card.user_evidence[0]!.quote_id],
            }],
          }])),
        });
      }
      if (payload.task === "agenthist_candidate_organization") {
        const value = payload.consolidation as {
          readonly request_id: string;
          readonly events: readonly { readonly event_id: string }[];
        };
        return completion({
          request_id: value.request_id,
          groups: [{
            lens: "style",
            hypothesis: "科研写作中避免使用“不是……而是……”式的刻意对立表达。",
            topic: "research_writing",
            relation: "correction_pattern",
            event_ids: value.events.map((item) => item.event_id),
          }],
        });
      }
      throw new Error(`unexpected analysis task: ${String(payload.task)}`);
    };
    const prepared = await runCli([
      "--json", "--state-dir", stateDirectory,
      "experience", "--all", "--output", reviewDirectory,
    ], runtime(root, fetcher));
    assert.equal(prepared.exitCode, 0, prepared.stderr);
    const output = JSON.parse(prepared.stdout) as {
      readonly data: {
        readonly consolidation: { readonly model: string; readonly groups: number };
        readonly review: Record<string, unknown> & {
          readonly review_id: string;
          readonly candidates: number;
          readonly review_file: string;
          readonly audit_file: string;
        };
      };
    };
    assert.equal(output.data.consolidation.model, "organizer-model");
    assert.equal(output.data.consolidation.groups, 1);
    assert.equal(output.data.review.candidates, 1);
    const reviewText = await readFile(output.data.review.review_file, "utf8");
    assert.match(reviewText, /Prompt for the reviewing AI/);
    assert.match(reviewText, /User text \(the only direct evidence/);
    assert.match(reviewText, /不是而是/);
    assert.match(reviewText, /AgentHist does not consume or constrain/);
    assert.doesNotMatch(reviewText, /decisions\.json|experience apply/);
    assert.match(await readFile(output.data.review.audit_file, "utf8"), /Unrouted Evidence Audit/);
    assert.equal("decisions_file" in output.data.review, false);

    const cachedDirectory = path.join(root, "review-cached");
    const cached = await runCli([
      "--json", "--state-dir", stateDirectory,
      "experience", "--all", "--output", cachedDirectory,
    ], runtime(root, async () => { throw new Error("cached preparation must not call a model"); }));
    assert.equal(cached.exitCode, 0, cached.stderr);
    const cachedData = (JSON.parse(cached.stdout) as {
      readonly data: {
        readonly fast: { readonly requests: number };
        readonly consolidation: { readonly requests: number };
      };
    }).data;
    assert.equal(cachedData.fast.requests, 0);
    assert.equal(cachedData.consolidation.requests, 0);
    assert.ok(requests >= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
