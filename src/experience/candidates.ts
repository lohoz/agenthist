import {
  estimateExperienceTokens,
  EXPERIENCE_TOPICS,
  type DiscoveryCard,
  type ExperienceTopic,
} from "./corpus.js";
import {
  EXPERIENCE_LENSES,
  fastEvidenceEventJson,
  type ExperienceLens,
  type FastDiscoveryResult,
  type FastEvidenceEvent,
} from "./evidence.js";
import { canonicalDigest } from "../domain/history-identity.js";
import type { JsonValue } from "../domain/history.js";

export const CANDIDATE_ORGANIZATION_SCHEMA_VERSION = "agenthist.candidate-organization/v1" as const;
export const CANDIDATE_ORGANIZATION_PROMPT_VERSION = "agenthist.candidate-organization-prompt/v1" as const;

export const CONSOLIDATION_RELATIONS = [
  "shared_principle",
  "correction_pattern",
  "workflow_pattern",
] as const;

export const CONSOLIDATION_UNROUTED_REASONS = [
  "not_grouped",
  "same_episode_only",
  "same_message_only",
  "insufficient_evidence",
] as const;

export type ConsolidationRelation = (typeof CONSOLIDATION_RELATIONS)[number];
export type ConsolidationUnroutedReason = (typeof CONSOLIDATION_UNROUTED_REASONS)[number];
export type ConsolidationScope = "writing" | "research" | "engineering" | "workflow";

const MAXIMUM_GROUP_OCCURRENCES = 12;
const MAXIMUM_GROUPS_PER_REQUEST = 8;
const CONSOLIDATION_PROMPT_OVERHEAD_TOKENS = 2_400;

export interface EvidenceOccurrence {
  readonly occurrenceRef: string;
  readonly episodeRef: string;
  readonly mentionRefs: readonly string[];
  readonly card: DiscoveryCard;
  readonly discovery: FastDiscoveryResult;
  readonly event: FastEvidenceEvent;
  readonly eventIndex: number;
}

export interface ExperienceConsolidationRequest {
  readonly requestRef: string;
  readonly scope: ConsolidationScope;
  readonly evidence: readonly EvidenceOccurrence[];
  readonly estimatedInputTokens: number;
}

export interface ConsolidatedExperienceGroup {
  readonly groupRef: string;
  readonly requestRef: string;
  readonly scope: ConsolidationScope;
  readonly lens: ExperienceLens;
  readonly hypothesis: string;
  readonly topic: ExperienceTopic;
  readonly relation: ConsolidationRelation;
  readonly evidence: readonly EvidenceOccurrence[];
}

export interface UnroutedEvidenceOccurrence {
  readonly occurrence: EvidenceOccurrence;
  readonly reason: ConsolidationUnroutedReason;
}

export interface ExperienceConsolidationResult {
  readonly requestRef: string;
  readonly groups: readonly ConsolidatedExperienceGroup[];
  readonly unrouted: readonly UnroutedEvidenceOccurrence[];
}

export interface ExperienceConsolidationPlan {
  readonly occurrences: readonly EvidenceOccurrence[];
  readonly requests: readonly ExperienceConsolidationRequest[];
  readonly localUnrouted: readonly UnroutedEvidenceOccurrence[];
}

interface RequestAliases {
  readonly occurrenceByAlias: ReadonlyMap<string, EvidenceOccurrence>;
  readonly episodeByRef: ReadonlyMap<string, string>;
  readonly lineageByRef: ReadonlyMap<string, string>;
}

function normalizePhrase(value: string): string {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}_.:/+-]+/gu, " ").trim().replace(/\s+/g, " ");
}

function occurrenceRef(
  card: DiscoveryCard,
  discovery: FastDiscoveryResult,
  event: FastEvidenceEvent,
  eventIndex: number,
): string {
  return `ahocc3_${canonicalDigest({
    card_ref: card.cardRef,
    task_anchor: normalizePhrase(discovery.taskAnchor),
    event_index: eventIndex,
    event: fastEvidenceEventJson(event),
  })}`;
}

function episodeRef(card: DiscoveryCard): string {
  return `ahepisode3_${canonicalDigest({
    lineage_ref: card.lineageRef,
    turn_start: card.turnStart,
    user_timestamp: card.userTimestamp,
  })}`;
}

function mentionRef(card: DiscoveryCard, event: FastEvidenceEvent): string[] {
  return [...new Set(event.supportQuotes.map((quote) => {
    const source = quote.source === "user_text"
      ? { ordinal: card.turnStart, timestamp: card.userTimestamp }
      : { ordinal: card.nextUser!.ordinal, timestamp: card.nextUser!.timestamp };
    return `ahmention1_${canonicalDigest({
      lineage_ref: card.lineageRef,
      ordinal: source.ordinal,
      timestamp: source.timestamp,
    })}`;
  }))];
}

