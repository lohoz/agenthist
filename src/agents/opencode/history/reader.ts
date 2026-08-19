import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  ConversationItem,
  ConversationMessage,
  JsonValue,
  StoredSession,
} from "../../../domain/history.js";
import type { PortableContextBlock } from "../../../domain/portable-context.js";
import {
  managedResourceReference,
  type ManagedResourceObject,
} from "../../../domain/resource.js";
import { encodeSQLiteValue } from "../../../infrastructure/sqlite.js";
import { openCodeSessionRef } from "../identity.js";
import {
  type OpenCodeHistorySchema,
  type OpenCodeHistoryTable,
  openCodePendingInputStatuses,
  openCodeRevertStatuses,
  openCodeTableSchema,
  readOpenCodeTableRows,
  validateOpenCodeHistoryDatabase,
} from "../storage/database.js";
import {
  OPENCODE_LEGACY_COMPACTION_TAIL_NOTE,
  openCodeCompactionDescriptor,
  openCodeAgentName,
  openCodeSubtaskDescriptor,
  projectOpenCodeDerivedPart,
} from "./derived-part-projection.js";
import { projectOpenCodeFilePart } from "./file-part-projection.js";
import { projectOpenCodeSessionMessages } from "./session-message-projection.js";
import { projectOpenCodeReasoningPart, projectOpenCodeTextPart } from "./text-part-projection.js";
import { projectOpenCodeTool } from "./tool-projection.js";
import type { OpenCodeToolOutputDescriptor } from "../tool-output.js";

type SQLiteRow = Record<string, unknown>;

export const OPENCODE_HISTORY_DATABASE_RELATIVE_PATH = "opencode/history.sqlite";
const OPENCODE_AGENT_REPLAY_PREFIX =
  " Use the above message and context to generate a prompt and call the task tool with subagent: ";
const OPENCODE_AGENT_DENIED_SUFFIX = " . Invoked by user; guaranteed to exist.";
const OPENCODE_SUBTASK_REPLAY_TEXT = "The following tool was executed by the user";
const OPENCODE_SUBTASK_SUMMARY_TEXT = "Summarize the task tool output above and continue with your task.";

export interface ReadOpenCodeHistoryOptions {
  readonly databasePath: string;
  readonly databaseRelativePath: string;
  readonly sidecarFiles: readonly string[];
  readonly planFiles?: ReadonlyMap<string, string>;
  readonly toolOutputs?: ReadonlyMap<string, readonly OpenCodeToolOutputDescriptor[]>;
  readonly toolOutputResources?: ReadonlyMap<string, ManagedResourceObject>;
  readonly previousLibrary?: ReadonlyMap<string, StoredSession["library"]>;
  readonly importedLibrary?: ReadonlyMap<string, StoredSession["library"]>;
  readonly previousSessions?: ReadonlyMap<string, StoredSession>;
  readonly nonReusableSessions?: ReadonlySet<string>;
}

export interface ReadOpenCodeHistoryResult {
  readonly sessions: readonly StoredSession[];
  readonly managedResources: ReadonlyMap<string, readonly ManagedResourceObject[]>;
  readonly unassignedSidecars: readonly string[];
  readonly warnings: readonly string[];
  readonly reusedSessions: number;
  readonly rebuiltSessions: number;
}

