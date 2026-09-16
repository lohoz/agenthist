import type { ConversationMessage } from "../domain/history.js";
import { sessionAgent } from "../domain/history.js";
import type { PortableContextBlock } from "../domain/portable-context.js";

export const TECHNICAL_DETAIL_PREVIEW_CHARACTERS = 32 * 1024;
export const MAX_TECHNICAL_DETAIL_CHUNK_CHARACTERS = 64 * 1024;
export const MAX_TECHNICAL_DETAIL_CHARACTERS = 64 * 1024 * 1024;
export const MAX_TECHNICAL_DETAIL_BYTES = 64 * 1024 * 1024;

const MAX_CONVERSATION_ORDINAL = 1_000_000;
const MAX_TECHNICAL_DETAILS = 1_000_000;
const MAX_SUMMARY_CHARACTERS = 256;
const KNOWN_BLOCKS = new Set<PortableContextBlock["kind"]>([
  "text",
  "historical_citations",
  "historical_context",
  "historical_event",
  "historical_work_state",
  "historical_reference",
  "historical_reasoning",
  "historical_reasoning_trace",
  "historical_tool",
  "historical_resource",
]);

export interface TechnicalDetailSummary {
  readonly id: string;
  readonly detailIndex: number;
  readonly label: string;
  readonly summary: string;
  readonly totalCharacters: number;
  readonly preview: string;
  readonly truncated: boolean;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export type TechnicalDetailChunk =
  | {
      readonly status: "available";
      readonly id: string;
      readonly detailIndex: number;
      readonly label: string;
      readonly offset: number;
      readonly limit: number;
      readonly totalCharacters: number;
      readonly returnedCharacters: number;
      readonly text: string;
      readonly nextOffset?: number;
    }
  | {
      readonly status: "unavailable";
      readonly id: string;
      readonly detailIndex: number;
      readonly label: string;
      readonly reason: string;
    };

interface TechnicalDetailDescriptor {
  readonly id: string;
  readonly detailIndex: number;
  readonly label: string;
  readonly summary: string;
  render(): string;
}

interface RenderedDetail {
  readonly status: "available";
  readonly text: string;
  readonly totalCharacters: number;
}

interface UnavailableDetail {
  readonly status: "unavailable";
  readonly reason: string;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validUnicodeText(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.includes("\0") ||
    hasUnpairedSurrogate(value)
  ) throw new Error(`${label} is invalid`);
  return value;
}

function codePointCount(value: string): number {
  let count = 0;
  for (const _character of value) count++;
  return count;
}

function sliceCodePoints(value: string, offset: number, limit: number): string {
  let codePoint = 0;
  let start = value.length;
  let end = value.length;
  let foundEnd = false;
  for (let index = 0; index < value.length;) {
    if (codePoint === offset) start = index;
    if (codePoint === offset + limit) {
      end = index;
      foundEnd = true;
      break;
    }
    const point = value.codePointAt(index)!;
    index += point > 0xffff ? 2 : 1;
    codePoint++;
  }
  if (offset === codePoint && start === value.length) start = value.length;
  if (!foundEnd) end = value.length;
  return value.slice(start, end);
}

function boundedSummary(value: string): string {
  const total = codePointCount(value);
  return total <= MAX_SUMMARY_CHARACTERS
    ? value
    : `${sliceCodePoints(value, 0, MAX_SUMMARY_CHARACTERS - 1)}…`;
}

function blockDescription(block: Exclude<PortableContextBlock, { readonly kind: "text" }>): {
  readonly label: string;
  readonly summary: string;
} {
  if (block.kind === "historical_tool") {
    const identity = [block.tool.namespace, block.tool.name].filter((value) => value !== undefined).join("/");
    return {
      label: "Tool history",
      summary: `${block.tool.phase}${identity === "" ? "" : ` · ${identity}`}`,
    };
  }
  if (block.kind === "historical_reasoning") {
    return { label: "Reasoning summary", summary: `${block.summary.length} section(s)` };
  }
  if (block.kind === "historical_reasoning_trace") {
    return { label: "Reasoning trace", summary: boundedSummary(block.text) || "Reasoning trace" };
  }
  if (block.kind === "historical_resource") {
    return { label: "Resource", summary: `${block.resource.name} · ${block.resource.mediaType}` };
  }
  if (block.kind === "historical_reference") {
    return { label: "Reference", summary: `${block.reference.namespace}/${block.reference.type}` };
  }
  if (block.kind === "historical_citations") {
    return { label: "Citations", summary: `${block.citations.length} citation group(s)` };
  }
  if (block.kind === "historical_context") {
    return { label: "Historical context", summary: block.context.sourceRole };
  }
  if (block.kind === "historical_work_state") {
    return { label: "Work state", summary: `${block.workState.items.length} item(s)` };
  }
  if (block.kind === "historical_event") {
    return { label: "Historical event", summary: boundedSummary(block.event) };
  }
  throw new Error("technical detail contains an unknown portable block kind");
}

function validateMessage(message: ConversationMessage): void {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("technical detail message is invalid");
  }
  const allowed = new Set([
    "kind", "role", "text", "timestamp", "model", "contentKinds", "portableBlocks", "portableNotes",
  ]);
  const unknown = Object.keys(message).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`technical detail message has an unknown field: ${unknown}`);
  if (
    message.kind !== "message" ||
    message.role !== "user" && message.role !== "assistant" &&
      message.role !== "system" && message.role !== "developer"
  ) throw new Error("technical detail message is invalid");
  validUnicodeText(message.text, "technical detail message text");
  validUnicodeText(message.timestamp, "technical detail message timestamp");
  if (message.model !== undefined) validUnicodeText(message.model, "technical detail message model");
  for (const [label, values] of [
    ["content kinds", message.contentKinds],
    ["portable notes", message.portableNotes],
  ] as const) {
    if (values !== undefined && (
      !Array.isArray(values) || values.length > MAX_TECHNICAL_DETAILS ||
      values.some((value) => typeof value !== "string")
    )) throw new Error(`technical detail ${label} are invalid`);
  }
  if (message.portableBlocks !== undefined && (
    !Array.isArray(message.portableBlocks) || message.portableBlocks.length > MAX_TECHNICAL_DETAILS
  )) throw new Error("technical detail portable blocks are invalid");
}