export function evidenceOccurrences(
  cards: readonly DiscoveryCard[],
  discoveries: readonly FastDiscoveryResult[],
): EvidenceOccurrence[] {
  const discoveryByRef = new Map(discoveries.map((discovery) => [discovery.discoveryId, discovery]));
  if (
    discoveryByRef.size !== discoveries.length || cards.length !== discoveries.length ||
    cards.some((card) => !discoveryByRef.has(card.cardRef))
  ) throw new Error("experience consolidation discoveries do not match their cards");
  return cards.flatMap((card) => {
    const discovery = discoveryByRef.get(card.cardRef)!;
    return discovery.events.map((event, eventIndex) => ({
      occurrenceRef: occurrenceRef(card, discovery, event, eventIndex),
      episodeRef: episodeRef(card),
      mentionRefs: mentionRef(card, event),
      card,
      discovery,
      event,
      eventIndex,
    }));
  });
}

function aliases(request: ExperienceConsolidationRequest): RequestAliases {
  const ordered = [...request.evidence].sort((left, right) => left.occurrenceRef.localeCompare(right.occurrenceRef));
  const occurrenceByAlias = new Map(ordered.map((item, index) => [`a${index}`, item]));
  const episodes = [...new Set(ordered.map((item) => item.episodeRef))].sort();
  const lineages = [...new Set(ordered.map((item) => item.card.lineageRef))].sort();
  return {
    occurrenceByAlias,
    episodeByRef: new Map(episodes.map((reference, index) => [reference, `e${index}`])),
    lineageByRef: new Map(lineages.map((reference, index) => [reference, `l${index}`])),
  };
}

function requestPayload(scope: ConsolidationScope, evidence: readonly EvidenceOccurrence[]): Record<string, unknown> {
  const mapped = aliases({ requestRef: "pending", scope, evidence, estimatedInputTokens: 0 });
  return {
    scenario: scope,
    lenses: EXPERIENCE_LENSES,
    events: [...mapped.occurrenceByAlias].map(([alias, item]) => ({
      event_id: alias,
      episode_id: mapped.episodeByRef.get(item.episodeRef),
      lineage_id: mapped.lineageByRef.get(item.card.lineageRef),
      topic: item.event.topic,
      lenses: item.event.lenses,
      basis: item.event.basis,
      task_anchor: item.discovery.taskAnchor,
      episode_summary: item.discovery.episodeSummary,
      observation: item.event.observation,
      behavior_signature: {
        situation: item.event.behaviorSignature.situation,
        behavior: item.event.behaviorSignature.behavior,
        target: item.event.behaviorSignature.target,
      },
    })),
  };
}

function makeRequest(scope: ConsolidationScope, evidence: readonly EvidenceOccurrence[]): ExperienceConsolidationRequest {
  const ordered = [...evidence].sort((left, right) => left.occurrenceRef.localeCompare(right.occurrenceRef));
  const payload = requestPayload(scope, ordered);
  const requestRef = `ahconreq2_${canonicalDigest({
    schema: CANDIDATE_ORGANIZATION_SCHEMA_VERSION,
    prompt: CANDIDATE_ORGANIZATION_PROMPT_VERSION,
    payload,
  })}`;
  return {
    requestRef,
    scope,
    evidence: ordered,
    estimatedInputTokens: CONSOLIDATION_PROMPT_OVERHEAD_TOKENS + estimateExperienceTokens(
      JSON.stringify({ request_id: requestRef, ...payload }),
    ),
  };
}

function topicScope(topic: ExperienceTopic): ConsolidationScope {
  if (topic === "research_writing" || topic === "communication_style") return "writing";
  if (
    topic === "research_literature" || topic === "research_experimentation" ||
    topic === "research_analysis" || topic === "data_analysis"
  ) return "research";
  if (
    topic === "software_development" || topic === "software_testing" ||
    topic === "software_debugging" || topic === "version_control"
  ) return "engineering";
  return "workflow";
}

function independentlyComparable(evidence: readonly EvidenceOccurrence[]): boolean {
  return new Set(evidence.map((item) => item.episodeRef)).size >= 2 &&
    new Set(evidence.flatMap((item) => item.mentionRefs)).size >= 2;
}

