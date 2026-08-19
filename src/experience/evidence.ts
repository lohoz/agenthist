import { canonicalDigest } from "../domain/history-identity.js";
import {
  discoveryCardJson,
  EXPERIENCE_TOPICS,
  type DiscoveryCard,
  type ExperienceTopic,
} from "./corpus.js";
import type { JsonValue } from "../domain/history.js";

export const FAST_DISCOVERY_SCHEMA_VERSION = "agenthist.fast-discovery/v12" as const;
export const FAST_DISCOVERY_PROMPT_VERSION = "agenthist.fast-discovery-prompt/v12" as const;

export const FAST_EVIDENCE_BASES = [
  "explicit_constraint",
  "explicit_preference",
  "substantive_correction",
  "stated_workflow",
  "failure_prevention",
  "evaluation_criterion",
  "contextual_follow_up",
  "task_request",
] as const;

export const EXPERIENCE_LENSES = [
  "style",
  "workflow",
  "quality",
  "scope",
  "verification",
  "correction",
] as const;

const MAXIMUM_EVENTS = 6;
const MAXIMUM_EVENT_LENSES = 3;
const MAXIMUM_SUPPORT_QUOTES = 6;
const MAXIMUM_QUOTE_CHARACTERS = 900;
const TARGET_QUOTE_CHARACTERS = 450;
const SENTENCE_SEGMENTER = new Intl.Segmenter("und", { granularity: "sentence" });

export type FastEvidenceBasis = (typeof FAST_EVIDENCE_BASES)[number];
export type ExperienceLens = (typeof EXPERIENCE_LENSES)[number];

export interface FastBehaviorSignature {
  readonly situation: string;
  readonly behavior: string;
  readonly target: string;
}

export interface FastSupportQuote {
  readonly evidenceId: string;
  readonly role: "user";
  readonly source: "user_text" | "next_user";
  readonly text: string;
}

export interface FastEvidenceEvent {
  readonly evidenceIds: readonly string[];
  readonly topic: ExperienceTopic;
  readonly basis: FastEvidenceBasis;
  readonly lenses: readonly ExperienceLens[];
  readonly observation: string;
  readonly behaviorSignature: FastBehaviorSignature;
  readonly supportQuotes: readonly FastSupportQuote[];
}

export interface FastDiscoveryResult {
  readonly discoveryId: string;
  readonly taskAnchor: string;
  readonly episodeSummary: string;
  readonly events: readonly FastEvidenceEvent[];
}

export interface FastDiscoveryBatchResult {
  readonly discoveries: readonly FastDiscoveryResult[];
  readonly discardedDiscoveryKeys: readonly string[];
}

interface FastQuoteCandidate {
  readonly quoteId: string;
  readonly source: "user_text" | "next_user";
  readonly text: string;
}

interface FastRequestCard {
  readonly key: string;
  readonly card: DiscoveryCard;
  readonly quotes: readonly FastQuoteCandidate[];
}

function stringSchema(maxLength: number): Record<string, unknown> {
  return { type: "string", maxLength };
}

function characterLength(value: string): number {
  return [...value].length;
}

function splitLongQuote(value: string): string[] {
  const characters = [...value];
  if (characters.length <= MAXIMUM_QUOTE_CHARACTERS) return [value];
  const result: string[] = [];
  for (let index = 0; index < characters.length; index += MAXIMUM_QUOTE_CHARACTERS) {
    result.push(characters.slice(index, index + MAXIMUM_QUOTE_CHARACTERS).join(""));
  }
  return result;
}

function quoteChunks(value: string): string[] {
  const sentences = [...SENTENCE_SEGMENTER.segment(value)].flatMap((segment) =>
    splitLongQuote(segment.segment));
  const result: string[] = [];
  let current = "";
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed !== "") result.push(trimmed);
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.trim() === "") {
      if (current !== "") current += sentence;
      continue;
    }
    if (current !== "" && characterLength(current) + characterLength(sentence) > MAXIMUM_QUOTE_CHARACTERS) {
      flush();
    }
    current += sentence;
    if (characterLength(current) >= TARGET_QUOTE_CHARACTERS) flush();
  }
  flush();
  return result;
}

