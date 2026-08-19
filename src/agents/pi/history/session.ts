import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import type { ConversationItem, ConversationMessage, JsonValue } from "../../../domain/history.js";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 1_000_000;
const ENTRY_ID = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const MESSAGE_ROLES = new Set([
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
]);

export interface PiSessionHeader {
  readonly type: "session";
  readonly version: 3;
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly parentSession?: string;
  readonly record: Readonly<Record<string, JsonValue>>;
}

export interface PiSessionEntry {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly record: Readonly<Record<string, JsonValue>>;
}

export interface ParsedPiSession {
  readonly header: PiSessionHeader;
  readonly entries: readonly PiSessionEntry[];
  readonly activeEntries: readonly PiSessionEntry[];
  readonly title: string;
  readonly model: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly conversation: readonly ConversationItem[];
  readonly searchText: readonly string[];
  readonly leafId: string | null;
  readonly roots: number;
  readonly branchPoints: number;
  readonly messageCount: number;
}

function objectValue(value: unknown): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validTimestamp(value: string): boolean {
  return value !== "" && Number.isFinite(Date.parse(value));
}

function normalizeStoredPath(value: string, label: string): string {
  if (value.includes("\0")) throw new Error(`Pi ${label} contains NUL`);
  if (path.posix.isAbsolute(value)) return path.posix.normalize(value);
  if (path.win32.isAbsolute(value)) return path.win32.normalize(value);
  throw new Error(`Pi ${label} is not absolute`);
}

function timestamp(value: JsonValue | undefined, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}

function contentText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((block) => {
    const item = objectValue(block);
    if (item?.type === "text" && typeof item.text === "string") return [item.text];
    if (item?.type === "thinking" && typeof item.thinking === "string") return [item.thinking];
    if (item?.type === "toolCall" && typeof item.name === "string") return [`[Tool call: ${item.name}]`];
    if (item?.type === "image" && typeof item.mimeType === "string") return [`[Image: ${item.mimeType}]`];
    return [];
  }).join("\n");
}

function contentKinds(value: JsonValue | undefined): readonly string[] | undefined {
  if (typeof value === "string") return ["text"];
  if (!Array.isArray(value)) return undefined;
  const result = [...new Set(value.flatMap((block) => {
    const item = objectValue(block);
    return typeof item?.type === "string" ? [item.type] : [];
  }))];
  return result.length === 0 ? undefined : result;
}

function validateContent(value: JsonValue | undefined, allowed: ReadonlySet<string>, label: string): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value)) throw new Error(`Pi ${label} content is invalid`);
  for (const block of value) {
    const item = objectValue(block);
    if (item === undefined || typeof item.type !== "string" || !allowed.has(item.type)) {
      throw new Error(`Pi ${label} content block is invalid`);
    }
    if (item.type === "text" && typeof item.text !== "string") throw new Error(`Pi ${label} text is invalid`);
    if (item.type === "image" && (typeof item.data !== "string" || typeof item.mimeType !== "string")) {
      throw new Error(`Pi ${label} image is invalid`);
    }
    if (item.type === "thinking" && typeof item.thinking !== "string") {
      throw new Error("Pi assistant thinking block is invalid");
    }
    if (
      item.type === "toolCall" &&
      (typeof item.id !== "string" || item.id === "" || typeof item.name !== "string" || item.name === "" ||
        objectValue(item.arguments) === undefined)
    ) throw new Error("Pi assistant tool call is invalid");
  }
}

function validateMessage(record: Readonly<Record<string, JsonValue>>): void {
  const message = objectValue(record.message);
  const role = stringValue(message?.role);
  if (message === undefined || role === undefined || !MESSAGE_ROLES.has(role)) {
    throw new Error("Pi message entry is invalid");
  }
  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
    throw new Error("Pi message timestamp is invalid");
  }
  if (role === "user") {
    validateContent(message.content, new Set(["text", "image"]), "user");
    return;
  }
  if (role === "assistant") {
    validateContent(message.content, new Set(["text", "thinking", "toolCall"]), "assistant");
    if (typeof message.provider !== "string" || message.provider === "" || typeof message.model !== "string" ||
      message.model === "" || typeof message.stopReason !== "string" || objectValue(message.usage) === undefined) {
      throw new Error("Pi assistant message metadata is invalid");
    }
    return;
  }
  if (role === "toolResult") {
    validateContent(message.content, new Set(["text", "image"]), "tool result");
    if (
      typeof message.toolCallId !== "string" || message.toolCallId === "" ||
      typeof message.toolName !== "string" || message.toolName === "" || typeof message.isError !== "boolean"
    ) throw new Error("Pi tool result metadata is invalid");
    return;
  }
  if (role === "bashExecution") {
    if (typeof message.command !== "string" || typeof message.output !== "string" ||
      typeof message.cancelled !== "boolean" || typeof message.truncated !== "boolean") {
      throw new Error("Pi bash execution message is invalid");
    }
    return;
  }
  if (role === "custom") {
    validateContent(message.content, new Set(["text", "image"]), "custom message");
    if (typeof message.customType !== "string" || message.customType === "" || typeof message.display !== "boolean") {
      throw new Error("Pi custom message is invalid");
    }
    return;
  }
  if (role === "branchSummary" && (typeof message.summary !== "string" || typeof message.fromId !== "string")) {
    throw new Error("Pi branch summary message is invalid");
  }
  if (role === "compactionSummary" &&
    (typeof message.summary !== "string" || typeof message.tokensBefore !== "number")) {
    throw new Error("Pi compaction summary message is invalid");
  }
}