function rows(database: DatabaseSync, sql: string): SQLiteRow[] {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all() as SQLiteRow[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return undefined;
}

function timestamp(value: unknown): string {
  const milliseconds = integer(value);
  if (milliseconds === undefined) return "";
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const fields = new Set(allowed);
  return Object.keys(value).every((name) => fields.has(name));
}

function closedAbortedError(value: unknown): boolean {
  const error = objectValue(value);
  const data = objectValue(error?.data);
  return error !== undefined && hasOnlyFields(error, ["name", "data"]) &&
    error.name === "MessageAbortedError" && data !== undefined &&
    hasOnlyFields(data, ["message"]) && typeof data.message === "string";
}

interface LegacyCompactionClosure {
  readonly boundaryIds: ReadonlySet<string>;
  readonly summaryIds: ReadonlySet<string>;
  readonly tailMessageIds: ReadonlySet<string>;
  readonly latestBoundaryIndex: number;
}

function closedPortableTextParts(parts: readonly SQLiteRow[], role: "user" | "assistant"): boolean {
  return parts.length !== 0 && parts.every((part) => {
    const data = jsonObject(part.data);
    if (data === undefined) return false;
    const projected = projectOpenCodeTextPart(data, role);
    return projected.block?.kind === "text" && projected.gap === undefined;
  });
}

interface ClosedPortableRetainedParts {
  readonly hasTool: boolean;
}

function closedPortableRetainedUserParts(
  message: SQLiteRow,
  parts: readonly SQLiteRow[],
): boolean {
  const messageId = text(message.id);
  const sessionId = text(message.session_id);
  if (messageId === undefined || sessionId === undefined || parts.length === 0) return false;
  let portableBlocks = 0;
  for (const part of parts) {
    const data = jsonObject(part.data);
    if (data === undefined) return false;
    if (data.type === "text") {
      const projected = projectOpenCodeTextPart(data, "user");
      if (projected.block?.kind !== "text" || projected.gap !== undefined) return false;
      portableBlocks++;
      continue;
    }
    const partId = text(part.id);
    if (
      data.type !== "file" || partId === undefined ||
      projectOpenCodeFilePart(data, { id: partId, messageId, sessionId }) === undefined
    ) return false;
    if (legacyFilePartIsReplayed(data, "user")) portableBlocks++;
  }
  return portableBlocks !== 0;
}

function closedPortableRetainedParts(
  message: SQLiteRow,
  parts: readonly SQLiteRow[],
  role: "user" | "assistant",
  allowTools: boolean,
  toolOutputs: readonly OpenCodeToolOutputDescriptor[],
  toolOutputResources: ReadonlyMap<string, ManagedResourceObject>,
): ClosedPortableRetainedParts | undefined {
  if (role === "user") return closedPortableRetainedUserParts(message, parts) ? { hasTool: false } : undefined;
  const messageId = text(message.id);
  const sessionId = text(message.session_id);
  const metadata = jsonObject(message.data);
  if (messageId === undefined || sessionId === undefined || metadata === undefined || parts.length === 0) {
    return undefined;
  }
  const expectedStructured = Object.hasOwn(metadata, "structured") ? metadata.structured : undefined;
  let structuredClosures = 0;
  let tools = 0;
  let portableBlocks = 0;
  for (const part of parts) {
    const data = jsonObject(part.data);
    if (data === undefined) return undefined;
    if (data.type === "text") {
      const projected = projectOpenCodeTextPart(data, role);
      if (projected.block?.kind !== "text" || projected.gap !== undefined) return undefined;
      portableBlocks++;
      continue;
    }
    if (data.type === "reasoning") {
      const projected = projectOpenCodeReasoningPart(data);
      if (projected.gap !== undefined) return undefined;
      if (projected.block !== undefined) portableBlocks++;
      continue;
    }
    if (!allowTools || data.type !== "tool") return undefined;
    const projected = projectOpenCodeTool(
      data,
      { messageId, sessionId },
      toolOutputs,
      toolOutputResources,
      expectedStructured,
    );
    if (projected.block?.kind !== "historical_tool") return undefined;
    tools++;
    portableBlocks++;
    structuredClosures += projected.notes?.filter((note) => note === "opencode.structured_output.closed").length ?? 0;
  }
  return portableBlocks !== 0 && (expectedStructured === undefined || structuredClosures === 1)
    ? { hasTool: tools !== 0 }
    : undefined;
}

function closedLegacyRetainedTail(
  messages: readonly SQLiteRow[],
  previousMessage: SQLiteRow | undefined,
  summaryMessage: SQLiteRow,
  partsByMessage: ReadonlyMap<string, readonly SQLiteRow[]>,
  toolOutputs: readonly OpenCodeToolOutputDescriptor[],
  toolOutputResources: ReadonlyMap<string, ManagedResourceObject>,
): boolean {
  if (messages.length === 0) return false;
  const firstMetadata = jsonObject(messages[0]!.data);
  const startsWithAssistant = firstMetadata?.role === "assistant";
  if (
    startsWithAssistant
      ? messages.length % 2 !== 1
      : firstMetadata?.role !== "user" || messages.length % 2 !== 0
  ) return false;
  const previousId = text(previousMessage?.id);
  const previousMetadata = jsonObject(previousMessage?.data);
  const summaryMetadata = jsonObject(summaryMessage.data);
  if (
    startsWithAssistant && (
      previousId === undefined || previousMetadata?.role !== "user" ||
      firstMetadata?.parentID !== previousId ||
      typeof firstMetadata?.providerID !== "string" || firstMetadata?.providerID === "" ||
      typeof firstMetadata?.modelID !== "string" || firstMetadata?.modelID === "" ||
      firstMetadata?.providerID !== summaryMetadata?.providerID ||
      firstMetadata?.modelID !== summaryMetadata?.modelID
    )
  ) return false;
  let previousUserId = startsWithAssistant ? previousId ?? "" : "";
  for (const [index, message] of messages.entries()) {
    const id = text(message.id);
    const metadata = jsonObject(message.data);
    const role = (index + (startsWithAssistant ? 1 : 0)) % 2 === 0 ? "user" : "assistant";
    const portable = id === undefined || metadata?.role !== role
      ? undefined
      : closedPortableRetainedParts(
        message,
        partsByMessage.get(id) ?? [],
        role,
        !(startsWithAssistant && index === 0),
        toolOutputs,
        toolOutputResources,
      );
    if (id === undefined || metadata?.role !== role || portable === undefined) return false;
    if (role === "user") {
      previousUserId = id;
      continue;
    }
    const finish = metadata.finish;
    if (
      metadata.parentID !== previousUserId || typeof finish !== "string" || finish === "" ||
      finish === "unknown" || (finish === "tool-calls" && !portable.hasTool) ||
      metadata.summary === true || Object.hasOwn(metadata, "error")
    ) return false;
  }
  return true;
}

function legacyCompactionClosure(
  messages: readonly SQLiteRow[],
  partsByMessage: ReadonlyMap<string, readonly SQLiteRow[]>,
  toolOutputs: readonly OpenCodeToolOutputDescriptor[],
  toolOutputResources: ReadonlyMap<string, ManagedResourceObject>,
): LegacyCompactionClosure {
  const messageIndices = new Map<string, number>();
  const summariesByParent = new Map<string, string[]>();
  for (const [index, message] of messages.entries()) {
    const id = text(message.id);
    const metadata = jsonObject(message.data);
    if (id === undefined || metadata === undefined) continue;
    messageIndices.set(id, index);
    const parentId = text(metadata.parentID);
    if (
      metadata.role !== "assistant" || metadata.summary !== true ||
      typeof metadata.finish !== "string" || metadata.finish === "" ||
      Object.hasOwn(metadata, "error") || parentId === undefined || parentId === ""
    ) continue;
    const summaries = summariesByParent.get(parentId) ?? [];
    summaries.push(id);
    summariesByParent.set(parentId, summaries);
  }

  const boundaryIds = new Set<string>();
  const summaryIds = new Set<string>();
  let tailMessageIds = new Set<string>();
  let latestBoundaryIndex = -1;
  for (const [index, message] of messages.entries()) {
    const id = text(message.id);
    const metadata = jsonObject(message.data);
    const parts = id === undefined ? [] : partsByMessage.get(id) ?? [];
    const summaries = id === undefined ? [] : summariesByParent.get(id) ?? [];
    const summaryIndex = summaries.length === 1 ? messageIndices.get(summaries[0]!) : undefined;
    const compactionData = parts.length === 1 ? jsonObject(parts[0]!.data) : undefined;
    const compaction = compactionData === undefined ? undefined : openCodeCompactionDescriptor(compactionData);
    if (
      id === undefined || metadata?.role !== "user" || compaction === undefined || summaries.length !== 1 ||
      summaryIndex === undefined || summaryIndex <= index
    ) continue;
    let candidateTailIds = new Set<string>();
    if (compaction.tailStartId !== undefined) {
      const tailStartIndex = messageIndices.get(compaction.tailStartId);
      const summaryId = summaries[0]!;
      if (
        tailStartIndex === undefined || tailStartIndex <= 0 || tailStartIndex >= index ||
        summaryIndex !== index + 1 ||
        !closedPortableTextParts(partsByMessage.get(summaryId) ?? [], "assistant") ||
        !closedLegacyRetainedTail(
          messages.slice(tailStartIndex, index),
          messages[tailStartIndex - 1],
          messages[summaryIndex]!,
          partsByMessage,
          toolOutputs,
          toolOutputResources,
        )
      ) continue;
      candidateTailIds = new Set(messages.slice(tailStartIndex, index).map((item) => text(item.id)!));
    }
    boundaryIds.add(id);
    summaryIds.add(summaries[0]!);
    latestBoundaryIndex = index;
    tailMessageIds = candidateTailIds;
  }
  return { boundaryIds, summaryIds, tailMessageIds, latestBoundaryIndex };
}

function encodedRow(row: SQLiteRow): JsonValue {
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, encodeSQLiteValue(value)]));
}