function quoteCandidates(card: DiscoveryCard): FastQuoteCandidate[] {
  const userSources = [
    { source: "user_text" as const, text: card.userText },
    ...(card.nextUser === undefined ? [] : [{ source: "next_user" as const, text: card.nextUser.text }]),
  ];
  const users = userSources.flatMap((source) => quoteChunks(source.text).map((text) => ({ ...source, text })));
  return users.map((candidate, index) => ({ quoteId: `u${index}`, ...candidate }));
}

function requestCards(cards: readonly DiscoveryCard[]): FastRequestCard[] {
  return cards.map((card, index) => ({ key: `d${index}`, card, quotes: quoteCandidates(card) }));
}

function eventSchema(userQuoteIds: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      topic: { type: "string", enum: EXPERIENCE_TOPICS },
      basis: { type: "string", enum: FAST_EVIDENCE_BASES },
      lenses: {
        type: "array",
        items: { type: "string", enum: EXPERIENCE_LENSES },
        minItems: 1,
        maxItems: MAXIMUM_EVENT_LENSES,
      },
      observation: stringSchema(500),
      behavior_signature: {
        type: "object",
        properties: {
          situation: stringSchema(120),
          behavior: stringSchema(140),
          target: stringSchema(100),
        },
        required: ["situation", "behavior", "target"],
        additionalProperties: false,
      },
      user_quote_ids: {
        type: "array",
        items: { type: "string", enum: userQuoteIds },
        minItems: 1,
        maxItems: MAXIMUM_SUPPORT_QUOTES,
      },
    },
    required: ["topic", "basis", "lenses", "observation", "behavior_signature", "user_quote_ids"],
    additionalProperties: false,
  };
}

function discoverySchema(request: FastRequestCard): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      task_anchor: stringSchema(200),
      episode_summary: stringSchema(500),
      events: {
        type: "array",
        items: eventSchema(request.quotes.map((quote) => quote.quoteId)),
        minItems: 1,
        maxItems: MAXIMUM_EVENTS,
      },
    },
    required: ["task_anchor", "episode_summary", "events"],
    additionalProperties: false,
  };
}

export function fastDiscoveryResponseSchema(requestedCards: readonly DiscoveryCard[]): Readonly<Record<string, unknown>> {
  const requests = requestCards(requestedCards);
  return {
    type: "object",
    properties: {
      discoveries: {
        type: "object",
        properties: Object.fromEntries(requests.map((request) => [request.key, discoverySchema(request)])),
        required: requests.map((request) => request.key),
        additionalProperties: false,
      },
    },
    required: ["discoveries"],
    additionalProperties: false,
  };
}

export function fastDiscoveryRequestJson(requestedCards: readonly DiscoveryCard[]): JsonValue {
  return requestCards(requestedCards).map((request) => ({
    discovery_key: request.key,
    timestamp: request.card.userTimestamp,
    turn_range: [request.card.turnStart, request.card.turnEnd],
    context_before: {
      previous_user: request.card.previousUser === undefined ? null : { ...request.card.previousUser },
      assistant: request.card.precedingAssistant.map((message) => ({ ...message })),
    },
    user_evidence: request.quotes.map((quote) => ({
      quote_id: quote.quoteId,
      source: quote.source,
      text: quote.text,
    })),
    assistant_context: request.card.assistant.flatMap((message) => quoteChunks(message.text).map((text) => ({
      timestamp: message.timestamp,
      text,
    }))),
    tools: request.card.tools.map((tool) => ({ ...tool })),
    omitted_tools: request.card.omittedTools,
  })) as JsonValue;
}

export class FastDiscoveryValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`fast discovery output is invalid: ${issues.slice(0, 3).join("; ")}`);
    this.name = "FastDiscoveryValidationError";
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
  values: T,
  label: string,
  issues: string[],
): T[number] | undefined {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    issues.push(`${label} must be one of: ${values.join(", ")}`);
    return undefined;
  }
  return value as T[number];
}

function stringArray<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
  issues: string[],
  minimum: number,
  maximum: number,
): T[number][] | undefined {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    issues.push(`${label} must contain ${minimum}-${maximum} values`);
    return undefined;
  }
  const result = value.flatMap((item, index) => {
    const parsed = enumValue(item, values, `${label}[${index}]`, issues);
    return parsed === undefined ? [] : [parsed];
  });
  if (new Set(result).size !== result.length) issues.push(`${label} must not contain duplicates`);
  return result.length === value.length ? result : undefined;
}