function validateEntry(record: Readonly<Record<string, JsonValue>>, seen: ReadonlySet<string>): PiSessionEntry {
  const type = stringValue(record.type);
  const id = stringValue(record.id);
  const parentId = record.parentId;
  const entryTimestamp = stringValue(record.timestamp);
  if (
    type === undefined || !ENTRY_TYPES.has(type) || id === undefined || !ENTRY_ID.test(id) || seen.has(id) ||
    !(parentId === null || typeof parentId === "string" && seen.has(parentId)) ||
    entryTimestamp === undefined || !validTimestamp(entryTimestamp)
  ) throw new Error("Pi session entry is invalid");
  if (type === "message") validateMessage(record);
  if (type === "model_change" &&
    (typeof record.provider !== "string" || record.provider === "" ||
      typeof record.modelId !== "string" || record.modelId === "")) {
    throw new Error("Pi model change entry is invalid");
  }
  if (type === "thinking_level_change" && (typeof record.thinkingLevel !== "string" || record.thinkingLevel === "")) {
    throw new Error("Pi thinking level entry is invalid");
  }
  if (type === "compaction") {
    if (
      typeof record.summary !== "string" || typeof record.tokensBefore !== "number" ||
      typeof record.firstKeptEntryId !== "string" || !seen.has(record.firstKeptEntryId)
    ) throw new Error("Pi compaction entry is invalid");
  }
  if (type === "branch_summary" &&
    (typeof record.summary !== "string" || typeof record.fromId !== "string" || !seen.has(record.fromId))) {
    throw new Error("Pi branch summary entry is invalid");
  }
  if (type === "custom" && (typeof record.customType !== "string" || record.customType === "")) {
    throw new Error("Pi custom entry is invalid");
  }
  if (type === "custom_message") {
    validateContent(record.content, new Set(["text", "image"]), "custom entry");
    if (typeof record.customType !== "string" || record.customType === "" || typeof record.display !== "boolean") {
      throw new Error("Pi custom message entry is invalid");
    }
  }
  if (type === "label" &&
    (typeof record.targetId !== "string" || !seen.has(record.targetId) ||
      !(record.label === undefined || typeof record.label === "string"))) {
    throw new Error("Pi label entry is invalid");
  }
  if (type === "session_info" && !(record.name === undefined || typeof record.name === "string")) {
    throw new Error("Pi session info entry is invalid");
  }
  return { type, id, parentId, timestamp: entryTimestamp, record };
}

function activePath(entries: readonly PiSessionEntry[]): PiSessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const result: PiSessionEntry[] = [];
  let current = entries.at(-1);
  while (current !== undefined) {
    result.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return result.reverse();
}

function messageConversation(entry: PiSessionEntry): ConversationItem[] {
  const message = objectValue(entry.record.message)!;
  const role = stringValue(message.role)!;
  const at = timestamp(message.timestamp, entry.timestamp);
  if (role === "user" || role === "assistant") {
    const kinds = contentKinds(message.content);
    const item: ConversationMessage = {
      kind: "message",
      role,
      text: contentText(message.content),
      timestamp: at,
      ...(role === "assistant" && typeof message.model === "string" ? { model: message.model } : {}),
      ...(kinds === undefined ? {} : { contentKinds: kinds }),
    };
    return [item];
  }
  if (role === "custom") {
    const kinds = contentKinds(message.content);
    return [{
      kind: "message",
      role: "user",
      text: contentText(message.content),
      timestamp: at,
      ...(kinds === undefined ? {} : { contentKinds: kinds }),
    }];
  }
  const label = role === "toolResult"
    ? `Tool result: ${stringValue(message.toolName) ?? "unknown"}`
    : role === "bashExecution"
      ? `Shell: ${stringValue(message.command) ?? ""}`
      : role === "branchSummary"
        ? "Branch summary"
        : "Compaction summary";
  return [{ kind: "gap", label, timestamp: at, code: `pi.${role}` }];
}

function conversationEntry(entry: PiSessionEntry): ConversationItem[] {
  if (entry.type === "message") return messageConversation(entry);
  if (entry.type === "custom_message") {
    const kinds = contentKinds(entry.record.content);
    return [{
      kind: "message",
      role: "user",
      text: contentText(entry.record.content),
      timestamp: entry.timestamp,
      ...(kinds === undefined ? {} : { contentKinds: kinds }),
    }];
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return [{
      kind: "gap",
      label: entry.type === "compaction" ? "Compaction" : "Branch summary",
      timestamp: entry.timestamp,
      code: `pi.${entry.type}`,
    }];
  }
  return [];
}