function sessionScanFingerprint(values: readonly unknown[]): string {
  const digest = createHash("sha256").update("opencode-session/v1\0");
  for (const value of values) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("cannot fingerprint OpenCode session metadata");
    digest.update(encoded).update("\0");
  }
  return `opencode-session/v1:${digest.digest("hex")}`;
}

function persistedRows(
  database: DatabaseSync,
  schema: OpenCodeHistorySchema,
  name: OpenCodeHistoryTable,
): SQLiteRow[] {
  const table = openCodeTableSchema(schema, name);
  if (table === undefined) return [];
  return readOpenCodeTableRows(database, table).map((values) => Object.fromEntries(
    table.columns.map((column, index) => [column.name, values[index]]),
  ));
}

const OPENCODE_TODO_COLUMNS = new Set([
  "session_id",
  "content",
  "status",
  "priority",
  "position",
  "time_created",
  "time_updated",
]);
const OPENCODE_TODO_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);
const OPENCODE_TODO_PRIORITIES = new Set(["high", "medium", "low"]);

interface OpenCodeTodoProjection {
  readonly stateBySession: ReadonlyMap<string, JsonValue>;
  readonly searchTextBySession: ReadonlyMap<string, readonly string[]>;
}

function openCodeTodoProjection(
  database: DatabaseSync,
  schema: OpenCodeHistorySchema,
): OpenCodeTodoProjection {
  const table = openCodeTableSchema(schema, "todo");
  if (table === undefined) return { stateBySession: new Map(), searchTextBySession: new Map() };
  const requiredColumns = ["session_id", "content", "status", "priority", "position"];
  const columnNames = table.columns.map((column) => column.name);
  const supportedSchema = requiredColumns.every((column) => columnNames.includes(column)) &&
    columnNames.every((column) => OPENCODE_TODO_COLUMNS.has(column));
  const sessionIdIndex = columnNames.indexOf("session_id");
  const contentIndex = columnNames.indexOf("content");
  const statusIndex = columnNames.indexOf("status");
  const priorityIndex = columnNames.indexOf("priority");
  const positionIndex = columnNames.indexOf("position");
  const grouped = new Map<string, ReturnType<typeof readOpenCodeTableRows>>();
  const searchTextBySession = new Map<string, string[]>();
  for (const row of readOpenCodeTableRows(database, table)) {
    const sessionId = text(row[sessionIdIndex]);
    if (sessionId === undefined) throw new Error("OpenCode todo row has no session owner");
    const owned = grouped.get(sessionId) ?? [];
    owned.push(row);
    grouped.set(sessionId, owned);
    const content = text(row[contentIndex]);
    if (content !== undefined) {
      const searchable = searchTextBySession.get(sessionId) ?? [];
      searchable.push(content);
      searchTextBySession.set(sessionId, searchable);
    }
  }
  const stateBySession = new Map<string, JsonValue>();
  for (const [sessionId, owned] of grouped) {
    const items: Array<Record<string, JsonValue>> = [];
    let verified = supportedSchema;
    for (const [ordinal, row] of owned.entries()) {
      const position = integer(row[positionIndex]);
      const content = text(row[contentIndex]);
      const status = text(row[statusIndex]);
      const priority = text(row[priorityIndex]);
      if (
        position !== ordinal || content === undefined || status === undefined || priority === undefined ||
        !OPENCODE_TODO_STATUSES.has(status) || !OPENCODE_TODO_PRIORITIES.has(priority)
      ) {
        verified = false;
        continue;
      }
      items.push({ position, content, status, priority });
    }
    stateBySession.set(sessionId, verified && items.length === owned.length
      ? { status: "verified", items }
      : { status: "unverified", count: owned.length });
  }
  return { stateBySession, searchTextBySession };
}

function modelIdentity(session: SQLiteRow, messages: readonly SQLiteRow[]): { model: string; provider: string } {
  const nativeModel = text(session.model);
  const parsed = jsonObject(nativeModel);
  let model = text(parsed?.id) ?? text(parsed?.modelID) ?? (parsed === undefined ? nativeModel ?? "" : "");
  let provider = text(parsed?.providerID) ?? "";
  for (const message of messages) {
    const data = jsonObject(message.data);
    if (data === undefined) continue;
    model ||= text(data.modelID) ?? text(jsonObject(data.model)?.modelID) ?? text(jsonObject(data.model)?.id) ?? "";
    provider ||= text(data.providerID) ?? text(jsonObject(data.model)?.providerID) ?? "";
    if (model !== "" && provider !== "") break;
  }
  return { model, provider };
}