function behaviorSignature(
  value: unknown,
  label: string,
  issues: string[],
): FastBehaviorSignature | undefined {
  const item = objectValue(value, label, issues);
  if (item === undefined) return undefined;
  exactKeys(item, ["situation", "behavior", "target"], label, issues);
  const situation = textValue(item.situation, `${label}.situation`, issues, 120);
  const behavior = textValue(item.behavior, `${label}.behavior`, issues, 140);
  const target = textValue(item.target, `${label}.target`, issues, 100);
  return situation === undefined || behavior === undefined || target === undefined
    ? undefined
    : { situation, behavior, target };
}

function quoteIds(
  value: unknown,
  request: FastRequestCard,
  label: string,
  issues: string[],
): FastSupportQuote[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAXIMUM_SUPPORT_QUOTES) {
    issues.push(`${label} must contain 1-${MAXIMUM_SUPPORT_QUOTES} quote IDs`);
    return undefined;
  }
  const candidates = new Map(request.quotes.map((quote) => [quote.quoteId, quote]));
  const ids = value.flatMap((item, index) => {
    if (typeof item !== "string" || item.length > 12 || !candidates.has(item)) {
      issues.push(`${label}[${index}] is not a supplied user quote ID`);
      return [];
    }
    return [item];
  });
  if (new Set(ids).size !== ids.length) issues.push(`${label} must not contain duplicates`);
  if (ids.length !== value.length) return undefined;
  return ids.map((id) => {
    const quote = candidates.get(id)!;
    return {
      evidenceId: request.card.cardRef,
      role: "user",
      source: quote.source,
      text: quote.text,
    };
  });
}

function eventValue(
  value: unknown,
  request: FastRequestCard,
  label: string,
  issues: string[],
): FastEvidenceEvent | undefined {
  const item = objectValue(value, label, issues);
  if (item === undefined) return undefined;
  exactKeys(item, ["topic", "basis", "lenses", "observation", "behavior_signature", "user_quote_ids"], label, issues);
  const topic = enumValue(item.topic, EXPERIENCE_TOPICS, `${label}.topic`, issues);
  const basis = enumValue(item.basis, FAST_EVIDENCE_BASES, `${label}.basis`, issues);
  const lenses = stringArray(
    item.lenses,
    EXPERIENCE_LENSES,
    `${label}.lenses`,
    issues,
    1,
    MAXIMUM_EVENT_LENSES,
  );
  const observation = textValue(item.observation, `${label}.observation`, issues, 500);
  const signature = behaviorSignature(item.behavior_signature, `${label}.behavior_signature`, issues);
  const supportQuotes = quoteIds(item.user_quote_ids, request, `${label}.user_quote_ids`, issues);
  if (
    topic === undefined || basis === undefined || lenses === undefined || observation === undefined ||
    signature === undefined || supportQuotes === undefined
  ) return undefined;
  return {
    evidenceIds: [request.card.cardRef],
    topic,
    basis,
    lenses,
    observation,
    behaviorSignature: signature,
    supportQuotes,
  };
}

function discoveryValue(
  value: unknown,
  request: FastRequestCard,
  issues: string[],
): FastDiscoveryResult | undefined {
  const label = `discoveries.${request.key}`;
  const item = objectValue(value, label, issues);
  if (item === undefined) return undefined;
  exactKeys(item, ["task_anchor", "episode_summary", "events"], label, issues);
  const taskAnchor = textValue(item.task_anchor, `${label}.task_anchor`, issues, 200);
  const episodeSummary = textValue(item.episode_summary, `${label}.episode_summary`, issues, 500);
  if (!Array.isArray(item.events) || item.events.length < 1 || item.events.length > MAXIMUM_EVENTS) {
    issues.push(`${label}.events must contain 1-${MAXIMUM_EVENTS} events`);
    return undefined;
  }
  const events = item.events.flatMap((candidate, index) => {
    const event = eventValue(candidate, request, `${label}.events[${index}]`, issues);
    return event === undefined ? [] : [event];
  });
  if (taskAnchor === undefined || episodeSummary === undefined || events.length !== item.events.length) {
    return undefined;
  }
  return { discoveryId: request.card.cardRef, taskAnchor, episodeSummary, events };
}

