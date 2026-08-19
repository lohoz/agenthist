import path from "node:path";

import type { Agent } from "../domain/agent.js";
import { canonicalDigest } from "../domain/history-identity.js";
import type { ConversationMessage, JsonValue, StoredSession } from "../domain/history.js";
import type { HistoricalToolEvidence } from "../domain/portable-context.js";

export const EXPERIENCE_INDEX_SCHEMA = "agenthist.experience-index/v7" as const;
export const EXPERIENCE_PARSER_VERSION = "agenthist.experience-parser/v3" as const;
export const EXPERIENCE_LINEAGE_VERSION = "agenthist.experience-lineage/v1" as const;

export const DEFAULT_EXPERIENCE_MAX_INPUT_TOKENS = 50_000;
export const DEFAULT_EXPERIENCE_MAX_DEEP_INPUT_TOKENS = 128_000;
export const DEFAULT_EXPERIENCE_REQUEST_INPUT_TOKENS = 64_000;

const MAX_DISCOVERY_USER_BYTES = 8 * 1024;
const MAX_ASSISTANT_EVIDENCE_BYTES = 6 * 1024;
const MAX_PREVIOUS_USER_BYTES = 3 * 1024;
const MAX_PRECEDING_ASSISTANT_BYTES = 4 * 1024;
const MAX_NEXT_USER_BYTES = 3 * 1024;
const MAX_TOOL_VALUE_BYTES = 1024;
const MAX_TOOL_EVIDENCE_BYTES = 4 * 1024;
const MAX_DISCOVERY_CARDS_PER_REQUEST = 8;
const REQUEST_OVERHEAD_TOKENS = 1_200;

export const EXPERIENCE_TOPICS = [
  "research_writing",
  "research_literature",
  "research_experimentation",
  "research_analysis",
  "software_development",
  "software_testing",
  "software_debugging",
  "data_analysis",
  "version_control",
  "project_workflow",
  "communication_style",
  "general",
] as const;
export type ExperienceTopic = (typeof EXPERIENCE_TOPICS)[number];

export interface ExperienceToolSummary {
  readonly name: string;
  readonly namespace: string;
  readonly status: string;
  readonly inputSummary: string;
  readonly outputSummary: string;
  readonly errorSummary: string;
  readonly resources: number;
  readonly references: number;
}