function searchableText(entry: PiSessionEntry): string[] {
  if (entry.type === "message") {
    const message = objectValue(entry.record.message)!;
    const role = stringValue(message.role)!;
    if (role === "bashExecution") return [stringValue(message.command) ?? "", stringValue(message.output) ?? ""];
    if (role === "branchSummary" || role === "compactionSummary") return [stringValue(message.summary) ?? ""];
    return [contentText(message.content)];
  }
  if (entry.type === "custom_message") return [contentText(entry.record.content)];
  if (entry.type === "compaction" || entry.type === "branch_summary") return [stringValue(entry.record.summary) ?? ""];
  if (entry.type === "session_info") return [stringValue(entry.record.name) ?? ""];
  return [];
}

function firstUserText(entries: readonly PiSessionEntry[]): string {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = objectValue(entry.record.message)!;
    if (message.role === "user") return contentText(message.content).replace(/\s+/g, " ").trim();
  }
  return "";
}

function compact(value: string, maximum = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`;
}

function sessionModel(entries: readonly PiSessionEntry[]): { readonly provider: string; readonly model: string } {
  let provider = "";
  let model = "";
  for (const entry of entries) {
    if (entry.type === "model_change") {
      provider = stringValue(entry.record.provider)!;
      model = stringValue(entry.record.modelId)!;
    } else if (entry.type === "message") {
      const message = objectValue(entry.record.message)!;
      if (message.role === "assistant") {
        provider = stringValue(message.provider)!;
        model = stringValue(message.model)!;
      }
    }
  }
  return { provider, model };
}

function sessionTitle(entries: readonly PiSessionEntry[]): string {
  let name = "";
  for (const entry of entries) {
    if (entry.type === "session_info") name = stringValue(entry.record.name)?.trim() ?? "";
  }
  return compact(name) || compact(firstUserText(activePath(entries))) || "Pi session";
}

function updatedAt(header: PiSessionHeader, entries: readonly PiSessionEntry[], modifiedAt: string): string {
  const values = [header.timestamp, modifiedAt, ...entries.flatMap((entry) => {
    if (entry.type !== "message") return [entry.timestamp];
    const message = objectValue(entry.record.message)!;
    return [entry.timestamp, timestamp(message.timestamp, entry.timestamp)];
  })].map((value) => Date.parse(value)).filter(Number.isFinite);
  return new Date(Math.max(...values)).toISOString();
}

export async function parsePiSession(filePath: string, modifiedAt: string): Promise<ParsedPiSession> {
  const input = createReadStream(filePath);
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let header: PiSessionHeader | undefined;
  const entries: PiSessionEntry[] = [];
  const seen = new Set<string>();
  try {
    for await (const line of lines) {
      if (line === "") throw new Error("Pi session contains an empty record");
      if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) throw new Error("Pi session record exceeds validation limits");
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new Error("Pi session contains invalid JSON"); }
      const record = objectValue(parsed);
      if (record === undefined) throw new Error("Pi session record is not an object");
      if (header === undefined) {
        if (
          record.type !== "session" || record.version !== 3 || typeof record.id !== "string" || record.id === "" ||
          typeof record.timestamp !== "string" || !validTimestamp(record.timestamp) ||
          typeof record.cwd !== "string" ||
          !(record.parentSession === undefined || typeof record.parentSession === "string")
        ) throw new Error("Pi session header is invalid or unsupported");
        const cwd = normalizeStoredPath(record.cwd, "session cwd");
        const parentSession = typeof record.parentSession === "string"
          ? normalizeStoredPath(record.parentSession, "parent session path")
          : undefined;
        header = {
          type: "session",
          version: 3,
          id: record.id,
          timestamp: record.timestamp,
          cwd,
          ...(parentSession === undefined ? {} : { parentSession }),
          record,
        };
        continue;
      }
      if (entries.length >= MAX_ENTRIES) throw new Error("Pi session exceeds entry limits");
      const entry = validateEntry(record, seen);
      entries.push(entry);
      seen.add(entry.id);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (header === undefined) throw new Error("Pi session has no header");
  const activeEntries = activePath(entries);
  const children = new Map<string | null, number>();
  for (const entry of entries) children.set(entry.parentId, (children.get(entry.parentId) ?? 0) + 1);
  const current = sessionModel(activeEntries);
  const conversation = activeEntries.flatMap(conversationEntry);
  return {
    header,
    entries,
    activeEntries,
    title: sessionTitle(entries),
    model: current.model,
    provider: current.provider,
    createdAt: new Date(Date.parse(header.timestamp)).toISOString(),
    updatedAt: updatedAt(header, entries, modifiedAt),
    conversation,
    searchText: [...new Set(entries.flatMap(searchableText).map((value) => value.trim()).filter(Boolean))],
    leafId: entries.at(-1)?.id ?? null,
    roots: children.get(null) ?? 0,
    branchPoints: [...children.values()].filter((count) => count > 1).length,
    messageCount: entries.filter((entry) => entry.type === "message").length,
  };
}
