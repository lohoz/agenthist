import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import type {
  ConversationGap,
  ConversationItem,
  ConversationMessage,
  JsonValue,
} from "../../../domain/history.js";
import {
  validHistoricalReference,
  type HistoricalReferenceEvidence,
  type PortableContextBlock,
} from "../../../domain/portable-context.js";
import {
  createManagedResourceObject,
  decodeCanonicalBase64DataUri,
  managedResourceReference,
  managedResourceName,
  type ManagedResourceObject,
} from "../../../domain/resource.js";
import { canonicalCodexSessionId } from "../identity.js";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const OFFICIAL_FILENAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/i;
const USER_TURN_ABORTED_MARKER = /^<turn_aborted>\nThe user interrupted the previous turn on purpose\.(?: Any running unified exec processes (?:were terminated|may still be running in the background)\.)? If any tools\/commands were aborted, they may have partially executed(?:; verify current state before retrying)?\.\n<\/turn_aborted>$/;
const DEVELOPER_TURN_ABORTED_MARKER = /^<turn_aborted>\nThe previous turn was interrupted on purpose\.(?: Any running unified exec processes (?:were terminated|may still be running in the background)\.)? If any tools\/commands were aborted, they may have partially executed(?:; verify current state before retrying)?\.\n<\/turn_aborted>$/;
const ROLLBACK_NON_BOUNDARY_GAPS = new Set([
  "codex.response.reasoning",
  "codex.response_context",
  "codex.world_state",
  "codex.inter_agent_communication_metadata",
]);
type CodexImageDetail = "auto" | "low" | "high" | "original";

interface SessionMetadata {
  readonly id: string;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
  readonly historyMode: "legacy" | "paginated";
  readonly subagentHistoryStartOrdinal?: number;
  readonly forkedFromId?: string;
  readonly parentThreadId?: string;
  readonly historyBase?: CodexHistoryBase;
  readonly ordinal?: number;
  readonly endByteOffset: number;
}

export interface CodexHistoryBase {
  readonly threadId: string;
  readonly endOrdinalExclusive: number;
  readonly endByteOffset: number;
}

export interface ParsedCodexRollout {
  readonly nativeId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
  readonly title: string;
  readonly conversation: readonly ConversationItem[];
  readonly managedResources: readonly ManagedResourceObject[];
  readonly portableConversation: readonly ConversationItem[];
  readonly portableManagedResources: readonly ManagedResourceObject[];
  readonly materializedCompactionCheckpoints: number;
  readonly materializedRollbackTurns: number;
  readonly nativeSummary: JsonValue;
  readonly recordCount: number;
  readonly endOrdinalExclusive?: number;
  readonly historyMode: "legacy" | "paginated";
  readonly sessionId: string;
  readonly subagentHistoryStartOrdinal?: number;
  readonly forkedFromId?: string;
  readonly parentThreadId?: string;
  readonly historyBase?: CodexHistoryBase;
  readonly metadataEndByteOffset: number;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((name) => names.has(name));
}

function normalizedImageDetail(value: unknown): CodexImageDetail | undefined {
  if (value === undefined) return "high";
  return value === "auto" || value === "low" || value === "high" || value === "original"
    ? value
    : undefined;
}

function validTextElements(text: string, value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  const boundaries = new Set<number>([0]);
  let byteLength = 0;
  for (const character of text) {
    byteLength += Buffer.byteLength(character, "utf8");
    boundaries.add(byteLength);
  }
  return value.every((rawElement) => {
    const element = objectValue(rawElement);
    const byteRange = objectValue(element?.byte_range);
    if (
      element === undefined || !hasOnlyFields(element, ["byte_range", "placeholder"]) ||
      Object.keys(element).length !== 2 || byteRange === undefined ||
      !hasOnlyFields(byteRange, ["start", "end"]) || Object.keys(byteRange).length !== 2 ||
      typeof byteRange.start !== "number" || !Number.isSafeInteger(byteRange.start) || byteRange.start < 0 ||
      typeof byteRange.end !== "number" || !Number.isSafeInteger(byteRange.end) ||
      byteRange.end < byteRange.start || byteRange.end > byteLength ||
      !boundaries.has(byteRange.start) || !boundaries.has(byteRange.end)
    ) return false;
    return element.placeholder === null || typeof element.placeholder === "string";
  });
}

function jsonObject(value: string): Record<string, JsonValue> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, JsonValue>
    : undefined;
}

function localShellAction(value: unknown): JsonValue | undefined {
  const action = objectValue(value);
  if (
    action === undefined || !hasOnlyFields(
      action,
      ["type", "command", "timeout_ms", "working_directory", "env", "user"],
    ) || action.type !== "exec" || !Array.isArray(action.command) ||
    !action.command.every((part) => typeof part === "string")
  ) return undefined;
  if (
    action.timeout_ms !== undefined && action.timeout_ms !== null &&
    (typeof action.timeout_ms !== "number" || !Number.isSafeInteger(action.timeout_ms) || action.timeout_ms < 0)
  ) return undefined;
  if (
    action.working_directory !== undefined && action.working_directory !== null &&
    typeof action.working_directory !== "string"
  ) return undefined;
  if (action.user !== undefined && action.user !== null && typeof action.user !== "string") return undefined;
  const environment = action.env === undefined || action.env === null ? undefined : objectValue(action.env);
  if (
    action.env !== undefined && action.env !== null &&
    (environment === undefined || !Object.values(environment).every((item) => typeof item === "string"))
  ) return undefined;
  return action as JsonValue;
}

function webSearchAction(value: unknown): JsonValue | undefined {
  const action = objectValue(value);
  if (action === undefined) return undefined;
  if (action.type === "search") {
    if (!hasOnlyFields(action, ["type", "query", "queries"])) return undefined;
    if (
      action.query !== undefined && action.query !== null &&
      (typeof action.query !== "string" || action.query === "")
    ) return undefined;
    if (
      action.queries !== undefined && action.queries !== null &&
      (!Array.isArray(action.queries) || action.queries.length === 0 ||
        !action.queries.every((item) => typeof item === "string" && item !== ""))
    ) return undefined;
    const hasQuery = typeof action.query === "string";
    const hasQueries = Array.isArray(action.queries);
    if (!hasQuery && !hasQueries) return undefined;
    return action as JsonValue;
  }
  if (action.type === "open_page") {
    return hasOnlyFields(action, ["type", "url"]) && typeof action.url === "string" && action.url !== ""
      ? action as JsonValue
      : undefined;
  }
  if (action.type === "find_in_page") {
    return hasOnlyFields(action, ["type", "url", "pattern"]) &&
        typeof action.url === "string" && action.url !== "" &&
        typeof action.pattern === "string" && action.pattern !== ""
      ? action as JsonValue
      : undefined;
  }
  return undefined;
}

interface ParsedStructuredToolOutput {
  readonly output: readonly JsonValue[];
  readonly managedResources: readonly ManagedResourceObject[];
  readonly references: readonly HistoricalReferenceEvidence[];
  readonly notes: readonly string[];
}

function structuredToolOutput(value: unknown): ParsedStructuredToolOutput | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: JsonValue[] = [];
  const managedResources = new Map<string, ManagedResourceObject>();
  const references = new Map<string, HistoricalReferenceEvidence>();
  const notes: string[] = [];
  for (const item of value) {
    const content = objectValue(item);
    if (content === undefined) return undefined;
    if (content.type === "input_text") {
      if (!hasOnlyFields(content, ["type", "text"]) || typeof content.text !== "string") return undefined;
      output.push({ type: "input_text", text: content.text });
      continue;
    }
    if (content.type === "encrypted_content") {
      if (
        !hasOnlyFields(content, ["type", "encrypted_content"]) ||
        typeof content.encrypted_content !== "string" || content.encrypted_content === ""
      ) return undefined;
      output.push({ type: "encrypted_content", omitted: true });
      notes.push("codex.tool_output_encrypted.skipped");
      continue;
    }
    let sourceType: "input_image" | "input_audio";
    let mediaUrl: string;
    let detail: "auto" | "low" | "high" | "original" | undefined;
    if (content.type === "input_image") {
      if (!hasOnlyFields(content, ["type", "image_url", "detail"]) || typeof content.image_url !== "string") {
        return undefined;
      }
      if (
        content.detail !== undefined && content.detail !== "auto" && content.detail !== "low" &&
        content.detail !== "high" && content.detail !== "original"
      ) return undefined;
      sourceType = "input_image";
      mediaUrl = content.image_url;
      detail = content.detail;
    } else if (content.type === "input_audio") {
      if (!hasOnlyFields(content, ["type", "audio_url"]) || typeof content.audio_url !== "string") {
        return undefined;
      }
      sourceType = "input_audio";
      mediaUrl = content.audio_url;
      detail = undefined;
    } else {
      return undefined;
    }
    const decoded = decodeCanonicalBase64DataUri(mediaUrl);
    const mediaPrefix = sourceType === "input_image" ? "image/" : "audio/";
    if (decoded === undefined) {
      if (sourceType !== "input_image") return undefined;
      let protocol: string;
      try {
        protocol = new URL(mediaUrl).protocol;
      } catch {
        return undefined;
      }
      if (protocol !== "http:" && protocol !== "https:") return undefined;
      const reference: HistoricalReferenceEvidence = {
        type: "image",
        namespace: "codex.tool_output_image_url",
        locator: mediaUrl,
      };
      if (!validHistoricalReference(reference)) return undefined;
      references.set(JSON.stringify(reference), reference);
      output.push({
        type: "historical_reference",
        source_type: sourceType,
        namespace: reference.namespace,
        locator: reference.locator,
        ...(detail === undefined ? {} : { detail }),
      });
      notes.push("codex.tool_output_image.reference_preserved");
      continue;
    }
    if (!decoded.mediaType.startsWith(mediaPrefix)) return undefined;
    const name = managedResourceName("", decoded.mediaType);
    const resource = createManagedResourceObject({
      bytes: decoded.bytes,
      mediaType: decoded.mediaType,
      name,
      sourceReference: (sha256) =>
        `codex:tool-output-${sourceType}:${decoded.mediaType}:sha256:${sha256}`,
    });
    if (resource === undefined) return undefined;
    managedResources.set(JSON.stringify(managedResourceReference(resource)), resource);
    output.push({
      type: "managed_resource",
      source_type: sourceType,
      resource_relative_path: resource.relativePath,
      media_type: resource.mediaType,
      ...(detail === undefined ? {} : { detail }),
    });
    notes.push(sourceType === "input_image"
      ? "codex.tool_output_image.managed"
      : "codex.tool_output_audio.managed");
  }
  return {
    output,
    managedResources: [...managedResources.values()],
    references: [...references.values()],
    notes,
  };
}

interface ParsedCodexToolEvent {
  readonly kind:
    | "function_call"
    | "function_call_output"
    | "custom_tool_call"
    | "custom_tool_call_output"
    | "local_shell_call"
    | "web_search_call"
    | "image_generation_call"
    | "tool_search_call"
    | "tool_search_output";
  readonly family: "function" | "custom" | "local_shell" | "web_search" | "image_generation" | "tool_search";
  readonly phase: "call" | "result" | "exchange";
  readonly callId: string;
  readonly name?: string;
  readonly turnId?: string;
  readonly block: Extract<PortableContextBlock, { readonly kind: "historical_tool" }>;
  readonly notes: readonly string[];
  readonly managedResources: readonly ManagedResourceObject[];
}

interface ParsedCodexReasoningSummary {
  readonly kind: "reasoning";
  readonly block: Extract<PortableContextBlock, { readonly kind: "historical_reasoning" }>;
  readonly notes: readonly string[];
}

type ParsedCodexAssistantEvidence =
  | { readonly kind: "tool"; readonly tool: ParsedCodexToolEvent }
  | ParsedCodexReasoningSummary;