function renderTool(data: Record<string, unknown>): string {
  const tool = text(data.tool) ?? "tool";
  const state = data.state !== null && typeof data.state === "object" && !Array.isArray(data.state)
    ? data.state as Record<string, unknown>
    : undefined;
  const status = text(state?.status);
  const lines = [`[tool: ${tool}${status === undefined ? "" : ` (${status})`}]`];
  if (state?.input !== undefined) {
    try { lines.push(`input: ${JSON.stringify(state.input)}`); } catch { /* native bytes remain in evidence */ }
  }
  for (const field of ["title", "output", "error"] as const) {
    const value = text(state?.[field]);
    if (value !== undefined && value !== "") lines.push(`${field}: ${value}`);
  }
  const metadataValue = state?.metadata;
  const metadata = metadataValue !== null && typeof metadataValue === "object" && !Array.isArray(metadataValue)
    ? metadataValue as Record<string, unknown>
    : undefined;
  const outputPath = text(metadata?.outputPath);
  if (outputPath !== undefined) lines.push(`output path: ${outputPath}`);
  return lines.join("\n");
}

interface RenderedPart {
  readonly kind: string;
  readonly text?: string;
  readonly portableBlock?: PortableContextBlock;
  readonly portableNotes?: readonly string[];
  readonly managedResources?: readonly ManagedResourceObject[];
  readonly gap?: string;
  readonly gapCode?: string;
}

interface OpenCodeLegacyControlClosures {
  readonly agentParts: ReadonlySet<string>;
  readonly subtaskParts: ReadonlySet<string>;
}

function legacyFilePartIsReplayed(
  data: Record<string, unknown>,
  role: "user" | "assistant",
): boolean {
  return role === "user" && data.mime !== "text/plain" && data.mime !== "application/x-directory";
}

function addManagedResource(
  resources: Map<string, ManagedResourceObject>,
  resource: ManagedResourceObject,
): void {
  const key = JSON.stringify([
    resource.sha256,
    resource.sizeBytes,
    resource.mediaType,
    resource.name,
    resource.sourceReference,
    resource.relativePath,
  ]);
  const existing = resources.get(key);
  if (existing !== undefined && !Buffer.from(existing.bytes).equals(Buffer.from(resource.bytes))) {
    throw new Error("OpenCode managed resource identity contains different bytes");
  }
  resources.set(key, resource);
}

function mergeManagedResources(
  ...groups: readonly (readonly ManagedResourceObject[])[]
): ManagedResourceObject[] {
  const resources = new Map<string, ManagedResourceObject>();
  for (const resource of groups.flat()) addManagedResource(resources, resource);
  return [...resources.values()];
}

function renderPart(
  part: SQLiteRow,
  toolOutputs: readonly OpenCodeToolOutputDescriptor[],
  toolOutputResources: ReadonlyMap<string, ManagedResourceObject>,
  expectedStructured: unknown,
  role: "user" | "assistant",
  controlClosures: OpenCodeLegacyControlClosures,
): RenderedPart {
  const data = jsonObject(part.data);
  if (data === undefined) return {
    kind: "unclassified",
    gap: "part metadata is not readable JSON",
    gapCode: "opencode.part.unclassified",
  };
  const kind = text(data.type);
  if (kind === "text") {
    const projected = projectOpenCodeTextPart(data, role);
    return {
      kind,
      ...(projected.text === undefined ? {} : { text: projected.text }),
      ...(projected.block === undefined ? {} : { portableBlock: projected.block }),
      ...(projected.notes === undefined ? {} : { portableNotes: projected.notes }),
      ...(projected.gap === undefined ? {} : { gap: projected.gap }),
      ...(projected.gapCode === undefined ? {} : { gapCode: projected.gapCode }),
    };
  }
  if (kind === "reasoning") {
    if (role !== "assistant") {
      return { kind, gap: "reasoning part belongs to a non-assistant message", gapCode: "opencode.part.reasoning_invalid" };
    }
    const projected = projectOpenCodeReasoningPart(data);
    return {
      kind,
      ...(projected.text === undefined ? {} : { text: projected.text }),
      ...(projected.block === undefined ? {} : { portableBlock: projected.block }),
      ...(projected.notes === undefined ? {} : { portableNotes: projected.notes }),
      ...(projected.gap === undefined ? {} : { gap: projected.gap }),
      ...(projected.gapCode === undefined ? {} : { gapCode: projected.gapCode }),
    };
  }
  if (kind === "tool") {
    const sessionId = text(part.session_id);
    const messageId = text(part.message_id);
    const portable = sessionId === undefined || messageId === undefined
      ? {}
      : projectOpenCodeTool(
          data,
          { sessionId, messageId },
          toolOutputs,
          toolOutputResources,
          expectedStructured,
        );
    return portable.block === undefined
      ? {
          kind,
          text: renderTool(data),
          gap: "tool part is not a closed portable historical exchange",
          gapCode: "opencode.part.tool",
        }
      : {
          kind,
          text: renderTool(data),
          portableBlock: portable.block,
          ...(portable.notes === undefined ? {} : { portableNotes: portable.notes }),
          ...(portable.managedResources === undefined ? {} : { managedResources: portable.managedResources }),
        };
  }
  if (kind === "file") {
    const partId = text(part.id);
    const messageId = text(part.message_id);
    const sessionId = text(part.session_id);
    const projected = partId === undefined || messageId === undefined || sessionId === undefined
      ? undefined
      : projectOpenCodeFilePart(data, { id: partId, messageId, sessionId });
    if (projected !== undefined && !legacyFilePartIsReplayed(data, role)) return {
      kind,
      text: projected.kind === "resource"
        ? `[file] ${projected.resource.name} ${projected.resource.mediaType}`
        : `[file] ${text(data.filename) ?? projected.reference.locator} ${text(data.mime) ?? ""}`.trimEnd(),
      portableNotes: ["opencode.legacy_file_part.skipped"],
    };
    if (projected?.kind === "resource") return {
      kind,
      text: `[file] ${projected.resource.name} ${projected.resource.mediaType}`,
      portableBlock: { kind: "historical_resource", resource: managedResourceReference(projected.resource) },
      portableNotes: ["opencode.file_part.managed", ...projected.notes],
      managedResources: [projected.resource],
    };
    if (projected?.kind === "reference") return {
      kind,
      text: `[file] ${text(data.filename) ?? projected.reference.locator} ${text(data.mime) ?? ""}`.trimEnd(),
      portableBlock: { kind: "historical_reference", reference: projected.reference },
      portableNotes: projected.notes,
    };
    const details = [text(data.filename), text(data.mime), text(data.url)]
      .filter((item): item is string => item !== undefined);
    return {
      kind,
      text: `[file]${details.length === 0 ? "" : ` ${details.join(" ")}`}`,
      gap: "file part requires portable resource normalization",
      gapCode: "opencode.part.file",
    };
  }
  const derived = projectOpenCodeDerivedPart(data);
  if (derived !== undefined) {
    const partId = text(part.id);
    if (
      derived.code === "opencode.part.subtask" && partId !== undefined &&
      controlClosures.subtaskParts.has(partId)
    ) {
      return {
        kind: derived.kind,
        text: OPENCODE_SUBTASK_REPLAY_TEXT,
        portableBlock: { kind: "text", text: OPENCODE_SUBTASK_REPLAY_TEXT },
        portableNotes: ["opencode.subtask.materialized"],
      };
    }
    if (
      role === "user" && derived.code === "opencode.part.agent" && partId !== undefined &&
      controlClosures.agentParts.has(partId)
    ) {
      return {
        kind: derived.kind,
        portableNotes: ["opencode.agent_reference.part_skipped"],
      };
    }
    return { kind: derived.kind, gap: derived.label, gapCode: derived.code };
  }
  return {
    kind: kind ?? "unclassified",
    gap: kind === undefined ? "part type is unavailable" : `unsupported part type: ${kind}`,
    gapCode: "opencode.part.unsupported",
  };
}