function validateIdentity(sessionRef: string, itemOrdinal: number): void {
  if (typeof sessionRef !== "string" || sessionAgent(sessionRef) === undefined) {
    throw new Error("technical detail session reference is invalid");
  }
  if (!Number.isSafeInteger(itemOrdinal) || itemOrdinal < 0 || itemOrdinal > MAX_CONVERSATION_ORDINAL) {
    throw new Error("technical detail conversation ordinal is invalid");
  }
}

function detailId(sessionRef: string, itemOrdinal: number, detailIndex: number): string {
  return `${sessionRef}:${itemOrdinal}:technical:${detailIndex}`;
}

function descriptors(
  sessionRef: string,
  itemOrdinal: number,
  message: ConversationMessage,
): TechnicalDetailDescriptor[] {
  validateIdentity(sessionRef, itemOrdinal);
  validateMessage(message);
  const result: TechnicalDetailDescriptor[] = [];
  const append = (label: string, summary: string, render: () => string): void => {
    if (result.length >= MAX_TECHNICAL_DETAILS) throw new Error("technical detail count exceeds supported limits");
    const detailIndex = result.length;
    result.push({
      id: detailId(sessionRef, itemOrdinal, detailIndex),
      detailIndex,
      label,
      summary: boundedSummary(summary),
      render,
    });
  };
  if ((message.contentKinds?.length ?? 0) !== 0) {
    const kinds = message.contentKinds!.map((value) => validUnicodeText(value, "technical content kind"));
    append("Content kinds", kinds.join(", "), () => kinds.join("\n"));
  }
  for (const rawBlock of message.portableBlocks ?? []) {
    if (rawBlock === null || typeof rawBlock !== "object" || Array.isArray(rawBlock) ||
      typeof (rawBlock as { readonly kind?: unknown }).kind !== "string" ||
      !KNOWN_BLOCKS.has((rawBlock as { readonly kind: PortableContextBlock["kind"] }).kind)) {
      throw new Error("technical detail contains an unknown portable block kind");
    }
    const block = rawBlock as PortableContextBlock;
    if (block.kind === "text") continue;
    const description = blockDescription(block);
    append(description.label, description.summary, () => {
      const serialized = JSON.stringify(block, null, 2);
      if (serialized === undefined) throw new Error("technical detail JSON serialization returned no value");
      return serialized;
    });
  }
  for (const rawNote of message.portableNotes ?? []) {
    const note = validUnicodeText(rawNote, "technical note");
    append("Technical note", note, () => note);
  }
  return result;
}