export function validateFastDiscoveryBatch(
  value: unknown,
  requestedCards: readonly DiscoveryCard[],
): FastDiscoveryBatchResult {
  const issues: string[] = [];
  const root = objectValue(value, "root", issues);
  if (root === undefined) throw new FastDiscoveryValidationError(issues);
  exactKeys(root, ["discoveries"], "root", issues);
  const response = objectValue(root.discoveries, "root.discoveries", issues);
  if (response === undefined) throw new FastDiscoveryValidationError(issues);
  const requests = requestCards(requestedCards);
  const expectedKeys = new Set(requests.map((request) => request.key));
  const discardedDiscoveryKeys = Object.keys(response).filter((key) => !expectedKeys.has(key)).sort();
  const missing = requests.filter((request) => !(request.key in response)).map((request) => request.key);
  if (missing.length !== 0) issues.push(`root.discoveries is missing: ${missing.join(", ")}`);
  const discoveries = requests.flatMap((request) => {
    const discovery = discoveryValue(response[request.key], request, issues);
    return discovery === undefined ? [] : [discovery];
  });
  if (issues.length !== 0 || discoveries.length !== requestedCards.length) {
    throw new FastDiscoveryValidationError(issues.slice(0, 12));
  }
  return { discoveries, discardedDiscoveryKeys };
}

function cachedSupportQuotes(
  value: unknown,
  card: DiscoveryCard,
  label: string,
  issues: string[],
): FastSupportQuote[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAXIMUM_SUPPORT_QUOTES) {
    issues.push(`${label} must contain 1-${MAXIMUM_SUPPORT_QUOTES} quotes`);
    return undefined;
  }
  const result = value.flatMap((candidate, index) => {
    const quoteLabel = `${label}[${index}]`;
    const item = objectValue(candidate, quoteLabel, issues);
    if (item === undefined) return [];
    exactKeys(item, ["evidence_id", "role", "source", "text"], quoteLabel, issues);
    const evidenceId = textValue(item.evidence_id, `${quoteLabel}.evidence_id`, issues, 128);
    const role = enumValue(item.role, ["user"] as const, `${quoteLabel}.role`, issues);
    const source = enumValue(item.source, ["user_text", "next_user"] as const, `${quoteLabel}.source`, issues);
    const text = textValue(item.text, `${quoteLabel}.text`, issues, MAXIMUM_QUOTE_CHARACTERS);
    if (evidenceId !== undefined && evidenceId !== card.cardRef) {
      issues.push(`${quoteLabel}.evidence_id must match its discovery_id`);
    }
    const sourceText = source === "user_text"
      ? card.userText
      : source === "next_user" ? card.nextUser?.text : undefined;
    if (source !== undefined && (sourceText === undefined || text === undefined || !sourceText.includes(text))) {
      issues.push(`${quoteLabel}.text is not an exact user evidence substring`);
    }
    return evidenceId === undefined || role === undefined || source === undefined || text === undefined
      ? []
      : [{ evidenceId, role, source, text }];
  });
  return result.length === value.length ? result : undefined;
}

function cachedEventValue(
  value: unknown,
  card: DiscoveryCard,
  label: string,
  issues: string[],
): FastEvidenceEvent | undefined {
  const item = objectValue(value, label, issues);
  if (item === undefined) return undefined;
  exactKeys(item, [
    "evidence_ids", "topic", "basis", "lenses", "observation", "behavior_signature", "support_quotes",
  ], label, issues);
  if (!Array.isArray(item.evidence_ids) || item.evidence_ids.length !== 1 || item.evidence_ids[0] !== card.cardRef) {
    issues.push(`${label}.evidence_ids must contain only its discovery_id`);
  }
  const topic = enumValue(item.topic, EXPERIENCE_TOPICS, `${label}.topic`, issues);
  const basis = enumValue(item.basis, FAST_EVIDENCE_BASES, `${label}.basis`, issues);
  const lenses = stringArray(
    item.lenses,
    EXPERIENCE_LENSES,
    `${label}.lenses`,
    issues,
    1,
    MAXIMUM_EVENT_LENSES,
  );
  const observation = textValue(item.observation, `${label}.observation`, issues, 500);
  const signature = behaviorSignature(item.behavior_signature, `${label}.behavior_signature`, issues);
  const supportQuotes = cachedSupportQuotes(item.support_quotes, card, `${label}.support_quotes`, issues);
  if (
    topic === undefined || basis === undefined || lenses === undefined || observation === undefined ||
    signature === undefined || supportQuotes === undefined
  ) return undefined;
  return {
    evidenceIds: [card.cardRef],
    topic,
    basis,
    lenses,
    observation,
    behaviorSignature: signature,
    supportQuotes,
  };
}