export function buildExperienceConsolidationPlan(
  cards: readonly DiscoveryCard[],
  discoveries: readonly FastDiscoveryResult[],
  maximumRequestTokens: number,
): ExperienceConsolidationPlan {
  if (!Number.isSafeInteger(maximumRequestTokens) || maximumRequestTokens < 0) {
    throw new Error("experience consolidation request input token budget must be a non-negative integer");
  }
  const occurrences = evidenceOccurrences(cards, discoveries);
  const requests: ExperienceConsolidationRequest[] = [];
  const localUnrouted: UnroutedEvidenceOccurrence[] = [];
  for (const scope of ["writing", "research", "engineering", "workflow"] as const) {
    const evidence = occurrences.filter((item) => topicScope(item.event.topic) === scope);
    if (evidence.length === 0) continue;
    if (independentlyComparable(evidence)) requests.push(makeRequest(scope, evidence));
    else evidence.forEach((occurrence) => localUnrouted.push({ occurrence, reason: "insufficient_evidence" }));
  }
  return { occurrences, requests, localUnrouted };
}

export function experienceConsolidationRequestJson(request: ExperienceConsolidationRequest): JsonValue {
  return {
    request_id: request.requestRef,
    schema_version: CANDIDATE_ORGANIZATION_SCHEMA_VERSION,
    ...requestPayload(request.scope, request.evidence),
  } as JsonValue;
}

function stringSchema(maxLength: number): Record<string, unknown> {
  return { type: "string", maxLength };
}

export function experienceConsolidationResponseSchema(
  request: ExperienceConsolidationRequest,
): Readonly<Record<string, unknown>> {
  const eventIds = [...aliases(request).occurrenceByAlias.keys()];
  return {
    type: "object",
    properties: {
      request_id: { type: "string", const: request.requestRef },
      groups: {
        type: "array",
        maxItems: MAXIMUM_GROUPS_PER_REQUEST,
        items: {
          type: "object",
          properties: {
            lens: { type: "string", enum: EXPERIENCE_LENSES },
            hypothesis: stringSchema(500),
            topic: { type: "string", enum: EXPERIENCE_TOPICS },
            relation: { type: "string", enum: CONSOLIDATION_RELATIONS },
            event_ids: {
              type: "array",
              items: { type: "string", enum: eventIds },
              minItems: 2,
              maxItems: MAXIMUM_GROUP_OCCURRENCES,
            },
          },
          required: ["lens", "hypothesis", "topic", "relation", "event_ids"],
          additionalProperties: false,
        },
      },
    },
    required: ["request_id", "groups"],
    additionalProperties: false,
  };
}

export class ExperienceConsolidationValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`experience consolidation output is invalid: ${issues.slice(0, 3).join("; ")}`);
    this.name = "ExperienceConsolidationValidationError";
    this.issues = issues;
  }
}