function renderDetail(descriptor: TechnicalDetailDescriptor): RenderedDetail | UnavailableDetail {
  try {
    const text = descriptor.render();
    if (Buffer.byteLength(text, "utf8") > MAX_TECHNICAL_DETAIL_BYTES) {
      return { status: "unavailable", reason: "Technical detail exceeds the 64 MiB limit." };
    }
    const totalCharacters = codePointCount(text);
    if (totalCharacters > MAX_TECHNICAL_DETAIL_CHARACTERS) {
      return { status: "unavailable", reason: "Technical detail exceeds the 64 MiB limit." };
    }
    return { status: "available", text, totalCharacters };
  } catch {
    return { status: "unavailable", reason: "Technical detail is unavailable." };
  }
}

export function listTechnicalDetails(
  sessionRef: string,
  itemOrdinal: number,
  message: ConversationMessage,
): readonly TechnicalDetailSummary[] {
  return descriptors(sessionRef, itemOrdinal, message).map((descriptor): TechnicalDetailSummary => {
    const rendered = renderDetail(descriptor);
    if (rendered.status === "unavailable") {
      return {
        id: descriptor.id,
        detailIndex: descriptor.detailIndex,
        label: descriptor.label,
        summary: descriptor.summary,
        totalCharacters: 0,
        preview: "",
        truncated: false,
        available: false,
        unavailableReason: rendered.reason,
      };
    }
    const preview = sliceCodePoints(rendered.text, 0, TECHNICAL_DETAIL_PREVIEW_CHARACTERS);
    return {
      id: descriptor.id,
      detailIndex: descriptor.detailIndex,
      label: descriptor.label,
      summary: descriptor.summary,
      totalCharacters: rendered.totalCharacters,
      preview,
      truncated: rendered.totalCharacters > TECHNICAL_DETAIL_PREVIEW_CHARACTERS,
      available: true,
    };
  });
}

export function getTechnicalDetailChunk(
  sessionRef: string,
  itemOrdinal: number,
  message: ConversationMessage,
  detailIndex: number,
  offset: number,
  limit: number,
): TechnicalDetailChunk {
  const available = descriptors(sessionRef, itemOrdinal, message);
  if (!Number.isSafeInteger(detailIndex) || detailIndex < 0 || detailIndex >= available.length) {
    throw new Error("technical detail index is invalid or unavailable");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_TECHNICAL_DETAIL_CHARACTERS) {
    throw new Error("technical detail offset is outside the supported range");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TECHNICAL_DETAIL_CHUNK_CHARACTERS) {
    throw new Error("technical detail chunk limit is outside the supported range");
  }
  const descriptor = available[detailIndex]!;
  const rendered = renderDetail(descriptor);
  if (rendered.status === "unavailable") {
    return {
      status: "unavailable",
      id: descriptor.id,
      detailIndex,
      label: descriptor.label,
      reason: rendered.reason,
    };
  }
  if (offset > rendered.totalCharacters) throw new Error("technical detail offset exceeds its total length");
  const text = sliceCodePoints(rendered.text, offset, limit);
  const returnedCharacters = codePointCount(text);
  const nextOffset = offset + returnedCharacters;
  return {
    status: "available",
    id: descriptor.id,
    detailIndex,
    label: descriptor.label,
    offset,
    limit,
    totalCharacters: rendered.totalCharacters,
    returnedCharacters,
    text,
    ...(nextOffset >= rendered.totalCharacters ? {} : { nextOffset }),
  };
}