export function validateCachedFastDiscovery(value: unknown, card: DiscoveryCard): FastDiscoveryResult {
  const issues: string[] = [];
  const item = objectValue(value, "cached discovery", issues);
  if (item === undefined) throw new FastDiscoveryValidationError(issues);
  exactKeys(item, ["discovery_id", "task_anchor", "episode_summary", "events"], "cached discovery", issues);
  const discoveryId = textValue(item.discovery_id, "cached discovery.discovery_id", issues, 128);
  if (discoveryId !== undefined && discoveryId !== card.cardRef) {
    issues.push("cached discovery.discovery_id does not match its card");
  }
  const taskAnchor = textValue(item.task_anchor, "cached discovery.task_anchor", issues, 200);
  const episodeSummary = textValue(item.episode_summary, "cached discovery.episode_summary", issues, 500);
  if (!Array.isArray(item.events) || item.events.length < 1 || item.events.length > MAXIMUM_EVENTS) {
    issues.push(`cached discovery.events must contain 1-${MAXIMUM_EVENTS} events`);
    throw new FastDiscoveryValidationError(issues);
  }
  const events = item.events.flatMap((candidate, index) => {
    const event = cachedEventValue(candidate, card, `cached discovery.events[${index}]`, issues);
    return event === undefined ? [] : [event];
  });
  if (
    issues.length !== 0 || discoveryId === undefined || taskAnchor === undefined || episodeSummary === undefined ||
    events.length !== item.events.length
  ) throw new FastDiscoveryValidationError(issues.slice(0, 12));
  return { discoveryId, taskAnchor, episodeSummary, events };
}

export function fastEvidenceEventJson(event: FastEvidenceEvent): JsonValue {
  return {
    evidence_ids: [...event.evidenceIds],
    topic: event.topic,
    basis: event.basis,
    lenses: [...event.lenses],
    observation: event.observation,
    behavior_signature: {
      situation: event.behaviorSignature.situation,
      behavior: event.behaviorSignature.behavior,
      target: event.behaviorSignature.target,
    },
    support_quotes: event.supportQuotes.map((quote) => ({
      evidence_id: quote.evidenceId,
      role: quote.role,
      source: quote.source,
      text: quote.text,
    })),
  } as JsonValue;
}

export function fastDiscoveryJson(result: FastDiscoveryResult): JsonValue {
  return {
    discovery_id: result.discoveryId,
    task_anchor: result.taskAnchor,
    episode_summary: result.episodeSummary,
    events: result.events.map(fastEvidenceEventJson),
  } as JsonValue;
}

export function fastDiscoveryCacheKey(card: DiscoveryCard, profileFingerprint: string): string {
  return `ahfastcache2_${canonicalDigest({
    schema: FAST_DISCOVERY_SCHEMA_VERSION,
    prompt: FAST_DISCOVERY_PROMPT_VERSION,
    profile: profileFingerprint,
    card: discoveryCardJson(card),
  })}`;
}

export function fastDiscoveryBatchRef(cards: readonly DiscoveryCard[], profileFingerprint: string): string {
  return `ahfastbatch2_${canonicalDigest({
    schema: FAST_DISCOVERY_SCHEMA_VERSION,
    prompt: FAST_DISCOVERY_PROMPT_VERSION,
    profile: profileFingerprint,
    cards: cards.map((card) => fastDiscoveryCacheKey(card, profileFingerprint)),
  })}`;
}