interface ParsedCodexResponseMessage {
  readonly message: ConversationMessage;
  readonly localImages: readonly string[];
  readonly localAudio: readonly string[];
  readonly embeddedImages: readonly string[];
  readonly embeddedAudio: readonly string[];
  readonly managedResources: readonly ManagedResourceObject[];
  readonly unsupportedBlocks: number;
  readonly portableWithoutDisplay?: true;
}

interface ParsedCodexDisplayMessage {
  readonly message: ConversationMessage;
  readonly localImages: readonly string[];
  readonly localAudio: readonly string[];
  readonly embeddedImages: readonly string[];
  readonly embeddedAudio: readonly string[];
  readonly mirrorValid: boolean;
  readonly externalSessionImportMarker?: boolean;
}

interface ParsedCodexMemoryCitation {
  readonly valid: boolean;
  readonly block?: Extract<PortableContextBlock, { readonly kind: "historical_citations" }>;
}

interface CodexCompactionProjection {
  readonly replacementMessages: readonly ParsedCodexResponseMessage[];
  readonly responseStart: number;
  readonly displayStart: number;
  readonly gapStart: number;
}

interface CodexRollbackProjection {
  readonly gap: ConversationGap;
  readonly numTurns: number;
}

interface ParsedCodexAbortMarker {
  readonly response: ParsedCodexResponseMessage;
  readonly timestamp: string;
  readonly turnId?: string;
}

interface FinalizedCodexConversationProjection {
  readonly conversation: readonly ConversationItem[];
  readonly messages: readonly ConversationMessage[];
  readonly selectedResponse: readonly ParsedCodexResponseMessage[];
  readonly displayMatched: boolean;
}

function codexMemoryCitation(value: unknown): ParsedCodexMemoryCitation {
  if (value === null) return { valid: true };
  const citation = objectValue(value);
  if (
    citation === undefined || !hasOnlyFields(citation, ["entries", "rolloutIds"]) ||
    !Array.isArray(citation.entries) || !Array.isArray(citation.rolloutIds)
  ) return { valid: false };
  const entries: Array<{
    readonly path: string;
    readonly lineStart: number;
    readonly lineEnd: number;
    readonly note: string;
  }> = [];
  for (const rawEntry of citation.entries) {
    const entry = objectValue(rawEntry);
    if (
      entry === undefined || !hasOnlyFields(entry, ["path", "lineStart", "lineEnd", "note"]) ||
      typeof entry.path !== "string" || entry.path === "" ||
      typeof entry.lineStart !== "number" || !Number.isSafeInteger(entry.lineStart) ||
      entry.lineStart < 0 || entry.lineStart > 0xffff_ffff ||
      typeof entry.lineEnd !== "number" || !Number.isSafeInteger(entry.lineEnd) ||
      entry.lineEnd < entry.lineStart || entry.lineEnd > 0xffff_ffff ||
      typeof entry.note !== "string"
    ) return { valid: false };
    entries.push({
      path: entry.path,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      note: entry.note,
    });
  }
  const rolloutIds: string[] = [];
  for (const id of citation.rolloutIds) {
    if (typeof id !== "string" || id === "") return { valid: false };
    rolloutIds.push(id);
  }
  if (entries.length === 0 && rolloutIds.length === 0) return { valid: true };
  return {
    valid: true,
    block: {
      kind: "historical_citations",
      citations: [{
        type: "memory_citation",
        entries,
        rolloutIds,
      }],
    },
  };
}

function withCodexMemoryCitation(
  message: ConversationMessage,
  citation: ParsedCodexMemoryCitation | undefined,
): ConversationMessage {
  if (citation?.block === undefined) return message;
  return {
    ...message,
    contentKinds: ["memory_citation"],
    portableBlocks: [citation.block],
    portableNotes: ["codex.memory_citation.materialized"],
  };
}

function codexReasoningSummary(payload: Record<string, unknown>): ParsedCodexReasoningSummary | undefined {
  if (
    payload.type !== "reasoning" || !hasOnlyFields(
      payload,
      ["type", "id", "summary", "content", "encrypted_content", "internal_chat_message_metadata_passthrough"],
    ) ||
    (payload.id !== undefined && payload.id !== null && stringValue(payload.id) === "") ||
    !Array.isArray(payload.summary) || payload.summary.length === 0
  ) return undefined;
  const summary: string[] = [];
  for (const candidate of payload.summary) {
    const part = objectValue(candidate);
    if (
      part === undefined || !hasOnlyFields(part, ["type", "text"]) ||
      part.type !== "summary_text" || typeof part.text !== "string" || part.text === ""
    ) return undefined;
    summary.push(part.text);
  }
  if (payload.content !== undefined && payload.content !== null) {
    if (!Array.isArray(payload.content) || payload.content.some((candidate) => {
      const part = objectValue(candidate);
      return part === undefined || !hasOnlyFields(part, ["type", "text"]) ||
        (part.type !== "reasoning_text" && part.type !== "text") || typeof part.text !== "string";
    })) return undefined;
  }
  if (
    payload.encrypted_content !== undefined && payload.encrypted_content !== null &&
    typeof payload.encrypted_content !== "string"
  ) return undefined;
  if (payload.internal_chat_message_metadata_passthrough !== undefined) {
    const turn = toolTurnId(payload.internal_chat_message_metadata_passthrough);
    if (!turn.valid) return undefined;
  }
  return {
    kind: "reasoning",
    block: { kind: "historical_reasoning", summary },
    notes: [
      ...(Array.isArray(payload.content) && payload.content.length !== 0
        ? ["codex.reasoning_raw.skipped"]
        : []),
      ...(typeof payload.encrypted_content === "string"
        ? ["codex.reasoning_encrypted.skipped"]
        : []),
    ],
  };
}

function toolTurnId(value: unknown): { readonly valid: boolean; readonly value?: string } {
  if (value === undefined) return { valid: true };
  const metadata = objectValue(value);
  if (metadata === undefined || !hasOnlyFields(metadata, ["turn_id"])) return { valid: false };
  const turnId = stringValue(metadata.turn_id);
  return turnId === "" ? { valid: false } : { valid: true, value: turnId };
}

const CANONICAL_AGENT_PATH = /^(?:\/morpheus|\/root(?:\/[a-z0-9_]+)*)$/;

function canonicalAgentMessageEnvelope(
  text: string,
  author: string,
  recipient: string,
): "NEW_TASK" | "MESSAGE" | "FINAL_ANSWER" | undefined {
  const marker = "\nPayload:\n";
  const boundary = text.indexOf(marker);
  if (boundary < 0) return undefined;
  const header = text.slice(0, boundary).split("\n");
  if (header.length !== 3 || header[1] !== `Task name: ${recipient}` || header[2] !== `Sender: ${author}`) {
    return undefined;
  }
  const type = header[0]?.slice("Message Type: ".length);
  return header[0] === `Message Type: ${type}` &&
      (type === "NEW_TASK" || type === "MESSAGE" || type === "FINAL_ANSWER")
    ? type
    : undefined;
}

function agentMessageFromResponse(
  payload: Record<string, unknown>,
  timestamp: string,
  deliveryTrigger: boolean | undefined,
): ParsedCodexResponseMessage | undefined {
  if (
    payload.type !== "agent_message" || deliveryTrigger === undefined ||
    !hasOnlyFields(
      payload,
      ["type", "id", "author", "recipient", "content", "internal_chat_message_metadata_passthrough"],
    ) ||
    (payload.id !== undefined && stringValue(payload.id) === "") ||
    !Array.isArray(payload.content) || payload.content.length !== 1
  ) return undefined;
  const author = stringValue(payload.author);
  const recipient = stringValue(payload.recipient);
  const content = objectValue(payload.content[0]);
  const turn = toolTurnId(payload.internal_chat_message_metadata_passthrough);
  if (
    !CANONICAL_AGENT_PATH.test(author) || !CANONICAL_AGENT_PATH.test(recipient) || author === recipient ||
    content === undefined || !hasOnlyFields(content, ["type", "text"]) ||
    content.type !== "input_text" || typeof content.text !== "string" ||
    !turn.valid || turn.value === undefined
  ) return undefined;
  const messageType = canonicalAgentMessageEnvelope(content.text, author, recipient);
  if (
    messageType === undefined ||
    (deliveryTrigger ? messageType !== "NEW_TASK" : messageType === "NEW_TASK")
  ) return undefined;
  return {
    message: {
      kind: "message",
      role: "user",
      text: content.text,
      timestamp,
      contentKinds: ["agent_message"],
      portableBlocks: [{ kind: "text", text: content.text }],
      portableNotes: ["codex.agent_message_context.materialized"],
    },
    localImages: [],
    localAudio: [],
    embeddedImages: [],
    embeddedAudio: [],
    managedResources: [],
    unsupportedBlocks: 0,
    portableWithoutDisplay: true,
  };
}