function objectValue(value: unknown, label: string, issues: string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${label} must be an object`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string, issues: string[]): void {
  const expected = new Set(keys);
  const missing = keys.filter((key) => !(key in value));
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length !== 0) issues.push(`${label} is missing: ${missing.join(", ")}`);
  if (unexpected.length !== 0) issues.push(`${label} has unsupported keys: ${unexpected.join(", ")}`);
}

function textValue(value: unknown, label: string, issues: string[], maximum: number): string | undefined {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000]/u.test(value)) {
    issues.push(`${label} must be a non-empty string`);
    return undefined;
  }
  if ([...value].length > maximum) {
    issues.push(`${label} exceeds ${maximum} characters`);
    return undefined;
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
  issues: string[],
): T[number] | undefined {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.push(`${label} must be one of: ${allowed.join(", ")}`);
    return undefined;
  }
  return value as T[number];
}

function eventIds(
  value: unknown,
  label: string,
  mapped: RequestAliases,
  issues: string[],
): string[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAXIMUM_GROUP_OCCURRENCES) {
    issues.push(`${label} must contain 2-${MAXIMUM_GROUP_OCCURRENCES} event IDs`);
    return undefined;
  }
  const result = value.flatMap((candidate, index) => {
    const id = textValue(candidate, `${label}[${index}]`, issues, 16);
    if (id !== undefined && !mapped.occurrenceByAlias.has(id)) {
      issues.push(`${label}[${index}] was not supplied in this request`);
    }
    return id === undefined ? [] : [id];
  });
  if (new Set(result).size !== result.length) issues.push(`${label} must not contain duplicates`);
  return result.length === value.length ? result : undefined;
}

function groupValue(
  value: unknown,
  index: number,
  request: ExperienceConsolidationRequest,
  mapped: RequestAliases,
  issues: string[],
): ConsolidatedExperienceGroup | undefined {
  const label = `groups[${index}]`;
  const item = objectValue(value, label, issues);
  if (item === undefined) return undefined;
  exactKeys(item, ["lens", "hypothesis", "topic", "relation", "event_ids"], label, issues);
  const lens = enumValue(item.lens, EXPERIENCE_LENSES, `${label}.lens`, issues);
  const hypothesis = textValue(item.hypothesis, `${label}.hypothesis`, issues, 500);
  const topic = enumValue(item.topic, EXPERIENCE_TOPICS, `${label}.topic`, issues);
  const relation = enumValue(item.relation, CONSOLIDATION_RELATIONS, `${label}.relation`, issues);
  const ids = eventIds(item.event_ids, `${label}.event_ids`, mapped, issues);
  const evidence = ids?.map((id) => mapped.occurrenceByAlias.get(id)!) ?? [];
  if (
    lens === undefined || hypothesis === undefined || topic === undefined || relation === undefined ||
    ids === undefined
  ) return undefined;
  const groupRef = `ahcongroup2_${canonicalDigest({
    request_ref: request.requestRef,
    lens,
    hypothesis,
    topic,
    relation,
    occurrences: evidence.map((occurrence) => occurrence.occurrenceRef),
  })}`;
  return {
    groupRef,
    requestRef: request.requestRef,
    scope: request.scope,
    lens,
    hypothesis,
    topic,
    relation,
    evidence,
  };
}

export function validateExperienceConsolidation(
  value: unknown,
  request: ExperienceConsolidationRequest,
): ExperienceConsolidationResult {
  const issues: string[] = [];
  const root = objectValue(value, "root", issues);
  if (root === undefined) throw new ExperienceConsolidationValidationError(issues);
  exactKeys(root, ["request_id", "groups"], "root", issues);
  const requestId = textValue(root.request_id, "root.request_id", issues, 128);
  if (requestId !== undefined && requestId !== request.requestRef) {
    issues.push("root.request_id does not match the requested consolidation");
  }
  const mapped = aliases(request);
  if (!Array.isArray(root.groups) || root.groups.length > MAXIMUM_GROUPS_PER_REQUEST) {
    issues.push(`root.groups must contain 0-${MAXIMUM_GROUPS_PER_REQUEST} groups`);
  }
  const parsedGroups = Array.isArray(root.groups)
    ? root.groups.flatMap((candidate, index) => {
        const group = groupValue(candidate, index, request, mapped, issues);
        return group === undefined ? [] : [group];
      })
    : [];
  const groups = [...new Map(parsedGroups.map((group) => [group.groupRef, group])).values()];
  const grouped = new Set(groups.flatMap((group) => group.evidence.map((item) => item.occurrenceRef)));
  const unrouted: UnroutedEvidenceOccurrence[] = request.evidence
    .filter((occurrence) => !grouped.has(occurrence.occurrenceRef))
    .map((occurrence) => ({ occurrence, reason: "not_grouped" }));
  if (
    issues.length !== 0 || requestId === undefined ||
    (Array.isArray(root.groups) && parsedGroups.length !== root.groups.length)
  ) throw new ExperienceConsolidationValidationError(issues.slice(0, 16));
  return { requestRef: requestId, groups, unrouted };
}

export function experienceConsolidationResultJson(result: ExperienceConsolidationResult): JsonValue {
  return {
    request_ref: result.requestRef,
    groups: result.groups.map((group) => ({
      group_ref: group.groupRef,
      lens: group.lens,
      hypothesis: group.hypothesis,
      topic: group.topic,
      relation: group.relation,
      occurrence_refs: group.evidence.map((occurrence) => occurrence.occurrenceRef),
    })),
    unrouted: result.unrouted.map((item) => ({
      occurrence_ref: item.occurrence.occurrenceRef,
      reason: item.reason,
    })),
  } as JsonValue;
}

export function validateCachedExperienceConsolidation(
  value: unknown,
  request: ExperienceConsolidationRequest,
): ExperienceConsolidationResult {
  const issues: string[] = [];
  const root = objectValue(value, "cached consolidation", issues);
  if (root === undefined) throw new ExperienceConsolidationValidationError(issues);
  exactKeys(root, ["request_ref", "groups", "unrouted"], "cached consolidation", issues);
  const requestRef = textValue(root.request_ref, "cached consolidation.request_ref", issues, 128);
  if (requestRef !== undefined && requestRef !== request.requestRef) {
    issues.push("cached consolidation.request_ref does not match its request");
  }
  const occurrences = new Map(request.evidence.map((item) => [item.occurrenceRef, item]));
  const grouped = new Set<string>();
  const parsedGroups = Array.isArray(root.groups) ? root.groups.flatMap((candidate, index) => {
    const label = `cached consolidation.groups[${index}]`;
    const item = objectValue(candidate, label, issues);
    if (item === undefined) return [];
    exactKeys(item, ["group_ref", "lens", "hypothesis", "topic", "relation", "occurrence_refs"], label, issues);
    const groupRef = textValue(item.group_ref, `${label}.group_ref`, issues, 128);
    const lens = enumValue(item.lens, EXPERIENCE_LENSES, `${label}.lens`, issues);
    const hypothesis = textValue(item.hypothesis, `${label}.hypothesis`, issues, 500);
    const topic = enumValue(item.topic, EXPERIENCE_TOPICS, `${label}.topic`, issues);
    const relation = enumValue(item.relation, CONSOLIDATION_RELATIONS, `${label}.relation`, issues);
    if (!Array.isArray(item.occurrence_refs) || item.occurrence_refs.length < 2 ||
      item.occurrence_refs.length > MAXIMUM_GROUP_OCCURRENCES) {
      issues.push(`${label}.occurrence_refs must contain 2-${MAXIMUM_GROUP_OCCURRENCES} IDs`);
      return [];
    }
    const references = item.occurrence_refs.flatMap((candidateRef, occurrenceIndex) => {
      const reference = textValue(candidateRef, `${label}.occurrence_refs[${occurrenceIndex}]`, issues, 128);
      if (reference !== undefined && !occurrences.has(reference)) {
        issues.push(`${label}.occurrence_refs[${occurrenceIndex}] was not supplied`);
      }
      return reference === undefined ? [] : [reference];
    });
    if (new Set(references).size !== references.length) {
      issues.push(`${label}.occurrence_refs must not contain duplicates`);
    }
    const evidence = references.flatMap((reference) => {
      const occurrence = occurrences.get(reference);
      if (occurrence !== undefined) grouped.add(reference);
      return occurrence === undefined ? [] : [occurrence];
    });
    return groupRef === undefined || lens === undefined || hypothesis === undefined || topic === undefined ||
      relation === undefined || evidence.length !== item.occurrence_refs.length
      ? []
      : [{
          groupRef,
          requestRef: request.requestRef,
          scope: request.scope,
          lens,
          hypothesis,
          topic,
          relation,
          evidence,
        }];
  }) : (issues.push("cached consolidation.groups must be an array"), []);
  const groups = [...new Map(parsedGroups.map((group) => [group.groupRef, group])).values()];
  const seenUnrouted = new Set<string>();
  const unrouted = Array.isArray(root.unrouted) ? root.unrouted.flatMap((candidate, index) => {
    const label = `cached consolidation.unrouted[${index}]`;
    const item = objectValue(candidate, label, issues);
    if (item === undefined) return [];
    exactKeys(item, ["occurrence_ref", "reason"], label, issues);
    const reference = textValue(item.occurrence_ref, `${label}.occurrence_ref`, issues, 128);
    const reason = enumValue(item.reason, CONSOLIDATION_UNROUTED_REASONS, `${label}.reason`, issues);
    const occurrence = reference === undefined ? undefined : occurrences.get(reference);
    if (reference !== undefined && occurrence === undefined) issues.push(`${label}.occurrence_ref was not supplied`);
    if (reference !== undefined) {
      if (grouped.has(reference)) issues.push(`${label}.occurrence_ref was already grouped`);
      if (seenUnrouted.has(reference)) issues.push(`${label}.occurrence_ref is duplicated`);
      seenUnrouted.add(reference);
    }
    return occurrence === undefined || reason === undefined ? [] : [{ occurrence, reason }];
  }) : (issues.push("cached consolidation.unrouted must be an array"), []);
  const missing = request.evidence.filter((item) =>
    !grouped.has(item.occurrenceRef) && !seenUnrouted.has(item.occurrenceRef));
  if (missing.length !== 0) issues.push("cached consolidation does not audit every ungrouped occurrence");
  if (issues.length !== 0 || requestRef === undefined) {
    throw new ExperienceConsolidationValidationError(issues.slice(0, 16));
  }
  return { requestRef, groups, unrouted };
}

export function experienceConsolidationCacheKey(
  request: ExperienceConsolidationRequest,
  profileFingerprint: string,
): string {
  return `ahconcache2_${canonicalDigest({
    schema: CANDIDATE_ORGANIZATION_SCHEMA_VERSION,
    prompt: CANDIDATE_ORGANIZATION_PROMPT_VERSION,
    profile: profileFingerprint,
    request: experienceConsolidationRequestJson(request),
  })}`;
}