export interface ExperienceAssistantEvidence {
  readonly ordinal: number;
  readonly timestamp: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface ExperienceAdjacentUserEvidence {
  readonly ordinal: number;
  readonly timestamp: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface ExperienceBeat {
  readonly beatRef: string;
  readonly sessionRef: string;
  readonly sourceRevision: string;
  readonly agent: Agent;
  readonly lineageRef: string;
  readonly projectKey: string;
  readonly context: string;
  readonly turnStart: number;
  readonly turnEnd: number;
  readonly userTimestamp: string;
  readonly userText: string;
  readonly previousUser?: ExperienceAdjacentUserEvidence;
  readonly precedingAssistant: readonly ExperienceAssistantEvidence[];
  readonly assistant: readonly ExperienceAssistantEvidence[];
  readonly tools: readonly ExperienceToolSummary[];
  readonly omittedTools: number;
  readonly nextUser?: ExperienceAdjacentUserEvidence;
}

export interface DiscoveryCard {
  readonly cardRef: string;
  readonly beatRef: string;
  readonly sessionRef: string;
  readonly sourceRevision: string;
  readonly agent: Agent;
  readonly lineageRef: string;
  readonly projectKey: string;
  readonly context: string;
  readonly turnStart: number;
  readonly turnEnd: number;
  readonly userTimestamp: string;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
  readonly userByteStart: number;
  readonly userByteEnd: number;
  readonly userText: string;
  readonly previousUser?: ExperienceAdjacentUserEvidence;
  readonly precedingAssistant: readonly ExperienceAssistantEvidence[];
  readonly assistant: readonly ExperienceAssistantEvidence[];
  readonly tools: readonly ExperienceToolSummary[];
  readonly omittedTools: number;
  readonly nextUser?: ExperienceAdjacentUserEvidence;
  readonly contentDigest: string;
  readonly requestBytes: number;
  readonly estimatedInputTokens: number;
}

export interface SessionExperienceIndex {
  readonly parserVersion: typeof EXPERIENCE_PARSER_VERSION;
  readonly sessionRef: string;
  readonly sourceRevision: string;
  readonly agent: Agent;
  readonly snapshotId: string;
  readonly lineageRef: string;
  readonly logicalDigest: string;
  readonly nativeRelationKeys: readonly string[];
  readonly projectKey: string;
  readonly context: string;
  readonly updatedAt: string;
  readonly beats: readonly ExperienceBeat[];
  readonly cards: readonly DiscoveryCard[];
}

export interface ExperienceLineageInput {
  readonly sessionRef: string;
  readonly logicalDigest: string;
  readonly nativeRelationKeys: readonly string[];
}

export interface ExperienceBudgetPlan {
  readonly selected: readonly DiscoveryCard[];
  readonly totalCards: number;
  readonly selectedCards: number;
  readonly remainingCards: number;
  readonly estimatedFastInputTokens: number;
  readonly fastRequests: number;
  readonly deepInputTokensUpperBound: number;
  readonly deepRequestsUpperBound: number;
}

export interface ExperienceCardBatch {
  readonly cards: readonly DiscoveryCard[];
  readonly estimatedInputTokens: number;
}

interface Envelope {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

const ENVELOPE_HEADER = /<<<AGENTHIST_([A-Z0-9_]+)_V1>>>/g;
const KNOWN_ENVELOPES = new Set([
  "HISTORICAL_TOOL_EVIDENCE",
  "HISTORICAL_RESOURCE",
  "HISTORICAL_REFERENCE",
  "HISTORICAL_CITATIONS",
  "HISTORICAL_CONTEXT",
  "HISTORICAL_WORK_STATE",
  "HISTORICAL_EVENT",
  "HISTORICAL_REASONING_SUMMARY",
  "HISTORICAL_REASONING_TRACE",
]);

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function historicalEnvelopes(text: string): Envelope[] {
  const result: Envelope[] = [];
  ENVELOPE_HEADER.lastIndex = 0;
  for (let match = ENVELOPE_HEADER.exec(text); match !== null; match = ENVELOPE_HEADER.exec(text)) {
    const name = match[1]!;
    if (!KNOWN_ENVELOPES.has(name)) continue;
    const payloadStart = match.index + match[0].length;
    const footer = `<<<END_AGENTHIST_${name}_V1>>>`;
    const footerStart = text.indexOf(footer, payloadStart);
    if (footerStart < 0) continue;
    const payloadText = text.slice(payloadStart, footerStart).trim();
    let payload: unknown;
    try { payload = JSON.parse(payloadText); } catch { continue; }
    const record = objectValue(payload);
    if (
      record === undefined || typeof record.notice !== "string" ||
      !record.notice.startsWith("Historical ") || typeof record.source_agent !== "string"
    ) continue;
    result.push({ start: match.index, end: footerStart + footer.length, name, payload: record });
    ENVELOPE_HEADER.lastIndex = footerStart + footer.length;
  }
  return result;
}

function removeHistoricalEnvelopes(text: string): string {
  const envelopes = historicalEnvelopes(text);
  if (envelopes.length === 0) return text.trim();
  let result = "";
  let offset = 0;
  for (const envelope of envelopes) {
    result += text.slice(offset, envelope.start);
    offset = envelope.end;
  }
  return (result + text.slice(offset)).trim();
}

function textBlocks(message: ConversationMessage): string | undefined {
  if (message.portableBlocks === undefined || message.portableBlocks.length === 0) return undefined;
  const text = message.portableBlocks.flatMap((block) => block.kind === "text" ? [block.text] : []);
  return text.length === 0 ? "" : text.join("\n\n");
}

export function experienceVisibleText(message: ConversationMessage): string {
  return removeHistoricalEnvelopes(textBlocks(message) ?? message.text);
}

function boundedUtf8(value: string, maximumBytes: number): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return { text: value, truncated: false };
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function jsonSummary(value: unknown): string {
  if (value === undefined) return "";
  let candidate: string | undefined;
  try { candidate = JSON.stringify(value); } catch { return "[unserializable]"; }
  const rendered = candidate ?? "[unserializable]";
  return boundedUtf8(rendered, MAX_TOOL_VALUE_BYTES).text;
}

interface ToolEvent {
  readonly phase: "call" | "result" | "exchange";
  readonly callId: string;
  readonly name: string;
  readonly namespace: string;
  readonly status: string;
  readonly inputSummary: string;
  readonly outputSummary: string;
  readonly errorSummary: string;
  readonly resources: number;
  readonly references: number;
}

function toolEvent(tool: HistoricalToolEvidence): ToolEvent {
  return {
    phase: tool.phase,
    callId: tool.callId,
    name: tool.name ?? "",
    namespace: tool.namespace ?? "",
    status: tool.status ?? (tool.error === undefined ? "" : "error"),
    inputSummary: jsonSummary(tool.input),
    outputSummary: jsonSummary(tool.output),
    errorSummary: jsonSummary(tool.error),
    resources: tool.resources?.length ?? 0,
    references: tool.references?.length ?? 0,
  };
}

function envelopeToolEvent(envelope: Envelope): ToolEvent | undefined {
  if (envelope.name !== "HISTORICAL_TOOL_EVIDENCE") return undefined;
  const value = envelope.payload;
  const phase = value.phase;
  if (
    phase !== "call" && phase !== "result" && phase !== "exchange" ||
    typeof value.call_id !== "string"
  ) return undefined;
  return {
    phase,
    callId: value.call_id,
    name: typeof value.name === "string" ? value.name : "",
    namespace: typeof value.namespace === "string" ? value.namespace : "",
    status: typeof value.status === "string" ? value.status : value.error === undefined ? "" : "error",
    inputSummary: jsonSummary(value.input),
    outputSummary: jsonSummary(value.output),
    errorSummary: jsonSummary(value.error),
    resources: Array.isArray(value.resources) ? value.resources.length : 0,
    references: Array.isArray(value.references) ? value.references.length : 0,
  };
}

function messageToolEvents(message: ConversationMessage): ToolEvent[] {
  const structured = (message.portableBlocks ?? []).flatMap((block): ToolEvent[] =>
    block.kind === "historical_tool" ? [toolEvent(block.tool)] : []);
  if (structured.length !== 0) return structured;
  return historicalEnvelopes(message.text).flatMap((envelope): ToolEvent[] => {
    const event = envelopeToolEvent(envelope);
    return event === undefined ? [] : [event];
  });
}

function closeToolEvents(events: readonly ToolEvent[]): ExperienceToolSummary[] {
  const calls = new Map<string, ToolEvent>();
  const result: ExperienceToolSummary[] = [];
  for (const event of events) {
    if (event.phase === "call") {
      calls.set(event.callId, event);
      continue;
    }
    const call = event.phase === "result" ? calls.get(event.callId) : undefined;
    if (event.phase === "result" && call === undefined) continue;
    result.push({
      name: event.name || call?.name || "unknown",
      namespace: event.namespace || call?.namespace || "",
      status: event.status || (event.errorSummary === "" ? "completed" : "error"),
      inputSummary: event.inputSummary || call?.inputSummary || "",
      outputSummary: event.outputSummary,
      errorSummary: event.errorSummary,
      resources: event.resources,
      references: event.references,
    });
    if (call !== undefined) calls.delete(event.callId);
  }
  return result;
}

function boundedToolEvidence(tools: readonly ExperienceToolSummary[]): {
  readonly tools: readonly ExperienceToolSummary[];
  readonly omittedTools: number;
} {
  const selected: ExperienceToolSummary[] = [];
  let bytes = 0;
  for (const tool of tools) {
    const toolBytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
    if (bytes + toolBytes > MAX_TOOL_EVIDENCE_BYTES) break;
    selected.push(tool);
    bytes += toolBytes;
  }
  return { tools: selected, omittedTools: tools.length - selected.length };
}

interface TextFragment {
  readonly text: string;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export function splitExperienceText(value: string, maximumBytes = MAX_DISCOVERY_USER_BYTES): TextFragment[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 64) {
    throw new Error("experience text byte limit must be at least 64");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0) return [];
  const fragments: TextFragment[] = [];
  let start = 0;
  while (start < bytes.byteLength) {
    let end = Math.min(start + maximumBytes, bytes.byteLength);
    if (end < bytes.byteLength) {
      while (end > start && (bytes[end]! & 0xc0) === 0x80) end--;
      const minimumPreferred = start + Math.floor((end - start) / 2);
      const paragraph = bytes.lastIndexOf("\n\n", end - 1);
      const newline = paragraph >= minimumPreferred ? paragraph + 2 : bytes.lastIndexOf("\n", end - 1) + 1;
      if (newline > minimumPreferred) end = newline;
    }
    if (end <= start) throw new Error("experience text cannot be split safely");
    fragments.push({ text: bytes.subarray(start, end).toString("utf8"), byteStart: start, byteEnd: end });
    start = end;
  }
  return fragments;
}

export function estimateExperienceTokens(value: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii++;
    else other++;
  }
  return Math.ceil((ascii / 4 + other) * 1.2) + 16;
}

function cardRequestValue(
  card: Omit<DiscoveryCard, "cardRef" | "requestBytes" | "estimatedInputTokens">,
): Record<string, unknown> {
  return {
    discovery_id: "pending",
    agent: card.agent,
    project_key: card.projectKey,
    context: card.context,
    timestamp: card.userTimestamp,
    turn_range: [card.turnStart, card.turnEnd],
    user_byte_range: [card.userByteStart, card.userByteEnd],
    user_text: card.userText,
    context_before: {
      previous_user: card.previousUser ?? null,
      assistant: card.precedingAssistant,
    },
    assistant: card.assistant,
    tools: card.tools,
    omitted_tools: card.omittedTools,
    next_user: card.nextUser ?? null,
  };
}

function discoveryCards(beat: ExperienceBeat): DiscoveryCard[] {
  const fragments = splitExperienceText(beat.userText);
  return fragments.map((fragment, fragmentIndex): DiscoveryCard => {
    const base = {
      beatRef: beat.beatRef,
      sessionRef: beat.sessionRef,
      sourceRevision: beat.sourceRevision,
      agent: beat.agent,
      lineageRef: beat.lineageRef,
      projectKey: beat.projectKey,
      context: beat.context,
      turnStart: beat.turnStart,
      turnEnd: beat.turnEnd,
      userTimestamp: beat.userTimestamp,
      fragmentIndex,
      fragmentCount: fragments.length,
      userByteStart: fragment.byteStart,
      userByteEnd: fragment.byteEnd,
      userText: fragment.text,
      ...(beat.previousUser === undefined ? {} : { previousUser: beat.previousUser }),
      precedingAssistant: beat.precedingAssistant,
      assistant: beat.assistant,
      tools: beat.tools,
      omittedTools: beat.omittedTools,
      ...(beat.nextUser === undefined ? {} : { nextUser: beat.nextUser }),
      contentDigest: `ahcardcontent1_${canonicalDigest({
        turnStart: beat.turnStart,
        turnEnd: beat.turnEnd,
        userTimestamp: beat.userTimestamp,
        fragmentIndex,
        userText: fragment.text,
        previousUser: beat.previousUser ?? null,
        precedingAssistant: beat.precedingAssistant,
        assistant: beat.assistant,
        tools: beat.tools,
        omittedTools: beat.omittedTools,
        nextUser: beat.nextUser ?? null,
      })}`,
    };
    const cardRef = `ahcard1_${canonicalDigest({
      parser: EXPERIENCE_PARSER_VERSION,
      sessionRef: beat.sessionRef,
      sourceRevision: beat.sourceRevision,
      turnStart: beat.turnStart,
      fragmentIndex,
      contentDigest: base.contentDigest,
    })}`;
    const requestValue = cardRequestValue(base);
    const serialized = JSON.stringify({ ...requestValue, discovery_id: cardRef });
    return {
      cardRef,
      ...base,
      requestBytes: Buffer.byteLength(serialized, "utf8"),
      estimatedInputTokens: estimateExperienceTokens(serialized),
    };
  });
}

function projectKey(context: string): string {
  const normalized = context === "" ? "" : path.normalize(context);
  return `ahproj1_${canonicalDigest({ context: normalized })}`;
}

function nativeRelationKeys(session: StoredSession): string[] {
  const native = objectValue(session.native);
  const keys = new Set<string>([`${session.agent}:${session.nativeId}`]);
  if (session.agent === "codex") {
    const spawn = objectValue(native?.spawn);
    const lineage = objectValue(native?.lineage);
    const component = spawn?.componentNativeIds;
    if (spawn?.relationStatus === "valid" && Array.isArray(component)) {
      component.forEach((value) => { if (typeof value === "string" && value !== "") keys.add(`codex:${value}`); });
      for (const value of [lineage?.forkedFromId, lineage?.parentThreadId, objectValue(lineage?.historyBase)?.threadId]) {
        if (typeof value === "string" && value !== "") keys.add(`codex:${value}`);
      }
    }
  }
  if (session.agent === "opencode") {
    const component = native?.componentNativeIds;
    if (native?.relationStatus === "valid" && Array.isArray(component)) {
      component.forEach((value) => { if (typeof value === "string" && value !== "") keys.add(`opencode:${value}`); });
    }
    if (native?.relationStatus === "valid") {
      for (const value of [native.parentId, ...(Array.isArray(native.childNativeIds) ? native.childNativeIds : [])]) {
        if (typeof value === "string" && value !== "") keys.add(`opencode:${value}`);
      }
    }
  }
  return [...keys].sort();
}

function portableEvidenceIdentity(message: ConversationMessage): unknown[] {
  if (message.portableBlocks !== undefined) {
    return message.portableBlocks.flatMap((block): unknown[] => {
      if (block.kind === "text" || block.kind === "historical_tool") return [];
      if (block.kind === "historical_resource") {
        return [{
          kind: block.kind,
          sha256: block.resource.sha256,
          sizeBytes: block.resource.sizeBytes,
          mediaType: block.resource.mediaType,
          name: block.resource.name,
        }];
      }
      if (block.kind === "historical_reference") return [{ kind: block.kind, reference: block.reference }];
      if (block.kind === "historical_citations") return [{ kind: block.kind, citations: block.citations }];
      if (block.kind === "historical_context") return [{ kind: block.kind, context: block.context }];
      if (block.kind === "historical_work_state") return [{ kind: block.kind, workState: block.workState }];
      if (block.kind === "historical_event") return [{ kind: block.kind, event: block.event, reason: block.reason }];
      if (block.kind === "historical_reasoning") return [{ kind: block.kind, summary: block.summary }];
      return [{ kind: block.kind, text: block.text }];
    });
  }
  return historicalEnvelopes(message.text).flatMap((envelope): unknown[] => {
    if (envelope.name === "HISTORICAL_TOOL_EVIDENCE") return [];
    const { notice: _notice, source_agent: _sourceAgent, resolve_against: _resolveAgainst, ...payload } =
      envelope.payload;
    return [{ kind: envelope.name, payload }];
  });
}

function logicalConversationDigest(session: StoredSession): string {
  return `ahlogical1_${canonicalDigest({
    conversation: session.conversation.map((item) => item.kind === "gap"
      ? { kind: item.kind, timestamp: item.timestamp, code: item.code ?? "", label: item.label }
      : {
          kind: item.kind,
          role: item.role,
          timestamp: item.timestamp,
          text: experienceVisibleText(item),
          tools: closeToolEvents(messageToolEvents(item)),
          evidence: portableEvidenceIdentity(item),
        }),
  })}`;
}

function assistantEvidence(
  messages: readonly { readonly ordinal: number; readonly message: ConversationMessage }[],
  maximumBytes = MAX_ASSISTANT_EVIDENCE_BYTES,
): ExperienceAssistantEvidence[] {
  let remaining = maximumBytes;
  const result: ExperienceAssistantEvidence[] = [];
  for (const { ordinal, message } of messages) {
    if (remaining <= 0) break;
    const visible = experienceVisibleText(message);
    if (visible === "") continue;
    const bounded = boundedUtf8(visible, remaining);
    result.push({ ordinal, timestamp: message.timestamp, text: bounded.text, truncated: bounded.truncated });
    remaining -= Buffer.byteLength(bounded.text, "utf8");
  }
  return result;
}

export function buildSessionExperienceIndex(
  session: StoredSession,
  snapshotId: string,
  revision: string,
): SessionExperienceIndex {
  const beats: ExperienceBeat[] = [];
  const relationKeys = nativeRelationKeys(session);
  const initialLineageRef = `ahlin1_${canonicalDigest({
    version: EXPERIENCE_LINEAGE_VERSION,
    logicalDigest: logicalConversationDigest(session),
    nativeRelationKeys: relationKeys,
  })}`;
  const sessionProjectKey = projectKey(session.context);
  for (let index = 0; index < session.conversation.length; index++) {
    const item = session.conversation[index]!;
    if (item.kind !== "message" || item.role !== "user") continue;
    const userText = experienceVisibleText(item);
    if (userText === "") continue;
    const precedingAssistants: Array<{ readonly ordinal: number; readonly message: ConversationMessage }> = [];
    let previousUser: ExperienceAdjacentUserEvidence | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      const preceding = session.conversation[cursor]!;
      if (preceding.kind === "gap") break;
      if (preceding.role === "assistant") {
        precedingAssistants.unshift({ ordinal: cursor, message: preceding });
        continue;
      }
      if (preceding.role === "user") {
        const text = experienceVisibleText(preceding);
        if (text !== "") {
          const bounded = boundedUtf8(text, MAX_PREVIOUS_USER_BYTES);
          previousUser = {
            ordinal: cursor,
            timestamp: preceding.timestamp,
            text: bounded.text,
            truncated: bounded.truncated,
          };
        }
        break;
      }
    }
    const assistants: Array<{ readonly ordinal: number; readonly message: ConversationMessage }> = [];
    const tools: ToolEvent[] = [];
    let end = index;
    let nextUser: ExperienceAdjacentUserEvidence | undefined;
    for (let cursor = index + 1; cursor < session.conversation.length; cursor++) {
      const following = session.conversation[cursor]!;
      if (following.kind === "gap") {
        end = cursor;
        break;
      }
      if (following.role === "user") {
        const text = experienceVisibleText(following);
        if (text !== "") {
          const bounded = boundedUtf8(text, MAX_NEXT_USER_BYTES);
          nextUser = {
            ordinal: cursor,
            timestamp: following.timestamp,
            text: bounded.text,
            truncated: bounded.truncated,
          };
        }
        break;
      }
      if (following.role === "assistant") {
        assistants.push({ ordinal: cursor, message: following });
        tools.push(...messageToolEvents(following));
        end = cursor;
      }
    }
    const toolEvidence = boundedToolEvidence(closeToolEvents(tools));
    const beatRef = `ahbeat1_${canonicalDigest({
      parser: EXPERIENCE_PARSER_VERSION,
      sessionRef: session.sessionRef,
      sourceRevision: revision,
      turnStart: index,
      userText,
    })}`;
    beats.push({
      beatRef,
      sessionRef: session.sessionRef,
      sourceRevision: revision,
      agent: session.agent,
      lineageRef: initialLineageRef,
      projectKey: sessionProjectKey,
      context: session.context,
      turnStart: index,
      turnEnd: end,
      userTimestamp: item.timestamp,
      userText,
      ...(previousUser === undefined ? {} : { previousUser }),
      precedingAssistant: assistantEvidence(precedingAssistants, MAX_PRECEDING_ASSISTANT_BYTES),
      assistant: assistantEvidence(assistants),
      tools: toolEvidence.tools,
      omittedTools: toolEvidence.omittedTools,
      ...(nextUser === undefined ? {} : { nextUser }),
    });
  }
  const logicalDigest = logicalConversationDigest(session);
  return {
    parserVersion: EXPERIENCE_PARSER_VERSION,
    sessionRef: session.sessionRef,
    sourceRevision: revision,
    agent: session.agent,
    snapshotId,
    lineageRef: initialLineageRef,
    logicalDigest,
    nativeRelationKeys: relationKeys,
    projectKey: sessionProjectKey,
    context: session.context,
    updatedAt: session.updatedAt,
    beats,
    cards: beats.flatMap(discoveryCards),
  };
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    const parent = this.parent.get(value);
    if (parent === undefined) throw new Error("experience lineage member is missing");
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) this.parent.set(rightRoot, leftRoot);
    else this.parent.set(leftRoot, rightRoot);
  }
}