function codexToolEvent(payload: Record<string, unknown>): ParsedCodexToolEvent | undefined {
  const kind = payload.type;
  if (kind === "local_shell_call") {
    if (!hasOnlyFields(
      payload,
      ["type", "id", "call_id", "status", "action", "internal_chat_message_metadata_passthrough"],
    )) return undefined;
    const callId = stringValue(payload.call_id);
    const input = localShellAction(payload.action);
    const turn = toolTurnId(payload.internal_chat_message_metadata_passthrough);
    if (callId === "" || payload.status !== "completed" || input === undefined || !turn.valid) return undefined;
    const notes = [
      "codex.local_shell_transport.skipped",
      ...(payload.id === undefined ? [] : ["codex.tool_identity.skipped"]),
      ...(payload.internal_chat_message_metadata_passthrough === undefined
        ? []
        : ["codex.tool_metadata.skipped"]),
    ];
    if (payload.id !== undefined && stringValue(payload.id) === "") return undefined;
    return {
      kind,
      family: "local_shell",
      phase: "call",
      callId,
      name: "local_shell",
      ...(turn.value === undefined ? {} : { turnId: turn.value }),
      block: {
        kind: "historical_tool",
        tool: {
          phase: "call",
          callId,
          name: "local_shell",
          status: "completed",
          input,
        },
      },
      notes,
      managedResources: [],
    };
  }
  if (kind === "web_search_call") {
    if (!hasOnlyFields(
      payload,
      ["type", "id", "status", "action", "internal_chat_message_metadata_passthrough"],
    )) return undefined;
    const callId = stringValue(payload.id);
    const input = webSearchAction(payload.action);
    const turn = toolTurnId(payload.internal_chat_message_metadata_passthrough);
    if (callId === "" || payload.status !== "completed" || input === undefined || !turn.valid) return undefined;
    return {
      kind,
      family: "web_search",
      phase: "exchange",
      callId,
      name: "web_search",
      ...(turn.value === undefined ? {} : { turnId: turn.value }),
      block: {
        kind: "historical_tool",
        tool: {
          phase: "exchange",
          callId,
          name: "web_search",
          status: "completed",
          input,
        },
      },
      notes: [
        "codex.web_search_transport.skipped",
        ...(payload.internal_chat_message_metadata_passthrough === undefined
          ? []
          : ["codex.tool_metadata.skipped"]),
      ],
      managedResources: [],
    };
  }
  if (kind === "image_generation_call") {
    if (!hasOnlyFields(
      payload,
      ["type", "id", "status", "revised_prompt", "result", "internal_chat_message_metadata_passthrough"],
    )) return undefined;
    const callId = stringValue(payload.id);
    const revisedPrompt = payload.revised_prompt === undefined
      ? undefined
      : stringValue(payload.revised_prompt);
    const turn = toolTurnId(payload.internal_chat_message_metadata_passthrough);
    const decoded = typeof payload.result === "string"
      ? decodeCanonicalBase64DataUri(`data:image/png;base64,${payload.result}`, "image/png")
      : undefined;
    if (
      callId === "" || payload.status !== "completed" || revisedPrompt === "" ||
      decoded === undefined || !turn.valid
    ) return undefined;
    const name = managedResourceName("generated-image.png", decoded.mediaType);
    const resource = createManagedResourceObject({
      bytes: decoded.bytes,
      mediaType: decoded.mediaType,
      name,
      sourceReference: (sha256) => `codex:image-generation:${callId}:sha256:${sha256}`,
    });
    if (resource === undefined) return undefined;
    return {
      kind,
      family: "image_generation",
      phase: "exchange",
      callId,
      name: "image_generation",
      ...(turn.value === undefined ? {} : { turnId: turn.value }),
      block: {
        kind: "historical_tool",
        tool: {
          phase: "exchange",
          callId,
          name: "image_generation",
          status: "completed",
          input: revisedPrompt === undefined ? {} : { revised_prompt: revisedPrompt },
          output: {
            type: "managed_resource",
            source_type: "image_generation_result",
            resource_relative_path: resource.relativePath,
            media_type: resource.mediaType,
          },
          resources: [managedResourceReference(resource)],
        },
      },
      notes: [
        "codex.image_generation_transport.skipped",
        "codex.image_generation_result.managed",
        ...(payload.internal_chat_message_metadata_passthrough === undefined
          ? []
          : ["codex.tool_metadata.skipped"]),
      ],
      managedResources: [resource],
    };
  }
  if (kind === "tool_search_call") {
    if (!hasOnlyFields(
      payload,
      ["type", "id", "call_id", "status", "execution", "arguments", "internal_chat_message_metadata_passthrough"],
    )) return undefined;
    const callId = stringValue(payload.call_id);
    const turn = toolTurnId(payload.internal_chat_message_metadata_passthrough);
    if (
      callId === "" || payload.execution !== "client" || payload.arguments === undefined || !turn.valid ||
      (payload.status !== undefined && payload.status !== null && payload.status !== "completed")
    ) return undefined;
    if (payload.id !== undefined && stringValue(payload.id) === "") return undefined;
    return {
      kind,
      family: "tool_search",
      phase: "call",
      callId,
      name: "tool_search",
      ...(turn.value === undefined ? {} : { turnId: turn.value }),
      block: {
        kind: "historical_tool",
        tool: {
          phase: "call",
          callId,
          name: "tool_search",
          input: { execution: "client", arguments: payload.arguments as JsonValue },
          ...(payload.status === "completed" ? { status: "completed" } : {}),
        },
      },
      notes: [
        "codex.tool_search_transport.skipped",
        ...(payload.id === undefined ? [] : ["codex.tool_identity.skipped"]),
        ...(payload.internal_chat_message_metadata_passthrough === undefined
          ? []
          : ["codex.tool_metadata.skipped"]),
      ],
      managedResources: [],
    };
  }
  if (kind === "tool_search_output") {
    if (!hasOnlyFields(
      payload,
      ["type", "id", "call_id", "status", "execution", "tools", "internal_chat_message_metadata_passthrough"],
    )) return undefined;
    const callId = stringValue(payload.call_id);
    const turn = toolTurnId(payload.internal_chat_message_metadata_passthrough);
    if (
      callId === "" || payload.execution !== "client" || payload.status !== "completed" ||
      !Array.isArray(payload.tools) || !turn.valid
    ) return undefined;
    if (payload.id !== undefined && stringValue(payload.id) === "") return undefined;
    return {
      kind,
      family: "tool_search",
      phase: "result",
      callId,
      ...(turn.value === undefined ? {} : { turnId: turn.value }),
      block: {
        kind: "historical_tool",
        tool: {
          phase: "result",
          callId,
          output: {
            execution: "client",
            status: "completed",
            tools: payload.tools as JsonValue[],
          },
        },
      },
      notes: [
        ...(payload.id === undefined ? [] : ["codex.tool_identity.skipped"]),
        ...(payload.internal_chat_message_metadata_passthrough === undefined
          ? []
          : ["codex.tool_metadata.skipped"]),
      ],
      managedResources: [],
    };
  }
  if (
    kind !== "function_call" && kind !== "function_call_output" &&
    kind !== "custom_tool_call" && kind !== "custom_tool_call_output"
  ) return undefined;
  const family = kind.startsWith("custom_") ? "custom" : "function";
  const phase = kind.endsWith("_output") ? "result" : "call";
  const allowed = kind === "function_call"
    ? [
      "type", "name", "namespace", "arguments", "encrypted_function_args", "call_id", "id",
      "internal_chat_message_metadata_passthrough",
    ]
    : kind === "function_call_output"
      ? ["type", "call_id", "output", "id", "internal_chat_message_metadata_passthrough"]
      : kind === "custom_tool_call"
        ? [
          "type", "name", "namespace", "input", "call_id", "id", "status",
          "internal_chat_message_metadata_passthrough",
        ]
        : ["type", "call_id", "name", "output", "id", "internal_chat_message_metadata_passthrough"];
  if (!hasOnlyFields(payload, allowed)) return undefined;
  const callId = stringValue(payload.call_id);
  const turn = toolTurnId(payload.internal_chat_message_metadata_passthrough);
  if (callId === "" || !turn.valid) return undefined;
  let notes = payload.internal_chat_message_metadata_passthrough === undefined
    ? []
    : ["codex.tool_metadata.skipped"];
  if (payload.id !== undefined) {
    if (stringValue(payload.id) === "") return undefined;
    notes = [...notes, "codex.tool_identity.skipped"];
  }
  if (phase === "call") {
    const name = stringValue(payload.name);
    const namespace = payload.namespace === undefined ? undefined : stringValue(payload.namespace);
    const status = payload.status === undefined ? undefined : stringValue(payload.status);
    const input = family === "function"
      ? jsonObject(stringValue(payload.arguments))
      : typeof payload.input === "string" ? payload.input : undefined;
    if (name === "" || input === undefined) return undefined;
    if (namespace === "" || status === "") return undefined;
    if (payload.encrypted_function_args !== undefined) {
      if (
        !Array.isArray(payload.encrypted_function_args) ||
        payload.encrypted_function_args.some((value) => typeof value !== "string")
      ) return undefined;
      notes = [...notes, "codex.encrypted_function_args.skipped"];
    }
    if (family === "custom") notes = [...notes, "codex.custom_tool_transport.skipped"];
    return {
      kind,
      family,
      phase,
      callId,
      name,
      ...(turn.value === undefined ? {} : { turnId: turn.value }),
      block: {
        kind: "historical_tool",
        tool: {
          phase: "call",
          callId,
          name,
          input,
          ...(namespace === undefined ? {} : { namespace }),
          ...(status === undefined ? {} : { status }),
        },
      },
      notes,
      managedResources: [],
    };
  }
  const parsedOutput = typeof payload.output === "string"
    ? { output: payload.output, managedResources: [], references: [], notes: [] }
    : structuredToolOutput(payload.output);
  if (parsedOutput === undefined) return undefined;
  const name = payload.name === undefined ? undefined : stringValue(payload.name);
  if (name === "") return undefined;
  return {
    kind,
    family,
    phase,
    callId,
    ...(name === undefined ? {} : { name }),
    ...(turn.value === undefined ? {} : { turnId: turn.value }),
    block: {
      kind: "historical_tool",
      tool: {
        phase: "result",
        callId,
        output: parsedOutput.output,
        ...(parsedOutput.managedResources.length === 0
          ? {}
          : { resources: parsedOutput.managedResources.map(managedResourceReference) }),
        ...(parsedOutput.references.length === 0 ? {} : { references: parsedOutput.references }),
      },
    },
    notes: [...notes, ...parsedOutput.notes],
    managedResources: parsedOutput.managedResources,
  };
}

function parseMetadata(payload: Record<string, unknown>): Omit<SessionMetadata, "endByteOffset"> | undefined {
  const id = stringValue(payload.id);
  const rawSessionId = stringValue(payload.session_id);
  const timestamp = stringValue(payload.timestamp);
  const cwd = stringValue(payload.cwd);
  if (
    id === "" ||
    timestamp === "" ||
    cwd === "" ||
    stringValue(payload.originator) === "" ||
    stringValue(payload.cli_version) === ""
  ) {
    return undefined;
  }
  let canonical: string;
  let sessionId: string;
  try {
    canonical = canonicalCodexSessionId(id);
    sessionId = rawSessionId === "" ? canonical : canonicalCodexSessionId(rawSessionId);
  } catch {
    return undefined;
  }
  const historyMode = payload.history_mode === undefined ? "legacy" : payload.history_mode;
  if (historyMode !== "legacy" && historyMode !== "paginated") return undefined;
  const optionalId = (value: unknown): string | undefined | null => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return null;
    try {
      return canonicalCodexSessionId(value);
    } catch {
      return null;
    }
  };
  const forkedFromId = optionalId(payload.forked_from_id);
  const parentThreadId = optionalId(payload.parent_thread_id);
  if (forkedFromId === null || parentThreadId === null || forkedFromId === canonical || parentThreadId === canonical) {
    return undefined;
  }
  let historyBase: CodexHistoryBase | undefined;
  if (payload.history_base !== undefined) {
    const base = objectValue(payload.history_base);
    const threadId = optionalId(base?.thread_id);
    if (
      base === undefined || !hasOnlyFields(base, ["thread_id", "end_ordinal_exclusive", "end_byte_offset"]) ||
      Object.keys(base).length !== 3 || threadId === undefined || threadId === null || threadId === canonical ||
      typeof base.end_ordinal_exclusive !== "number" || !Number.isSafeInteger(base.end_ordinal_exclusive) ||
      base.end_ordinal_exclusive <= 0 ||
      typeof base.end_byte_offset !== "number" || !Number.isSafeInteger(base.end_byte_offset) ||
      base.end_byte_offset <= 0 || historyMode !== "paginated"
    ) return undefined;
    historyBase = {
      threadId,
      endOrdinalExclusive: base.end_ordinal_exclusive,
      endByteOffset: base.end_byte_offset,
    };
  }
  let subagentHistoryStartOrdinal: number | undefined;
  if (payload.subagent_history_start_ordinal !== undefined) {
    if (
      typeof payload.subagent_history_start_ordinal !== "number" ||
      !Number.isSafeInteger(payload.subagent_history_start_ordinal) ||
      payload.subagent_history_start_ordinal < 1 || historyMode !== "paginated" ||
      parentThreadId === undefined || sessionId === canonical
    ) return undefined;
    subagentHistoryStartOrdinal = payload.subagent_history_start_ordinal;
  }
  if (sessionId !== canonical && parentThreadId === undefined) return undefined;
  return {
    id: canonical,
    sessionId,
    timestamp,
    cwd,
    provider: stringValue(payload.model_provider),
    model: stringValue(payload.model) || stringValue(payload.model_name),
    historyMode,
    ...(subagentHistoryStartOrdinal === undefined ? {} : { subagentHistoryStartOrdinal }),
    ...(forkedFromId === undefined ? {} : { forkedFromId }),
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(historyBase === undefined ? {} : { historyBase }),
  };
}