function closedAgentReferenceParts(
  byMessage: ReadonlyMap<string, readonly SQLiteRow[]>,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const parts of byMessage.values()) {
    for (let index = 0; index + 1 < parts.length; index++) {
      const part = parts[index]!;
      const data = jsonObject(part.data);
      const name = data === undefined ? undefined : openCodeAgentName(data);
      const replay = jsonObject(parts[index + 1]!.data);
      const expected = name === undefined ? undefined : OPENCODE_AGENT_REPLAY_PREFIX + name;
      if (
        expected === undefined || replay === undefined ||
        !hasOnlyFields(replay, ["type", "text", "synthetic"]) ||
        replay.type !== "text" || replay.synthetic !== true ||
        (replay.text !== expected && replay.text !== expected + OPENCODE_AGENT_DENIED_SUFFIX)
      ) continue;
      const partId = text(part.id);
      if (partId !== undefined) result.add(partId);
    }
  }
  return result;
}

function materializedSubtaskParts(
  messages: readonly SQLiteRow[],
  byMessage: ReadonlyMap<string, readonly SQLiteRow[]>,
  toolOutputs: readonly OpenCodeToolOutputDescriptor[],
  toolOutputResources: ReadonlyMap<string, ManagedResourceObject>,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (let index = 0; index + 2 < messages.length; index++) {
    const user = messages[index]!;
    const assistant = messages[index + 1]!;
    const summary = messages[index + 2]!;
    const userId = text(user.id);
    const assistantId = text(assistant.id);
    const sessionId = text(user.session_id);
    const userData = jsonObject(user.data);
    const assistantData = jsonObject(assistant.data);
    const summaryData = jsonObject(summary.data);
    if (
      userId === undefined || assistantId === undefined || sessionId === undefined ||
      text(assistant.session_id) !== sessionId || text(summary.session_id) !== sessionId ||
      userData?.role !== "user" || assistantData?.role !== "assistant" || summaryData?.role !== "user"
    ) continue;
    const userParts = byMessage.get(userId) ?? [];
    const assistantParts = byMessage.get(assistantId) ?? [];
    const summaryId = text(summary.id);
    const summaryParts = summaryId === undefined ? [] : byMessage.get(summaryId) ?? [];
    if (userParts.length !== 1 || assistantParts.length !== 1 || summaryParts.length !== 1) continue;
    const subtaskPart = userParts[0]!;
    const subtaskData = jsonObject(subtaskPart.data);
    const subtask = subtaskData === undefined ? undefined : openCodeSubtaskDescriptor(subtaskData);
    if (
      subtask === undefined || subtask.model === undefined ||
      subtask.command === undefined || subtask.command === ""
    ) {
      continue;
    }
    const userModel = objectValue(userData.model);
    if (
      typeof userData.agent !== "string" || userData.agent === "" || userModel === undefined ||
      !hasOnlyFields(userModel, ["providerID", "modelID"]) ||
      typeof userModel.providerID !== "string" || userModel.providerID === "" ||
      typeof userModel.modelID !== "string" || userModel.modelID === ""
    ) continue;
    if (
      assistantData.parentID !== userId || assistantData.finish !== "tool-calls" ||
      assistantData.mode !== subtask.agent || assistantData.agent !== subtask.agent ||
      assistantData.providerID !== subtask.model.providerID || assistantData.modelID !== subtask.model.modelID ||
      Object.hasOwn(assistantData, "error")
    ) continue;
    const toolData = jsonObject(assistantParts[0]!.data);
    const projectedTool = toolData === undefined
      ? undefined
      : projectOpenCodeTool(
          toolData,
          { sessionId, messageId: assistantId },
          toolOutputs,
          toolOutputResources,
          undefined,
        );
    const expectedInput = {
      prompt: subtask.prompt,
      description: subtask.description,
      subagent_type: subtask.agent,
      command: subtask.command,
    };
    const toolState = objectValue(toolData?.state);
    const taskMetadata = objectValue(toolState?.metadata);
    if (
      projectedTool?.block?.kind !== "historical_tool" || projectedTool.block.tool.name !== "task" ||
      projectedTool.notes?.includes("opencode.task_result.closed") !== true ||
      !isDeepStrictEqual(projectedTool.block.tool.input, expectedInput) ||
      !isDeepStrictEqual(taskMetadata?.model, subtask.model)
    ) continue;
    const summaryPart = jsonObject(summaryParts[0]!.data);
    if (
      !isDeepStrictEqual(summaryData.agent, userData.agent) ||
      !isDeepStrictEqual(summaryData.model, userData.model) ||
      !isDeepStrictEqual(summaryPart, {
        type: "text",
        text: OPENCODE_SUBTASK_SUMMARY_TEXT,
        synthetic: true,
      })
    ) continue;
    const partId = text(subtaskPart.id);
    if (partId !== undefined) result.add(partId);
  }
  return result;
}