export function resolveExperienceLineages(inputs: readonly ExperienceLineageInput[]): ReadonlyMap<string, string> {
  const set = new DisjointSet();
  inputs.forEach((input) => set.add(input.sessionRef));
  const byLogical = new Map<string, string>();
  const byRelation = new Map<string, string>();
  for (const input of inputs.toSorted((left, right) => left.sessionRef.localeCompare(right.sessionRef))) {
    const logical = byLogical.get(input.logicalDigest);
    if (logical === undefined) byLogical.set(input.logicalDigest, input.sessionRef);
    else set.union(logical, input.sessionRef);
    for (const relation of input.nativeRelationKeys) {
      const related = byRelation.get(relation);
      if (related === undefined) byRelation.set(relation, input.sessionRef);
      else set.union(related, input.sessionRef);
    }
  }
  const components = new Map<string, ExperienceLineageInput[]>();
  for (const input of inputs) {
    const root = set.find(input.sessionRef);
    const values = components.get(root) ?? [];
    values.push(input);
    components.set(root, values);
  }
  const result = new Map<string, string>();
  for (const members of components.values()) {
    const lineageRef = `ahlin1_${canonicalDigest({
      version: EXPERIENCE_LINEAGE_VERSION,
      logicalDigests: [...new Set(members.map((member) => member.logicalDigest))].sort(),
      nativeRelationKeys: [...new Set(members.flatMap((member) => member.nativeRelationKeys))].sort(),
    })}`;
    members.forEach((member) => result.set(member.sessionRef, lineageRef));
  }
  return result;
}