function localInputMediaResource(
  content: readonly unknown[],
  index: number,
  expectedOrdinal: number,
  mediaKind: "image" | "audio",
): { readonly resource: ManagedResourceObject; readonly mirrorKey: string } | undefined {
  const opening = objectValue(content[index]);
  const media = objectValue(content[index + 1]);
  const closing = objectValue(content[index + 2]);
  const mediaFields = mediaKind === "image" ? ["type", "image_url", "detail"] : ["type", "audio_url"];
  const mediaType = `input_${mediaKind}`;
  if (
    opening === undefined || media === undefined || closing === undefined ||
    !hasOnlyFields(opening, ["type", "text"]) || opening.type !== "input_text" ||
    !hasOnlyFields(media, mediaFields) || media.type !== mediaType ||
    !hasOnlyFields(closing, ["type", "text"]) || closing.type !== "input_text" ||
    closing.text !== `</${mediaKind}>`
  ) return undefined;
  const wrapper = typeof opening.text === "string"
    ? mediaKind === "image"
      ? /^<image name=\[Image #(\d+)\] path="([^"\r\n]+)">$/.exec(opening.text)
      : /^<audio name=\[Audio #(\d+)\] path="([^"\r\n]+)">$/.exec(opening.text)
    : null;
  if (wrapper === null || Number(wrapper[1]) !== expectedOrdinal) return undefined;
  const sourcePath = wrapper[2]!;
  if (
    !path.posix.isAbsolute(sourcePath) || path.posix.normalize(sourcePath) !== sourcePath ||
    path.posix.basename(sourcePath) === ""
  ) return undefined;
  const imageDetail = mediaKind === "image" ? normalizedImageDetail(media.detail) : undefined;
  if (mediaKind === "image" && imageDetail === undefined) return undefined;
  const mediaUrl = mediaKind === "image" ? media.image_url : media.audio_url;
  const decoded = typeof mediaUrl === "string"
    ? decodeCanonicalBase64DataUri(mediaUrl)
    : undefined;
  if (decoded === undefined || !decoded.mediaType.startsWith(`${mediaKind}/`)) return undefined;
  const name = managedResourceName(path.posix.basename(sourcePath), decoded.mediaType);
  const resource = createManagedResourceObject({
    bytes: decoded.bytes,
    mediaType: decoded.mediaType,
    name,
    sourceReference: sourcePath,
  });
  return resource === undefined
    ? undefined
    : {
      resource,
      mirrorKey: mediaKind === "image" ? JSON.stringify([sourcePath, imageDetail]) : sourcePath,
    };
}

type ParsedCodexEmbeddedInputMedia =
  | {
    readonly kind: "resource";
    readonly resource: ManagedResourceObject;
    readonly mirrorKey: string;
  }
  | {
    readonly kind: "reference";
    readonly reference: HistoricalReferenceEvidence;
    readonly mirrorKey: string;
  };

function embeddedInputMedia(
  media: Record<string, unknown>,
  expectedOrdinal: number,
  mediaKind: "image" | "audio",
  expectedType: "image" | "audio" | "input_image" | "input_audio",
): ParsedCodexEmbeddedInputMedia | undefined {
  const mediaFields = mediaKind === "image" ? ["type", "image_url", "detail"] : ["type", "audio_url"];
  if (!hasOnlyFields(media, mediaFields) || media.type !== expectedType) return undefined;
  const detail = mediaKind === "image" ? normalizedImageDetail(media.detail) : undefined;
  if (mediaKind === "image" && detail === undefined) return undefined;
  const mediaUrl = mediaKind === "image" ? media.image_url : media.audio_url;
  const decoded = typeof mediaUrl === "string"
    ? decodeCanonicalBase64DataUri(mediaUrl)
    : undefined;
  if (decoded !== undefined && decoded.mediaType.startsWith(`${mediaKind}/`)) {
    const fallbackName = managedResourceName("", decoded.mediaType);
    const suffix = fallbackName.slice("attachment".length);
    const resource = createManagedResourceObject({
      bytes: decoded.bytes,
      mediaType: decoded.mediaType,
      name: `input-${mediaKind}-${expectedOrdinal}${suffix}`,
      sourceReference: (sha256) => `codex:user-input:${mediaKind}:${expectedOrdinal}:sha256:${sha256}`,
    });
    if (resource === undefined) return undefined;
    return {
      kind: "resource",
      resource,
      mirrorKey: JSON.stringify([resource.sha256, resource.sizeBytes, resource.mediaType, detail]),
    };
  }
  if (mediaKind !== "image" || typeof mediaUrl !== "string") return undefined;
  let protocol: string;
  try {
    protocol = new URL(mediaUrl).protocol;
  } catch {
    return undefined;
  }
  if (protocol !== "http:" && protocol !== "https:") return undefined;
  const reference: HistoricalReferenceEvidence = {
    type: "image",
    namespace: "codex.input_image_url",
    locator: mediaUrl,
  };
  if (!validHistoricalReference(reference)) return undefined;
  return {
    kind: "reference",
    reference,
    mirrorKey: JSON.stringify([mediaUrl, detail]),
  };
}

function legacyEmbeddedMedia(
  urlsValue: unknown,
  detailsValue: unknown,
  mediaKind: "image" | "audio",
): readonly string[] | undefined {
  const urls = urlsValue === undefined ? [] : urlsValue;
  if (!Array.isArray(urls) || !urls.every((value) => typeof value === "string")) return undefined;
  const details = mediaKind === "image"
    ? detailsValue === undefined ? [] : detailsValue
    : [];
  if (
    !Array.isArray(details) || details.length > urls.length ||
    !details.every((value) => value === null || value === "auto" || value === "low" ||
      value === "high" || value === "original")
  ) return undefined;
  const mirrorKeys: string[] = [];
  for (let index = 0; index < urls.length; index++) {
    const detail = details[index];
    const media = mediaKind === "image"
      ? {
        type: "image",
        image_url: urls[index],
        ...(detail === undefined || detail === null ? {} : { detail }),
      }
      : { type: "audio", audio_url: urls[index] };
    const parsed = embeddedInputMedia(media, index + 1, mediaKind, mediaKind);
    if (parsed === undefined) return undefined;
    mirrorKeys.push(parsed.mirrorKey);
  }
  return mirrorKeys;
}

function legacyLocalImageMirror(
  pathsValue: unknown,
  detailsValue: unknown,
): readonly string[] | undefined {
  const paths = pathsValue === undefined ? [] : pathsValue;
  const details = detailsValue === undefined ? [] : detailsValue;
  if (
    !Array.isArray(paths) || !paths.every((value) =>
      typeof value === "string" && path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
      path.posix.basename(value) !== "") ||
    !Array.isArray(details) || details.length > paths.length ||
    !details.every((value) => value === null || normalizedImageDetail(value) !== undefined)
  ) return undefined;
  return paths.map((sourcePath, index) => {
    const detail = details[index];
    return JSON.stringify([sourcePath, normalizedImageDetail(detail === null ? undefined : detail)]);
  });
}

function messageFromResponse(
  payload: Record<string, unknown>,
  timestamp: string,
  model: string,
): ParsedCodexResponseMessage | undefined {
  if (payload.type !== "message") {
    return undefined;
  }
  const role = payload.role;
  if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") {
    return undefined;
  }
  if (!Array.isArray(payload.content)) {
    return undefined;
  }
  const text: string[] = [];
  const portableBlocks: PortableContextBlock[] = [];
  const contentKinds: string[] = [];
  const localImages: string[] = [];
  const localAudio: string[] = [];
  const embeddedImages: string[] = [];
  const embeddedAudio: string[] = [];
  const managedResources: ManagedResourceObject[] = [];
  let unsupportedBlocks = 0;
  let imageOrdinal = 1;
  let audioOrdinal = 1;
  for (let index = 0; index < payload.content.length;) {
    const rawBlock = payload.content[index];
    const block = objectValue(rawBlock);
    const kind = stringValue(block?.type);
    const image = role === "user" && kind === "input_text"
      ? localInputMediaResource(payload.content, index, imageOrdinal, "image")
      : undefined;
    if (image !== undefined) {
      contentKinds.push("input_image");
      portableBlocks.push({ kind: "historical_resource", resource: managedResourceReference(image.resource) });
      localImages.push(image.mirrorKey);
      managedResources.push(image.resource);
      imageOrdinal++;
      index += 3;
      continue;
    }
    const audio = role === "user" && kind === "input_text"
      ? localInputMediaResource(payload.content, index, audioOrdinal, "audio")
      : undefined;
    if (audio !== undefined) {
      contentKinds.push("input_audio");
      portableBlocks.push({ kind: "historical_resource", resource: managedResourceReference(audio.resource) });
      localAudio.push(audio.mirrorKey);
      managedResources.push(audio.resource);
      audioOrdinal++;
      index += 3;
      continue;
    }
    const embeddedImage = role === "user" && kind === "input_image" && block !== undefined
      ? embeddedInputMedia(block, imageOrdinal, "image", "input_image")
      : undefined;
    if (embeddedImage !== undefined) {
      contentKinds.push("input_image");
      portableBlocks.push(embeddedImage.kind === "resource"
        ? { kind: "historical_resource", resource: managedResourceReference(embeddedImage.resource) }
        : { kind: "historical_reference", reference: embeddedImage.reference });
      embeddedImages.push(embeddedImage.mirrorKey);
      if (embeddedImage.kind === "resource") managedResources.push(embeddedImage.resource);
      imageOrdinal++;
      index++;
      continue;
    }
    const embeddedAudioItem = role === "user" && kind === "input_audio" && block !== undefined
      ? embeddedInputMedia(block, audioOrdinal, "audio", "input_audio")
      : undefined;
    if (embeddedAudioItem !== undefined) {
      contentKinds.push("input_audio");
      portableBlocks.push(embeddedAudioItem.kind === "resource"
        ? { kind: "historical_resource", resource: managedResourceReference(embeddedAudioItem.resource) }
        : { kind: "historical_reference", reference: embeddedAudioItem.reference });
      embeddedAudio.push(embeddedAudioItem.mirrorKey);
      if (embeddedAudioItem.kind === "resource") managedResources.push(embeddedAudioItem.resource);
      audioOrdinal++;
      index++;
      continue;
    }
    contentKinds.push(kind === "" ? "unknown" : kind);
    if (block === undefined || typeof block.text !== "string") {
      unsupportedBlocks++;
      index++;
      continue;
    }
    if (
      kind === "text" ||
      (role === "user" && kind === "input_text") ||
      (role !== "user" && (kind === "output_text" || kind === "input_text"))
    ) {
      text.push(block.text);
      portableBlocks.push({ kind: "text", text: block.text });
    } else {
      unsupportedBlocks++;
    }
    index++;
  }
  if (portableBlocks.length === 0) {
    return undefined;
  }
  return {
    message: {
      kind: "message",
      role,
      text: text.join("\n"),
      timestamp,
      contentKinds,
      portableBlocks,
      ...(role === "assistant" && model !== "" ? { model } : {}),
    },
    localImages,
    localAudio,
    embeddedImages,
    embeddedAudio,
    managedResources,
    unsupportedBlocks,
  };
}

function codexAbortMarker(
  payload: Record<string, unknown>,
  timestamp: string,
  model: string,
): ParsedCodexAbortMarker | undefined {
  if (!hasOnlyFields(
    payload,
    ["type", "id", "role", "content", "phase", "internal_chat_message_metadata_passthrough"],
  ) || payload.type !== "message" || (payload.role !== "user" && payload.role !== "developer") ||
    !Array.isArray(payload.content) || payload.content.length !== 1 ||
    (payload.id !== undefined && payload.id !== null &&
      (typeof payload.id !== "string" || payload.id === "")) ||
    (payload.phase !== undefined && payload.phase !== null)) return undefined;
  const content = objectValue(payload.content[0]);
  const text = content?.text;
  const markerValid = payload.role === "user"
    ? typeof text === "string" && USER_TURN_ABORTED_MARKER.test(text)
    : typeof text === "string" && DEVELOPER_TURN_ABORTED_MARKER.test(text);
  const turn = toolTurnId(payload.internal_chat_message_metadata_passthrough);
  const response = messageFromResponse(payload, timestamp, model);
  if (
    content === undefined || !hasOnlyFields(content, ["type", "text"]) || content.type !== "input_text" ||
    !markerValid || !turn.valid || response === undefined || response.unsupportedBlocks !== 0
  ) return undefined;
  return {
    response,
    timestamp,
    ...(turn.value === undefined ? {} : { turnId: turn.value }),
  };
}

function materializedTurnAbortedResponse(
  marker: ParsedCodexAbortMarker,
  model: string,
): ParsedCodexResponseMessage {
  return {
    message: {
      kind: "message",
      role: "assistant",
      text: "[turn aborted]\nThe preceding Codex turn was interrupted; persisted output may be partial.",
      timestamp: marker.timestamp,
      contentKinds: ["turn_aborted"],
      portableBlocks: [{ kind: "historical_event", event: "turn_aborted", reason: "interrupted" }],
      portableNotes: ["codex.turn_aborted.materialized"],
      ...(model === "" ? {} : { model }),
    },
    localImages: [],
    localAudio: [],
    embeddedImages: [],
    embeddedAudio: [],
    managedResources: [],
    unsupportedBlocks: 0,
    portableWithoutDisplay: true,
  };
}

function compactedReplacementMessages(
  payload: Record<string, unknown>,
  timestamp: string,
): ParsedCodexResponseMessage[] | undefined {
  if (
    typeof payload.message !== "string" || payload.message === "" ||
    !Array.isArray(payload.replacement_history) || payload.replacement_history.length === 0
  ) {
    return undefined;
  }
  const messages: ParsedCodexResponseMessage[] = [];
  for (const rawMessage of payload.replacement_history) {
    const message = objectValue(rawMessage);
    if (
      message === undefined || !hasOnlyFields(
        message,
        ["type", "id", "role", "content", "phase", "internal_chat_message_metadata_passthrough"],
      ) || message.type !== "message" || message.role !== "user" || !Array.isArray(message.content) ||
      message.content.length !== 1
    ) return undefined;
    if (
      message.id !== undefined && message.id !== null &&
      (typeof message.id !== "string" || message.id === "")
    ) return undefined;
    if (message.phase !== undefined && message.phase !== null) return undefined;
    if (
      message.internal_chat_message_metadata_passthrough !== undefined &&
      message.internal_chat_message_metadata_passthrough !== null &&
      !toolTurnId(message.internal_chat_message_metadata_passthrough).valid
    ) return undefined;
    const text: string[] = [];
    for (const rawContent of message.content) {
      const content = objectValue(rawContent);
      if (
        content === undefined || !hasOnlyFields(content, ["type", "text"]) ||
        content.type !== "input_text" || typeof content.text !== "string" || content.text === ""
      ) return undefined;
      text.push(content.text);
    }
    messages.push({
      message: {
        kind: "message",
        role: "user",
        text: text.join("\n"),
        timestamp,
        contentKinds: text.map(() => "input_text"),
        portableBlocks: text.map((value) => ({ kind: "text", text: value })),
      },
      localImages: [],
      localAudio: [],
      embeddedImages: [],
      embeddedAudio: [],
      managedResources: [],
      unsupportedBlocks: 0,
    });
  }
  return messages.at(-1)?.message.text === payload.message ? messages : undefined;
}

function responseGap(payload: Record<string, unknown>): { readonly code: string; readonly label: string } {
  const candidate = typeof payload.type === "string" ? payload.type : "";
  const kind = /^[A-Za-z0-9._-]{1,64}$/.test(candidate) ? candidate : "unclassified";
  return {
    code: `codex.response.${kind.toLowerCase().replaceAll("-", "_")}`,
    label: `native ${kind} content retained in raw history`,
  };
}

function rolloutGap(type: string): { readonly code: string; readonly label: string } {
  const kind = /^[A-Za-z0-9._-]{1,64}$/.test(type) ? type : "unclassified";
  return {
    code: `codex.rollout.${kind.toLowerCase().replaceAll("-", "_")}`,
    label: `native ${kind} rollout item retained in raw history`,
  };
}

function isWorldStatePayload(payload: Record<string, unknown>): boolean {
  return hasOnlyFields(payload, ["full", "state"]) && typeof payload.full === "boolean" &&
    Object.prototype.hasOwnProperty.call(payload, "state");
}

function isInterAgentCommunicationMetadata(payload: Record<string, unknown>): boolean {
  return hasOnlyFields(payload, ["trigger_turn"]) && typeof payload.trigger_turn === "boolean";
}

function isThreadRollbackPayload(payload: Record<string, unknown>): boolean {
  return hasOnlyFields(payload, ["type", "num_turns"]) && payload.type === "thread_rolled_back" &&
    typeof payload.num_turns === "number" && Number.isSafeInteger(payload.num_turns) &&
    payload.num_turns > 0 && payload.num_turns <= 0xffff_ffff;
}

function isTurnAbortedPayload(payload: Record<string, unknown>): boolean {
  if (!hasOnlyFields(payload, ["type", "turn_id", "reason", "started_at", "completed_at", "duration_ms"])) {
    return false;
  }
  const optionalInteger = (value: unknown): boolean =>
    value === undefined || value === null || typeof value === "number" && Number.isSafeInteger(value);
  return payload.type === "turn_aborted" &&
    (payload.turn_id === undefined || payload.turn_id === null ||
      typeof payload.turn_id === "string" && payload.turn_id !== "") &&
    (payload.reason === "interrupted" || payload.reason === "replaced" ||
      payload.reason === "review_ended" || payload.reason === "budget_limited") &&
    optionalInteger(payload.started_at) && optionalInteger(payload.completed_at) &&
    optionalInteger(payload.duration_ms);
}

function isContextCompactedPayload(payload: Record<string, unknown>): boolean {
  return hasOnlyFields(payload, ["type"]) && payload.type === "context_compacted";
}

function reconcileDisplayMessages(
  response: readonly ParsedCodexResponseMessage[],
  display: readonly ParsedCodexDisplayMessage[],
): {
  readonly extras: readonly ParsedCodexResponseMessage[];
  readonly selected: readonly ParsedCodexResponseMessage[];
  readonly messages: readonly ConversationMessage[];
  readonly skippedExternalSessionImportMarkers: readonly ParsedCodexDisplayMessage[];
  readonly matched: boolean;
} {
  const used = new Set<number>();
  const matchedDisplay = new Map<number, ParsedCodexDisplayMessage>();
  const skippedExternalSessionImportMarkers: ParsedCodexDisplayMessage[] = [];
  let cursor = 0;
  for (const shown of display) {
    let found = -1;
    for (let index = cursor; index < response.length; index++) {
      const candidate = response[index]!;
      if (
        shown.mirrorValid && candidate.message.role === shown.message.role &&
        candidate.message.text === shown.message.text &&
        candidate.localImages.length === shown.localImages.length &&
        candidate.localImages.every((value, imageIndex) => value === shown.localImages[imageIndex]) &&
        candidate.localAudio.length === shown.localAudio.length &&
        candidate.localAudio.every((value, audioIndex) => value === shown.localAudio[audioIndex]) &&
        candidate.embeddedImages.length === shown.embeddedImages.length &&
        candidate.embeddedImages.every((value, imageIndex) => value === shown.embeddedImages[imageIndex]) &&
        candidate.embeddedAudio.length === shown.embeddedAudio.length &&
        candidate.embeddedAudio.every((value, audioIndex) => value === shown.embeddedAudio[audioIndex])
      ) {
        found = index;
        break;
      }
    }
    if (found < 0 && shown.externalSessionImportMarker === true) {
      skippedExternalSessionImportMarkers.push(shown);
      continue;
    }
    if (found < 0) {
      return {
        extras: [],
        selected: [],
        messages: [],
        skippedExternalSessionImportMarkers: [],
        matched: false,
      };
    }
    used.add(found);
    matchedDisplay.set(found, shown);
    cursor = found + 1;
  }
  const selected = response.flatMap((message, index): ParsedCodexResponseMessage[] => {
    if (!used.has(index) && message.portableWithoutDisplay !== true) return [];
    const shown = matchedDisplay.get(index);
    const contentKinds = shown?.message.contentKinds ?? [];
    const portableBlocks = shown?.message.portableBlocks ?? [];
    const portableNotes = shown?.message.portableNotes ?? [];
    if (contentKinds.length === 0 && portableBlocks.length === 0 && portableNotes.length === 0) return [message];
    return [{
      ...message,
      message: {
        ...message.message,
        contentKinds: [...(message.message.contentKinds ?? []), ...contentKinds],
        portableBlocks: [...(message.message.portableBlocks ?? []), ...portableBlocks],
        portableNotes: [...(message.message.portableNotes ?? []), ...portableNotes],
      },
    }];
  });
  return {
    extras: response.filter((message, index) => !used.has(index) && message.portableWithoutDisplay !== true),
    selected,
    messages: selected.map((message) => message.message),
    skippedExternalSessionImportMarkers,
    matched: true,
  };
}

function finalizeConversationProjection(
  prefix: readonly ParsedCodexResponseMessage[],
  response: readonly ParsedCodexResponseMessage[],
  display: readonly ParsedCodexDisplayMessage[],
  sourceGaps: readonly ConversationItem[],
  updatedAt: string,
): FinalizedCodexConversationProjection {
  const gaps = [...sourceGaps];
  let selectedResponse: readonly ParsedCodexResponseMessage[] = response;
  let messages: readonly ConversationMessage[] = response.map((message) => message.message);
  let displayMatched = false;
  if (display.length !== 0) {
    const reconciled = reconcileDisplayMessages(response, display);
    displayMatched = reconciled.matched;
    selectedResponse = reconciled.matched ? reconciled.selected : [];
    messages = reconciled.matched ? reconciled.messages : display.map((message) => message.message);
    if (!reconciled.matched) {
      gaps.push({
        kind: "gap",
        code: "codex.display_mirror_mismatch",
        label: "Codex visible message mirror does not match response history",
        timestamp: updatedAt,
      });
    } else {
      for (const marker of reconciled.skippedExternalSessionImportMarkers) {
        gaps.push({
          kind: "gap",
          code: "codex.external_session_import_marker",
          label: "Codex external-session import marker retained only in native history",
          timestamp: marker.message.timestamp,
        });
      }
      for (const extra of reconciled.extras) {
        const hiddenReasoning = extra.message.contentKinds?.filter((kind) => kind === "reasoning").length ?? 0;
        for (let index = 0; index < hiddenReasoning; index++) {
          const gap = responseGap({ type: "reasoning" });
          gaps.push({ kind: "gap", ...gap, timestamp: extra.message.timestamp });
        }
        gaps.push({
          kind: "gap",
          code: "codex.response_context",
          label: "Codex execution context is retained only in native history",
          timestamp: extra.message.timestamp,
        });
      }
    }
  }
  const projectedMessages = [...prefix.map((message) => message.message), ...messages];
  const conversation = [...projectedMessages, ...gaps].sort((left, right) => {
    const leftTime = Date.parse(left.timestamp);
    const rightTime = Date.parse(right.timestamp);
    return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
  });
  return {
    conversation,
    messages: projectedMessages,
    selectedResponse: [...prefix, ...selectedResponse],
    displayMatched,
  };
}

function coalesceInheritedUserMessages(
  messages: readonly ParsedCodexResponseMessage[],
): ParsedCodexResponseMessage[] {
  const result: ParsedCodexResponseMessage[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (previous?.message.role !== "user" || message.message.role !== "user") {
      result.push(message);
      continue;
    }
    result[result.length - 1] = {
      ...previous,
      message: {
        ...previous.message,
        text: [previous.message.text, message.message.text].filter((text) => text !== "").join("\n"),
        timestamp: message.message.timestamp,
        contentKinds: [...(previous.message.contentKinds ?? []), ...(message.message.contentKinds ?? [])],
        portableBlocks: [...(previous.message.portableBlocks ?? []), ...(message.message.portableBlocks ?? [])],
        portableNotes: [
          ...(previous.message.portableNotes ?? []),
          ...(message.message.portableNotes ?? []),
          "codex.subagent_inherited_user_messages.coalesced",
        ],
      },
      localImages: [...previous.localImages, ...message.localImages],
      localAudio: [...previous.localAudio, ...message.localAudio],
      embeddedImages: [...previous.embeddedImages, ...message.embeddedImages],
      embeddedAudio: [...previous.embeddedAudio, ...message.embeddedAudio],
      managedResources: [...previous.managedResources, ...message.managedResources],
      unsupportedBlocks: previous.unsupportedBlocks + message.unsupportedBlocks,
    };
  }
  return result;
}

function materializeRollbackProjection(
  projection: FinalizedCodexConversationProjection,
  rollbacks: readonly CodexRollbackProjection[],
  recordTimestampsMonotonic: boolean,
  protectedCompactionPrefix: readonly ParsedCodexResponseMessage[],
): { readonly projection: FinalizedCodexConversationProjection; readonly materializedTurns: number } {
  if (!recordTimestampsMonotonic || !projection.displayMatched || rollbacks.length === 0) {
    return { projection, materializedTurns: 0 };
  }
  const rollbackByGap = new Map<ConversationGap, number>(
    rollbacks.map((rollback): readonly [ConversationGap, number] => [rollback.gap, rollback.numTurns]),
  );
  const timestampCounts = new Map<number, number>();
  const protectedMessages = new Set(protectedCompactionPrefix.map((message) => message.message));
  for (const item of projection.conversation) {
    const instant = Date.parse(item.timestamp);
    timestampCounts.set(instant, (timestampCounts.get(instant) ?? 0) + 1);
  }
  const conversation: ConversationItem[] = [];
  let materializedTurns = 0;
  for (const item of projection.conversation) {
    const numTurns = item.kind === "gap" ? rollbackByGap.get(item) : undefined;
    if (numTurns === undefined || timestampCounts.get(Date.parse(item.timestamp)) !== 1) {
      conversation.push(item);
      continue;
    }
    const userPositions = conversation.flatMap((candidate, index) =>
      candidate.kind === "message" && candidate.role === "user" ? [index] : []);
    if (userPositions.length === 0) {
      conversation.push(item);
      continue;
    }
    if (conversation.some((candidate) =>
      candidate.kind === "gap" && !ROLLBACK_NON_BOUNDARY_GAPS.has(candidate.code ?? ""))) {
      conversation.push(item);
      continue;
    }
    const droppedTurns = Math.min(numTurns, userPositions.length);
    const cutIndex = userPositions[userPositions.length - droppedTurns]!;
    const cutMessage = conversation[cutIndex];
    if (cutMessage?.kind !== "message" || protectedMessages.has(cutMessage)) {
      conversation.push(item);
      continue;
    }
    conversation.splice(cutIndex);
    materializedTurns += droppedTurns;
  }
  if (materializedTurns === 0) return { projection, materializedTurns: 0 };
  const messages = conversation.filter((item): item is ConversationMessage => item.kind === "message");
  const retainedMessages = new Set(messages);
  return {
    projection: {
      ...projection,
      conversation,
      messages,
      selectedResponse: projection.selectedResponse.filter((message) => retainedMessages.has(message.message)),
    },
    materializedTurns,
  };
}

function legacyDisplayMessage(
  payload: Record<string, unknown>,
  timestamp: string,
  model: string,
): ParsedCodexDisplayMessage | undefined {
  if ((payload.type !== "user_message" && payload.type !== "agent_message") || typeof payload.message !== "string") {
    return undefined;
  }
  const isUser = payload.type === "user_message";
  const localImages = isUser
    ? legacyLocalImageMirror(payload.local_images, payload.local_image_details)
    : [];
  const localAudio = isUser && Array.isArray(payload.local_audio) &&
      payload.local_audio.every((value) => typeof value === "string")
    ? payload.local_audio as string[]
    : [];
  const embeddedImages = isUser
    ? legacyEmbeddedMedia(payload.images, payload.image_details, "image")
    : [];
  const embeddedAudio = isUser
    ? legacyEmbeddedMedia(payload.audio, undefined, "audio")
    : [];
  const localAudioValid = !isUser || payload.local_audio === undefined || (
    Array.isArray(payload.local_audio) && payload.local_audio.every((value) =>
      typeof value === "string" && path.posix.isAbsolute(value) && path.posix.normalize(value) === value)
  );
  const textElementsValid = !isUser || payload.text_elements === undefined ||
    validTextElements(payload.message, payload.text_elements);
  const portableNotes = isUser && Array.isArray(payload.text_elements) && payload.text_elements.length !== 0
    ? ["codex.user_text_elements.skipped"]
    : [];
  const citation = !isUser && Object.hasOwn(payload, "memory_citation")
    ? codexMemoryCitation(payload.memory_citation)
    : undefined;
  const externalSessionImportMarker = !isUser &&
    payload.message === "<EXTERNAL SESSION IMPORTED>" &&
    hasOnlyFields(payload, ["type", "message", "phase", "memory_citation"]) &&
    (payload.phase === undefined || payload.phase === null) &&
    (payload.memory_citation === undefined || payload.memory_citation === null);
  return {
    message: withCodexMemoryCitation({
      kind: "message",
      role: isUser ? "user" : "assistant",
      text: payload.message,
      timestamp,
      ...(!isUser && model !== "" ? { model } : {}),
      ...(portableNotes.length === 0 ? {} : { portableNotes }),
    }, citation),
    localImages: localImages ?? [],
    localAudio,
    embeddedImages: embeddedImages ?? [],
    embeddedAudio: embeddedAudio ?? [],
    mirrorValid: localImages !== undefined && embeddedImages !== undefined && localAudioValid &&
      embeddedAudio !== undefined && textElementsValid &&
      (citation?.valid ?? true),
    ...(externalSessionImportMarker ? { externalSessionImportMarker: true } : {}),
  };
}

function paginatedDisplayMessage(
  payload: Record<string, unknown>,
  timestamp: string,
  model: string,
): ParsedCodexDisplayMessage | undefined {
  if (payload.type !== "item_completed") return undefined;
  const item = objectValue(payload.item);
  if (item === undefined || stringValue(item.id) === "" || !Array.isArray(item.content)) return undefined;
  if (item.type === "UserMessage") {
    const text: string[] = [];
    const localImages: string[] = [];
    const localAudio: string[] = [];
    const embeddedImages: string[] = [];
    const embeddedAudio: string[] = [];
    const portableNotes: string[] = [];
    let mirrorValid = true;
    let imageOrdinal = 1;
    let audioOrdinal = 1;
    for (const rawContent of item.content) {
      const content = objectValue(rawContent);
      if (content?.type === "text") {
        if (
          !hasOnlyFields(content, ["type", "text", "text_elements"]) || typeof content.text !== "string" ||
          !validTextElements(content.text, content.text_elements)
        ) return undefined;
        text.push(content.text);
        if (content.text_elements.length !== 0) portableNotes.push("codex.user_text_elements.skipped");
        continue;
      }
      if (content?.type === "local_image") {
        const detail = normalizedImageDetail(content.detail);
        if (
          !hasOnlyFields(content, ["type", "path", "detail"]) || typeof content.path !== "string" ||
          !path.posix.isAbsolute(content.path) || path.posix.normalize(content.path) !== content.path ||
          path.posix.basename(content.path) === "" || detail === undefined
        ) return undefined;
        localImages.push(JSON.stringify([content.path, detail]));
        imageOrdinal++;
        continue;
      }
      if (content?.type === "local_audio") {
        if (
          !hasOnlyFields(content, ["type", "path"]) || typeof content.path !== "string" ||
          !path.posix.isAbsolute(content.path) || path.posix.normalize(content.path) !== content.path
        ) return undefined;
        localAudio.push(content.path);
        audioOrdinal++;
        continue;
      }
      if (content?.type === "image") {
        const parsed = embeddedInputMedia(content, imageOrdinal, "image", "image");
        if (parsed === undefined) return undefined;
        embeddedImages.push(parsed.mirrorKey);
        imageOrdinal++;
        continue;
      }
      if (content?.type === "audio") {
        const parsed = embeddedInputMedia(content, audioOrdinal, "audio", "audio");
        if (parsed === undefined) return undefined;
        embeddedAudio.push(parsed.mirrorKey);
        audioOrdinal++;
        continue;
      }
      if (content?.type === "skill" || content?.type === "mention") {
        if (
          !hasOnlyFields(content, ["type", "name", "path"]) || Object.keys(content).length !== 3 ||
          typeof content.name !== "string" || content.name === "" ||
          typeof content.path !== "string" || content.path === ""
        ) return undefined;
        portableNotes.push(content.type === "skill"
          ? "codex.user_skill_selection.skipped"
          : "codex.user_mention_selection.skipped");
        continue;
      }
      mirrorValid = false;
    }
    return {
      message: {
        kind: "message",
        role: "user",
        text: text.join("\n"),
        timestamp,
        ...(portableNotes.length === 0 ? {} : { portableNotes }),
      },
      localImages,
      localAudio,
      embeddedImages,
      embeddedAudio,
      mirrorValid,
    };
  }
  if (item.type === "AgentMessage") {
    const text: string[] = [];
    for (const rawContent of item.content) {
      const content = objectValue(rawContent);
      if (
        content === undefined || content.type !== "Text" || typeof content.text !== "string"
      ) return undefined;
      text.push(content.text);
    }
    const citation = Object.hasOwn(item, "memory_citation")
      ? codexMemoryCitation(item.memory_citation)
      : undefined;
    return {
      message: withCodexMemoryCitation({
        kind: "message",
        role: "assistant",
        text: text.join("\n"),
        timestamp,
        ...(model === "" ? {} : { model }),
      }, citation),
      localImages: [],
      localAudio: [],
      embeddedImages: [],
      embeddedAudio: [],
      mirrorValid: citation?.valid ?? true,
    };
  }
  return undefined;
}

function displayMessage(
  payload: Record<string, unknown>,
  timestamp: string,
  model: string,
): ParsedCodexDisplayMessage | undefined {
  return legacyDisplayMessage(payload, timestamp, model) ?? paginatedDisplayMessage(payload, timestamp, model);
}

function isDisplayMessagePayload(payload: Record<string, unknown>): boolean {
  if (payload.type === "user_message" || payload.type === "agent_message") return true;
  const item = objectValue(payload.item);
  return payload.type === "item_completed" && (item?.type === "UserMessage" || item?.type === "AgentMessage");
}

function uniqueManagedResources(messages: readonly ParsedCodexResponseMessage[]): ManagedResourceObject[] {
  const resources = new Map<string, ManagedResourceObject>();
  for (const resource of messages.flatMap((message) => message.managedResources)) {
    const reference = managedResourceReference(resource);
    const key = JSON.stringify(reference);
    const existing = resources.get(key);
    if (existing !== undefined && !Buffer.from(existing.bytes).equals(Buffer.from(resource.bytes))) {
      throw new Error("Codex managed resource identity contains different bytes");
    }
    resources.set(key, resource);
  }
  return [...resources.values()];
}

function compactTitle(value: string): string {
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length <= 200 ? compact : `${compact.slice(0, 197)}...`;
}

function latestTimestamp(current: string, candidate: string): string {
  const currentTime = Date.parse(current);
  const candidateTime = Date.parse(candidate);
  if (Number.isNaN(candidateTime)) {
    return current;
  }
  return current === "" || Number.isNaN(currentTime) || candidateTime > currentTime ? candidate : current;
}

async function parseCodexRolloutRange(
  filePath: string,
  endByteOffset?: number,
): Promise<ParsedCodexRollout> {
  if (
    endByteOffset !== undefined &&
    (!Number.isSafeInteger(endByteOffset) || endByteOffset <= 0)
  ) throw new Error(`Codex rollout prefix byte offset is invalid: ${filePath}`);
  const filenameMatch = OFFICIAL_FILENAME.exec(path.basename(filePath));
  const filenameId = filenameMatch?.[1] === undefined ? undefined : canonicalCodexSessionId(filenameMatch[1]);
  const metadata: SessionMetadata[] = [];
  const recordOrdinals: Array<number | undefined> = [];
  const responseMessages: ParsedCodexResponseMessage[] = [];
  const displayMessages: ParsedCodexDisplayMessage[] = [];
  const gaps: ConversationItem[] = [];
  const rollbackProjections: CodexRollbackProjection[] = [];
  const pendingToolEvents: ParsedCodexToolEvent[] = [];
  let pendingAssistantEvidence: ParsedCodexAssistantEvidence[] = [];
  const openToolCalls = new Map<string, ParsedCodexToolEvent>();
  const completedToolCalls = new Set<string>();
  let toolBatchInvalid = false;
  let currentModel = "";
  let updatedAt = "";
  let records = 0;
  let lineEndByteOffset = 0;
  let activeCompaction: CodexCompactionProjection | undefined;
  let previousProjectionTimestamp = Number.NEGATIVE_INFINITY;
  let projectionTimestampsMonotonic = true;
  let projectionUpdatedAt = "";
  let pendingInterAgentDeliveryTrigger: boolean | undefined;
  let pendingAbortMarker: ParsedCodexAbortMarker | undefined;
  let headModel = "";
  let headHasHistoryBase = false;
  let subagentHistoryStartOrdinal: number | undefined;
  let inheritedProjection: {
    readonly portable: FinalizedCodexConversationProjection;
    readonly compactionCheckpoints: number;
    readonly rollbackTurns: number;
  } | undefined;

  const resetToolBatch = (): void => {
    pendingToolEvents.length = 0;
    openToolCalls.clear();
    completedToolCalls.clear();
    toolBatchInvalid = false;
  };
  const blockToolBatch = (timestamp: string): void => {
    for (const tool of pendingToolEvents) {
      const gap = responseGap({ type: tool.kind });
      gaps.push({ kind: "gap", ...gap, timestamp });
    }
    pendingAssistantEvidence = pendingAssistantEvidence.filter((evidence) => evidence.kind !== "tool");
    resetToolBatch();
  };
  const blockReasoningBatch = (timestamp: string): void => {
    const reasoning = pendingAssistantEvidence.filter((evidence) => evidence.kind === "reasoning");
    for (const _item of reasoning) {
      const gap = responseGap({ type: "reasoning" });
      gaps.push({ kind: "gap", ...gap, timestamp });
    }
    pendingAssistantEvidence = pendingAssistantEvidence.filter((evidence) => evidence.kind !== "reasoning");
  };
  const finishAssistantEvidence = (message: ConversationMessage): {
    readonly message: ConversationMessage;
    readonly managedResources: readonly ManagedResourceObject[];
  } => {
    if (pendingAssistantEvidence.length === 0) {
      resetToolBatch();
      return { message, managedResources: [] };
    }
    if (toolBatchInvalid || openToolCalls.size !== 0) {
      blockToolBatch(message.timestamp);
    }
    if (pendingAssistantEvidence.length === 0) {
      return { message, managedResources: [] };
    }
    const projected: ConversationMessage = {
      ...message,
      contentKinds: [
        ...pendingAssistantEvidence.map((evidence) =>
          evidence.kind === "tool" ? evidence.tool.kind : "reasoning"),
        ...(message.contentKinds ?? []),
      ],
      portableBlocks: [
        ...pendingAssistantEvidence.map((evidence) =>
          evidence.kind === "tool" ? evidence.tool.block : evidence.block),
        ...(message.portableBlocks ?? []),
      ],
      portableNotes: [
        ...pendingAssistantEvidence.flatMap((evidence) =>
          evidence.kind === "tool" ? evidence.tool.notes : evidence.notes),
        ...(message.portableNotes ?? []),
      ],
    };
    const managedResources = pendingAssistantEvidence.flatMap((evidence) =>
      evidence.kind === "tool" ? evidence.tool.managedResources : []);
    pendingAssistantEvidence = [];
    resetToolBatch();
    return { message: projected, managedResources };
  };
  const flushUnpairedAbortMarker = (): void => {
    const marker = pendingAbortMarker;
    if (marker === undefined) return;
    if (pendingToolEvents.length !== 0 || toolBatchInvalid) blockToolBatch(marker.timestamp);
    if (pendingAssistantEvidence.some((evidence) => evidence.kind === "reasoning")) {
      blockReasoningBatch(marker.timestamp);
    }
    responseMessages.push(marker.response);
    gaps.push({
      kind: "gap",
      code: "codex.turn_aborted_marker_unpaired",
      label: "Codex model-visible aborted-turn marker has no matching terminal event",
      timestamp: marker.timestamp,
    });
    pendingAbortMarker = undefined;
  };
  const finalizeCurrentProjection = (
    inherited: boolean,
  ): {
    readonly complete: FinalizedCodexConversationProjection;
    readonly portable: FinalizedCodexConversationProjection;
    readonly compactionCheckpoints: number;
    readonly rollbackTurns: number;
  } => {
    flushUnpairedAbortMarker();
    if (pendingToolEvents.length !== 0 || toolBatchInvalid) blockToolBatch(projectionUpdatedAt);
    if (pendingAssistantEvidence.some((evidence) => evidence.kind === "reasoning")) {
      blockReasoningBatch(projectionUpdatedAt);
    }
    const finalize = (
      prefix: readonly ParsedCodexResponseMessage[],
      response: readonly ParsedCodexResponseMessage[],
      display: readonly ParsedCodexDisplayMessage[],
      sourceGaps: readonly ConversationItem[],
    ): FinalizedCodexConversationProjection => {
      if (!inherited || display.length !== 0) {
        return finalizeConversationProjection(prefix, response, display, sourceGaps, projectionUpdatedAt);
      }
      const modelMessages = coalesceInheritedUserMessages(response.filter((item) =>
        item.message.role === "user" || item.message.role === "assistant"));
      const executionContext = response.flatMap((item): ConversationItem[] =>
        item.message.role === "user" || item.message.role === "assistant"
          ? []
          : [{
            kind: "gap",
            code: "codex.response_context",
            label: "Codex execution context is retained only in native history",
            timestamp: item.message.timestamp,
          }]);
      return finalizeConversationProjection(
        prefix,
        modelMessages,
        [],
        [...sourceGaps, ...executionContext],
        projectionUpdatedAt,
      );
    };
    const complete = finalize([], responseMessages, displayMessages, gaps);
    const portableBase = activeCompaction === undefined
      ? complete
      : finalize(
        activeCompaction.replacementMessages,
        responseMessages.slice(activeCompaction.responseStart),
        displayMessages.slice(activeCompaction.displayStart),
        gaps.slice(activeCompaction.gapStart),
      );
    const rollback = !inherited && headHasHistoryBase
      ? { projection: portableBase, materializedTurns: 0 }
      : materializeRollbackProjection(
        portableBase,
        rollbackProjections,
        projectionTimestampsMonotonic,
        activeCompaction?.replacementMessages ?? [],
      );
    return {
      complete,
      portable: rollback.projection,
      compactionCheckpoints: activeCompaction === undefined ? 0 : 1,
      rollbackTurns: rollback.materializedTurns,
    };
  };
  const resetProjection = (): void => {
    responseMessages.length = 0;
    displayMessages.length = 0;
    gaps.length = 0;
    rollbackProjections.length = 0;
    resetToolBatch();
    pendingAssistantEvidence = [];
    activeCompaction = undefined;
    previousProjectionTimestamp = Number.NEGATIVE_INFINITY;
    projectionTimestampsMonotonic = true;
    projectionUpdatedAt = "";
    pendingInterAgentDeliveryTrigger = undefined;
    pendingAbortMarker = undefined;
    currentModel = headModel;
  };

  const input = createReadStream(filePath, {
    encoding: "utf8",
    ...(endByteOffset === undefined ? {} : { end: endByteOffset - 1 }),
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      lineEndByteOffset += Buffer.byteLength(line, "utf8") + 1;
      if (line.trim() === "") {
        continue;
      }
      if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
        throw new Error(`Codex rollout record is too large: ${filePath}`);
      }
      records++;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new Error(`Codex rollout contains invalid JSONL: ${filePath}`);
      }
      const event = objectValue(raw);
      const type = stringValue(event?.type);
      const timestamp = stringValue(event?.timestamp);
      const payload = objectValue(event?.payload);
      if (event === undefined || type === "" || payload === undefined) {
        throw new Error(`Codex rollout event is invalid: ${filePath}`);
      }
      const rawOrdinal = event.ordinal;
      const ordinal = typeof rawOrdinal === "number" && Number.isSafeInteger(rawOrdinal) && rawOrdinal >= 0
        ? rawOrdinal
        : undefined;
      recordOrdinals.push(ordinal);
      const recordTimestamp = Date.parse(timestamp);
      updatedAt = latestTimestamp(updatedAt, timestamp);
      if (
        subagentHistoryStartOrdinal !== undefined && inheritedProjection === undefined &&
        ordinal !== undefined && ordinal >= subagentHistoryStartOrdinal
      ) {
        const inherited = finalizeCurrentProjection(true);
        inheritedProjection = {
          portable: inherited.portable,
          compactionCheckpoints: inherited.compactionCheckpoints,
          rollbackTurns: inherited.rollbackTurns,
        };
        resetProjection();
      }
      if (!Number.isFinite(recordTimestamp) || recordTimestamp < previousProjectionTimestamp) {
        projectionTimestampsMonotonic = false;
      } else {
        previousProjectionTimestamp = recordTimestamp;
      }
      projectionUpdatedAt = latestTimestamp(projectionUpdatedAt, timestamp);
      if (
        pendingAbortMarker !== undefined &&
        !(type === "event_msg" && payload.type === "turn_aborted")
      ) flushUnpairedAbortMarker();
      if (type === "session_meta") {
        const parsed = parseMetadata(payload);
        if (parsed === undefined) {
          throw new Error(`Codex rollout session metadata is invalid: ${filePath}`);
        }
        const head = metadata.length === 0;
        metadata.push({ ...parsed, ...(ordinal === undefined ? {} : { ordinal }), endByteOffset: lineEndByteOffset });
        if (head) {
          headModel = parsed.model;
          headHasHistoryBase = parsed.historyBase !== undefined;
          subagentHistoryStartOrdinal = parsed.subagentHistoryStartOrdinal;
        }
        currentModel ||= parsed.model;
        continue;
      }
      const deliveryTrigger = pendingInterAgentDeliveryTrigger;
      pendingInterAgentDeliveryTrigger = undefined;
      if (type === "turn_context") {
        currentModel = stringValue(payload.model) || stringValue(payload.model_name) || currentModel;
        continue;
      }
      if (type === "response_item") {
        const abortMarker = codexAbortMarker(payload, timestamp, currentModel);
        if (abortMarker !== undefined) {
          pendingAbortMarker = abortMarker;
          continue;
        }
        if (payload.type === "agent_message") {
          const message = agentMessageFromResponse(payload, timestamp, deliveryTrigger);
          if (message === undefined) {
            const gap = responseGap(payload);
            gaps.push({ kind: "gap", ...gap, timestamp });
          } else {
            responseMessages.push(message);
          }
          continue;
        }
        if (payload.type === "reasoning") {
          const reasoning = codexReasoningSummary(payload);
          if (reasoning === undefined) {
            const gap = responseGap(payload);
            gaps.push({ kind: "gap", ...gap, timestamp });
          } else {
            pendingAssistantEvidence.push(reasoning);
          }
          continue;
        }
        if (
          payload.type === "function_call" || payload.type === "function_call_output" ||
          payload.type === "custom_tool_call" || payload.type === "custom_tool_call_output" ||
          payload.type === "local_shell_call" || payload.type === "web_search_call" ||
          payload.type === "image_generation_call" ||
          payload.type === "tool_search_call" || payload.type === "tool_search_output"
        ) {
          const tool = codexToolEvent(payload);
          if (tool === undefined) {
            const gap = responseGap(payload);
            gaps.push({ kind: "gap", ...gap, timestamp });
            toolBatchInvalid = true;
            continue;
          }
          pendingToolEvents.push(tool);
          pendingAssistantEvidence.push({ kind: "tool", tool });
          if (tool.phase === "call") {
            if (openToolCalls.has(tool.callId) || completedToolCalls.has(tool.callId)) {
              toolBatchInvalid = true;
            } else {
              openToolCalls.set(tool.callId, tool);
            }
          } else if (tool.phase === "result") {
            const call = openToolCalls.get(tool.callId);
            const familyMatches = call !== undefined && (
              call.family === tool.family || call.family === "local_shell" && tool.family === "function"
            );
            if (
              call === undefined ||
              !familyMatches ||
              (tool.name !== undefined && tool.name !== call.name) ||
              (call.turnId !== undefined && tool.turnId !== undefined && call.turnId !== tool.turnId)
            ) {
              toolBatchInvalid = true;
            } else {
              openToolCalls.delete(tool.callId);
              completedToolCalls.add(tool.callId);
            }
          } else if (openToolCalls.has(tool.callId) || completedToolCalls.has(tool.callId)) {
            toolBatchInvalid = true;
          } else {
            completedToolCalls.add(tool.callId);
          }
          continue;
        }
        const parsedMessage = messageFromResponse(payload, timestamp, currentModel);
        if (parsedMessage !== undefined) {
          let message = parsedMessage.message;
          let managedResources = parsedMessage.managedResources;
          if (message.role === "user") {
            if (pendingToolEvents.length !== 0 || toolBatchInvalid) blockToolBatch(timestamp);
            if (pendingAssistantEvidence.some((evidence) => evidence.kind === "reasoning")) {
              blockReasoningBatch(timestamp);
            }
          }
          if (
            message.role === "assistant" &&
            (stringValue(payload.phase) !== "commentary" ||
              pendingToolEvents.length === 0 && !toolBatchInvalid)
          ) {
            const finished = finishAssistantEvidence(message);
            message = finished.message;
            managedResources = [...managedResources, ...finished.managedResources];
          }
          responseMessages.push({ ...parsedMessage, message, managedResources });
        }
        if (parsedMessage === undefined || parsedMessage.unsupportedBlocks !== 0) {
          const gap = responseGap(payload);
          gaps.push({ kind: "gap", ...gap, timestamp });
        }
        continue;
      }
      if (type === "event_msg") {
        if (payload.type === "thread_rolled_back") {
          const valid = isThreadRollbackPayload(payload);
          const gap: ConversationGap = {
            kind: "gap",
            code: valid
              ? "codex.thread_rollback"
              : "codex.thread_rollback_invalid",
            label: valid
              ? "Codex thread rollback changes the active conversation"
              : "Codex thread rollback record is invalid",
            timestamp,
          };
          gaps.push(gap);
          if (valid) rollbackProjections.push({ gap, numTurns: payload.num_turns as number });
          continue;
        }
        if (payload.type === "turn_aborted") {
          const valid = isTurnAbortedPayload(payload);
          const marker = pendingAbortMarker;
          const eventTurnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
          const markerMatches = marker !== undefined && payload.reason === "interrupted" &&
            (marker.turnId === undefined || marker.turnId === eventTurnId);
          if (valid && marker !== undefined && markerMatches) {
            pendingAbortMarker = undefined;
            if (pendingToolEvents.some((tool) => tool.turnId !== undefined && tool.turnId !== eventTurnId)) {
              toolBatchInvalid = true;
            }
            const materialized = materializedTurnAbortedResponse(marker, currentModel);
            const finished = finishAssistantEvidence(materialized.message);
            responseMessages.push({
              ...materialized,
              message: finished.message,
              managedResources: finished.managedResources,
            });
            continue;
          }
          flushUnpairedAbortMarker();
          gaps.push({
            kind: "gap",
            code: valid ? "codex.turn_aborted" : "codex.turn_aborted_invalid",
            label: valid
              ? "Codex aborted turn may contain partial model or tool output"
              : "Codex aborted-turn record is invalid",
            timestamp,
          });
          continue;
        }
        if (payload.type === "context_compacted") {
          const valid = isContextCompactedPayload(payload);
          gaps.push({
            kind: "gap",
            code: valid ? "codex.context_compacted" : "codex.context_compacted_invalid",
            label: valid
              ? "Codex legacy context-compaction event retained in raw history"
              : "Codex context-compaction event is invalid",
            timestamp,
          });
          continue;
        }
        const message = displayMessage(payload, timestamp, currentModel);
        if (message !== undefined) {
          displayMessages.push(message);
        } else if (isDisplayMessagePayload(payload)) {
          gaps.push({
            kind: "gap",
            code: "codex.display_mirror_invalid",
            label: "Codex visible message mirror is invalid",
            timestamp,
          });
        }
        continue;
      }
      if (type === "compacted") {
        if (pendingToolEvents.length !== 0 || toolBatchInvalid) blockToolBatch(timestamp);
        if (pendingAssistantEvidence.some((evidence) => evidence.kind === "reasoning")) {
          blockReasoningBatch(timestamp);
        }
        const replacementMessages = compactedReplacementMessages(payload, timestamp);
        gaps.push({
          kind: "gap",
          code: "codex.compacted",
          label: "native compacted retained in raw history",
          timestamp,
        });
        if (replacementMessages !== undefined) {
          activeCompaction = {
            replacementMessages,
            responseStart: responseMessages.length,
            displayStart: displayMessages.length,
            gapStart: gaps.length,
          };
        }
        continue;
      }
      if (type === "inter_agent_communication") {
        gaps.push({
          kind: "gap",
          code: "codex.inter_agent_communication",
          label: "native inter_agent_communication retained in raw history",
          timestamp,
        });
        continue;
      }
      if (type === "world_state" && isWorldStatePayload(payload)) {
        gaps.push({
          kind: "gap",
          code: "codex.world_state",
          label: "Codex source workspace state baseline retained in raw history",
          timestamp,
        });
        continue;
      }
      if (type === "inter_agent_communication_metadata" && isInterAgentCommunicationMetadata(payload)) {
        gaps.push({
          kind: "gap",
          code: "codex.inter_agent_communication_metadata",
          label: "Codex inter-Agent delivery metadata retained in raw history",
          timestamp,
        });
        pendingInterAgentDeliveryTrigger = payload.trigger_turn as boolean;
        continue;
      }
      gaps.push({ kind: "gap", ...rolloutGap(type), timestamp });
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (records === 0 || metadata.length === 0) {
    throw new Error(`Codex rollout has no session metadata: ${filePath}`);
  }
  let selected: SessionMetadata;
  if (metadata.length === 1) {
    selected = metadata[0]!;
  } else {
    // Copied forks persist child metadata first; extracted archive objects no longer have the rollout filename.
    const expectedId = filenameId ?? metadata[0]!.id;
    if (metadata[0]!.id !== expectedId) {
      throw new Error(`Codex fork metadata cannot be identified: ${filePath}`);
    }
    const matching = metadata.filter((value) => value.id === expectedId);
    if (matching.length !== 1) {
      throw new Error(`Codex fork metadata is ambiguous: ${filePath}`);
    }
    selected = matching[0]!;
  }
  if (filenameId !== undefined && selected.id !== filenameId) {
    throw new Error(`Codex rollout filename and session ID disagree: ${filePath}`);
  }
  const allOrdinalsPresent = recordOrdinals.every((ordinal) => ordinal !== undefined);
  const noOrdinalsPresent = recordOrdinals.every((ordinal) => ordinal === undefined);
  if (
    selected.historyMode === "paginated"
      ? !allOrdinalsPresent || selected.ordinal === undefined
      : !noOrdinalsPresent
  ) throw new Error(`Codex rollout record ordinals disagree with history mode: ${filePath}`);
  if (allOrdinalsPresent && recordOrdinals.some((ordinal, index) =>
    index !== 0 && ordinal! <= recordOrdinals[index - 1]!
  )) throw new Error(`Codex paginated rollout ordinals are not strictly increasing: ${filePath}`);
  if (allOrdinalsPresent && recordOrdinals.at(-1)! >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Codex paginated rollout ordinal exceeds the supported range: ${filePath}`);
  }
  const endOrdinalExclusive = allOrdinalsPresent ? recordOrdinals.at(-1)! + 1 : undefined;
  const expectedStartOrdinal = selected.historyBase?.endOrdinalExclusive ?? 0;
  if (selected.historyMode === "paginated" && selected.ordinal !== expectedStartOrdinal) {
    throw new Error(`Codex paginated rollout starts at the wrong ordinal: ${filePath}`);
  }
  if (
    selected.subagentHistoryStartOrdinal !== undefined &&
    (selected.historyBase !== undefined || selected.ordinal !== 0 ||
      endOrdinalExclusive! < selected.subagentHistoryStartOrdinal)
  ) throw new Error(`Codex paginated subagent inherited prefix is incomplete: ${filePath}`);
  if (selected.subagentHistoryStartOrdinal !== subagentHistoryStartOrdinal) {
    throw new Error(`Codex subagent history projection boundary changed: ${filePath}`);
  }
  if (subagentHistoryStartOrdinal !== undefined && inheritedProjection === undefined) {
    const inherited = finalizeCurrentProjection(true);
    inheritedProjection = {
      portable: inherited.portable,
      compactionCheckpoints: inherited.compactionCheckpoints,
      rollbackTurns: inherited.rollbackTurns,
    };
    resetProjection();
  }
  const own = finalizeCurrentProjection(false);
  const portable = inheritedProjection === undefined || own.compactionCheckpoints !== 0
    ? own.portable
    : {
      ...own.portable,
      conversation: [...inheritedProjection.portable.conversation, ...own.portable.conversation],
      messages: [...inheritedProjection.portable.messages, ...own.portable.messages],
      selectedResponse: [
        ...inheritedProjection.portable.selectedResponse,
        ...own.portable.selectedResponse,
      ],
    };
  const materializedCompactionCheckpoints = own.compactionCheckpoints !== 0
    ? own.compactionCheckpoints
    : (inheritedProjection?.compactionCheckpoints ?? 0);
  const materializedRollbackTurns = own.compactionCheckpoints !== 0
    ? own.rollbackTurns
    : (inheritedProjection?.rollbackTurns ?? 0) + own.rollbackTurns;
  const firstUser = own.complete.messages.find((message) => message.role === "user")?.text ?? "";
  return {
    nativeId: selected.id,
    createdAt: selected.timestamp,
    updatedAt: updatedAt || selected.timestamp,
    cwd: selected.cwd,
    provider: selected.provider,
    model: currentModel || selected.model,
    title: compactTitle(firstUser),
    conversation: own.complete.conversation,
    managedResources: uniqueManagedResources(own.complete.selectedResponse),
    portableConversation: portable.conversation,
    portableManagedResources: uniqueManagedResources(portable.selectedResponse),
    materializedCompactionCheckpoints,
    materializedRollbackTurns,
    nativeSummary: {
      metadataRecords: metadata.length,
      recordCount: records,
    },
    recordCount: records,
    ...(endOrdinalExclusive === undefined ? {} : { endOrdinalExclusive }),
    historyMode: selected.historyMode,
    sessionId: selected.sessionId,
    ...(selected.subagentHistoryStartOrdinal === undefined
      ? {}
      : { subagentHistoryStartOrdinal: selected.subagentHistoryStartOrdinal }),
    ...(selected.forkedFromId === undefined ? {} : { forkedFromId: selected.forkedFromId }),
    ...(selected.parentThreadId === undefined ? {} : { parentThreadId: selected.parentThreadId }),
    ...(selected.historyBase === undefined ? {} : { historyBase: selected.historyBase }),
    metadataEndByteOffset: selected.endByteOffset,
  };
}

export async function parseCodexRollout(filePath: string): Promise<ParsedCodexRollout> {
  return parseCodexRolloutRange(filePath);
}

export async function parseCodexRolloutPrefix(
  filePath: string,
  endByteOffset: number,
): Promise<ParsedCodexRollout> {
  return parseCodexRolloutRange(filePath, endByteOffset);
}