function conversation(
  messages: readonly SQLiteRow[],
  parts: readonly SQLiteRow[],
  toolOutputs: readonly OpenCodeToolOutputDescriptor[],
  toolOutputResources: ReadonlyMap<string, ManagedResourceObject>,
): { readonly items: readonly ConversationItem[]; readonly managedResources: readonly ManagedResourceObject[] } {
  const byMessage = new Map<string, SQLiteRow[]>();
  for (const part of parts) {
    const messageId = text(part.message_id);
    if (messageId === undefined) continue;
    const values = byMessage.get(messageId) ?? [];
    values.push(part);
    byMessage.set(messageId, values);
  }
  const legacyCompaction = legacyCompactionClosure(messages, byMessage, toolOutputs, toolOutputResources);
  const controlClosures: OpenCodeLegacyControlClosures = {
    agentParts: closedAgentReferenceParts(byMessage),
    subtaskParts: materializedSubtaskParts(messages, byMessage, toolOutputs, toolOutputResources),
  };
  const result: ConversationItem[] = [];
  const managedResources = new Map<string, ManagedResourceObject>();
  let previousMessageId = "";
  let previousRole = "";
  let previousParentId = "";
  let previousFinish = "";
  let lastConversationMessageIndex = -1;
  for (const [messageIndex, message] of messages.entries()) {
    const messageId = text(message.id);
    const metadata = jsonObject(message.data);
    const role = text(metadata?.role);
    const createdAt = timestamp(message.time_created);
    if (messageId === undefined || (role !== "user" && role !== "assistant")) {
      result.push({ kind: "gap", label: "message metadata is not readable", timestamp: createdAt });
      continue;
    }
    const visible: string[] = [];
    const portableBlocks: PortableContextBlock[] = [];
    const portableNotes: string[] = [];
    const kinds: string[] = [];
    const gaps: string[] = [];
    const gapCodes: string[] = [];
    const messageManagedResources = new Map<string, ManagedResourceObject>();
    const materializedCompactionBoundary = legacyCompaction.boundaryIds.has(messageId);
    if (legacyCompaction.tailMessageIds.has(messageId)) {
      portableNotes.push(OPENCODE_LEGACY_COMPACTION_TAIL_NOTE);
    }
    const expectedStructured = role === "assistant" && metadata !== undefined && Object.hasOwn(metadata, "structured")
      ? metadata.structured
      : undefined;
    for (const part of byMessage.get(messageId) ?? []) {
      const rendered = renderPart(
        part,
        toolOutputs,
        toolOutputResources,
        expectedStructured,
        role,
        controlClosures,
      );
      kinds.push(rendered.kind);
      if (
        materializedCompactionBoundary && rendered.kind === "compaction" &&
        rendered.gapCode === "opencode.part.compaction"
      ) {
        visible.push("[compaction boundary]");
        portableBlocks.push({ kind: "text", text: "What did we do so far?" });
        portableNotes.push("opencode.legacy_compaction.materialized");
        continue;
      }
      if (rendered.text !== undefined && rendered.text !== "") visible.push(rendered.text);
      if (rendered.portableBlock !== undefined) portableBlocks.push(rendered.portableBlock);
      if (rendered.portableNotes !== undefined) portableNotes.push(...rendered.portableNotes);
      for (const resource of rendered.managedResources ?? []) addManagedResource(messageManagedResources, resource);
      if (rendered.gap !== undefined) {
        gaps.push(rendered.gap);
        gapCodes.push(rendered.gapCode ?? "opencode.part.unsupported");
      }
    }
    if (role === "assistant" && metadata !== undefined && Object.hasOwn(metadata, "error")) {
      const replayableAbort = closedAbortedError(metadata.error) &&
        kinds.some((kind) => kind !== "step-start" && kind !== "reasoning");
      if (replayableAbort) {
        visible.push("[response aborted]\nThe preceding OpenCode assistant response may be incomplete.");
        portableBlocks.push({ kind: "historical_event", event: "assistant_response_aborted", reason: "aborted" });
        kinds.push("historical_event");
        portableNotes.push("opencode.assistant_abort.materialized");
      } else {
        gaps.push("assistant error is excluded from OpenCode model replay");
        gapCodes.push("opencode.message.assistant_error");
      }
    }
    if (
      role === "assistant" && metadata?.summary === true &&
      !legacyCompaction.summaryIds.has(messageId)
    ) {
      gaps.push("assistant compaction summary changes OpenCode replay order");
      gapCodes.push("opencode.message.compaction_summary");
    }
    const structuredClosures = portableNotes.filter((note) => note === "opencode.structured_output.closed").length;
    if (expectedStructured !== undefined && structuredClosures !== 1) {
      gaps.push("assistant structured output is not closed by exactly one StructuredOutput tool exchange");
      gapCodes.push("opencode.part.structured_output");
    }
    if (visible.length !== 0) {
      const model = role === "assistant" ? text(metadata?.modelID) : undefined;
      const projected: ConversationMessage = {
        kind: "message",
        role,
        text: visible.join("\n\n"),
        timestamp: createdAt,
        contentKinds: kinds,
        portableBlocks,
        portableNotes,
        ...(model === undefined ? {} : { model }),
      };
      const parentId = text(metadata?.parentID) ?? "";
      const continuation = role === "assistant" && previousRole === "assistant" &&
        previousFinish === "tool-calls" && parentId !== "" &&
        (parentId === previousMessageId || parentId === previousParentId);
      const previous = continuation ? result[lastConversationMessageIndex] : undefined;
      if (previous?.kind === "message" && previous.role === "assistant") {
        result[lastConversationMessageIndex] = {
          ...previous,
          text: `${previous.text}\n\n${projected.text}`,
          contentKinds: [...(previous.contentKinds ?? []), ...(projected.contentKinds ?? [])],
          portableBlocks: [...(previous.portableBlocks ?? []), ...(projected.portableBlocks ?? [])],
          portableNotes: [
            ...(previous.portableNotes ?? []),
            ...(projected.portableNotes ?? []),
            "opencode.assistant_rows.coalesced",
          ],
          ...(projected.model === undefined ? {} : { model: projected.model }),
        };
      } else {
        result.push(projected);
        lastConversationMessageIndex = result.length - 1;
      }
    } else if (gaps.length === 0) {
      gaps.push("message has no readable parts");
    }
    for (const [index, gap] of gaps.entries()) {
      result.push({ kind: "gap", label: gap, code: gapCodes[index]!, timestamp: createdAt });
    }
    previousMessageId = messageId;
    previousRole = role;
    previousParentId = text(metadata?.parentID) ?? "";
    previousFinish = text(metadata?.finish) ?? "";
    if (
      legacyCompaction.latestBoundaryIndex < 0 || messageIndex >= legacyCompaction.latestBoundaryIndex ||
      legacyCompaction.tailMessageIds.has(messageId)
    ) {
      for (const resource of messageManagedResources.values()) addManagedResource(managedResources, resource);
    }
  }
  return { items: result, managedResources: [...managedResources.values()] };
}