function temporalSpread(cards: readonly DiscoveryCard[]): DiscoveryCard[] {
  const ordered = [...cards].sort((left, right) =>
    left.userTimestamp.localeCompare(right.userTimestamp) || left.cardRef.localeCompare(right.cardRef));
  if (ordered.length <= 2) return ordered;
  const result = [ordered[0]!, ordered.at(-1)!];
  const intervals: Array<readonly [number, number]> = [[0, ordered.length - 1]];
  while (intervals.length !== 0) {
    const [start, end] = intervals.shift()!;
    if (end - start <= 1) continue;
    const middle = Math.floor((start + end) / 2);
    result.push(ordered[middle]!);
    intervals.push([start, middle], [middle, end]);
  }
  return result;
}

function orderedCards(cards: readonly DiscoveryCard[]): DiscoveryCard[] {
  const byProject = new Map<string, Map<string, DiscoveryCard[]>>();
  for (const card of cards) {
    const lineages = byProject.get(card.projectKey) ?? new Map<string, DiscoveryCard[]>();
    const lineage = lineages.get(card.lineageRef) ?? [];
    lineage.push(card);
    lineages.set(card.lineageRef, lineage);
    byProject.set(card.projectKey, lineages);
  }
  const projects = [...byProject].sort(([left], [right]) => left.localeCompare(right));
  const strata: DiscoveryCard[][] = [];
  let lineageOffset = 0;
  while (true) {
    let added = false;
    for (const [, lineages] of projects) {
      const orderedLineages = [...lineages].sort(([left], [right]) => left.localeCompare(right));
      const lineage = orderedLineages[lineageOffset];
      if (lineage === undefined) continue;
      strata.push(temporalSpread(lineage[1]));
      added = true;
    }
    if (!added) break;
    lineageOffset++;
  }
  const result: DiscoveryCard[] = [];
  for (let depth = 0; result.length < cards.length; depth++) {
    for (const stratum of strata) {
      const card = stratum[depth];
      if (card !== undefined) result.push(card);
    }
  }
  return result;
}

