import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExperienceConsolidationPlan,
  experienceConsolidationRequestJson,
  validateExperienceConsolidation,
} from "../../../src/experience/candidates.js";
import type { DiscoveryCard } from "../../../src/experience/corpus.js";
import {
  validateFastDiscoveryBatch,
  type ExperienceLens,
  type FastDiscoveryResult,
  type FastEvidenceEvent,
} from "../../../src/experience/evidence.js";

function card(index: number, text: string): DiscoveryCard {
  const reference = `card-${index}`;
  const timestamp = new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString();
  return {
    cardRef: reference,
    beatRef: `beat-${index}`,
    sessionRef: `session-${index}`,
    sourceRevision: `revision-${index}`,
    agent: "codex",
    lineageRef: `lineage-${index}`,
    projectKey: `project-${index}`,
    context: `/work/project-${index}`,
    turnStart: index,
    turnEnd: index + 1,
    userTimestamp: timestamp,
    fragmentIndex: 0,
    fragmentCount: 1,
    userByteStart: 0,
    userByteEnd: Buffer.byteLength(text, "utf8"),
    userText: text,
    precedingAssistant: [],
    assistant: [],
    tools: [],
    omittedTools: 0,
    contentDigest: `digest-${index}`,
    requestBytes: Buffer.byteLength(text, "utf8"),
    estimatedInputTokens: 100,
  };
}

function event(source: DiscoveryCard, topic: string, lenses: readonly ExperienceLens[]): FastEvidenceEvent {
  return {
    evidenceIds: [source.cardRef],
    topic,
    basis: "explicit_constraint",
    lenses,
    observation: source.userText,
    behaviorSignature: {
      situation: "before changing an artifact",
      behavior: "confirm the intended scope",
      target: "the requested change",
    },
    supportQuotes: [{
      evidenceId: source.cardRef,
      role: "user",
      source: "user_text",
      text: source.userText,
    }],
  };
}

function discovery(source: DiscoveryCard, topic: string, lenses: readonly ExperienceLens[]): FastDiscoveryResult {
  return {
    discoveryId: source.cardRef,
    taskAnchor: "confirm scope",
    episodeSummary: "The user asked the assistant to confirm scope before making a change.",
    events: [event(source, topic, lenses)],
  };
}

test("Fast discovery accepts open topic labels", () => {
  const source = card(1, "Before changing the launch plan, confirm which audience is in scope.");
  const result = validateFastDiscoveryBatch({
    discoveries: {
      d0: {
        task_anchor: "confirm launch audience",
        episode_summary: "The user constrained a product-planning change.",
        events: [{
          topic: "product launch planning",
          basis: "explicit_constraint",
          lenses: ["scope"],
          observation: source.userText,
          behavior_signature: {
            situation: "before changing a launch plan",
            behavior: "confirm the intended audience",
            target: "the plan scope",
          },
          user_quote_ids: ["u0"],
        }],
      },
    },
  }, [source]);

  assert.equal(result.discoveries[0]!.events[0]!.topic, "product launch planning");
});

test("Candidate planning compares recurring behavior across subject areas", () => {
  const research = card(1, "Confirm which claims may change before revising the paper.");
  const engineering = card(2, "Confirm which API surface may change before refactoring.");
  const plan = buildExperienceConsolidationPlan(
    [research, engineering],
    [
      discovery(research, "research manuscript revision", ["scope", "workflow"]),
      discovery(engineering, "public API maintenance", ["scope", "workflow"]),
    ],
    100_000,
  );

  assert.equal(plan.requests.length, 1);
  assert.equal(plan.requests[0]!.scope, "global");
  assert.equal(plan.requests[0]!.maximumGroups, 16);
  assert.deepEqual(plan.requests[0]!.evidence.map((item) => item.event.topic).sort(), [
    "public API maintenance",
    "research manuscript revision",
  ]);
});

test("Candidate planning falls back to primary behavioral lenses only when the global request is too large", () => {
  const sources = [
    card(1, "Use restrained language in the paper."),
    card(2, "Use restrained language in the release note."),
    card(3, "Verify the source before citing it."),
    card(4, "Verify the behavior before documenting it."),
  ];
  const discoveries = [
    discovery(sources[0]!, "academic prose", ["style"]),
    discovery(sources[1]!, "release communication", ["style"]),
    discovery(sources[2]!, "literature review", ["verification"]),
    discovery(sources[3]!, "software documentation", ["verification"]),
  ];
  const unrestricted = buildExperienceConsolidationPlan(sources, discoveries, 100_000);
  const constrained = buildExperienceConsolidationPlan(
    sources,
    discoveries,
    unrestricted.requests[0]!.estimatedInputTokens - 1,
  );

  assert.deepEqual(constrained.requests.map((request) => request.scope), ["lens:style", "lens:verification"]);
  assert.ok(constrained.requests.every((request) => request.maximumGroups === 6));
  assert.equal(constrained.requests.flatMap((request) => request.evidence).length, sources.length);
  assert.equal(constrained.localUnrouted.length, 0);
});

test("Candidate output accepts a newly derived topic", () => {
  const first = card(1, "Confirm the audience before revising the paper.");
  const second = card(2, "Confirm the audience before rewriting the onboarding flow.");
  const request = buildExperienceConsolidationPlan(
    [first, second],
    [
      discovery(first, "academic communication", ["scope"]),
      discovery(second, "product onboarding", ["scope"]),
    ],
    100_000,
  ).requests[0]!;
  const payload = experienceConsolidationRequestJson(request) as unknown as {
    readonly events: readonly { readonly event_id: string }[];
  };
  const result = validateExperienceConsolidation({
    request_id: request.requestRef,
    groups: [{
      lens: "scope",
      hypothesis: "Confirm the intended audience before changing user-facing material.",
      topic: "audience-aware change planning",
      relation: "shared_principle",
      event_ids: payload.events.map((item) => item.event_id),
    }],
  }, request);

  assert.equal(result.groups[0]!.topic, "audience-aware change planning");
});

test("Candidate output audits recurrence confined to one episode and user message", () => {
  const first = card(1, "Check the requested boundary before editing.");
  const repeated = {
    ...card(2, "Check only the requested boundary."),
    lineageRef: first.lineageRef,
    turnStart: first.turnStart,
    userTimestamp: first.userTimestamp,
  };
  const independent = card(3, "Confirm the intended audience before rewriting.");
  const request = buildExperienceConsolidationPlan(
    [first, repeated, independent],
    [
      discovery(first, "change boundaries", ["scope"]),
      discovery(repeated, "change boundaries", ["scope"]),
      discovery(independent, "audience planning", ["scope"]),
    ],
    100_000,
  ).requests[0]!;
  const payload = experienceConsolidationRequestJson(request) as unknown as {
    readonly events: readonly { readonly event_id: string }[];
  };
  const confinedEventIds = request.evidence.flatMap((occurrence, index) =>
    occurrence.card.cardRef === first.cardRef || occurrence.card.cardRef === repeated.cardRef
      ? [payload.events[index]!.event_id]
      : []);

  const result = validateExperienceConsolidation({
    request_id: request.requestRef,
    groups: [{
      lens: "scope",
      hypothesis: "Check scope before editing.",
      topic: "change boundaries",
      relation: "shared_principle",
      event_ids: confinedEventIds,
    }],
  }, request);

  assert.equal(result.groups.length, 0);
  assert.deepEqual(
    result.unrouted
      .filter((item) => confinedEventIds.includes(
        payload.events[request.evidence.indexOf(item.occurrence)]!.event_id,
      ))
      .map((item) => item.reason),
    ["same_episode_only", "same_episode_only"],
  );
});