function group(rows: readonly SQLiteRow[], field: string): Map<string, SQLiteRow[]> {
  const result = new Map<string, SQLiteRow[]>();
  for (const row of rows) {
    const key = text(row[field]);
    if (key === undefined) continue;
    const values = result.get(key) ?? [];
    values.push(row);
    result.set(key, values);
  }
  return result;
}

function components(sessionRows: readonly SQLiteRow[]): Map<string, readonly string[]> {
  const ids = new Set(sessionRows.map((row) => text(row.id)).filter((id): id is string => id !== undefined));
  const edges = new Map<string, Set<string>>([...ids].map((id) => [id, new Set<string>()]));
  for (const row of sessionRows) {
    const id = text(row.id);
    const parent = text(row.parent_id);
    if (id === undefined || parent === undefined || !ids.has(parent)) continue;
    edges.get(id)!.add(parent);
    edges.get(parent)!.add(id);
  }
  const result = new Map<string, readonly string[]>();
  for (const id of [...ids].sort()) {
    if (result.has(id)) continue;
    const pending = [id];
    const members = new Set<string>();
    while (pending.length !== 0) {
      const current = pending.pop()!;
      if (members.has(current)) continue;
      members.add(current);
      pending.push(...edges.get(current)!);
    }
    const ordered = [...members].sort();
    for (const member of ordered) result.set(member, ordered);
  }
  return result;
}

function directChildren(sessionRows: readonly SQLiteRow[]): Map<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const row of sessionRows) {
    const child = text(row.id);
    const parent = text(row.parent_id);
    if (child === undefined || parent === undefined) continue;
    const children = result.get(parent) ?? [];
    children.push(child);
    result.set(parent, children);
  }
  return new Map([...result].map(([parent, children]) => [parent, children.sort()]));
}

function assignSessionSidecars(
  sidecarFiles: readonly string[],
  sessionIds: ReadonlySet<string>,
): { readonly owned: ReadonlyMap<string, readonly string[]>; readonly unassigned: readonly string[] } {
  const owned = new Map<string, string[]>();
  const unassigned: string[] = [];
  for (const file of sidecarFiles) {
    const match = /^opencode\/session_diff\/([^/]+)\.json$/.exec(file);
    const nativeId = match?.[1];
    if (nativeId === undefined || !sessionIds.has(nativeId)) {
      unassigned.push(file);
      continue;
    }
    const values = owned.get(nativeId) ?? [];
    values.push(file);
    owned.set(nativeId, values);
  }
  return {
    owned: new Map([...owned].map(([nativeId, files]) => [nativeId, [...files].sort()])),
    unassigned: [...unassigned].sort(),
  };
}