export function planExperienceBudget(
  cards: readonly DiscoveryCard[],
  maximumInputTokens: number,
  maximumDeepInputTokens: number,
  requestInputTokens = DEFAULT_EXPERIENCE_REQUEST_INPUT_TOKENS,
): ExperienceBudgetPlan {
  for (const [label, value] of [
    ["experience input token budget", maximumInputTokens],
    ["experience deep input token budget", maximumDeepInputTokens],
    ["experience request input token budget", requestInputTokens],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  }
  const ordered = orderedCards(cards);
  const selected: DiscoveryCard[] = [];
  let totalTokens = 0;
  let requests = 0;
  let currentRequest = REQUEST_OVERHEAD_TOKENS;
  let currentCards = 0;
  for (const card of ordered) {
    const tokens = card.estimatedInputTokens;
    if (tokens + REQUEST_OVERHEAD_TOKENS > requestInputTokens) {
      throw new Error(
        `experience card exceeds --request-input-tokens: ${card.cardRef} needs approximately ` +
        `${tokens + REQUEST_OVERHEAD_TOKENS}`,
      );
    }
    const needsNewRequest = selected.length === 0 || currentCards >= MAX_DISCOVERY_CARDS_PER_REQUEST ||
      currentRequest + tokens > requestInputTokens;
    const requestCost = needsNewRequest ? REQUEST_OVERHEAD_TOKENS + tokens : tokens;
    if (totalTokens + requestCost > maximumInputTokens) break;
    if (needsNewRequest) {
      requests++;
      currentRequest = REQUEST_OVERHEAD_TOKENS;
      currentCards = 0;
      totalTokens += REQUEST_OVERHEAD_TOKENS;
    }
    selected.push(card);
    currentCards++;
    currentRequest += tokens;
    totalTokens += tokens;
  }
  const remainingCards = ordered.length - selected.length;
  const deepUpper = selected.length === 0 || remainingCards > 0 ? 0 : maximumDeepInputTokens;
  return {
    selected,
    totalCards: ordered.length,
    selectedCards: selected.length,
    remainingCards,
    estimatedFastInputTokens: totalTokens,
    fastRequests: requests,
    deepInputTokensUpperBound: deepUpper,
    deepRequestsUpperBound: deepUpper === 0 ? 0 : 4,
  };
}

export function batchExperienceCards(
  cards: readonly DiscoveryCard[],
  requestInputTokens: number,
): ExperienceCardBatch[] {
  if (!Number.isSafeInteger(requestInputTokens) || requestInputTokens < 0) {
    throw new Error("experience request input token budget must be a non-negative integer");
  }
  const batches: Array<{ cards: DiscoveryCard[]; estimatedInputTokens: number }> = [];
  for (const card of cards) {
    if (card.estimatedInputTokens + REQUEST_OVERHEAD_TOKENS > requestInputTokens) {
      throw new Error(
        `experience card exceeds --request-input-tokens: ${card.cardRef} needs approximately ` +
        `${card.estimatedInputTokens + REQUEST_OVERHEAD_TOKENS}`,
      );
    }
    const current = batches.at(-1);
    if (
      current === undefined || current.cards.length >= MAX_DISCOVERY_CARDS_PER_REQUEST ||
      current.estimatedInputTokens + card.estimatedInputTokens > requestInputTokens
    ) {
      batches.push({
        cards: [card],
        estimatedInputTokens: REQUEST_OVERHEAD_TOKENS + card.estimatedInputTokens,
      });
    } else {
      current.cards.push(card);
      current.estimatedInputTokens += card.estimatedInputTokens;
    }
  }
  return batches;
}

export function discoveryCardJson(card: DiscoveryCard): JsonValue {
  return { ...cardRequestValue(card), discovery_id: card.cardRef } as JsonValue;
}