function mergeConversationItems(
  legacy: readonly ConversationItem[],
  current: readonly ConversationItem[],
): ConversationItem[] {
  return [...legacy, ...current]
    .map((item, index) => ({ item, index, instant: Date.parse(item.timestamp) }))
    .sort((left, right) => {
      const leftValid = Number.isFinite(left.instant);
      const rightValid = Number.isFinite(right.instant);
      if (leftValid && rightValid && left.instant !== right.instant) return left.instant - right.instant;
      if (leftValid !== rightValid) return leftValid ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

export function readOpenCodeHistory(options: ReadOpenCodeHistoryOptions): ReadOpenCodeHistoryResult {
  const database = new DatabaseSync(options.databasePath, { readOnly: true, readBigInts: true });
  try {
    const schema = validateOpenCodeHistoryDatabase(database);
    const pendingInputs = openCodePendingInputStatuses(database, schema);
    const reverts = openCodeRevertStatuses(database, schema);
    const sessionRows = rows(database, "SELECT * FROM session ORDER BY id");
    if (sessionRows.length === 0) throw new Error("OpenCode has no persisted sessions");
    const messageRows = rows(database, "SELECT * FROM message ORDER BY session_id, time_created, id");
    const partRows = rows(database, "SELECT * FROM part ORDER BY session_id, time_created, id");
    const sessionMessageRows = persistedRows(database, schema, "session_message");
    const eventRows = persistedRows(database, schema, "event");
    const todos = openCodeTodoProjection(database, schema);
    const messages = group(messageRows, "session_id");
    const parts = group(partRows, "session_id");
    const sessionMessages = group(sessionMessageRows, "session_id");
    const events = group(eventRows, "aggregate_id");
    const componentById = components(sessionRows);
    const childrenById = directChildren(sessionRows);
    const knownIds = new Set(componentById.keys());
    const sidecars = assignSessionSidecars(options.sidecarFiles, knownIds);
    const projectIds = new Set(
      rows(database, "SELECT id FROM project ORDER BY id")
        .map((row) => text(row.id))
        .filter((id): id is string => id !== undefined),
    );
    const warnings: string[] = [];
    const seen = new Set<string>();
    const sessions: StoredSession[] = [];
    const managedResources = new Map<string, readonly ManagedResourceObject[]>();
    let reusedSessions = 0;
    for (const row of sessionRows) {
      const nativeId = text(row.id);
      if (nativeId === undefined || seen.has(nativeId)) throw new Error("OpenCode contains an invalid or duplicate session ID");
      seen.add(nativeId);
      const sessionRef = openCodeSessionRef(nativeId);
      const parentId = text(row.parent_id);
      const projectId = text(row.project_id);
      let relationStatus = "valid";
      if (parentId !== undefined && !knownIds.has(parentId)) {
        warnings.push(`OpenCode session has a missing parent: ${nativeId}`);
        relationStatus = "invalid";
      }
      if (projectId === undefined || !projectIds.has(projectId)) {
        warnings.push(`OpenCode session has a missing project: ${nativeId}`);
        relationStatus = "invalid";
      }
      const ownedMessages = messages.get(nativeId) ?? [];
      const ownedParts = parts.get(nativeId) ?? [];
      const ownedSessionMessages = sessionMessages.get(nativeId) ?? [];
      const ownedEvents = events.get(nativeId) ?? [];
      const todoState = todos.stateBySession.get(nativeId) ?? { status: "empty" };
      const fingerprint = sessionScanFingerprint([
        encodedRow(row),
        ownedMessages.map(encodedRow),
        ownedParts.map(encodedRow),
        ownedSessionMessages.map(encodedRow),
        ownedEvents.map(encodedRow),
        [...(childrenById.get(nativeId) ?? [])],
        [...(componentById.get(nativeId) ?? [nativeId])],
        projectId !== undefined && projectIds.has(projectId),
        pendingInputs.get(nativeId) ?? "empty",
        reverts.get(nativeId) ?? "empty",
        todoState,
      ]);
      const previousSession = options.nonReusableSessions?.has(nativeId) === true
        ? undefined
        : options.previousSessions?.get(sessionRef);
      const reusable = previousSession?.scan?.fingerprint === fingerprint ? previousSession : undefined;
      const identity = modelIdentity(row, [...ownedMessages, ...ownedSessionMessages]);
      let conversationItems: readonly ConversationItem[];
      let sessionManagedResources: readonly ManagedResourceObject[];
      if (reusable !== undefined) {
        conversationItems = reusable.conversation;
        sessionManagedResources = [];
        reusedSessions++;
      } else {
        const legacyProjection = conversation(
          ownedMessages,
          ownedParts,
          options.toolOutputs?.get(nativeId) ?? [],
          options.toolOutputResources ?? new Map(),
        );
        conversationItems = legacyProjection.items;
        sessionManagedResources = legacyProjection.managedResources;
        if (ownedSessionMessages.length !== 0) {
          const legacyCoveredMessageIds = new Set(
            ownedParts.map((part) => text(part.message_id)).filter((id): id is string => id !== undefined),
          );
          if (legacyCoveredMessageIds.size === 0) {
            const currentProjection = projectOpenCodeSessionMessages(
              ownedSessionMessages,
              options.toolOutputs?.get(nativeId) ?? [],
              options.toolOutputResources ?? new Map(),
              ownedEvents,
            );
            conversationItems = currentProjection.items;
            sessionManagedResources = currentProjection.managedResources;
          } else {
            const uncovered = ownedSessionMessages.filter((message) => {
              const id = text(message.id);
              return id === undefined || !legacyCoveredMessageIds.has(id);
            });
            if (uncovered.length !== 0) {
              const currentProjection = projectOpenCodeSessionMessages(
                uncovered,
                options.toolOutputs?.get(nativeId) ?? [],
                options.toolOutputResources ?? new Map(),
                ownedEvents,
              );
              conversationItems = mergeConversationItems(legacyProjection.items, [
                ...currentProjection.items,
                {
                  kind: "gap",
                  label: "legacy message/part and session_message carriers contain different history",
                  code: "opencode.message_carriers.mixed",
                  timestamp: timestamp(uncovered[0]?.time_created),
                },
              ]);
              sessionManagedResources = mergeManagedResources(
                legacyProjection.managedResources,
                currentProjection.managedResources,
              );
            }
          }
        }
      }
      managedResources.set(sessionRef, sessionManagedResources);
      sessions.push({
        sessionRef,
        agent: "opencode",
        nativeId,
        title: text(row.title) ?? "",
        context: text(row.directory) ?? "",
        model: identity.model,
        provider: identity.provider,
        createdAt: timestamp(row.time_created),
        updatedAt: timestamp(row.time_updated),
        nativeArchived: row.time_archived !== null && row.time_archived !== undefined,
        library: options.previousLibrary?.get(sessionRef) ?? options.importedLibrary?.get(sessionRef) ?? {
          name: "",
          tags: [],
          archived: false,
          deleted: false,
        },
        conversation: conversationItems,
        searchText: reusable?.searchText ?? todos.searchTextBySession.get(nativeId) ?? [],
        rawFiles: [],
        native: {
          carrier: {
            database: options.databaseRelativePath,
            sidecars: [...(sidecars.owned.get(nativeId) ?? [])],
            plan: options.planFiles?.get(nativeId) ?? null,
            toolOutputs: (options.toolOutputs?.get(nativeId) ?? []).map((item) => ({
              nativePath: item.nativePath,
              relativePath: item.relativePath,
              available: item.available,
            })),
          },
          session: encodedRow(row),
          projectId: projectId ?? null,
          parentId: parentId ?? null,
          childNativeIds: [...(childrenById.get(nativeId) ?? [])],
          componentNativeIds: [...(componentById.get(nativeId) ?? [nativeId])],
          relationStatus,
          pendingInputStatus: pendingInputs.get(nativeId) ?? "empty",
          revertStatus: reverts.get(nativeId) ?? "empty",
          todoState,
        },
        scan: { fingerprint },
      });
    }
    return {
      sessions,
      managedResources,
      unassignedSidecars: sidecars.unassigned,
      warnings,
      reusedSessions,
      rebuiltSessions: sessions.length - reusedSessions,
    };
  } finally {
    database.close();
  }
}
