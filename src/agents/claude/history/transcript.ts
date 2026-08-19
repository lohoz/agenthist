import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ConversationItem, ConversationMessage, JsonValue } from "../../../domain/history.js";
import {
  validHistoricalReference,
  type HistoricalReferenceEvidence,
  type HistoricalToolEvidence,
  type PortableContextBlock,
  type PortableContextJson,
} from "../../../domain/portable-context.js";
import {
  createManagedResourceObject,
  decodeCanonicalBase64,
  MANAGED_TEXT_MEDIA_TYPE,
  managedResourceReference,
  managedResourceName,
  type ManagedResourceObject,
} from "../../../domain/resource.js";
import {
  backgroundAgentLaunchRecord,
  backgroundAgentNotificationRecord,
  backgroundAgentPeerRecord,
  backgroundAgentRetryRecord,
  skippableAgentListingDeltaRecord,
  type ClaudeBackgroundAgentLaunch,
} from "./background-agent.js";
import {
  claudeAmbientUserContextRecord,
  skippableClaudeEditedImageRecord,
} from "./ambient-context.js";
import { canonicalClaudeUuid } from "../identity.js";
import {
  projectClaudeCacheControl,
  projectClaudeClientToolContent,
  projectClaudeTextCitations,
  type ClaudeStructuredToolResultKind,
} from "./client-tool-projection.js";
import {
  isClaudeServerToolCall,
  isClaudeServerToolResultKind,
  projectClaudeServerToolCall,
  projectClaudeServerToolResult,
} from "./server-tool-projection.js";
import {
  verifiedPreToolUseBlockingMirror,
  verifiedReadImageResultMirror,
  verifiedReadPdfMetaCarrier,
  verifiedReadPdfResultMirror,
  verifiedReadResultMirror,
  verifiedReplResourceResultMirror,
  verifiedSupplementalToolResultMirror,
} from "./tool-result-projection.js";
import {
  claudeContentReplacementRecord,
  type ClaudeContentReplacement,
} from "../sidecars/tool-result.js";
import { parseClaudeTaskItems } from "../sidecars/task.js";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const GRAPH_TYPES = new Set(["user", "assistant", "attachment", "system", "progress"]);
const CLAUDE_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const CLAUDE_BASE64_DOCUMENT_MEDIA_TYPES = new Set(["application/pdf"]);
const CLAUDE_STRUCTURED_OUTPUT_RESULT = "Structured output provided successfully";
export const CLAUDE_COMPACTION_SUMMARY_NOTE = "claude.compaction_summary.materialized";
export const CLAUDE_CONTENT_REPLACEMENT_NOTE = "claude.content_replacement.materialized";
const CLAUDE_API_COMPACTION_ENCRYPTED_NOTE = "claude.api_compaction_encrypted_content.skipped";
const CLAUDE_SERVER_PAUSE_TURN_NOTE = "claude.server_pause_turn.materialized";

export interface ParsedClaudeTranscript {
  readonly nativeId: string;
  readonly firstRootRecordUuid: string;
  readonly title: string;
  readonly context: string;
  readonly model: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly conversation: readonly ConversationItem[];
  readonly observedCwds: readonly string[];
  readonly observedRelocatedCwds: readonly string[];
  readonly sessionMode: "" | "normal" | "coordinator";
  readonly observedVersions: readonly string[];
  readonly recordCount: number;
  readonly warnings: readonly string[];
  readonly nativeSummary: JsonValue;
  readonly managedResources: readonly ManagedResourceObject[];
  readonly portableConversation: readonly ConversationItem[];
  readonly portableNativeSummary: JsonValue;
  readonly portableManagedResources: readonly ManagedResourceObject[];
  readonly materializedCompactionCheckpoints: number;
  readonly materializedContentReplacements: number;
  readonly materializedMessageRetractions: number;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return "";
  return new Date(value).toISOString();
}

function compactTitle(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

interface ProjectedContent {
  readonly text: string;
  readonly portableBlocks: readonly PortableContextBlock[];
  readonly kinds: readonly string[];
  readonly portableNotes: readonly string[];
  readonly managedResources: readonly ManagedResourceObject[];
  readonly apiCompactionBlockCount: number;
  readonly apiCompaction?: {
    readonly summary: string;
    readonly encryptedContentOmitted: boolean;
  };
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((name) => names.has(name));
}

interface SessionTitleRecord {
  readonly kind: "custom" | "generated";
  readonly title: string;
}

function sessionTitleRecord(record: Record<string, unknown>): SessionTitleRecord | undefined {
  if (!hasOnlyFields(record, ["type", "customTitle", "aiTitle", "sessionId"]) ||
    canonicalRecordUuid(record.sessionId) === undefined) return undefined;
  if (record.type === "custom-title" && typeof record.customTitle === "string" &&
    record.customTitle.trim() !== "" && record.aiTitle === undefined) {
    return { kind: "custom", title: record.customTitle };
  }
  if (record.type === "ai-title" && typeof record.aiTitle === "string" &&
    record.aiTitle.trim() !== "" && record.customTitle === undefined) {
    return { kind: "generated", title: record.aiTitle };
  }
  return undefined;
}

function skippableLastPromptRecord(record: Record<string, unknown>, graphLeaf: string | undefined): boolean {
  if (!hasOnlyFields(record, ["type", "lastPrompt", "leafUuid", "sessionId"]) ||
    record.type !== "last-prompt" || canonicalRecordUuid(record.sessionId) === undefined) return false;
  const hasPrompt = record.lastPrompt !== undefined;
  const hasLeaf = record.leafUuid !== undefined;
  if (!hasPrompt && !hasLeaf) return false;
  if (hasPrompt && (typeof record.lastPrompt !== "string" || record.lastPrompt.trim() === "")) return false;
  if (hasLeaf && canonicalRecordUuid(record.leafUuid) !== graphLeaf) return false;
  return true;
}

function skippableSessionSummaryRecord(
  record: Record<string, unknown>,
  graph: ReadonlyMap<string, ClaudeGraphRecord>,
): boolean {
  const leafUuid = canonicalRecordUuid(record.leafUuid);
  return hasOnlyFields(record, ["type", "summary", "leafUuid"]) && record.type === "summary" &&
    typeof record.summary === "string" && record.summary.trim() !== "" &&
    leafUuid !== undefined &&
    (graph.get(leafUuid)?.kind === "user" || graph.get(leafUuid)?.kind === "assistant");
}

const CLAUDE_QUEUE_OPERATIONS = new Set(["enqueue", "dequeue", "remove", "popAll", "popOne"]);
const CLAUDE_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);
const CLAUDE_SESSION_MODES = new Set(["normal", "coordinator"]);
const CLAUDE_ISOLATION_LATCH_SIDES = new Set(["web", "connectors"]);
const CLAUDE_BRIDGE_SESSION_ID = /^(?:cse_|session_)[A-Za-z0-9_-]{1,128}$/;
const CLAUDE_BRIDGE_GROUPING_ID = /^sgrp_[A-Za-z0-9_]{1,128}$/;
const CLAUDE_OBSERVER_TASK_ID = /^a(?:[A-Za-z0-9_-]{1,63}-)?[0-9a-f]{16}$/;
const CLAUDE_AGENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
const CLAUDE_HISTORY_SUPPRESSION_CAUSES = new Set([
  "migration",
  "fork_inherit",
  "meta_seed",
  "restored_owner_mismatch",
  "env_owner_mismatch",
  "chokepoint_veto",
]);
const CLAUDE_HISTORY_SUPPRESSION_OWNER_CAUSES = new Set([
  "restored_owner_mismatch",
  "env_owner_mismatch",
  "chokepoint_veto",
]);

function skippableQueueOperationRecord(record: Record<string, unknown>): boolean {
  return hasOnlyFields(record, ["type", "operation", "timestamp", "sessionId", "content"]) &&
    record.type === "queue-operation" && typeof record.operation === "string" &&
    CLAUDE_QUEUE_OPERATIONS.has(record.operation) &&
    typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp)) &&
    canonicalRecordUuid(record.sessionId) !== undefined &&
    (record.content === undefined || typeof record.content === "string");
}

function skippableSessionEndRecord(record: Record<string, unknown>): boolean {
  return hasOnlyFields(record, ["type", "timestamp", "sessionId"]) && record.type === "ended-by-model" &&
    typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp)) &&
    canonicalRecordUuid(record.sessionId) !== undefined;
}

function verifiedClaudePermissionModeRecord(
  record: Record<string, unknown>,
  expectedSessionId: string,
): boolean {
  const sessionId = canonicalRecordUuid(expectedSessionId);
  return hasOnlyFields(record, ["type", "permissionMode", "sessionId"]) &&
    record.type === "permission-mode" && sessionId !== undefined &&
    canonicalRecordUuid(record.sessionId) === sessionId &&
    typeof record.permissionMode === "string" && CLAUDE_PERMISSION_MODES.has(record.permissionMode);
}

function verifiedClaudeStringStateRecord(
  record: Record<string, unknown>,
  expectedSessionId: string,
  type: string,
  field: string,
  accepts: (value: string) => boolean,
): boolean {
  const sessionId = canonicalRecordUuid(expectedSessionId);
  const value = record[field];
  return hasOnlyFields(record, ["type", field, "sessionId"]) && record.type === type &&
    sessionId !== undefined && canonicalRecordUuid(record.sessionId) === sessionId &&
    typeof value === "string" && accepts(value);
}

function safeClaudeDisplayValue(value: string): boolean {
  return value.trim() !== "" && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function verifiedClaudeSessionTagRecord(
  record: Record<string, unknown>,
  expectedSessionId: string,
): boolean {
  return hasOnlyFields(record, ["type", "tag", "sessionId"]) && record.type === "tag" &&
    canonicalRecordUuid(record.sessionId) === expectedSessionId && typeof record.tag === "string" &&
    (record.tag === "" || record.tag === record.tag.trim() && safeClaudeDisplayValue(record.tag));
}

export function verifiedClaudeRelocatedRecord(
  record: Record<string, unknown>,
  expectedSessionId: string,
): string | undefined {
  const sessionId = canonicalRecordUuid(expectedSessionId);
  return hasOnlyFields(record, ["type", "relocatedCwd", "sessionId"]) &&
    record.type === "relocated" && sessionId !== undefined &&
    canonicalRecordUuid(record.sessionId) === sessionId &&
    typeof record.relocatedCwd === "string" && record.relocatedCwd !== "" &&
    !record.relocatedCwd.includes("\0") && path.isAbsolute(record.relocatedCwd)
    ? path.normalize(record.relocatedCwd)
    : undefined;
}

export function verifiedClaudeWorktreeStateRecord(
  record: Record<string, unknown>,
  expectedSessionId: string,
): boolean {
  const sessionId = canonicalRecordUuid(expectedSessionId);
  if (
    !hasOnlyFields(record, ["type", "sessionId", "worktreeSession"]) ||
    record.type !== "worktree-state" || sessionId === undefined ||
    canonicalRecordUuid(record.sessionId) !== sessionId
  ) return false;
  if (record.worktreeSession === null) return true;
  const worktree = objectValue(record.worktreeSession);
  if (worktree === undefined || !hasOnlyFields(worktree, [
    "originalCwd", "worktreePath", "worktreeName", "worktreeBranch", "originalBranch",
    "originalHeadCommit", "sessionId", "tmuxSessionName", "hookBased",
    "preEnterOriginalCwd", "enteredExisting",
  ])) return false;
  if (
    typeof worktree.originalCwd !== "string" || !path.isAbsolute(worktree.originalCwd) ||
    typeof worktree.worktreePath !== "string" || !path.isAbsolute(worktree.worktreePath) ||
    typeof worktree.worktreeName !== "string" || worktree.worktreeName.trim() === "" ||
    canonicalRecordUuid(worktree.sessionId) !== sessionId ||
    (worktree.hookBased !== undefined && typeof worktree.hookBased !== "boolean") ||
    (worktree.preEnterOriginalCwd !== undefined &&
      (typeof worktree.preEnterOriginalCwd !== "string" ||
        !path.isAbsolute(worktree.preEnterOriginalCwd))) ||
    (worktree.enteredExisting !== undefined && typeof worktree.enteredExisting !== "boolean")
  ) return false;
  return ["worktreeBranch", "originalBranch", "originalHeadCommit", "tmuxSessionName"].every((field) =>
    worktree[field] === undefined || typeof worktree[field] === "string");
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return undefined;
  }
  return protocol === "http:" || protocol === "https:" ? value : undefined;
}

function sessionPullRequestRecord(
  record: Record<string, unknown>,
  expectedSessionId: string,
): ConversationMessage | undefined {
  const prUrl = httpUrl(record.prUrl);
  if (
    !hasOnlyFields(record, ["type", "sessionId", "prNumber", "prUrl", "prRepository", "timestamp"]) ||
    record.type !== "pr-link" || canonicalRecordUuid(record.sessionId) !== expectedSessionId ||
    typeof record.prNumber !== "number" || !Number.isSafeInteger(record.prNumber) || record.prNumber <= 0 ||
    prUrl === undefined || typeof record.prRepository !== "string" ||
    !safeClaudeDisplayValue(record.prRepository) || Buffer.byteLength(record.prRepository, "utf8") > 1024 ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp))
  ) return undefined;
  const reference: HistoricalReferenceEvidence = {
    type: "document",
    namespace: "claude.pull_request",
    locator: prUrl,
    title: `${record.prRepository}#${record.prNumber}`,
    context: JSON.stringify({ number: record.prNumber, repository: record.prRepository }),
  };
  if (!validHistoricalReference(reference)) return undefined;
  return {
    kind: "message",
    role: "system",
    text: `Pull request #${record.prNumber} (${record.prRepository})`,
    timestamp: new Date(record.timestamp).toISOString(),
    contentKinds: ["session_pull_request"],
    portableBlocks: [{ kind: "historical_reference", reference }],
  };
}

interface SessionArtifactRecord {
  readonly url: string;
  readonly message: ConversationMessage;
}

function sessionArtifactRecord(
  record: Record<string, unknown>,
  expectedSessionId: string,
): SessionArtifactRecord | undefined {
  const frameUrl = httpUrl(record.frameUrl);
  if (
    !hasOnlyFields(record, ["type", "sessionId", "path", "frameUrl", "title", "timestamp"]) ||
    record.type !== "frame-link" || canonicalRecordUuid(record.sessionId) !== expectedSessionId ||
    typeof record.path !== "string" || !safeClaudeDisplayValue(record.path) ||
    Buffer.byteLength(record.path, "utf8") > 4096 || frameUrl === undefined ||
    typeof record.title !== "string" ||
    (record.title !== "" && !safeClaudeDisplayValue(record.title)) ||
    Buffer.byteLength(record.title, "utf8") > 1024 ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp))
  ) return undefined;
  const reference: HistoricalReferenceEvidence = {
    type: "document",
    namespace: "claude.artifact",
    locator: frameUrl,
    ...(record.title === "" ? {} : { title: record.title }),
    context: JSON.stringify({ path: record.path }),
  };
  if (!validHistoricalReference(reference)) return undefined;
  return {
    url: frameUrl,
    message: {
      kind: "message",
      role: "system",
      text: record.title === "" ? `Published artifact (${record.path})` : `Published artifact: ${record.title}`,
      timestamp: new Date(record.timestamp).toISOString(),
      contentKinds: ["session_artifact"],
      portableBlocks: [{ kind: "historical_reference", reference }],
    },
  };
}

export function verifiedClaudeBridgeSessionRecord(
  record: Record<string, unknown>,
  expectedSessionId: string,
): boolean {
  if (
    !hasOnlyFields(record, [
      "type", "sessionId", "bridgeSessionId", "lastSequenceNum", "declaredDialogKinds",
      "sessionGroupingId", "noHistoryBackfill", "ownerAccountUuid", "ownerOrganizationUuid",
    ]) || record.type !== "bridge-session" ||
    canonicalRecordUuid(record.sessionId) !== expectedSessionId ||
    typeof record.bridgeSessionId !== "string" ||
    typeof record.lastSequenceNum !== "number" || !Number.isSafeInteger(record.lastSequenceNum) ||
    record.lastSequenceNum < 0
  ) return false;

  if (record.bridgeSessionId === "") {
    return record.lastSequenceNum === 0 && hasOnlyFields(record, [
      "type", "sessionId", "bridgeSessionId", "lastSequenceNum",
    ]);
  }
  if (!CLAUDE_BRIDGE_SESSION_ID.test(record.bridgeSessionId)) return false;

  if (record.declaredDialogKinds !== undefined && (
    !Array.isArray(record.declaredDialogKinds) || record.declaredDialogKinds.length === 0 ||
    record.declaredDialogKinds.length > 32 || !record.declaredDialogKinds.every((value) =>
      typeof value === "string" && value.length > 0 && value.length <= 64)
  )) return false;
  if (record.sessionGroupingId !== undefined && (
    typeof record.sessionGroupingId !== "string" ||
    !CLAUDE_BRIDGE_GROUPING_ID.test(record.sessionGroupingId)
  )) return false;
  if (record.noHistoryBackfill !== undefined && record.noHistoryBackfill !== true) return false;
  return ["ownerAccountUuid", "ownerOrganizationUuid"].every((field) =>
    record[field] === undefined || canonicalRecordUuid(record[field]) !== undefined);
}

function verifiedClaudeHistorySuppressionRecord(
  record: Record<string, unknown>,
  expectedSessionId: string,
): boolean {
  if (
    !hasOnlyFields(record, ["type", "sessionId", "cause", "vetoedAgainstAccountUuid", "ts"]) ||
    record.type !== "history-suppression" || canonicalRecordUuid(record.sessionId) !== expectedSessionId ||
    typeof record.cause !== "string" || !CLAUDE_HISTORY_SUPPRESSION_CAUSES.has(record.cause) ||
    typeof record.ts !== "string" || Number.isNaN(Date.parse(record.ts))
  ) return false;
  if (record.vetoedAgainstAccountUuid === undefined) return true;
  return CLAUDE_HISTORY_SUPPRESSION_OWNER_CAUSES.has(record.cause) &&
    canonicalRecordUuid(record.vetoedAgainstAccountUuid) !== undefined;
}

function verifiedClaudeObserverRefRecord(record: Record<string, unknown>): boolean {
  return hasOnlyFields(record, ["type", "observerTaskId", "observerAgentType", "timestamp"]) &&
    record.type === "observer-ref" &&
    typeof record.observerTaskId === "string" && CLAUDE_OBSERVER_TASK_ID.test(record.observerTaskId) &&
    typeof record.observerAgentType === "string" && record.observerAgentType.length <= 256 &&
    CLAUDE_AGENT_TYPE.test(record.observerAgentType) &&
    typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp));
}

function skippableTurnDurationRecord(record: Record<string, unknown>): boolean {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "type", "subtype", "durationMs", "messageCount",
    "timestamp", "uuid", "isMeta", "userType", "entrypoint", "cwd", "sessionId",
    "version", "gitBranch", "slug",
  ])) return false;
  if (
    record.type !== "system" || record.subtype !== "turn_duration" || record.isMeta !== false ||
    typeof record.durationMs !== "number" || !Number.isSafeInteger(record.durationMs) || record.durationMs < 0 ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp))
  ) return false;
  if (
    record.messageCount !== undefined &&
    (typeof record.messageCount !== "number" || !Number.isSafeInteger(record.messageCount) || record.messageCount < 0)
  ) return false;
  return ["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
    record[field] === undefined || typeof record[field] === "string");
}

interface ModelRefusalFallbackRecord {
  readonly fallbackModel: string;
  readonly refusedUserMessageUuid: string;
  readonly retractedMessageUuids: readonly string[];
}

function modelRefusalFallbackRecord(
  record: Record<string, unknown>,
): ModelRefusalFallbackRecord | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "type", "subtype", "direction", "scope", "content", "level",
    "trigger", "originalModel", "fallbackModel", "requestId", "apiRefusalCategory",
    "apiRefusalExplanation", "retractedMessageUuids", "refusedUserMessageUuid", "isMeta", "timestamp", "uuid",
    "userType", "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const rawRetracted = record.retractedMessageUuids;
  const retracted = Array.isArray(rawRetracted) && rawRetracted.length === 0
    ? []
    : canonicalUuidList(rawRetracted);
  const refusedUserMessageUuid = canonicalRecordUuid(record.refusedUserMessageUuid);
  if (
    record.type !== "system" || record.subtype !== "model_refusal_fallback" ||
    record.direction !== "retry" || record.scope !== "session" ||
    record.trigger !== "refusal" || record.level !== "warning" ||
    record.isSidechain !== false || record.isMeta !== false ||
    typeof record.content !== "string" || record.content.trim() === "" ||
    typeof record.originalModel !== "string" || record.originalModel.trim() === "" ||
    typeof record.fallbackModel !== "string" || record.fallbackModel.trim() === "" ||
    record.originalModel === record.fallbackModel ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    retracted === undefined || refusedUserMessageUuid === undefined
  ) return undefined;
  for (const field of ["requestId", "apiRefusalCategory", "apiRefusalExplanation"]) {
    const value = record[field];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.trim() === "")) {
      return undefined;
    }
  }
  if (!["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
    record[field] === undefined || typeof record[field] === "string")) return undefined;
  return {
    fallbackModel: record.fallbackModel,
    refusedUserMessageUuid,
    retractedMessageUuids: retracted,
  };
}

function skippableAwaySummaryRecord(
  record: Record<string, unknown>,
  turnDurationUuid: string | undefined,
): boolean {
  if (turnDurationUuid === undefined || !hasOnlyFields(record, [
    "parentUuid", "isSidechain", "type", "subtype", "content", "timestamp", "uuid",
    "isMeta", "userType", "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return false;
  if (
    record.type !== "system" || record.subtype !== "away_summary" || record.isMeta !== false ||
    record.isSidechain !== false || canonicalRecordUuid(record.parentUuid) !== turnDurationUuid ||
    typeof record.content !== "string" || record.content.trim() === "" ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp))
  ) return false;
  return ["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
    record[field] === undefined || typeof record[field] === "string");
}

function skippableEmptyTaskReminderRecord(record: Record<string, unknown>): boolean {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return false;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "content", "itemCount"]) ||
    (attachment.type !== "task_reminder" && attachment.type !== "todo_reminder") ||
    !Array.isArray(attachment.content) || attachment.content.length !== 0 || attachment.itemCount !== 0
  ) return false;
  return ["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
    record[field] === undefined || typeof record[field] === "string");
}

type ClaudeWorkReminderKind = "task_reminder" | "todo_reminder";

interface ClaudeWorkReminderItem {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly detailPresent: boolean;
}

interface ClaudeWorkReminder {
  readonly kind: ClaudeWorkReminderKind;
  readonly items: readonly ClaudeWorkReminderItem[];
  readonly itemCount: number;
  readonly detailItemCount: number;
}

function taskReminderItems(value: unknown): readonly ClaudeWorkReminderItem[] | undefined {
  const tasks = parseClaudeTaskItems(value);
  return tasks?.map((task) => ({
    id: task.id,
    title: task.subject,
    status: task.status,
    detailPresent: task.description !== "" ||
      task.activeForm !== undefined && task.activeForm !== task.subject ||
      task.owner !== undefined || task.blocks.length !== 0 || task.blockedBy.length !== 0 ||
      task.metadataPresent,
  }));
}

function todoReminderItems(value: unknown): readonly ClaudeWorkReminderItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: ClaudeWorkReminderItem[] = [];
  for (const [index, valueItem] of value.entries()) {
    const item = objectValue(valueItem);
    if (
      item === undefined || !hasOnlyFields(item, ["content", "status", "activeForm"]) ||
      typeof item.content !== "string" || item.content.length === 0 ||
      typeof item.activeForm !== "string" || item.activeForm.length === 0 ||
      item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed"
    ) return undefined;
    items.push({
      id: String(index + 1),
      title: item.content,
      status: item.status,
      detailPresent: item.activeForm !== item.content,
    });
  }
  return items;
}

function workReminderRecord(record: Record<string, unknown>): ClaudeWorkReminder | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  const kind = attachment?.type === "task_reminder" || attachment?.type === "todo_reminder"
    ? attachment.type
    : undefined;
  const items = kind === "task_reminder"
    ? taskReminderItems(attachment?.content)
    : kind === "todo_reminder"
      ? todoReminderItems(attachment?.content)
      : undefined;
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "content", "itemCount"]) ||
    kind === undefined || items === undefined || items.length === 0 || attachment.itemCount !== items.length ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  return {
    kind,
    items,
    itemCount: items.length,
    detailItemCount: items.filter((item) => item.detailPresent).length,
  };
}

function reminderItemText(kind: ClaudeWorkReminderKind, item: ClaudeWorkReminderItem): string {
  const prefix = kind === "task_reminder" ? `#${item.id}` : `${item.id}`;
  return `${prefix}. [${item.status}] ${item.title}`;
}

function projectedWorkReminder(reminder: ClaudeWorkReminder, when: string): ConversationMessage {
  return {
    kind: "message",
    role: "system",
    text: reminder.items.map((item) => reminderItemText(reminder.kind, item)).join("\n"),
    timestamp: when,
    contentKinds: [reminder.kind],
    portableBlocks: [{
      kind: "historical_work_state",
      workState: {
        sourceKind: reminder.kind,
        items: reminder.items.map((item) => ({
          id: item.id,
          title: item.title,
          description: "",
          status: item.status,
          blocks: [],
          blockedBy: [],
        })),
      },
    }],
  };
}

function skippableQueuedCommandRecord(record: Record<string, unknown>): boolean {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return false;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "prompt", "commandMode", "timestamp"]) ||
    attachment.type !== "queued_command" || typeof attachment.prompt !== "string" ||
    attachment.prompt.trim() === "" || attachment.commandMode !== "prompt" ||
    typeof attachment.timestamp !== "string" || Number.isNaN(Date.parse(attachment.timestamp))
  ) return false;
  return ["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
    record[field] === undefined || typeof record[field] === "string");
}

function skillListingRecord(record: Record<string, unknown>): string | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "content", "skillCount", "isInitial", "names"]) ||
    attachment.type !== "skill_listing" || typeof attachment.content !== "string" ||
    attachment.content.trim() === "" || typeof attachment.skillCount !== "number" ||
    !Number.isSafeInteger(attachment.skillCount) || attachment.skillCount <= 0 ||
    typeof attachment.isInitial !== "boolean"
  ) return undefined;
  if (attachment.names !== undefined) {
    if (!Array.isArray(attachment.names) || attachment.names.length !== attachment.skillCount ||
      attachment.names.some((value) => !validOpaqueIdentity(value)) ||
      new Set(attachment.names).size !== attachment.names.length) return undefined;
  }
  if (!["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
    record[field] === undefined || typeof record[field] === "string")) return undefined;
  return attachment.content;
}

function criticalSystemReminderRecord(record: Record<string, unknown>): string | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "content"]) ||
    attachment.type !== "critical_system_reminder" || typeof attachment.content !== "string" ||
    attachment.content.trim() === "" ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  return attachment.content;
}

interface ClaudeNestedMemory {
  readonly path: string;
  readonly text: string;
}

interface ClaudeRelevantMemories {
  readonly paths: readonly string[];
  readonly contexts: readonly string[];
}

const CLAUDE_MEMORY_TYPES = new Set(["User", "Project", "Local", "Managed"]);

function nestedMemoryRecord(record: Record<string, unknown>): ClaudeNestedMemory | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  const content = objectValue(attachment?.content);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    typeof record.cwd !== "string" || !path.isAbsolute(record.cwd) ||
    path.normalize(record.cwd) !== record.cwd ||
    !hasOnlyFields(attachment, ["type", "path", "content", "displayPath"]) ||
    attachment.type !== "nested_memory" || typeof attachment.path !== "string" ||
    !path.isAbsolute(attachment.path) || path.normalize(attachment.path) !== attachment.path ||
    typeof attachment.displayPath !== "string" || attachment.displayPath === "" ||
    attachment.displayPath !== path.relative(record.cwd, attachment.path) ||
    content === undefined ||
    !hasOnlyFields(content, ["path", "type", "content", "contentDiffersFromDisk"]) ||
    content.path !== attachment.path || typeof content.type !== "string" ||
    !CLAUDE_MEMORY_TYPES.has(content.type) || typeof content.content !== "string" ||
    content.content.trim() === "" || typeof content.contentDiffersFromDisk !== "boolean" ||
    !["userType", "entrypoint", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  return {
    path: attachment.path,
    text: `Contents of ${content.path}:\n\n${content.content}`,
  };
}

function relevantMemoriesRecord(record: Record<string, unknown>): ClaudeRelevantMemories | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  const memories = attachment?.memories;
  const validHeader = (memoryPath: string, header: string): boolean => {
    const label = `Memory: ${memoryPath}:`;
    if (header === label) return true;
    const suffix = `\n${label}`;
    if (!header.endsWith(suffix)) return false;
    const notice = header.slice(0, -suffix.length);
    const match = /^This memory is ([1-9][0-9]*) days old\. Memories are point-in-time observations, not live state \u2014 claims about code behavior or file:line citations may be outdated\. Verify against current code before asserting as fact\.$/.exec(
      notice,
    );
    const days = match === null ? undefined : Number(match[1]);
    return days !== undefined && Number.isSafeInteger(days) && days >= 2;
  };
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "memories"]) ||
    attachment.type !== "relevant_memories" || !Array.isArray(memories) ||
    memories.length === 0 || memories.length > 5 ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  const parsed = memories.map((value) => {
    const memory = objectValue(value);
    if (
      memory === undefined || !hasOnlyFields(memory, ["path", "content", "mtimeMs", "header", "limit"]) ||
      typeof memory.path !== "string" || !path.isAbsolute(memory.path) ||
      path.normalize(memory.path) !== memory.path ||
      typeof memory.content !== "string" || memory.content.trim() === "" ||
      typeof memory.mtimeMs !== "number" || !Number.isFinite(memory.mtimeMs) || memory.mtimeMs < 0 ||
      typeof memory.header !== "string" || memory.header.trim() === "" ||
      !validHeader(memory.path, memory.header) ||
      memory.limit !== undefined && (
        typeof memory.limit !== "number" || !Number.isSafeInteger(memory.limit) || memory.limit < 0
      )
    ) return undefined;
    return { path: memory.path, header: memory.header, content: memory.content };
  });
  if (parsed.some((memory) => memory === undefined)) return undefined;
  const values = parsed as Array<{ path: string; header: string; content: string }>;
  const paths = values.map((memory) => memory.path);
  if (new Set(paths).size !== paths.length) return undefined;
  const prefix = "Retrieved for possible relevance \u2014 use only if it actually applies to what the user asked.";
  return {
    paths,
    contexts: values.map((memory, index) =>
      `${index === 0 ? `${prefix}\n` : ""}${memory.header}\n${memory.content}`),
  };
}

type ClaudeRuntimeUsageReminderKind = "token_usage" | "total_tokens_reminder" | "budget_usd";

function runtimeUsageReminderRecord(
  record: Record<string, unknown>,
): ClaudeRuntimeUsageReminderKind | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  if (
    attachment.type === "total_tokens_reminder" &&
    hasOnlyFields(attachment, ["type", "text"]) &&
    typeof attachment.text === "string" && attachment.text.trim() !== ""
  ) return "total_tokens_reminder";
  if (
    attachment.type === "token_usage" &&
    hasOnlyFields(attachment, ["type", "used", "total", "remaining"]) &&
    typeof attachment.used === "number" && Number.isSafeInteger(attachment.used) && attachment.used >= 0 &&
    typeof attachment.total === "number" && Number.isSafeInteger(attachment.total) && attachment.total > 0 &&
    typeof attachment.remaining === "number" && Number.isSafeInteger(attachment.remaining) &&
    attachment.remaining === attachment.total - attachment.used
  ) return "token_usage";
  if (
    attachment.type === "budget_usd" &&
    hasOnlyFields(attachment, ["type", "used", "total", "remaining"]) &&
    typeof attachment.used === "number" && Number.isFinite(attachment.used) && attachment.used >= 0 &&
    typeof attachment.total === "number" && Number.isFinite(attachment.total) && attachment.total >= 0 &&
    typeof attachment.remaining === "number" && Number.isFinite(attachment.remaining) &&
    attachment.remaining === attachment.total - attachment.used
  ) return "budget_usd";
  return undefined;
}

function skippableToolSearchUsageReminderRecord(record: Record<string, unknown>): boolean {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return false;
  const attachment = objectValue(record.attachment);
  const names = attachment?.undiscoveredToolNames;
  const count = attachment?.undiscoveredCount;
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "undiscoveredToolNames", "undiscoveredCount"]) ||
    attachment.type !== "tool_search_usage_reminder" ||
    !Array.isArray(names) || names.length === 0 || names.some((value) => !validOpaqueIdentity(value)) ||
    typeof count !== "number" || !Number.isSafeInteger(count)
  ) return false;
  const toolNames = names as string[];
  if (
    toolNames.some((value, index) => index !== 0 && toolNames[index - 1]! > value) ||
    new Set(toolNames).size !== toolNames.length || count < toolNames.length
  ) return false;
  return ["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
    record[field] === undefined || typeof record[field] === "string");
}

interface ClaudeMcpInstructionsDelta {
  readonly text: string;
  readonly addedNames: readonly string[];
  readonly removedNames: readonly string[];
}

const CLAUDE_AMBIENT_CONTEXT_NOTICE =
  "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";

function mcpInstructionsDeltaRecord(record: Record<string, unknown>): ClaudeMcpInstructionsDelta | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  const addedNames = attachment?.addedNames;
  const addedBlocks = attachment?.addedBlocks;
  const removedNames = attachment?.removedNames;
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "addedNames", "addedBlocks", "removedNames"]) ||
    attachment.type !== "mcp_instructions_delta" ||
    !Array.isArray(addedNames) || !Array.isArray(addedBlocks) || !Array.isArray(removedNames) ||
    addedNames.length !== addedBlocks.length || addedNames.length + removedNames.length === 0 ||
    addedNames.some((value) => !validOpaqueIdentity(value)) ||
    removedNames.some((value) => !validOpaqueIdentity(value)) ||
    addedBlocks.some((value) => typeof value !== "string") ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  const names = addedNames as string[];
  const blocks = addedBlocks as string[];
  const removed = removedNames as string[];
  if (
    new Set(names).size !== names.length || new Set(removed).size !== removed.length ||
    names.some((name) => removed.includes(name)) ||
    blocks.some((block, index) => {
      const prefix = `## ${names[index]!}\n`;
      return !block.startsWith(prefix) || block.length === prefix.length;
    })
  ) return undefined;
  const contexts: string[] = [];
  if (blocks.length !== 0) {
    contexts.push(
      "# MCP Server Instructions\n" +
      "The following MCP servers have provided instructions for how to use their tools and resources:\n" +
      blocks.join("\n"),
    );
  }
  if (removed.length !== 0) {
    contexts.push(
      "The following MCP servers have disconnected. Their instructions above no longer apply:\n" +
      removed.join("\n"),
      CLAUDE_AMBIENT_CONTEXT_NOTICE,
    );
  }
  return { text: contexts.join("\n"), addedNames: names, removedNames: removed };
}

const MCP_DROPPED_TOOL_ENTRY =
  /^"([^"\r\n]+)" \(MCP server "([^"\r\n]+)"\): "([^"\r\n]+)"$/u;
const MCP_DROPPED_TOOL_FIELD_FORBIDDEN =
  /[<>";‘’‚“”„«»‹›〈〉⟨⟩⟪⟫〈〉《》\u0000-\u001f\u007f]/u;

function validMcpDroppedToolField(value: string): boolean {
  return value.length <= 200 && value === value.normalize("NFKC") && value === value.trim() &&
    !/[^\S ]/u.test(value) && !/ {2}/u.test(value) &&
    !MCP_DROPPED_TOOL_FIELD_FORBIDDEN.test(value);
}

function mcpDroppedToolsDeltaRecord(record: Record<string, unknown>): readonly string[] | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  const entries = attachment?.addedEntries;
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "addedEntries"]) ||
    attachment.type !== "mcp_dropped_tools_delta" || !Array.isArray(entries) || entries.length === 0 ||
    entries.some((value) => typeof value !== "string") ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  const values = entries as string[];
  if (
    new Set(values).size !== values.length ||
    values.some((entry, index) => index !== 0 && values[index - 1]! > entry) ||
    values.some((entry) => {
      const match = MCP_DROPPED_TOOL_ENTRY.exec(entry);
      return match === null || match.slice(1).some((field) => !validMcpDroppedToolField(field));
    })
  ) return undefined;
  return values;
}

function skippableDeferredToolsDeltaRecord(record: Record<string, unknown>): boolean {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return false;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, [
      "type", "addedNames", "addedLines", "removedNames", "readdedNames", "pendingMcpServers",
    ]) ||
    attachment.type !== "deferred_tools_delta" || !Array.isArray(attachment.addedNames) ||
    !Array.isArray(attachment.addedLines) || !Array.isArray(attachment.removedNames) ||
    attachment.addedNames.length !== attachment.addedLines.length
  ) return false;
  const hasExtendedFields = attachment.readdedNames !== undefined || attachment.pendingMcpServers !== undefined;
  if (hasExtendedFields && (!Array.isArray(attachment.readdedNames) ||
    !Array.isArray(attachment.pendingMcpServers))) return false;
  const addedNames = attachment.addedNames as unknown[];
  const addedLines = attachment.addedLines as unknown[];
  const removedNames = attachment.removedNames as unknown[];
  const readdedNames = (attachment.readdedNames ?? []) as unknown[];
  const pendingMcpServers = (attachment.pendingMcpServers ?? []) as unknown[];
  if (
    addedNames.length + removedNames.length + readdedNames.length + pendingMcpServers.length === 0 ||
    addedNames.some((value) => !validOpaqueIdentity(value)) ||
    removedNames.some((value) => !validOpaqueIdentity(value)) ||
    readdedNames.some((value) => !validOpaqueIdentity(value)) ||
    pendingMcpServers.some((value) => !validOpaqueIdentity(value)) ||
    addedLines.some((value) => typeof value !== "string" || value.trim() === "") ||
    addedNames.some((name, index) => name !== addedLines[index]) ||
    new Set(addedNames).size !== addedNames.length ||
    new Set(removedNames).size !== removedNames.length ||
    new Set(readdedNames).size !== readdedNames.length ||
    new Set(pendingMcpServers).size !== pendingMcpServers.length ||
    addedNames.some((name) => removedNames.includes(name))
  ) return false;
  return ["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
    record[field] === undefined || typeof record[field] === "string");
}

function skippableCommandPermissionsRecord(record: Record<string, unknown>): boolean {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return false;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "allowedTools", "model"]) ||
    attachment.type !== "command_permissions" || !Array.isArray(attachment.allowedTools) ||
    attachment.allowedTools.some((value) => !validOpaqueIdentity(value)) ||
    new Set(attachment.allowedTools).size !== attachment.allowedTools.length ||
    (attachment.model !== undefined && !validOpaqueIdentity(attachment.model))
  ) return false;
  return ["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
    record[field] === undefined || typeof record[field] === "string");
}

interface PlainHookSuccessRecord {
  readonly hookName: string;
  readonly toolUseId: string;
  readonly command: string;
  readonly durationMs: number;
}

interface SuccessfulHookRecord extends PlainHookSuccessRecord {
  readonly hookEvent: string;
  readonly content: string;
  readonly stdout: string;
}

interface ModelContextHookCarrier {
  readonly hookEvent: string;
  readonly context: string;
}

interface HookAdditionalContextRecord {
  readonly hookEvent: string;
  readonly contexts: readonly string[];
}

interface AsyncHookContextRecord {
  readonly context: string;
}

interface ProjectedHookContextCarrier extends ModelContextHookCarrier {
  readonly uuid: string;
}

interface SessionStartSystemMessageCarrier extends PlainHookSuccessRecord {
  readonly systemMessage: string;
}

interface PendingSessionStartSystemMessageCarrier extends SessionStartSystemMessageCarrier {
  readonly uuid: string;
}

interface SessionStartHookSystemMessage {
  readonly hookName: string;
  readonly toolUseId: string;
  readonly content: string;
}

interface HookRuntimeRecord {
  readonly kind: "cancelled" | "non_blocking_error" | "execution_error";
  readonly toolUseId: string;
}

interface StructuredOutputAttachmentRecord {
  readonly data: PortableContextJson;
}

function validOpaqueIdentity(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !/[\u0000-\u001f\u007f]/.test(value);
}

function validHookName(hookEvent: string, hookName: string): boolean {
  return hookName === hookEvent ||
    hookName.startsWith(`${hookEvent}:`) && hookName.length !== hookEvent.length + 1;
}

function skippableHookRuntimeRecord(
  record: Record<string, unknown>,
): HookRuntimeRecord | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  const attachmentType = attachment?.type;
  const kind = attachmentType === "hook_non_blocking_error"
    ? "non_blocking_error"
    : attachmentType === "hook_error_during_execution"
      ? "execution_error"
      : attachmentType === "hook_cancelled"
        ? "cancelled"
        : undefined;
  if (attachment === undefined || kind === undefined) return undefined;
  const runtimeFields = kind === "non_blocking_error"
    ? [
      "type", "hookName", "stderr", "stdout", "exitCode", "toolUseID", "hookEvent",
      "command", "durationMs",
    ]
    : kind === "execution_error"
      ? ["type", "content", "hookName", "toolUseID", "hookEvent", "command", "durationMs"]
      : ["type", "hookName", "toolUseID", "hookEvent", "command", "durationMs"];
  if (
    record.type !== "attachment" || record.isSidechain !== false ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, runtimeFields) ||
    !validOpaqueIdentity(attachment.hookEvent) || !validOpaqueIdentity(attachment.hookName) ||
    !validHookName(attachment.hookEvent, attachment.hookName) ||
    !validOpaqueIdentity(attachment.toolUseID) ||
    Object.hasOwn(attachment, "command") !== Object.hasOwn(attachment, "durationMs") ||
    (attachment.command !== undefined &&
      (typeof attachment.command !== "string" || attachment.command.trim() === "")) ||
    (attachment.durationMs !== undefined &&
      (typeof attachment.durationMs !== "number" || !Number.isSafeInteger(attachment.durationMs) ||
        attachment.durationMs < 0)) ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  if (kind === "non_blocking_error") {
    if (
      typeof attachment.stderr !== "string" || attachment.stderr.trim() === "" ||
      typeof attachment.stdout !== "string" || typeof attachment.exitCode !== "number" ||
      !Number.isSafeInteger(attachment.exitCode) || attachment.exitCode < 0
    ) return undefined;
  } else if (kind === "execution_error" &&
    (typeof attachment.content !== "string" || attachment.content.trim() === "")) {
    return undefined;
  }
  return { kind, toolUseId: attachment.toolUseID };
}

function skippableHookPermissionDecisionRecord(
  record: Record<string, unknown>,
): string | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "decision", "toolUseID", "hookEvent"]) ||
    attachment.type !== "hook_permission_decision" ||
    (attachment.decision !== "allow" && attachment.decision !== "deny") ||
    !validOpaqueIdentity(attachment.toolUseID) || attachment.hookEvent !== "PermissionRequest" ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  return attachment.toolUseID;
}

function structuredOutputAttachmentRecord(
  record: Record<string, unknown>,
): StructuredOutputAttachmentRecord | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  const data = objectValue(attachment?.data);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "data"]) || attachment.type !== "structured_output" ||
    data === undefined ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  return { data: data as PortableContextJson };
}

function successfulHookRecord(record: Record<string, unknown>): SuccessfulHookRecord | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, [
      "type", "hookName", "toolUseID", "hookEvent", "content", "stdout", "stderr",
      "exitCode", "command", "durationMs",
    ]) ||
    attachment.type !== "hook_success" || !validOpaqueIdentity(attachment.hookEvent) ||
    !validOpaqueIdentity(attachment.hookName) ||
    !validOpaqueIdentity(attachment.toolUseID) || typeof attachment.content !== "string" ||
    typeof attachment.stdout !== "string" || attachment.stderr !== "" || attachment.exitCode !== 0 ||
    typeof attachment.command !== "string" || attachment.command === "" ||
    typeof attachment.durationMs !== "number" ||
    !Number.isSafeInteger(attachment.durationMs) || attachment.durationMs < 0 ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  return {
    hookEvent: attachment.hookEvent,
    hookName: attachment.hookName,
    toolUseId: attachment.toolUseID,
    content: attachment.content,
    stdout: attachment.stdout,
    command: attachment.command,
    durationMs: attachment.durationMs,
  };
}

function modelContextHookCarrier(
  record: Record<string, unknown>,
): ModelContextHookCarrier | undefined {
  const hook = successfulHookRecord(record);
  if (
    hook === undefined || !validHookName(hook.hookEvent, hook.hookName) ||
    !validOpaqueIdentity(hook.command)
  ) return undefined;

  if (
    (hook.hookEvent === "SessionStart" || hook.hookEvent === "UserPromptSubmit") &&
    hook.content.trim() !== "" && hook.stdout === `${hook.content}\n`
  ) {
    return { hookEvent: hook.hookEvent, context: hook.content };
  }
  if (hook.content !== "") return undefined;
  let output: Record<string, unknown> | undefined;
  try { output = objectValue(JSON.parse(hook.stdout)); } catch { return undefined; }
  const hookOutput = objectValue(output?.hookSpecificOutput);
  if (
    output === undefined || !hasOnlyFields(output, ["hookSpecificOutput"]) || hookOutput === undefined ||
    !hasOnlyFields(hookOutput, ["hookEventName", "additionalContext"]) ||
    hookOutput.hookEventName !== hook.hookEvent ||
    typeof hookOutput.additionalContext !== "string" || hookOutput.additionalContext.trim() === ""
  ) return undefined;
  return { hookEvent: hook.hookEvent, context: hookOutput.additionalContext };
}

function sessionStartSystemMessageCarrier(
  record: Record<string, unknown>,
): SessionStartSystemMessageCarrier | undefined {
  const hook = successfulHookRecord(record);
  if (
    hook === undefined || hook.hookEvent !== "SessionStart" ||
    !validHookName("SessionStart", hook.hookName) || !validOpaqueIdentity(hook.command) ||
    hook.content !== ""
  ) return undefined;
  let output: Record<string, unknown> | undefined;
  try { output = objectValue(JSON.parse(hook.stdout)); } catch { return undefined; }
  if (
    output === undefined || !hasOnlyFields(output, ["systemMessage"]) ||
    typeof output.systemMessage !== "string" || output.systemMessage.trim() === ""
  ) return undefined;
  return {
    hookName: hook.hookName,
    toolUseId: hook.toolUseId,
    command: hook.command,
    durationMs: hook.durationMs,
    systemMessage: output.systemMessage,
  };
}

function sessionStartHookSystemMessage(
  record: Record<string, unknown>,
): SessionStartHookSystemMessage | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "content", "hookName", "toolUseID", "hookEvent"]) ||
    attachment.type !== "hook_system_message" || attachment.hookEvent !== "SessionStart" ||
    !validOpaqueIdentity(attachment.hookName) || !validHookName("SessionStart", attachment.hookName) ||
    !validOpaqueIdentity(attachment.toolUseID) || typeof attachment.content !== "string" ||
    attachment.content.trim() === "" ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  return {
    hookName: attachment.hookName,
    toolUseId: attachment.toolUseID,
    content: attachment.content,
  };
}

function hookAdditionalContextRecord(
  record: Record<string, unknown>,
): HookAdditionalContextRecord | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, ["type", "hookName", "toolUseID", "hookEvent", "content"]) ||
    attachment.type !== "hook_additional_context" || !validOpaqueIdentity(attachment.hookEvent) ||
    !validOpaqueIdentity(attachment.hookName) ||
    !validHookName(attachment.hookEvent, attachment.hookName) ||
    !validOpaqueIdentity(attachment.toolUseID) || !Array.isArray(attachment.content) ||
    attachment.content.length === 0 || attachment.content.some((value) =>
      typeof value !== "string" || value.trim() === "") ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  return { hookEvent: attachment.hookEvent, contexts: attachment.content as string[] };
}

function asyncHookContextRecord(
  record: Record<string, unknown>,
): AsyncHookContextRecord | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
    "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
  ])) return undefined;
  const attachment = objectValue(record.attachment);
  const response = objectValue(attachment?.response);
  const hookOutput = objectValue(response?.hookSpecificOutput);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !hasOnlyFields(attachment, [
      "type", "processId", "hookName", "hookEvent", "response", "stdout", "stderr", "exitCode",
    ]) ||
    attachment.type !== "async_hook_response" || !validOpaqueIdentity(attachment.processId) ||
    attachment.hookName !== "UserPromptSubmit" || attachment.hookEvent !== "UserPromptSubmit" ||
    response === undefined || !hasOnlyFields(response, ["hookSpecificOutput"]) || hookOutput === undefined ||
    !hasOnlyFields(hookOutput, ["hookEventName", "additionalContext"]) ||
    hookOutput.hookEventName !== attachment.hookEvent ||
    typeof hookOutput.additionalContext !== "string" || hookOutput.additionalContext.trim() === "" ||
    typeof attachment.stdout !== "string" || attachment.stdout.trim() === "" ||
    attachment.stderr !== "" || attachment.exitCode !== 0 ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  let stdout: unknown;
  try { stdout = JSON.parse(attachment.stdout); } catch { return undefined; }
  return isDeepStrictEqual(stdout, response) ? { context: hookOutput.additionalContext } : undefined;
}

function projectedHistoricalSystemContext(
  contexts: readonly string[],
  when: string,
  contentKind: "hook_additional_context" | "skill_listing" | "critical_system_reminder" |
    "nested_memory" | "relevant_memories" | "ambient_user_context" | "mcp_instructions_delta" |
    "background_agent_retry" | "background_agent_peer_message" | "background_agent_notification",
): ConversationMessage {
  return {
    kind: "message",
    role: "system",
    text: contexts.join("\n\n"),
    timestamp: when,
    contentKinds: contexts.map(() => contentKind),
    portableBlocks: contexts.map((text) => ({
      kind: "historical_context" as const,
      context: { sourceRole: "system" as const, text },
    })),
  };
}

function plainHookSuccessRecord(
  record: Record<string, unknown>,
  hookEvent: "PostToolUse" | "Stop",
): PlainHookSuccessRecord | undefined {
  const hook = successfulHookRecord(record);
  if (
    hook === undefined || hook.hookEvent !== hookEvent || hook.stdout !== `${hook.content}\n`
  ) return undefined;
  try {
    JSON.parse(hook.stdout.trim());
    return undefined;
  } catch {
    return {
      hookName: hook.hookName,
      toolUseId: hook.toolUseId,
      command: hook.command,
      durationMs: hook.durationMs,
    };
  }
}

function skippablePostToolUseHookRecord(record: Record<string, unknown>): string | undefined {
  const hook = plainHookSuccessRecord(record, "PostToolUse");
  return hook !== undefined && hook.hookName.startsWith("PostToolUse:") &&
    hook.hookName.length !== "PostToolUse:".length
    ? hook.toolUseId
    : undefined;
}

function skippableStopHookRecord(record: Record<string, unknown>): PlainHookSuccessRecord | undefined {
  const hook = plainHookSuccessRecord(record, "Stop");
  return hook?.hookName === "Stop" ? hook : undefined;
}

interface PendingStopHookRecord {
  readonly uuid: string;
  readonly toolUseId: string;
  readonly command: string;
  readonly durationMs?: number;
}

interface HookProgressRecord {
  readonly hookEvent: "SessionStart" | "PostToolUse" | "Stop";
  readonly hookName: string;
  readonly toolUseId: string;
  readonly command: string;
}

function skippableHookProgressRecord(record: Record<string, unknown>): HookProgressRecord | undefined {
  if (!hasOnlyFields(record, [
    "parentUuid", "isSidechain", "userType", "entrypoint", "cwd", "sessionId", "version",
    "gitBranch", "slug", "type", "data", "parentToolUseID", "toolUseID", "timestamp", "uuid",
  ])) return undefined;
  const data = objectValue(record.data);
  if (
    record.type !== "progress" || record.isSidechain !== false || data === undefined ||
    !hasOnlyFields(data, ["type", "hookEvent", "hookName", "command"]) ||
    data.type !== "hook_progress" ||
    (data.hookEvent !== "SessionStart" && data.hookEvent !== "PostToolUse" && data.hookEvent !== "Stop") ||
    typeof data.hookName !== "string" || data.hookName === "" ||
    /[\u0000-\u001f\u007f]/.test(data.hookName) ||
    typeof data.command !== "string" || data.command === "" ||
    typeof record.toolUseID !== "string" || record.toolUseID === "" ||
    /[\u0000-\u001f\u007f]/.test(record.toolUseID) ||
    record.parentToolUseID !== record.toolUseID ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  const validName = data.hookEvent === "Stop"
    ? data.hookName === "Stop"
    : data.hookName.startsWith(`${data.hookEvent}:`) && data.hookName.length !== data.hookEvent.length + 1;
  return validName
    ? {
      hookEvent: data.hookEvent,
      hookName: data.hookName,
      toolUseId: record.toolUseID,
      command: data.command,
    }
    : undefined;
}

function skippableStopHookSummary(
  record: Record<string, unknown>,
  pending: PendingStopHookRecord | undefined,
): boolean {
  if (pending === undefined || !hasOnlyFields(record, [
    "parentUuid", "isSidechain", "type", "subtype", "hookCount", "hookInfos",
    "hookErrors", "preventedContinuation", "stopReason", "hasOutput", "level",
    "timestamp", "uuid", "toolUseID", "userType", "entrypoint", "cwd", "sessionId",
    "version", "gitBranch", "slug",
  ])) return false;
  if (!Array.isArray(record.hookInfos) || record.hookInfos.length !== 1 ||
    !Array.isArray(record.hookErrors) || record.hookErrors.length !== 0) return false;
  const hookInfo = objectValue(record.hookInfos[0]);
  const hookInfoFields = pending.durationMs === undefined ? ["command"] : ["command", "durationMs"];
  if (
    record.type !== "system" || record.subtype !== "stop_hook_summary" ||
    record.isSidechain !== false || canonicalRecordUuid(record.parentUuid) !== pending.uuid ||
    record.hookCount !== 1 || record.preventedContinuation !== false || record.stopReason !== "" ||
    record.hasOutput !== true || record.level !== "suggestion" || record.toolUseID !== pending.toolUseId ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    hookInfo === undefined || !hasOnlyFields(hookInfo, hookInfoFields) ||
    hookInfo.command !== pending.command || hookInfo.durationMs !== pending.durationMs
  ) return false;
  return ["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"].every((field) =>
    record[field] === undefined || typeof record[field] === "string");
}

interface ClaudeSourceReferenceProjection {
  readonly reference: HistoricalReferenceEvidence;
  readonly sourceKind: "file" | "url";
  readonly cacheControlNotes: readonly string[];
}

function projectClaudeReferenceBlock(
  block: Record<string, unknown>,
  kind: "document" | "image",
): ClaudeSourceReferenceProjection | undefined {
  const source = objectValue(block.source);
  const allowedFields = kind === "document"
    ? ["type", "source", "cache_control", "citations", "context", "title"]
    : ["type", "source", "cache_control"];
  const cacheControlNotes = projectClaudeCacheControl(block);
  if (
    block.type !== kind || source === undefined || !hasOnlyFields(block, allowedFields) ||
    cacheControlNotes === undefined
  ) return undefined;
  let namespace: "anthropic.files" | "anthropic.url";
  let locator: string;
  let sourceKind: "file" | "url";
  if (source.type === "file" && hasOnlyFields(source, ["type", "file_id"])) {
    namespace = "anthropic.files";
    locator = typeof source.file_id === "string" ? source.file_id : "";
    sourceKind = "file";
  } else if (source.type === "url" && hasOnlyFields(source, ["type", "url"]) && httpUrl(source.url) !== undefined) {
    namespace = "anthropic.url";
    locator = source.url as string;
    sourceKind = "url";
  } else {
    return undefined;
  }
  const base = {
    type: kind,
    namespace,
    locator,
  } as const;
  if (kind === "image") {
    return validHistoricalReference(base)
      ? { reference: base, sourceKind, cacheControlNotes }
      : undefined;
  }
  if (
    Object.hasOwn(block, "title") && block.title !== null && typeof block.title !== "string" ||
    Object.hasOwn(block, "context") && block.context !== null && typeof block.context !== "string"
  ) return undefined;
  const citations = Object.hasOwn(block, "citations") && block.citations !== null
    ? objectValue(block.citations)
    : undefined;
  if (
    Object.hasOwn(block, "citations") && block.citations !== null &&
    (citations === undefined || !hasOnlyFields(citations, ["enabled"]) ||
      citations.enabled !== undefined && typeof citations.enabled !== "boolean")
  ) return undefined;
  const reference: HistoricalReferenceEvidence = {
    ...base,
    ...(Object.hasOwn(block, "title") ? { title: block.title as string | null } : {}),
    ...(Object.hasOwn(block, "context") ? { context: block.context as string | null } : {}),
    ...(Object.hasOwn(block, "citations")
      ? {
        citations: block.citations === null
          ? null
          : citations?.enabled === undefined ? {} : { enabled: citations.enabled as boolean },
      }
      : {}),
  };
  return validHistoricalReference(reference)
    ? { reference, sourceKind, cacheControlNotes }
    : undefined;
}

function projectClaudeSourceReference(
  block: Record<string, unknown>,
  role: string,
  kind: "document" | "image",
): { readonly reference: HistoricalReferenceEvidence; readonly notes: readonly string[] } | undefined {
  if (role !== "user") return undefined;
  const projected = projectClaudeReferenceBlock(block, kind);
  return projected === undefined
    ? undefined
    : {
        reference: projected.reference,
        notes: [
          ...projected.cacheControlNotes,
          `claude.user_${kind}_${projected.sourceKind}.reference_only`,
        ],
      };
}

function portableToolUse(block: Record<string, unknown>): PortableContextBlock | undefined {
  if (!hasOnlyFields(block, ["type", "id", "name", "input"]) ||
    typeof block.id !== "string" || block.id === "" || typeof block.name !== "string" || block.name === "") {
    return undefined;
  }
  const input = objectValue(block.input);
  if (input === undefined) return undefined;
  return {
    kind: "historical_tool",
    tool: {
      phase: "call",
      callId: block.id,
      name: block.name,
      input: input as PortableContextJson,
    },
  };
}

function managedClaudeBytes(
  bytes: Buffer,
  mediaType: string,
  filename: string,
  sourceReferencePrefix: string,
): ManagedResourceObject | undefined {
  const name = managedResourceName(filename, mediaType);
  return createManagedResourceObject({
    bytes,
    mediaType,
    name,
    sourceReference: (sha256) => `${sourceReferencePrefix}:sha256:${sha256}`,
  });
}

function toolResultHasResource(value: unknown): boolean {
  return Array.isArray(value) && value.some((raw) => {
    const block = objectValue(raw);
    return block?.type === "image" || block?.type === "document" || block?.type === "file";
  });
}

interface PortableToolResultProjection {
  readonly block: PortableContextBlock;
  readonly managedResources: readonly ManagedResourceObject[];
  readonly structuredKinds: readonly ClaudeStructuredToolResultKind[];
  readonly portableNotes: readonly string[];
}

function managedClaudeResource(
  value: unknown,
  expectedKind: "image" | "document",
  base64MediaTypes: ReadonlySet<string>,
  sourceReferencePrefix: string,
): ManagedResourceObject | undefined {
  const content = objectValue(value);
  const source = objectValue(content?.source);
  if (
    content === undefined || source === undefined || !hasOnlyFields(content, ["type", "source"]) ||
    content.type !== expectedKind || !hasOnlyFields(source, ["type", "data", "media_type"]) ||
    typeof source.data !== "string" || source.data === "" || typeof source.media_type !== "string"
  ) return undefined;
  let bytes: Buffer;
  let mediaType: string;
  if (source.type === "base64" && base64MediaTypes.has(source.media_type)) {
    const decoded = decodeCanonicalBase64(source.data);
    if (decoded === undefined) return undefined;
    bytes = decoded;
    mediaType = source.media_type;
  } else if (
    expectedKind === "document" && source.type === "text" && source.media_type === "text/plain"
  ) {
    bytes = Buffer.from(source.data, "utf8");
    mediaType = MANAGED_TEXT_MEDIA_TYPE;
  } else {
    return undefined;
  }
  return managedClaudeBytes(bytes, mediaType, "", sourceReferencePrefix);
}

function managedClaudeResourceContent(
  kind: "image" | "document",
  resource: ManagedResourceObject,
): PortableContextJson {
  return {
    type: kind,
    source: {
      type: "managed_resource",
      resource_relative_path: resource.relativePath,
      media_type: resource.mediaType,
    },
  };
}

function projectClaudeToolResultReference(
  value: unknown,
): {
  readonly content: PortableContextJson;
  readonly reference: HistoricalReferenceEvidence;
  readonly notes: readonly string[];
} | undefined {
  const block = objectValue(value);
  const kind = block?.type === "image" || block?.type === "document" ? block.type : undefined;
  if (block === undefined || kind === undefined) return undefined;
  const projected = projectClaudeReferenceBlock(block, kind);
  if (projected === undefined) return undefined;
  const reference = projected.reference;
  return {
    content: {
      type: kind,
      source: {
        type: "historical_reference",
        namespace: reference.namespace,
        locator: reference.locator,
      },
      ...(reference.title === undefined ? {} : { title: reference.title }),
      ...(reference.context === undefined ? {} : { context: reference.context }),
      ...(reference.citations === undefined ? {} : { citations: reference.citations }),
    },
    reference,
    notes: [
      ...projected.cacheControlNotes,
      `claude.tool_result_${kind}_${projected.sourceKind}.reference_only`,
    ],
  };
}

function portableStructuredToolResult(
  value: unknown,
  callId: string,
): {
  readonly content: PortableContextJson;
  readonly resources: readonly ManagedResourceObject[];
  readonly references: readonly HistoricalReferenceEvidence[];
  readonly structuredKinds: readonly ClaudeStructuredToolResultKind[];
  readonly portableNotes: readonly string[];
} | undefined {
  if (!Array.isArray(value) || value.length === 0 ||
    Buffer.byteLength(callId, "utf8") > 1024 || /[\u0000-\u001f\u007f]/.test(callId)) return undefined;
  const content: PortableContextJson[] = [];
  const resources: ManagedResourceObject[] = [];
  const references: HistoricalReferenceEvidence[] = [];
  let resourceOrdinal = 0;
  const structuredKinds = new Set<ClaudeStructuredToolResultKind>();
  const portableNotes: string[] = [];
  for (const raw of value) {
    const block = objectValue(raw);
    if (
      block !== undefined && hasOnlyFields(block, ["type", "text"]) &&
      block.type === "text" && typeof block.text === "string"
    ) {
      content.push({ type: "text", text: block.text });
      continue;
    }
    const structured = projectClaudeClientToolContent(block, {
      projectImage: (image) => {
        const nextResourceOrdinal = resourceOrdinal + 1;
        const resource = managedClaudeResource(
          image,
          "image",
          CLAUDE_IMAGE_MEDIA_TYPES,
          `claude:tool-result-image:${callId}:${nextResourceOrdinal}`,
        );
        if (resource !== undefined) {
          resourceOrdinal = nextResourceOrdinal;
          return { content: managedClaudeResourceContent("image", resource), resource };
        }
        const reference = projectClaudeToolResultReference(image);
        return reference === undefined
          ? undefined
          : {
              content: reference.content,
              reference: reference.reference,
              notes: reference.notes,
            };
      },
    });
    if (structured !== undefined) {
      if (structured.managedResources.some((resource) =>
        resources.some((candidate) => candidate.relativePath === resource.relativePath))) return undefined;
      structuredKinds.add(structured.kind);
      content.push(structured.content);
      resources.push(...structured.managedResources);
      for (const reference of structured.references) {
        if (!references.some((candidate) => isDeepStrictEqual(candidate, reference))) {
          references.push(reference);
        }
      }
      portableNotes.push(...structured.notes);
      continue;
    }
    const kind = block?.type === "image" || block?.type === "document" ? block.type : undefined;
    if (kind === undefined) return undefined;
    const reference = projectClaudeToolResultReference(block);
    if (reference !== undefined) {
      if (!references.some((candidate) => isDeepStrictEqual(candidate, reference.reference))) {
        references.push(reference.reference);
      }
      content.push(reference.content);
      portableNotes.push(...reference.notes);
      continue;
    }
    resourceOrdinal++;
    const resource = managedClaudeResource(
      block,
      kind,
      kind === "image" ? CLAUDE_IMAGE_MEDIA_TYPES : CLAUDE_BASE64_DOCUMENT_MEDIA_TYPES,
      `claude:tool-result-${kind}:${callId}:${resourceOrdinal}`,
    );
    if (
      resource === undefined ||
      resources.some((candidate) => candidate.relativePath === resource.relativePath)
    ) return undefined;
    resources.push(resource);
    content.push(managedClaudeResourceContent(kind, resource));
  }
  if (resources.length === 0 && references.length === 0 && structuredKinds.size === 0) return undefined;
  return {
    content,
    resources,
    references,
    structuredKinds: [...structuredKinds],
    portableNotes,
  };
}

function portableToolResult(block: Record<string, unknown>): PortableToolResultProjection | undefined {
  if (!hasOnlyFields(block, ["type", "tool_use_id", "content", "is_error", "cache_control"]) ||
    typeof block.tool_use_id !== "string" || block.tool_use_id === "") {
    return undefined;
  }
  if (block.is_error !== undefined && typeof block.is_error !== "boolean") return undefined;
  const cacheControlNotes = projectClaudeCacheControl(block);
  if (cacheControlNotes === undefined) return undefined;
  let content: PortableContextJson;
  let managedResources: readonly ManagedResourceObject[] = [];
  let references: readonly HistoricalReferenceEvidence[] = [];
  let structuredKinds: readonly ClaudeStructuredToolResultKind[] = [];
  let portableNotes: readonly string[] = cacheControlNotes;
  if (typeof block.content === "string") {
    content = block.content;
  } else if (Array.isArray(block.content) && block.content.every((raw) => {
    const value = objectValue(raw);
    return value !== undefined && hasOnlyFields(value, ["type", "text"]) &&
      value.type === "text" && typeof value.text === "string";
  })) {
    content = block.content as PortableContextJson;
  } else {
    const structuredResult = block.is_error === true
      ? undefined
      : portableStructuredToolResult(block.content, block.tool_use_id);
    if (structuredResult === undefined) return undefined;
    content = structuredResult.content;
    managedResources = structuredResult.resources;
    references = structuredResult.references;
    structuredKinds = structuredResult.structuredKinds;
    portableNotes = [...cacheControlNotes, ...structuredResult.portableNotes];
  }
  return {
    block: {
      kind: "historical_tool",
      tool: block.is_error === true
        ? { phase: "result", callId: block.tool_use_id, error: content }
        : {
            phase: "result",
            callId: block.tool_use_id,
            output: content,
            ...(managedResources.length === 0
              ? {}
              : { resources: managedResources.map(managedResourceReference) }),
            ...(references.length === 0 ? {} : { references }),
          },
    },
    managedResources,
    structuredKinds,
    portableNotes,
  };
}

function portableToolOutputHasStructuredMetadata(value: PortableContextJson | undefined): boolean {
  return Array.isArray(value) && value.some((raw) => {
    const kind = objectValue(raw)?.type;
    if (kind === "search_result" || kind === "tool_reference") return true;
    const source = objectValue(objectValue(raw)?.source);
    return kind === "document" && source?.type === "content";
  });
}

function visibleTool(block: Extract<PortableContextBlock, { readonly kind: "historical_tool" }>): string {
  const tool = block.tool;
  if (tool.phase === "call") return `[tool: ${tool.name} (${tool.callId})]\ninput: ${JSON.stringify(tool.input)}`;
  const value = tool.error === undefined ? tool.output : tool.error;
  return `[tool ${tool.error === undefined ? "result" : "error"}: ${tool.callId}]\n${JSON.stringify(value)}`;
}

function portableThinking(block: Record<string, unknown>): PortableContextBlock | undefined {
  if (
    !hasOnlyFields(block, ["type", "thinking", "signature"]) ||
    block.type !== "thinking" || typeof block.thinking !== "string" || block.thinking.trim() === "" ||
    typeof block.signature !== "string" || block.signature === ""
  ) return undefined;
  return { kind: "historical_reasoning", summary: [block.thinking] };
}

function projectClaudeApiCompaction(
  block: Record<string, unknown>,
): ProjectedContent["apiCompaction"] {
  if (
    !hasOnlyFields(block, ["type", "content", "encrypted_content"]) ||
    block.type !== "compaction" || !Object.hasOwn(block, "content") ||
    !Object.hasOwn(block, "encrypted_content") || typeof block.content !== "string" ||
    block.content.trim() === "" ||
    !(block.encrypted_content === null ||
      typeof block.encrypted_content === "string" && block.encrypted_content !== "")
  ) return undefined;
  return {
    summary: block.content,
    encryptedContentOmitted: block.encrypted_content !== null,
  };
}

function projectContent(
  value: unknown,
  role: string,
  recordUuid?: string,
  openServerCalls?: ReadonlyMap<string, HistoricalToolEvidence>,
): ProjectedContent {
  if (typeof value === "string") {
    return {
      text: value,
      portableBlocks: [{ kind: "text", text: value }],
      kinds: ["text"],
      portableNotes: [],
      managedResources: [],
      apiCompactionBlockCount: 0,
    };
  }
  if (!Array.isArray(value)) {
    return {
      text: "",
      portableBlocks: [],
      kinds: [],
      portableNotes: [],
      managedResources: [],
      apiCompactionBlockCount: 0,
    };
  }
  const text: string[] = [];
  const portableBlocks: PortableContextBlock[] = [];
  const kinds: string[] = [];
  const portableNotes: string[] = [];
  const managedResources: ManagedResourceObject[] = [];
  const apiCompactionBlockCount = value.filter((raw) => objectValue(raw)?.type === "compaction").length;
  let apiCompaction: ProjectedContent["apiCompaction"];
  let resourceOrdinal = 0;
  let pendingServerCall: HistoricalToolEvidence | undefined;
  for (const [index, raw] of value.entries()) {
    const precedingServerCall = pendingServerCall;
    pendingServerCall = undefined;
    const block = objectValue(raw);
    if (block === undefined) {
      kinds.push("unknown");
      continue;
    }
    const kind = typeof block.type === "string" ? block.type : "unknown";
    if (kind === "compaction") {
      const projected = role === "assistant" && index === 0 && apiCompactionBlockCount === 1
        ? projectClaudeApiCompaction(block)
        : undefined;
      if (projected === undefined) kinds.push(kind);
      else {
        apiCompaction = projected;
        if (projected.encryptedContentOmitted) portableNotes.push(CLAUDE_API_COMPACTION_ENCRYPTED_NOTE);
      }
      continue;
    }
    if (kind === "image" || kind === "document") {
      const source = objectValue(block.source);
      if (source?.type === "file" || source?.type === "url") {
        const projected = projectClaudeSourceReference(block, role, kind);
        kinds.push(`${kind}_reference`);
        if (projected === undefined) continue;
        text.push(`[source ${kind} reference]`);
        portableBlocks.push({ kind: "historical_reference", reference: projected.reference });
        portableNotes.push(...projected.notes);
        continue;
      }
      resourceOrdinal++;
      kinds.push(kind);
      const resource = role === "user" && recordUuid !== undefined && recordUuid !== ""
        ? managedClaudeResource(
            block,
            kind,
            kind === "image" ? CLAUDE_IMAGE_MEDIA_TYPES : CLAUDE_BASE64_DOCUMENT_MEDIA_TYPES,
            `claude:user-${kind}:${recordUuid}:${resourceOrdinal}`,
          )
        : undefined;
      if (resource !== undefined) {
        text.push(`[${kind}] ${resource.name} ${resource.mediaType}`);
        portableBlocks.push({ kind: "historical_resource", resource: managedResourceReference(resource) });
        portableNotes.push(`claude.user_${kind}.managed`);
        managedResources.push(resource);
      }
      continue;
    }
    if (kind === "container_upload") {
      kinds.push(kind);
      const cacheControlNotes = projectClaudeCacheControl(block);
      const reference = {
        type: "file" as const,
        namespace: "anthropic.files",
        locator: typeof block.file_id === "string" ? block.file_id : "",
      };
      const allowedFields = role === "user"
        ? ["type", "file_id", "cache_control"]
        : ["type", "file_id"];
      if (
        !hasOnlyFields(block, allowedFields) ||
        cacheControlNotes === undefined || !validHistoricalReference(reference)
      ) continue;
      text.push("[source file reference]");
      portableBlocks.push({ kind: "historical_reference", reference });
      portableNotes.push(...cacheControlNotes, "claude.container_upload.reference_only");
      continue;
    }
    if (kind === "text") {
      if (
        !hasOnlyFields(block, ["type", "text", "citations", "cache_control"]) ||
        typeof block.text !== "string"
      ) {
        kinds.push("text_metadata_invalid");
        continue;
      }
      const cacheControlNotes = projectClaudeCacheControl(block);
      if (cacheControlNotes === undefined) {
        kinds.push("text_metadata_invalid");
        continue;
      }
      const citations = Object.hasOwn(block, "citations")
        ? projectClaudeTextCitations(block.citations, role === "assistant" ? "response" : "parameter")
        : undefined;
      if (Object.hasOwn(block, "citations") && citations === undefined) {
        kinds.push("text_citations_invalid");
        continue;
      }
      kinds.push(kind);
      text.push(block.text);
      portableBlocks.push({ kind: "text", text: block.text });
      portableNotes.push(...cacheControlNotes);
      if (Array.isArray(citations) && citations.length !== 0) {
        portableBlocks.push({ kind: "historical_citations", citations });
        portableNotes.push("claude.text_citations.preserved");
      }
      continue;
    }
    if (kind === "thinking") {
      kinds.push(kind);
      const projected = role === "assistant" ? portableThinking(block) : undefined;
      if (projected !== undefined && projected.kind === "historical_reasoning") {
        text.push(`[reasoning summary]\n${projected.summary[0]}`);
        portableBlocks.push(projected);
        portableNotes.push("claude.thinking_signature.skipped");
      }
      continue;
    }
    if (kind === "tool_use") {
      kinds.push(kind);
      const projected = role === "assistant" ? portableToolUse(block) : undefined;
      if (projected !== undefined && projected.kind === "historical_tool") {
        portableBlocks.push(projected);
        text.push(visibleTool(projected));
      }
      continue;
    }
    if (kind === "server_tool_use" || kind === "mcp_tool_use") {
      kinds.push(kind);
      const projected = role === "assistant" ? projectClaudeServerToolCall(block) : undefined;
      if (projected !== undefined) {
        portableBlocks.push(projected);
        portableNotes.push(kind === "mcp_tool_use"
          ? "claude.mcp_server_configuration.skipped"
          : "claude.server_tool_caller.skipped");
        text.push(visibleTool(projected));
        pendingServerCall = projected.tool;
      }
      continue;
    }
    if (isClaudeServerToolResultKind(kind)) {
      kinds.push(kind);
      const resultCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const serverCall = precedingServerCall === undefined
        ? openServerCalls?.get(resultCallId)
        : precedingServerCall.callId === resultCallId
          ? precedingServerCall
          : undefined;
      const projected = role === "assistant" && serverCall !== undefined
        ? projectClaudeServerToolResult(block, serverCall)
        : undefined;
      if (projected !== undefined) {
        portableBlocks.push(projected.block);
        managedResources.push(...projected.managedResources);
        portableNotes.push(...projected.notes);
        text.push(visibleTool(projected.block));
      }
      continue;
    }
    if (kind === "tool_result") {
      const projected = role === "user" ? portableToolResult(block) : undefined;
      const singleImage = projected?.managedResources.length === 1 &&
        Array.isArray(block.content) && block.content.length === 1 &&
        objectValue(block.content[0])?.type === "image";
      const referenceResult = projected?.block.kind === "historical_tool" &&
        (projected.block.tool.references?.length ?? 0) !== 0;
      kinds.push(singleImage
        ? "tool_result_image"
        : projected !== undefined && projected.managedResources.length !== 0
          ? "tool_result_resource"
          : referenceResult
            ? "tool_result_reference"
            : toolResultHasResource(block.content) ? "tool_result_resource" : kind);
      if (projected !== undefined && projected.block.kind === "historical_tool") {
        portableBlocks.push(projected.block);
        managedResources.push(...projected.managedResources);
        portableNotes.push(...projected.portableNotes);
        if (projected.structuredKinds.includes("search_result")) {
          portableNotes.push("claude.tool_search_result.preserved");
        }
        if (projected.structuredKinds.includes("tool_reference")) {
          portableNotes.push("claude.tool_reference.preserved");
        }
        if (projected.structuredKinds.includes("content_document")) {
          portableNotes.push("claude.tool_content_document.preserved");
        }
        text.push(visibleTool(projected.block));
      }
      continue;
    }
    kinds.push(kind);
  }
  return {
    text: text.join("\n"),
    portableBlocks,
    kinds,
    portableNotes,
    managedResources,
    apiCompactionBlockCount,
    ...(apiCompaction === undefined ? {} : { apiCompaction }),
  };
}

function contentGapCode(kinds: readonly string[]): string {
  const candidate = kinds.length === 1 ? kinds[0]! : "unclassified";
  const normalized = /^[A-Za-z0-9._-]{1,64}$/.test(candidate)
    ? candidate.toLowerCase().replaceAll("-", "_")
    : "unclassified";
  return `claude.content.${normalized}`;
}

interface ProjectedClaudeMessage {
  readonly item: ConversationItem;
  readonly managedResources: readonly ManagedResourceObject[];
  readonly apiCompactionBlockCount: number;
  readonly apiCompaction?: ProjectedContent["apiCompaction"];
}

interface ClaudeAssistantEnvelopeClassification {
  readonly notes: readonly string[];
  readonly blocker?: "claude.assistant_error.unsupported" | "claude.assistant_completion.unsupported";
  readonly truncationReason?: "max_tokens" | "model_context_window_exceeded";
}

function classifyAssistantEnvelope(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  kinds: readonly string[],
): ClaudeAssistantEnvelopeClassification {
  const notes: string[] = [];
  const hasStopReason = Object.hasOwn(message, "stop_reason");
  const reason = message.stop_reason;
  const stopSequence = message.stop_sequence;
  const hasUnexpectedStopSequence = stopSequence !== undefined && stopSequence !== null && reason !== "stop_sequence";
  const truncationReason = reason === "max_tokens" || reason === "model_context_window_exceeded"
    ? reason
    : undefined;
  const truncationErrorValid = record.error === undefined || record.error === null ||
    truncationReason === "max_tokens" && record.error === "max_output_tokens";
  const truncationContentValid = kinds.length !== 0 && kinds.every((kind) =>
    kind === "text" || kind === "thinking" || kind === "redacted_thinking");
  if (
    notes.length === 0 && hasStopReason && truncationReason !== undefined && truncationErrorValid &&
    truncationContentValid && !hasUnexpectedStopSequence
  ) {
    return {
      notes: ["claude.assistant_truncation.materialized"],
      truncationReason,
    };
  }

  let blocker: ClaudeAssistantEnvelopeClassification["blocker"];
  if (record.error !== undefined && record.error !== null) {
    notes.push("claude.assistant_error.unsupported");
    blocker ??= "claude.assistant_error.unsupported";
  }
  if (!hasStopReason) return { notes, ...(blocker === undefined ? {} : { blocker }) };

  const clientToolUses = kinds.filter((kind) => kind === "tool_use").length;
  const validStopSequence = typeof stopSequence === "string" && stopSequence !== "";
  if (
    reason === "end_turn" && clientToolUses === 0 && !hasUnexpectedStopSequence ||
    reason === "tool_use" && clientToolUses !== 0 && !hasUnexpectedStopSequence
  ) return { notes, ...(blocker === undefined ? {} : { blocker }) };
  const lastKind = kinds.at(-1);
  if (
    blocker === undefined && reason === "pause_turn" && clientToolUses === 0 &&
    (lastKind === "server_tool_use" || lastKind === "mcp_tool_use") &&
    !hasUnexpectedStopSequence
  ) return { notes: [CLAUDE_SERVER_PAUSE_TURN_NOTE] };
  if (
    (reason === "stop_sequence" && clientToolUses === 0 && validStopSequence) ||
    (reason === "refusal" && clientToolUses === 0 && !hasUnexpectedStopSequence)
  ) {
    notes.push("claude.assistant_stop_reason.skipped");
    return { notes, ...(blocker === undefined ? {} : { blocker }) };
  }
  const completionBlocker = "claude.assistant_completion.unsupported" as const;
  notes.push(completionBlocker);
  return { notes, blocker: blocker ?? completionBlocker };
}

function projectMessage(
  record: Record<string, unknown>,
  kind: string,
  when: string,
  recordUuid: string | undefined,
  openServerCalls?: ReadonlyMap<string, HistoricalToolEvidence>,
): ProjectedClaudeMessage | undefined {
  const message = objectValue(record.message);
  if (message === undefined || message.role !== kind) {
    return {
      item: {
        kind: "gap",
        code: "claude.message_shape.unprojectable",
        label: `Claude ${kind} record is preserved only in native history`,
        timestamp: when,
      },
      managedResources: [],
      apiCompactionBlockCount: 0,
    };
  }
  const content = projectContent(message.content, kind, recordUuid, openServerCalls);
  const assistantEnvelope: ClaudeAssistantEnvelopeClassification = kind === "assistant"
    ? classifyAssistantEnvelope(record, message, content.kinds)
    : { notes: [] };
  if (content.text === "") {
    if (assistantEnvelope.blocker !== undefined || assistantEnvelope.truncationReason !== undefined) {
      return {
        item: {
          kind: "gap",
          code: assistantEnvelope.blocker ?? "claude.assistant_completion.unsupported",
          label: "Claude assistant response did not complete as ordinary portable history",
          timestamp: when,
        },
        managedResources: [],
        apiCompactionBlockCount: content.apiCompactionBlockCount,
        ...(content.apiCompaction === undefined ? {} : { apiCompaction: content.apiCompaction }),
      };
    }
    const label = content.kinds.length === 0
      ? `Claude ${kind} record has no readable text`
      : `Claude ${content.kinds.join(", ")} content is preserved in native history`;
    return {
      item: { kind: "gap", code: contentGapCode(content.kinds), label, timestamp: when },
      managedResources: [],
      apiCompactionBlockCount: content.apiCompactionBlockCount,
      ...(content.apiCompaction === undefined ? {} : { apiCompaction: content.apiCompaction }),
    };
  }
  const model = typeof message.model === "string" && message.model !== "" ? message.model : undefined;
  const truncationReason = assistantEnvelope.truncationReason;
  const truncationText = truncationReason === undefined
    ? undefined
    : `[response truncated: ${truncationReason}]\nThe preceding Claude response may be incomplete.`;
  const result: ConversationMessage = {
    kind: "message",
    role: kind as "user" | "assistant",
    text: truncationText === undefined ? content.text : `${content.text}\n${truncationText}`,
    portableBlocks: truncationReason === undefined
      ? content.portableBlocks
      : [
        ...content.portableBlocks,
        { kind: "historical_event", event: "assistant_response_truncated", reason: truncationReason },
      ],
    contentKinds: truncationReason === undefined ? content.kinds : [...content.kinds, "historical_event"],
    ...(content.portableNotes.length === 0 && assistantEnvelope.notes.length === 0
      ? {}
      : { portableNotes: [...content.portableNotes, ...assistantEnvelope.notes] }),
    timestamp: when,
    ...(model === undefined ? {} : { model }),
  };
  return {
    item: result,
    managedResources: content.managedResources,
    apiCompactionBlockCount: content.apiCompactionBlockCount,
    ...(content.apiCompaction === undefined ? {} : { apiCompaction: content.apiCompaction }),
  };
}

function projectCompactSummary(record: Record<string, unknown>, when: string): ConversationItem {
  const message = objectValue(record.message);
  if (message?.role !== "user" || typeof message.content !== "string" || message.content.trim() === "") {
    return {
      kind: "gap",
      code: "claude.compact_summary.unprojectable",
      label: "Claude compaction summary is preserved only in native history",
      timestamp: when,
    };
  }
  return {
    kind: "message",
    role: "system",
    text: message.content,
    timestamp: when,
    contentKinds: ["compact_summary"],
    portableBlocks: [],
  };
}

function projectApiCompactSummary(
  compaction: NonNullable<ProjectedContent["apiCompaction"]>,
  when: string,
): ConversationMessage {
  return {
    kind: "message",
    role: "system",
    text: compaction.summary,
    timestamp: when,
    contentKinds: ["api_compaction_summary"],
    portableBlocks: [],
  };
}

function canonicalRecordUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { return canonicalClaudeUuid(value); } catch { return undefined; }
}

function toolResultGraphReturn(record: Record<string, unknown>, parentUuid: string): boolean {
  if (
    record.type !== "user" || record.isMeta === true ||
    canonicalRecordUuid(record.sourceToolAssistantUUID) !== parentUuid
  ) return false;
  const message = objectValue(record.message);
  return message?.role === "user" && Array.isArray(message.content) && message.content.length !== 0 &&
    message.content.every((raw) => {
      const block = objectValue(raw);
      return block?.type === "tool_result" &&
        typeof block.tool_use_id === "string" && block.tool_use_id !== "";
    });
}

type PartialCompactKind = "partial_up_to" | "partial_from";

interface PartialCompactBoundary {
  readonly uuid: string;
  readonly parentUuid: string;
  readonly logicalParentUuid: string;
  readonly anchorUuid: string;
  readonly preservedUuids: readonly string[];
  readonly allTailUuid: string;
  readonly nondurablePreservedMessages: number;
  readonly messagesSummarized: number;
  readonly userContext?: string;
}

interface PendingCompactBoundary {
  readonly uuid: string;
  readonly fullValid: boolean;
  readonly partial?: PartialCompactBoundary;
}

interface ClaudeGraphRecord {
  readonly recordNumber: number;
  readonly parentUuid: string | null;
  readonly kind: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly version?: string;
}

function nearestPortableUserAncestorMatches(
  startUuid: string,
  expectedUuid: string,
  graph: ReadonlyMap<string, ClaudeGraphRecord>,
  portableUserMessageUuids: ReadonlySet<string>,
): boolean {
  let currentUuid = graph.get(startUuid)?.parentUuid;
  while (currentUuid !== undefined && currentUuid !== null) {
    if (portableUserMessageUuids.has(currentUuid)) return currentUuid === expectedUuid;
    currentUuid = graph.get(currentUuid)?.parentUuid;
  }
  return false;
}

function validRetractedTurnRecords(
  uuids: readonly string[],
  replacementUuid: string,
  refusedUserUuid: string,
  graph: ReadonlyMap<string, ClaudeGraphRecord>,
  portableUserMessageUuids: ReadonlySet<string>,
): boolean {
  const replacement = graph.get(replacementUuid);
  if (replacement?.kind !== "assistant") return false;
  return uuids.every((uuid) => {
    const record = graph.get(uuid);
    return record !== undefined && (record.kind === "assistant" || record.kind === "user") &&
      record.recordNumber < replacement.recordNumber && !portableUserMessageUuids.has(uuid) &&
      nearestPortableUserAncestorMatches(uuid, refusedUserUuid, graph, portableUserMessageUuids);
  });
}

interface PartialCompactCheckpoint {
  readonly kind: PartialCompactKind;
  readonly summaryIndex: number;
  readonly summaryUuid: string;
  readonly boundary: PartialCompactBoundary;
}

type CompactCheckpoint =
  | {
    readonly kind: "full";
    readonly summaryIndex: number;
    readonly summaryUuid: string;
  }
  | PartialCompactCheckpoint;

interface ApiCompactCheckpoint {
  readonly kind: "api";
  readonly summaryIndex: number;
}

interface MaterializableCompactCheckpoint {
  readonly kind: CompactCheckpoint["kind"] | ApiCompactCheckpoint["kind"];
  readonly summaryIndex: number;
  readonly preservedConversationIndexes: readonly number[];
  readonly expectedGraphDiscontinuities: number;
  readonly preservedUuids: readonly string[];
  readonly nondurablePreservedMessages: number;
}

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalUuidList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const uuid = canonicalRecordUuid(item);
    if (uuid === undefined || seen.has(uuid)) return undefined;
    seen.add(uuid);
    result.push(uuid);
  }
  return result;
}

function orderedUuidSubset(subset: readonly string[], superset: readonly string[]): boolean {
  const positions = new Map(superset.map((uuid, index) => [uuid, index]));
  let previous = -1;
  for (const uuid of subset) {
    const position = positions.get(uuid);
    if (position === undefined || position <= previous) return false;
    previous = position;
  }
  return true;
}

function validDiscoveredTools(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 ||
    value.some((item) => typeof item !== "string" || item === "")) return false;
  const tools = value as string[];
  const sorted = [...tools].sort();
  return new Set(tools).size === tools.length && tools.every((tool, index) => tool === sorted[index]);
}

function partialCompactBoundary(
  record: Record<string, unknown>,
  recordUuid: string | undefined,
): PartialCompactBoundary | undefined {
  const parentUuid = canonicalRecordUuid(record.parentUuid);
  const logicalParentUuid = canonicalRecordUuid(record.logicalParentUuid);
  const metadata = objectValue(record.compactMetadata);
  if (
    recordUuid === undefined || parentUuid === undefined || logicalParentUuid === undefined ||
    record.isMeta === true || metadata === undefined || metadata.trigger !== "manual" ||
    !nonnegativeInteger(metadata.preTokens) || !nonnegativeInteger(metadata.postTokens) ||
    !nonnegativeInteger(metadata.cumulativeDroppedTokens) || !nonnegativeInteger(metadata.durationMs) ||
    !nonnegativeInteger(metadata.messagesSummarized) || metadata.messagesSummarized === 0 ||
    (metadata.userContext !== undefined && typeof metadata.userContext !== "string") ||
    (metadata.preCompactDiscoveredTools !== undefined &&
      !validDiscoveredTools(metadata.preCompactDiscoveredTools)) ||
    !hasOnlyFields(metadata, [
      "trigger",
      "preTokens",
      "postTokens",
      "cumulativeDroppedTokens",
      "durationMs",
      "userContext",
      "messagesSummarized",
      "preCompactDiscoveredTools",
      "preservedSegment",
      "preservedMessages",
    ])
  ) return undefined;

  const segment = objectValue(metadata.preservedSegment);
  const messages = objectValue(metadata.preservedMessages);
  if (
    segment === undefined || messages === undefined ||
    !hasOnlyFields(segment, ["headUuid", "anchorUuid", "tailUuid"]) ||
    !hasOnlyFields(messages, ["anchorUuid", "uuids", "allUuids"])
  ) return undefined;
  const headUuid = canonicalRecordUuid(segment.headUuid);
  const segmentAnchorUuid = canonicalRecordUuid(segment.anchorUuid);
  const tailUuid = canonicalRecordUuid(segment.tailUuid);
  const messagesAnchorUuid = canonicalRecordUuid(messages.anchorUuid);
  const preservedUuids = canonicalUuidList(messages.uuids);
  const allUuids = canonicalUuidList(messages.allUuids);
  if (
    headUuid === undefined || segmentAnchorUuid === undefined || tailUuid === undefined ||
    messagesAnchorUuid === undefined || preservedUuids === undefined || allUuids === undefined ||
    segmentAnchorUuid !== messagesAnchorUuid || headUuid !== preservedUuids[0] ||
    tailUuid !== preservedUuids.at(-1) ||
    !orderedUuidSubset(preservedUuids, allUuids)
  ) return undefined;
  return {
    uuid: recordUuid,
    parentUuid,
    logicalParentUuid,
    anchorUuid: segmentAnchorUuid,
    preservedUuids,
    allTailUuid: allUuids.at(-1)!,
    nondurablePreservedMessages: allUuids.length - preservedUuids.length,
    messagesSummarized: metadata.messagesSummarized as number,
    ...(typeof metadata.userContext === "string" ? { userContext: metadata.userContext } : {}),
  };
}

function fullCompactBoundary(record: Record<string, unknown>, recordUuid: string | undefined): boolean {
  const parentUuid = canonicalRecordUuid(record.parentUuid);
  const metadata = objectValue(record.compactMetadata);
  if (
    recordUuid === undefined || parentUuid === undefined ||
    canonicalRecordUuid(record.logicalParentUuid) !== parentUuid ||
    record.isMeta === true || metadata === undefined ||
    (metadata.trigger !== "manual" && metadata.trigger !== "auto") ||
    !nonnegativeInteger(metadata.preTokens) ||
    metadata.preservedSegment !== undefined || metadata.preservedMessages !== undefined
  ) return false;
  if (metadata.postTokens !== undefined && !nonnegativeInteger(metadata.postTokens)) return false;
  if (metadata.durationMs !== undefined && !nonnegativeInteger(metadata.durationMs)) return false;
  if (metadata.messagesSummarized !== undefined && !nonnegativeInteger(metadata.messagesSummarized)) return false;
  if (metadata.userContext !== undefined && typeof metadata.userContext !== "string") return false;
  return Object.values(metadata).every((value) =>
    value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean");
}

function fullCompactSummary(
  record: Record<string, unknown>,
  recordUuid: string | undefined,
  boundary: PendingCompactBoundary | undefined,
): boolean {
  const message = objectValue(record.message);
  return boundary?.fullValid === true && recordUuid !== undefined &&
    canonicalRecordUuid(record.parentUuid) === boundary.uuid &&
    record.isMeta !== true && record.isVisibleInTranscriptOnly === true &&
    message?.role === "user" && typeof message.content === "string" && message.content.trim() !== "";
}

function partialCompactSummaryKind(
  record: Record<string, unknown>,
  recordUuid: string | undefined,
  boundary: PendingCompactBoundary | undefined,
): PartialCompactKind | undefined {
  const partial = boundary?.partial;
  const message = objectValue(record.message);
  const metadata = objectValue(record.summarizeMetadata);
  if (
    partial === undefined || recordUuid === undefined ||
    canonicalRecordUuid(record.parentUuid) !== partial.uuid || record.isMeta === true ||
    record.isVisibleInTranscriptOnly === true || message?.role !== "user" ||
    typeof message.content !== "string" || message.content.trim() === "" || metadata === undefined ||
    !hasOnlyFields(metadata, ["messagesSummarized", "userContext", "direction"]) ||
    (metadata.direction !== "up_to" && metadata.direction !== "from") ||
    metadata.messagesSummarized !== partial.messagesSummarized ||
    (metadata.userContext !== undefined && typeof metadata.userContext !== "string") ||
    metadata.userContext !== partial.userContext
  ) return undefined;
  if (metadata.direction === "up_to") {
    return recordUuid === partial.anchorUuid ? "partial_up_to" : undefined;
  }
  return partial.uuid === partial.anchorUuid ? "partial_from" : undefined;
}

function plainPortableMessage(item: ConversationItem): item is ConversationMessage {
  return item.kind === "message" && (item.role === "user" || item.role === "assistant") &&
    item.text.trim() !== "" && (item.contentKinds?.length ?? 0) !== 0 &&
    item.contentKinds!.every((kind) => kind === "text") &&
    (item.portableBlocks?.length ?? 0) !== 0 &&
    item.portableBlocks!.every((block) => block.kind === "text");
}

interface ResolvedPartialCheckpointGraph {
  readonly boundaryRecord: ClaudeGraphRecord;
  readonly headRecord: ClaudeGraphRecord;
  readonly preservedConversationIndexes: readonly number[];
  readonly firstRecordAfterSummary?: ClaudeGraphRecord;
}

function resolvePartialCheckpointGraph(
  checkpoint: PartialCompactCheckpoint,
  graph: ReadonlyMap<string, ClaudeGraphRecord>,
  conversationIndexes: ReadonlyMap<string, number>,
): ResolvedPartialCheckpointGraph | undefined {
  const boundaryRecord = graph.get(checkpoint.boundary.uuid);
  const summaryRecord = graph.get(checkpoint.summaryUuid);
  const headRecord = graph.get(checkpoint.boundary.preservedUuids[0]!);
  if (
    boundaryRecord === undefined || summaryRecord === undefined || headRecord === undefined ||
    boundaryRecord.parentUuid !== checkpoint.boundary.parentUuid ||
    boundaryRecord.recordNumber >= summaryRecord.recordNumber
  ) return undefined;

  const preservedConversationIndexes: number[] = [];
  let previousUuid: string | undefined;
  let previousRecordNumber = -1;
  let previousConversationIndex = -1;
  for (const uuid of checkpoint.boundary.preservedUuids) {
    const graphRecord = graph.get(uuid);
    const conversationIndex = conversationIndexes.get(uuid);
    if (
      graphRecord === undefined || (graphRecord.kind !== "user" && graphRecord.kind !== "assistant") ||
      graphRecord.recordNumber <= previousRecordNumber || graphRecord.recordNumber >= boundaryRecord.recordNumber ||
      conversationIndex === undefined || conversationIndex <= previousConversationIndex ||
      conversationIndex >= checkpoint.summaryIndex ||
      (previousUuid !== undefined && graphRecord.parentUuid !== previousUuid)
    ) return undefined;
    previousUuid = uuid;
    previousRecordNumber = graphRecord.recordNumber;
    previousConversationIndex = conversationIndex;
    preservedConversationIndexes.push(conversationIndex);
  }

  let firstRecordAfterSummary: ClaudeGraphRecord | undefined;
  for (const graphRecord of graph.values()) {
    if (graphRecord.recordNumber > summaryRecord.recordNumber) {
      firstRecordAfterSummary = graphRecord;
      break;
    }
  }
  return {
    boundaryRecord,
    headRecord,
    preservedConversationIndexes,
    ...(firstRecordAfterSummary === undefined ? {} : { firstRecordAfterSummary }),
  };
}

function summarizedSuffixReachesPreservedTail(
  checkpoint: PartialCompactCheckpoint,
  graph: ReadonlyMap<string, ClaudeGraphRecord>,
  boundaryRecord: ClaudeGraphRecord,
): boolean {
  const tailUuid = checkpoint.boundary.preservedUuids.at(-1)!;
  let currentUuid = checkpoint.boundary.parentUuid;
  let summarizedGraphRecords = 0;
  while (currentUuid !== tailUuid) {
    const current = graph.get(currentUuid);
    if (
      current === undefined || current.recordNumber >= boundaryRecord.recordNumber ||
      current.parentUuid === null
    ) return false;
    summarizedGraphRecords++;
    if (summarizedGraphRecords > checkpoint.boundary.messagesSummarized) return false;
    currentUuid = current.parentUuid;
  }
  return summarizedGraphRecords !== 0;
}

function materializablePartialCheckpoint(
  checkpoint: PartialCompactCheckpoint,
  graph: ReadonlyMap<string, ClaudeGraphRecord>,
  conversationIndexes: ReadonlyMap<string, number>,
): MaterializableCompactCheckpoint | undefined {
  const resolved = resolvePartialCheckpointGraph(checkpoint, graph, conversationIndexes);
  if (resolved === undefined) return undefined;
  let expectedGraphDiscontinuities = 0;
  if (checkpoint.kind === "partial_up_to") {
    const logicalParent = graph.get(checkpoint.boundary.logicalParentUuid);
    if (
      logicalParent === undefined ||
      checkpoint.boundary.parentUuid !== checkpoint.boundary.preservedUuids.at(-1) ||
      resolved.headRecord.parentUuid !== checkpoint.boundary.logicalParentUuid ||
      logicalParent.recordNumber >= resolved.headRecord.recordNumber ||
      (resolved.firstRecordAfterSummary !== undefined &&
        resolved.firstRecordAfterSummary.parentUuid !== checkpoint.summaryUuid &&
        resolved.firstRecordAfterSummary.parentUuid !== checkpoint.boundary.parentUuid)
    ) return undefined;
    expectedGraphDiscontinuities =
      resolved.firstRecordAfterSummary?.parentUuid === checkpoint.boundary.parentUuid
      ? 1
      : 0;
  } else if (
    checkpoint.boundary.logicalParentUuid !== checkpoint.boundary.preservedUuids.at(-1) ||
    checkpoint.boundary.allTailUuid !== checkpoint.boundary.logicalParentUuid ||
    !summarizedSuffixReachesPreservedTail(checkpoint, graph, resolved.boundaryRecord) ||
    (resolved.firstRecordAfterSummary !== undefined &&
      resolved.firstRecordAfterSummary.parentUuid !== checkpoint.summaryUuid)
  ) return undefined;
  return {
    kind: checkpoint.kind,
    summaryIndex: checkpoint.summaryIndex,
    preservedConversationIndexes: resolved.preservedConversationIndexes,
    expectedGraphDiscontinuities,
    preservedUuids: checkpoint.boundary.preservedUuids,
    nondurablePreservedMessages: checkpoint.boundary.nondurablePreservedMessages,
  };
}

function materializeCompactConversation(
  conversation: readonly ConversationItem[],
  checkpoint: MaterializableCompactCheckpoint,
): ConversationItem[] {
  const summary = conversation[checkpoint.summaryIndex];
  if (
    summary?.kind !== "message" || summary.role !== "system" || summary.text.trim() === "" ||
    summary.contentKinds?.length !== 1 ||
    (summary.contentKinds[0] !== "compact_summary" && summary.contentKinds[0] !== "api_compaction_summary")
  ) throw new Error("Claude compaction checkpoint does not reference its projected summary");
  const summaryMessage: ConversationMessage = {
    kind: "message",
    role: "user",
    text: summary.text,
    timestamp: summary.timestamp,
    contentKinds: ["text"],
    portableBlocks: [{ kind: "text", text: summary.text }],
    portableNotes: [CLAUDE_COMPACTION_SUMMARY_NOTE],
  };
  const preserved = checkpoint.preservedConversationIndexes.map((index): ConversationMessage => {
    const item = conversation[index]!;
    if (!plainPortableMessage(item)) {
      throw new Error("Claude partial compaction checkpoint references non-portable preserved history");
    }
    if (checkpoint.kind === "partial_from") return item;
    return {
      ...item,
      timestamp: summary.timestamp,
      portableNotes: [
        ...(item.portableNotes ?? []),
        "claude.compaction_preserved_timestamp.rebased",
      ],
    };
  });
  const activeSuffix = conversation.slice(checkpoint.summaryIndex + 1);
  return checkpoint.kind === "partial_from"
    ? [...preserved, summaryMessage, ...activeSuffix]
    : [summaryMessage, ...preserved, ...activeSuffix];
}

interface MaterializedContentReplacements {
  readonly conversation: readonly ConversationItem[];
  readonly applied: number;
  readonly inactive: number;
  readonly unsupported: number;
}

interface ClaudeMessageRetractionSignal {
  readonly replacementUuid: string;
  readonly supersededUuids: readonly string[];
}

interface MaterializedMessageRetractions {
  readonly conversation: readonly ConversationItem[];
  readonly applied: number;
  readonly unsupported: number;
}

function sameUuidSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((uuid, index) => uuid === right[index]);
}

function materializeMessageRetractions(
  conversation: readonly ConversationItem[],
  sourceUuids: readonly ReadonlySet<string>[],
  episodes: readonly ClaudeMessageRetractionSignal[],
  initialUnsupported: number,
  compactionMaterialized: boolean,
): MaterializedMessageRetractions {
  let unsupported = initialUnsupported;
  if (episodes.length === 0) {
    return { conversation, applied: 0, unsupported };
  }
  if (compactionMaterialized || sourceUuids.length !== conversation.length) {
    return {
      conversation,
      applied: 0,
      unsupported: unsupported + episodes.length,
    };
  }

  const indexesByUuid = new Map<string, number[]>();
  sourceUuids.forEach((uuids, index) => {
    for (const uuid of uuids) {
      const indexes = indexesByUuid.get(uuid) ?? [];
      indexes.push(index);
      indexesByUuid.set(uuid, indexes);
    }
  });
  const removedIndexes = new Set<number>();
  let applied = 0;
  for (const episode of episodes) {
    const replacementIndexes = indexesByUuid.get(episode.replacementUuid) ?? [];
    const superseded = new Set(episode.supersededUuids);
    const episodeIndexes = new Set<number>();
    let valid = replacementIndexes.length === 1;
    for (const uuid of episode.supersededUuids) {
      const indexes = indexesByUuid.get(uuid) ?? [];
      if (indexes.length !== 1) valid = false;
      else episodeIndexes.add(indexes[0]!);
    }
    const replacementIndex = replacementIndexes[0];
    for (const index of episodeIndexes) {
      const item = conversation[index];
      const sources = sourceUuids[index]!;
      if (
        item?.kind !== "message" || item.role !== "assistant" || sources.size === 0 ||
        [...sources].some((uuid) => !superseded.has(uuid)) ||
        replacementIndex === undefined || index >= replacementIndex || removedIndexes.has(index)
      ) valid = false;
    }
    const replacement = replacementIndex === undefined ? undefined : conversation[replacementIndex];
    const replacementSources = replacementIndex === undefined ? undefined : sourceUuids[replacementIndex];
    if (
      replacement?.kind !== "message" || replacement.role !== "assistant" ||
      replacementSources?.size !== 1 || !replacementSources.has(episode.replacementUuid) ||
      episodeIndexes.size === 0
    ) valid = false;
    if (!valid) {
      unsupported++;
      continue;
    }
    for (const index of episodeIndexes) removedIndexes.add(index);
    applied++;
  }
  return {
    conversation: conversation.filter((_item, index) => !removedIndexes.has(index)),
    applied,
    unsupported,
  };
}

function replaceableHistoricalToolResult(tool: HistoricalToolEvidence): boolean {
  if (
    tool.phase !== "result" || (tool.resources?.length ?? 0) !== 0 ||
    (tool.references?.length ?? 0) !== 0
  ) return false;
  const value = tool.error === undefined ? tool.output : tool.error;
  if (typeof value === "string") return value !== "";
  if (!Array.isArray(value) || value.length === 0) return false;
  let textBytes = 0;
  for (const raw of value) {
    const block = objectValue(raw);
    if (
      block === undefined || !hasOnlyFields(block, ["type", "text"]) ||
      block.type !== "text" || typeof block.text !== "string"
    ) return false;
    textBytes += Buffer.byteLength(block.text, "utf8");
  }
  return textBytes !== 0;
}

function historicalToolResultBlocks(
  conversation: readonly ConversationItem[],
): ReadonlyMap<string, readonly Extract<PortableContextBlock, { readonly kind: "historical_tool" }>[]> {
  const results = new Map<
    string,
    Array<Extract<PortableContextBlock, { readonly kind: "historical_tool" }>>
  >();
  for (const item of conversation) {
    if (item.kind !== "message") continue;
    for (const block of item.portableBlocks ?? []) {
      if (block.kind !== "historical_tool" || block.tool.phase !== "result") continue;
      const matches = results.get(block.tool.callId) ?? [];
      matches.push(block);
      results.set(block.tool.callId, matches);
    }
  }
  return results;
}

function materializeContentReplacements(
  fullConversation: readonly ConversationItem[],
  activeConversation: readonly ConversationItem[],
  replacements: ReadonlyMap<string, ClaudeContentReplacement>,
  inactiveHistoryMaterialized: boolean,
): MaterializedContentReplacements {
  const allResults = historicalToolResultBlocks(fullConversation);
  const activeResults = historicalToolResultBlocks(activeConversation);
  const applicable = new Map<string, ClaudeContentReplacement>();
  let inactive = 0;
  let unsupported = 0;
  for (const [callId, replacement] of replacements) {
    const all = allResults.get(callId) ?? [];
    const active = activeResults.get(callId) ?? [];
    if (all.length !== 1 || !replaceableHistoricalToolResult(all[0]!.tool)) {
      unsupported++;
    } else if (active.length === 0 && inactiveHistoryMaterialized) {
      inactive++;
    } else if (active.length !== 1 || !replaceableHistoricalToolResult(active[0]!.tool)) {
      unsupported++;
    } else {
      applicable.set(callId, replacement);
    }
  }

  const applied = new Set<string>();
  const conversation = activeConversation.map((item): ConversationItem => {
    if (item.kind !== "message" || item.portableBlocks === undefined) return item;
    let text = item.text;
    let changed = false;
    const notes = [...(item.portableNotes ?? [])];
    const portableBlocks = item.portableBlocks.map((block): PortableContextBlock => {
      if (block.kind !== "historical_tool" || block.tool.phase !== "result") return block;
      const replacement = applicable.get(block.tool.callId);
      if (replacement === undefined || applied.has(block.tool.callId)) return block;
      const before = visibleTool(block);
      const offset = text.indexOf(before);
      if (offset < 0 || text.indexOf(before, offset + before.length) >= 0) return block;
      const next: Extract<PortableContextBlock, { readonly kind: "historical_tool" }> = {
        ...block,
        tool: block.tool.error === undefined
          ? { ...block.tool, output: replacement.replacement }
          : { ...block.tool, error: replacement.replacement },
      };
      text = `${text.slice(0, offset)}${visibleTool(next)}${text.slice(offset + before.length)}`;
      changed = true;
      applied.add(block.tool.callId);
      notes.push(CLAUDE_CONTENT_REPLACEMENT_NOTE);
      return next;
    });
    return changed ? { ...item, text, portableBlocks, portableNotes: notes } : item;
  });
  unsupported += applicable.size - applied.size;
  return { conversation, applied: applied.size, inactive, unsupported };
}

function portableResourceKeys(conversation: readonly ConversationItem[]): Set<string> {
  const keys = new Set<string>();
  for (const item of conversation) {
    if (item.kind !== "message") continue;
    for (const block of item.portableBlocks ?? []) {
      const resources = block.kind === "historical_resource"
        ? [block.resource]
        : block.kind === "historical_tool"
          ? block.tool.resources ?? []
          : [];
      for (const resource of resources) keys.add(`${resource.sha256}\0${resource.relativePath}`);
    }
  }
  return keys;
}

interface PendingClaudeToolCall {
  readonly recordUuid: string;
  readonly tool: HistoricalToolEvidence;
  readonly resultParentUuids: Set<string>;
  structuredOutput?: {
    readonly recordUuid: string;
    readonly data: PortableContextJson;
  };
}

function verifiedStructuredOutputResult(
  nativeResult: unknown,
  projectedOutput: PortableContextJson | undefined,
  expected: PortableContextJson,
): boolean {
  const result = objectValue(nativeResult);
  return projectedOutput === CLAUDE_STRUCTURED_OUTPUT_RESULT && result !== undefined &&
    hasOnlyFields(result, ["data", "structured_output"]) &&
    result.data === CLAUDE_STRUCTURED_OUTPUT_RESULT &&
    isDeepStrictEqual(result.structured_output, expected);
}

interface PendingClaudeReadPdf {
  readonly resultRecordUuid: string;
  readonly resultBlock: Extract<PortableContextBlock, { readonly kind: "historical_tool" }>;
  readonly blockPosition: number;
  readonly resource: ManagedResourceObject;
}

export async function parseClaudeTranscript(
  filePath: string,
  sessionCandidate: string,
  fallbackTimestamp: string,
): Promise<ParsedClaudeTranscript> {
  const nativeId = canonicalClaudeUuid(sessionCandidate);
  const conversation: ConversationItem[] = [];
  const conversationSourceUuids: Set<string>[] = [];
  const graph = new Map<string, ClaudeGraphRecord>();
  const portableConversationIndexes = new Map<string, number>();
  const portableUserMessageUuids = new Set<string>();
  const compactCheckpoints: CompactCheckpoint[] = [];
  const apiCompactCheckpoints: ApiCompactCheckpoint[] = [];
  const roots: string[] = [];
  const observedCwds = new Set<string>();
  const observedRelocatedCwds = new Set<string>();
  const observedVersions = new Set<string>();
  const warnings = new Set<string>();
  const identityFailures = new Set<string>();
  let firstUser = "";
  let customTitle = "";
  let generatedTitle = "";
  let model = "";
  let createdMillis = Number.POSITIVE_INFINITY;
  let updatedMillis = Number.NEGATIVE_INFINITY;
  let recordCount = 0;
  let sessionTitleRecordCount = 0;
  let sessionSummaryRecordCount = 0;
  let lastPromptRecordCount = 0;
  let queueOperationRecordCount = 0;
  let sessionEndRecordCount = 0;
  let fileCheckpointRecordCount = 0;
  let worktreeStateRecordCount = 0;
  let permissionModeRecordCount = 0;
  let relocatedRecordCount = 0;
  let agentDisplayRecordCount = 0;
  let agentSettingRecordCount = 0;
  let sessionModeRecordCount = 0;
  let isolationLatchRecordCount = 0;
  let sessionTagRecordCount = 0;
  let pullRequestLinkRecordCount = 0;
  let frameLinkRecordCount = 0;
  let bridgeSessionRecordCount = 0;
  let historySuppressionRecordCount = 0;
  let observerRefRecordCount = 0;
  let contentReplacementRecordCount = 0;
  let contentReplacementItemCount = 0;
  let unknownNonGraphRecordCount = 0;
  let graphDiscontinuities = 0;
  let toolResultGraphReturns = 0;
  let nonMessageGraphRecords = 0;
  let portableGraphDiscontinuities = 0;
  let portableToolResultGraphReturns = 0;
  let portableNonMessageGraphRecords = 0;
  let modelRefusalFallbackRecordCount = 0;
  let portableModelRefusalFallbackRecordCount = 0;
  let turnDurationRecordCount = 0;
  let portableTurnDurationRecordCount = 0;
  let postToolUseHookRecordCount = 0;
  let portablePostToolUseHookRecordCount = 0;
  let stopHookRecordCount = 0;
  let portableStopHookRecordCount = 0;
  let hookProgressRecordCount = 0;
  let portableHookProgressRecordCount = 0;
  let hookNonBlockingErrorRecordCount = 0;
  let portableHookNonBlockingErrorRecordCount = 0;
  let hookExecutionErrorRecordCount = 0;
  let portableHookExecutionErrorRecordCount = 0;
  let hookCancelledRecordCount = 0;
  let portableHookCancelledRecordCount = 0;
  let hookPermissionDecisionRecordCount = 0;
  let portableHookPermissionDecisionRecordCount = 0;
  let structuredOutputRecordCount = 0;
  let portableStructuredOutputRecordCount = 0;
  let hookSystemMessageRecordCount = 0;
  let portableHookSystemMessageRecordCount = 0;
  let awaySummaryRecordCount = 0;
  let portableAwaySummaryRecordCount = 0;
  let emptyTaskReminderRecordCount = 0;
  let portableEmptyTaskReminderRecordCount = 0;
  let taskReminderRecordCount = 0;
  let portableTaskReminderRecordCount = 0;
  let taskReminderItemCount = 0;
  let portableTaskReminderItemCount = 0;
  let taskReminderDetailItemCount = 0;
  let portableTaskReminderDetailItemCount = 0;
  let todoReminderRecordCount = 0;
  let portableTodoReminderRecordCount = 0;
  let todoReminderItemCount = 0;
  let portableTodoReminderItemCount = 0;
  let todoReminderDetailItemCount = 0;
  let portableTodoReminderDetailItemCount = 0;
  let queuedCommandRecordCount = 0;
  let portableQueuedCommandRecordCount = 0;
  let agentListingDeltaRecordCount = 0;
  let portableAgentListingDeltaRecordCount = 0;
  let skillListingRecordCount = 0;
  let portableSkillListingRecordCount = 0;
  let criticalSystemReminderRecordCount = 0;
  let portableCriticalSystemReminderRecordCount = 0;
  let nestedMemoryRecordCount = 0;
  let portableNestedMemoryRecordCount = 0;
  let relevantMemoryRecordCount = 0;
  let portableRelevantMemoryRecordCount = 0;
  let relevantMemoryItemCount = 0;
  let portableRelevantMemoryItemCount = 0;
  let ambientUserContextRecordCount = 0;
  let portableAmbientUserContextRecordCount = 0;
  let editedImageRecordCount = 0;
  let portableEditedImageRecordCount = 0;
  let tokenUsageRecordCount = 0;
  let portableTokenUsageRecordCount = 0;
  let totalTokensReminderRecordCount = 0;
  let portableTotalTokensReminderRecordCount = 0;
  let budgetUsdRecordCount = 0;
  let portableBudgetUsdRecordCount = 0;
  let toolSearchUsageReminderRecordCount = 0;
  let portableToolSearchUsageReminderRecordCount = 0;
  let mcpInstructionsDeltaRecordCount = 0;
  let portableMcpInstructionsDeltaRecordCount = 0;
  let mcpDroppedToolsDeltaRecordCount = 0;
  let portableMcpDroppedToolsDeltaRecordCount = 0;
  let deferredToolsDeltaRecordCount = 0;
  let portableDeferredToolsDeltaRecordCount = 0;
  let commandPermissionsRecordCount = 0;
  let portableCommandPermissionsRecordCount = 0;
  let hookContextCarrierRecordCount = 0;
  let portableHookContextCarrierRecordCount = 0;
  let hookAdditionalContextRecordCount = 0;
  let portableHookAdditionalContextRecordCount = 0;
  let hookAdditionalContextValueCount = 0;
  let portableHookAdditionalContextValueCount = 0;
  let asyncHookContextRecordCount = 0;
  let portableAsyncHookContextRecordCount = 0;
  let backgroundAgentRetryRecordCount = 0;
  let portableBackgroundAgentRetryRecordCount = 0;
  let backgroundAgentPeerMessageRecordCount = 0;
  let portableBackgroundAgentPeerMessageRecordCount = 0;
  let backgroundAgentNotificationRecordCount = 0;
  let portableBackgroundAgentNotificationRecordCount = 0;
  let compactBoundaryCount = 0;
  let compactSummaryCount = 0;
  let apiCompactionBlockCount = 0;
  let compactionShapeValid = true;
  let pendingCompactBoundary: PendingCompactBoundary | undefined;
  let previousGraphUuid: string | undefined;
  const portableObservedCwds = new Set<string>();
  const portableObservedVersions = new Set<string>();
  const pendingBlocks: PortableContextBlock[] = [];
  const pendingKinds: string[] = [];
  const pendingNotes: string[] = [];
  const pendingText: string[] = [];
  const pendingSourceUuids = new Set<string>();
  const openToolCalls = new Map<string, PendingClaudeToolCall>();
  const openServerCalls = new Map<string, HistoricalToolEvidence>();
  let pendingServerPauseRecordUuid: string | undefined;
  const backgroundAgentLaunchesByAgentId = new Map<string, ClaudeBackgroundAgentLaunch>();
  const backgroundAgentLaunchesByResultUuid = new Map<string, ClaudeBackgroundAgentLaunch>();
  const postToolUseHookCandidates = new Set<string>();
  let pendingStopHook: PendingStopHookRecord | undefined;
  let pendingHookProgress: (HookProgressRecord & { readonly uuid: string }) | undefined;
  let pendingSessionStartSystemMessageCarrier: PendingSessionStartSystemMessageCarrier | undefined;
  let pendingTurnDurationUuid: string | undefined;
  let pendingProjectedHookContexts: readonly ProjectedHookContextCarrier[] = [];
  const managedResources = new Map<string, ManagedResourceObject>();
  let pendingReadPdf: PendingClaudeReadPdf | undefined;
  let pendingTimestamp = "";
  let pendingModel = "";
  let latestObservedCwd = "";
  let relocatedCwd = "";
  let sessionMode: "" | "normal" | "coordinator" = "";
  let currentPullRequestLink: ConversationMessage | undefined;
  const currentArtifactLinks = new Map<string, ConversationMessage>();
  const announcedMcpInstructionServers = new Set<string>();
  const announcedMcpDroppedToolEntries = new Set<string>();
  const loadedNestedMemoryPaths = new Set<string>();
  const surfacedRelevantMemoryPaths = new Set<string>();
  const currentContentReplacements = new Map<string, ClaudeContentReplacement>();
  const pendingRetractionSignals = new Map<string, ClaudeMessageRetractionSignal>();
  const messageRetractionEpisodes: ClaudeMessageRetractionSignal[] = [];
  let unsupportedMessageRetractions = 0;

  const pushConversation = (
    item: ConversationItem,
    sourceUuids: Iterable<string> = [],
  ): void => {
    conversation.push(item);
    conversationSourceUuids.push(new Set(sourceUuids));
  };
  const appendPending = (message: ConversationMessage, sourceUuid?: string): void => {
    pendingBlocks.push(...(message.portableBlocks ?? []));
    pendingKinds.push(...(message.contentKinds ?? []));
    pendingNotes.push(...(message.portableNotes ?? []));
    if (message.text !== "") pendingText.push(message.text);
    pendingTimestamp = message.timestamp;
    pendingModel = message.model ?? pendingModel;
    if (sourceUuid !== undefined) pendingSourceUuids.add(sourceUuid);
  };
  const flushPending = (): void => {
    if (pendingKinds.length === 0 && pendingBlocks.length === 0 && pendingText.length === 0) return;
    if (pendingServerPauseRecordUuid !== undefined) pendingNotes.push("claude.tool_relation.invalid");
    pushConversation({
      kind: "message",
      role: "assistant",
      text: pendingText.join("\n\n"),
      timestamp: pendingTimestamp,
      contentKinds: [...pendingKinds],
      portableBlocks: [...pendingBlocks],
      portableNotes: [...pendingNotes],
      ...(pendingModel === "" ? {} : { model: pendingModel }),
    }, pendingSourceUuids);
    pendingBlocks.length = 0;
    pendingKinds.length = 0;
    pendingNotes.length = 0;
    pendingText.length = 0;
    pendingSourceUuids.clear();
    openToolCalls.clear();
    openServerCalls.clear();
    pendingServerPauseRecordUuid = undefined;
    pendingTimestamp = "";
    pendingModel = "";
  };
  const resetPortableCompactionState = (record: Record<string, unknown>): void => {
    portableGraphDiscontinuities = 0;
    portableToolResultGraphReturns = 0;
    portableNonMessageGraphRecords = 0;
    portableModelRefusalFallbackRecordCount = 0;
    portableTurnDurationRecordCount = 0;
    portablePostToolUseHookRecordCount = 0;
    portableStopHookRecordCount = 0;
    portableHookProgressRecordCount = 0;
    portableHookNonBlockingErrorRecordCount = 0;
    portableHookExecutionErrorRecordCount = 0;
    portableHookCancelledRecordCount = 0;
    portableHookPermissionDecisionRecordCount = 0;
    portableStructuredOutputRecordCount = 0;
    portableHookSystemMessageRecordCount = 0;
    portableAwaySummaryRecordCount = 0;
    portableEmptyTaskReminderRecordCount = 0;
    portableTaskReminderRecordCount = 0;
    portableTaskReminderItemCount = 0;
    portableTaskReminderDetailItemCount = 0;
    portableTodoReminderRecordCount = 0;
    portableTodoReminderItemCount = 0;
    portableTodoReminderDetailItemCount = 0;
    portableQueuedCommandRecordCount = 0;
    portableAgentListingDeltaRecordCount = 0;
    portableSkillListingRecordCount = 0;
    portableCriticalSystemReminderRecordCount = 0;
    portableNestedMemoryRecordCount = 0;
    portableRelevantMemoryRecordCount = 0;
    portableRelevantMemoryItemCount = 0;
    portableAmbientUserContextRecordCount = 0;
    portableEditedImageRecordCount = 0;
    portableTokenUsageRecordCount = 0;
    portableTotalTokensReminderRecordCount = 0;
    portableBudgetUsdRecordCount = 0;
    portableToolSearchUsageReminderRecordCount = 0;
    portableMcpInstructionsDeltaRecordCount = 0;
    portableMcpDroppedToolsDeltaRecordCount = 0;
    portableDeferredToolsDeltaRecordCount = 0;
    portableCommandPermissionsRecordCount = 0;
    portableHookContextCarrierRecordCount = 0;
    portableHookAdditionalContextRecordCount = 0;
    portableHookAdditionalContextValueCount = 0;
    portableAsyncHookContextRecordCount = 0;
    portableBackgroundAgentRetryRecordCount = 0;
    portableBackgroundAgentPeerMessageRecordCount = 0;
    portableBackgroundAgentNotificationRecordCount = 0;
    loadedNestedMemoryPaths.clear();
    surfacedRelevantMemoryPaths.clear();
    portableObservedCwds.clear();
    portableObservedVersions.clear();
    if (typeof record.cwd === "string" && path.isAbsolute(record.cwd)) {
      portableObservedCwds.add(path.normalize(record.cwd));
    }
    if (typeof record.version === "string" && record.version !== "") {
      portableObservedVersions.add(record.version);
    }
  };

  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const eligiblePostToolUseHookCandidates = new Set(postToolUseHookCandidates);
      postToolUseHookCandidates.clear();
      const eligibleStopHook = pendingStopHook;
      pendingStopHook = undefined;
      const eligibleHookProgress = pendingHookProgress;
      pendingHookProgress = undefined;
      const eligibleSessionStartSystemMessageCarrier = pendingSessionStartSystemMessageCarrier;
      pendingSessionStartSystemMessageCarrier = undefined;
      const eligibleTurnDurationUuid = pendingTurnDurationUuid;
      pendingTurnDurationUuid = undefined;
      const eligibleProjectedHookContexts = pendingProjectedHookContexts;
      pendingProjectedHookContexts = [];
      recordCount++;
      if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
        identityFailures.add("record_too_large");
        continue;
      }
      if (line === "") {
        warnings.add("empty_record");
        continue;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch {
        identityFailures.add("invalid_json");
        continue;
      }
      const record = objectValue(parsed);
      if (record === undefined) {
        identityFailures.add("record_not_object");
        continue;
      }
      const kind = typeof record.type === "string" ? record.type : "";
      const titleRecord = sessionTitleRecord(record);
      const skippedSessionSummary = skippableSessionSummaryRecord(record, graph);
      const skippedLastPrompt = skippableLastPromptRecord(record, previousGraphUuid);
      const skippedQueueOperation = skippableQueueOperationRecord(record);
      const skippedSessionEnd = skippableSessionEndRecord(record);
      const fileCheckpointRecord = kind === "file-history-snapshot" || kind === "file-history-delta";
      const worktreeStateRecord = verifiedClaudeWorktreeStateRecord(record, nativeId);
      const permissionModeRecord = verifiedClaudePermissionModeRecord(record, nativeId);
      const relocatedRecord = verifiedClaudeRelocatedRecord(record, nativeId);
      const agentNameRecord = verifiedClaudeStringStateRecord(
        record,
        nativeId,
        "agent-name",
        "agentName",
        safeClaudeDisplayValue,
      );
      const agentColorRecord = verifiedClaudeStringStateRecord(
        record,
        nativeId,
        "agent-color",
        "agentColor",
        safeClaudeDisplayValue,
      );
      const agentSettingRecord = verifiedClaudeStringStateRecord(
        record,
        nativeId,
        "agent-setting",
        "agentSetting",
        safeClaudeDisplayValue,
      );
      const sessionModeRecord = verifiedClaudeStringStateRecord(
        record,
        nativeId,
        "mode",
        "mode",
        (value) => CLAUDE_SESSION_MODES.has(value),
      );
      const isolationLatchRecord = verifiedClaudeStringStateRecord(
        record,
        nativeId,
        "isolation-latch",
        "side",
        (value) => CLAUDE_ISOLATION_LATCH_SIDES.has(value),
      );
      const sessionTagRecord = verifiedClaudeSessionTagRecord(record, nativeId);
      const pullRequestLink = sessionPullRequestRecord(record, nativeId);
      const artifactLink = sessionArtifactRecord(record, nativeId);
      const bridgeSessionRecord = verifiedClaudeBridgeSessionRecord(record, nativeId);
      const historySuppressionRecord = verifiedClaudeHistorySuppressionRecord(record, nativeId);
      const observerRefRecord = verifiedClaudeObserverRefRecord(record);
      const contentReplacementRecord = kind === "content-replacement"
        ? claudeContentReplacementRecord(record, nativeId)
        : undefined;
      const mainContentReplacementRecord = contentReplacementRecord?.agentId === undefined
        ? contentReplacementRecord
        : undefined;
      const compactBoundary = kind === "system" && record.subtype === "compact_boundary";
      const compactSummary = kind === "user" && record.isCompactSummary === true;
      const skippedTurnDuration = skippableTurnDurationRecord(record);
      const skippedAwaySummary = skippableAwaySummaryRecord(record, eligibleTurnDurationUuid);
      const skippedEmptyTaskReminder = skippableEmptyTaskReminderRecord(record);
      const workReminder = workReminderRecord(record);
      const skippedQueuedCommand = skippableQueuedCommandRecord(record);
      const skippedAgentListingDelta = skippableAgentListingDeltaRecord(record);
      const skillListing = skillListingRecord(record);
      const criticalSystemReminder = criticalSystemReminderRecord(record);
      const nestedMemory = nestedMemoryRecord(record);
      const relevantMemories = relevantMemoriesRecord(record);
      const ambientUserContext = claudeAmbientUserContextRecord(record);
      const editedImage = skippableClaudeEditedImageRecord(record);
      const runtimeUsageReminder = runtimeUsageReminderRecord(record);
      const toolSearchUsageReminder = skippableToolSearchUsageReminderRecord(record);
      const mcpInstructionsDelta = mcpInstructionsDeltaRecord(record);
      const mcpDroppedToolsDelta = mcpDroppedToolsDeltaRecord(record);
      const deferredToolsDelta = skippableDeferredToolsDeltaRecord(record);
      const commandPermissions = skippableCommandPermissionsRecord(record);
      const postToolUseHookId = skippablePostToolUseHookRecord(record);
      const skippedPostToolUseHook = postToolUseHookId !== undefined &&
        eligiblePostToolUseHookCandidates.delete(postToolUseHookId);
      const stopHook = skippableStopHookRecord(record);
      const skippedStopHookSummary = skippableStopHookSummary(record, eligibleStopHook);
      const skippedStopHook = stopHook !== undefined || skippedStopHookSummary;
      const hookProgress = skippableHookProgressRecord(record);
      const hookRuntime = skippableHookRuntimeRecord(record);
      const hookPermissionDecisionId = skippableHookPermissionDecisionRecord(record);
      const structuredOutputAttachment = structuredOutputAttachmentRecord(record);
      const structuredOutputRecordUuid = canonicalRecordUuid(record.uuid);
      const structuredOutputParent = canonicalRecordUuid(record.parentUuid);
      const structuredOutputCandidates = structuredOutputAttachment !== undefined &&
          structuredOutputRecordUuid !== undefined && structuredOutputParent !== undefined &&
          openToolCalls.size === 1 && openServerCalls.size === 0
        ? [...openToolCalls.values()].filter((call) =>
          call.recordUuid === structuredOutputParent && call.tool.name === "StructuredOutput" &&
          call.structuredOutput === undefined &&
          isDeepStrictEqual(call.tool.input, structuredOutputAttachment.data))
        : [];
      const projectedStructuredOutputCall = structuredOutputCandidates.length === 1
        ? structuredOutputCandidates[0]
        : undefined;
      const hookProgressParent = canonicalRecordUuid(record.parentUuid);
      const postToolUseCall = hookProgress?.hookEvent === "PostToolUse"
        ? openToolCalls.get(hookProgress.toolUseId)
        : undefined;
      const skippedHookProgress = hookProgress !== undefined && (
        hookProgress.hookEvent === "SessionStart"
          ? record.parentUuid === null && graph.size === 0
          : hookProgress.hookEvent === "PostToolUse"
            ? postToolUseCall !== undefined && (
              hookProgressParent === postToolUseCall.recordUuid ||
              eligibleHookProgress?.hookEvent === "PostToolUse" &&
              eligibleHookProgress.toolUseId === hookProgress.toolUseId &&
              hookProgressParent === eligibleHookProgress.uuid
            )
            : hookProgressParent !== undefined && hookProgressParent === previousGraphUuid &&
              graph.get(hookProgressParent)?.kind === "assistant" &&
              openToolCalls.size === 0 && openServerCalls.size === 0
      );
      const hookContextCarrier = modelContextHookCarrier(record);
      const hookAdditionalContext = hookAdditionalContextRecord(record);
      const asyncHookContext = asyncHookContextRecord(record);
      const backgroundRecordParent = canonicalRecordUuid(record.parentUuid);
      const backgroundRecordIsLinear = backgroundRecordParent !== undefined &&
        backgroundRecordParent === previousGraphUuid;
      const projectedBackgroundAgentRetry = backgroundRecordIsLinear
        ? backgroundAgentRetryRecord(record, backgroundAgentLaunchesByResultUuid)
        : undefined;
      const projectedBackgroundAgentPeer = backgroundRecordIsLinear &&
          graph.get(backgroundRecordParent!)?.kind === "assistant"
        ? backgroundAgentPeerRecord(record, backgroundAgentLaunchesByAgentId)
        : undefined;
      const projectedBackgroundAgentNotification = backgroundRecordIsLinear &&
          graph.get(backgroundRecordParent!)?.kind === "assistant"
        ? backgroundAgentNotificationRecord(record, backgroundAgentLaunchesByAgentId)
        : undefined;
      const systemMessageCarrier = sessionStartSystemMessageCarrier(record);
      const hookSystemMessage = sessionStartHookSystemMessage(record);
      const portableMetadataStateClosed = openToolCalls.size === 0 && openServerCalls.size === 0 &&
        pendingReadPdf === undefined;
      const refusalFallback = modelRefusalFallbackRecord(record);
      const refusalFallbackParent = canonicalRecordUuid(record.parentUuid);
      const retractionSignal = refusalFallbackParent === undefined
        ? undefined
        : pendingRetractionSignals.get(refusalFallbackParent);
      const closesMessageRetraction = refusalFallback !== undefined &&
        refusalFallback.retractedMessageUuids.length !== 0 && retractionSignal !== undefined &&
        sameUuidSequence(refusalFallback.retractedMessageUuids, retractionSignal.supersededUuids) &&
        refusalFallbackParent === retractionSignal.replacementUuid &&
        validRetractedTurnRecords(
          retractionSignal.supersededUuids,
          retractionSignal.replacementUuid,
          refusalFallback.refusedUserMessageUuid,
          graph,
          portableUserMessageUuids,
        );
      const skippedModelRefusalFallback = portableMetadataStateClosed && refusalFallback !== undefined &&
        refusalFallbackParent !== undefined && refusalFallbackParent === previousGraphUuid &&
        graph.get(refusalFallbackParent)?.kind === "assistant" &&
        graph.get(refusalFallbackParent)?.model === refusalFallback.fallbackModel &&
        nearestPortableUserAncestorMatches(
          refusalFallbackParent,
          refusalFallback.refusedUserMessageUuid,
          graph,
          portableUserMessageUuids,
        ) && (refusalFallback.retractedMessageUuids.length === 0 || closesMessageRetraction);
      const systemMessageParent = canonicalRecordUuid(record.parentUuid);
      const systemMessageCarrierMatchesProgress = systemMessageCarrier !== undefined &&
        eligibleHookProgress?.hookEvent === "SessionStart" &&
        systemMessageParent === eligibleHookProgress.uuid &&
        systemMessageCarrier.hookName === eligibleHookProgress.hookName &&
        systemMessageCarrier.toolUseId === eligibleHookProgress.toolUseId &&
        systemMessageCarrier.command === eligibleHookProgress.command;
      const skippedSystemMessageCarrier = portableMetadataStateClosed && systemMessageCarrier !== undefined && (
        (record.parentUuid === null && graph.size === 0) || systemMessageCarrierMatchesProgress
      );
      const skippedHookSystemMessage = portableMetadataStateClosed && hookSystemMessage !== undefined &&
        eligibleSessionStartSystemMessageCarrier !== undefined &&
        systemMessageParent === eligibleSessionStartSystemMessageCarrier.uuid &&
        hookSystemMessage.hookName === eligibleSessionStartSystemMessageCarrier.hookName &&
        hookSystemMessage.toolUseId === eligibleSessionStartSystemMessageCarrier.toolUseId &&
        hookSystemMessage.content === eligibleSessionStartSystemMessageCarrier.systemMessage;
      const hookContextParent = canonicalRecordUuid(record.parentUuid);
      const hookContextMatchesCarriers = hookAdditionalContext !== undefined &&
        eligibleProjectedHookContexts.length !== 0 &&
        hookContextParent === eligibleProjectedHookContexts.at(-1)!.uuid &&
        eligibleProjectedHookContexts.length <= hookAdditionalContext.contexts.length &&
        eligibleProjectedHookContexts.every((carrier, index) =>
          carrier.hookEvent === hookAdditionalContext.hookEvent &&
          carrier.context === hookAdditionalContext.contexts[index]);
      const projectedHookContextCarrier = portableMetadataStateClosed ? hookContextCarrier : undefined;
      const projectedHookAdditionalContext = portableMetadataStateClosed && hookAdditionalContext !== undefined &&
          (eligibleProjectedHookContexts.length === 0 || hookContextMatchesCarriers)
        ? hookAdditionalContext
        : undefined;
      const asyncHookParent = canonicalRecordUuid(record.parentUuid);
      const projectedAsyncHookContext = portableMetadataStateClosed && asyncHookContext !== undefined &&
          asyncHookParent !== undefined && asyncHookParent === previousGraphUuid &&
          graph.get(asyncHookParent)?.kind === "user" && portableUserMessageUuids.has(asyncHookParent)
        ? asyncHookContext
        : undefined;
      const projectedSkillListing = portableMetadataStateClosed ? skillListing : undefined;
      const projectedCriticalSystemReminder = portableMetadataStateClosed
        ? criticalSystemReminder
        : undefined;
      const projectedNestedMemory = portableMetadataStateClosed && nestedMemory !== undefined &&
          !loadedNestedMemoryPaths.has(nestedMemory.path)
        ? nestedMemory
        : undefined;
      const projectedRelevantMemories = portableMetadataStateClosed && relevantMemories !== undefined &&
          relevantMemories.paths.every((memoryPath) => !surfacedRelevantMemoryPaths.has(memoryPath))
        ? relevantMemories
        : undefined;
      const projectedAmbientUserContext = portableMetadataStateClosed ? ambientUserContext : undefined;
      const skippedEditedImage = portableMetadataStateClosed && editedImage;
      const skippedRuntimeUsageReminder = portableMetadataStateClosed ? runtimeUsageReminder : undefined;
      const skippedToolSearchUsageReminder = portableMetadataStateClosed && toolSearchUsageReminder;
      const mcpInstructionsTransitionValid = mcpInstructionsDelta !== undefined &&
          mcpInstructionsDelta.addedNames.every((name) => !announcedMcpInstructionServers.has(name)) &&
          mcpInstructionsDelta.removedNames.every((name) => announcedMcpInstructionServers.has(name));
      const projectedMcpInstructionsDelta = portableMetadataStateClosed && mcpInstructionsTransitionValid
        ? mcpInstructionsDelta
        : undefined;
      const mcpDroppedToolsTransitionValid = mcpDroppedToolsDelta !== undefined &&
        mcpDroppedToolsDelta.every((entry) => !announcedMcpDroppedToolEntries.has(entry));
      const skippedMcpDroppedToolsDelta = portableMetadataStateClosed && mcpDroppedToolsTransitionValid;
      const projectedWorkReminderRecord = portableMetadataStateClosed ? workReminder : undefined;
      const skippedDeferredToolsDelta = portableMetadataStateClosed && deferredToolsDelta;
      const skippedCommandPermissions = portableMetadataStateClosed && commandPermissions;
      const projectedHookAdditionalContextValues = projectedHookAdditionalContext?.contexts.slice(
        hookContextMatchesCarriers ? eligibleProjectedHookContexts.length : 0,
      ) ?? [];
      const skippedPortableMetadata = skippedTurnDuration || skippedPostToolUseHook ||
        skippedStopHook || skippedHookProgress || hookRuntime !== undefined ||
        hookPermissionDecisionId !== undefined ||
        projectedStructuredOutputCall !== undefined ||
        skippedSystemMessageCarrier ||
        skippedHookSystemMessage || skippedAwaySummary ||
        skippedEmptyTaskReminder || projectedWorkReminderRecord !== undefined ||
        skippedQueuedCommand || skippedAgentListingDelta ||
        skippedDeferredToolsDelta || skippedCommandPermissions ||
        projectedSkillListing !== undefined || projectedCriticalSystemReminder !== undefined ||
        projectedNestedMemory !== undefined || projectedRelevantMemories !== undefined ||
        projectedAmbientUserContext !== undefined ||
        skippedEditedImage ||
        skippedRuntimeUsageReminder !== undefined || skippedToolSearchUsageReminder ||
        projectedMcpInstructionsDelta !== undefined ||
        skippedMcpDroppedToolsDelta ||
        projectedHookContextCarrier !== undefined || projectedHookAdditionalContext !== undefined ||
        projectedAsyncHookContext !== undefined || skippedModelRefusalFallback ||
        mainContentReplacementRecord !== undefined;
      if (compactBoundary) compactBoundaryCount++;
      if (compactSummary) compactSummaryCount++;
      let recordGraphUuid: string | undefined;
      if (record.sessionId !== undefined) {
        const recordSession = canonicalRecordUuid(record.sessionId);
        if (recordSession !== nativeId) identityFailures.add("session_id_mismatch");
      }
      const when = timestamp(record.timestamp);
      if (when !== "") {
        const millis = Date.parse(when);
        createdMillis = Math.min(createdMillis, millis);
        updatedMillis = Math.max(updatedMillis, millis);
      }
      if (typeof record.version === "string" && record.version !== "") {
        observedVersions.add(record.version);
        if (!skippedPortableMetadata) portableObservedVersions.add(record.version);
      }
      if (typeof record.cwd === "string" && record.cwd !== "") {
        if (!path.isAbsolute(record.cwd)) identityFailures.add("cwd_not_absolute");
        else {
          latestObservedCwd = path.normalize(record.cwd);
          observedCwds.add(latestObservedCwd);
          if (!skippedPortableMetadata) portableObservedCwds.add(latestObservedCwd);
        }
      }
      if (titleRecord?.kind === "custom") customTitle = titleRecord.title;
      else if (titleRecord?.kind === "generated") generatedTitle = titleRecord.title;

      if (GRAPH_TYPES.has(kind)) {
        const uuid = canonicalRecordUuid(record.uuid);
        if (uuid === undefined || graph.has(uuid)) {
          identityFailures.add(uuid === undefined ? "graph_uuid_invalid" : "graph_uuid_duplicate");
          continue;
        }
        if (!Object.hasOwn(record, "parentUuid") || record.isSidechain !== false) {
          identityFailures.add("graph_shape_invalid");
          continue;
        }
        let graphParentUuid: string | null;
        if (record.parentUuid === null) {
          graphParentUuid = null;
          roots.push(uuid);
          if (previousGraphUuid !== undefined) {
            graphDiscontinuities++;
            portableGraphDiscontinuities++;
          }
        } else {
          const parent = canonicalRecordUuid(record.parentUuid);
          if (parent === undefined || !graph.has(parent) || parent === uuid) {
            identityFailures.add("graph_parent_invalid");
            continue;
          }
          if (parent !== previousGraphUuid) {
            graphDiscontinuities++;
            portableGraphDiscontinuities++;
            if (toolResultGraphReturn(record, parent)) {
              toolResultGraphReturns++;
              portableToolResultGraphReturns++;
            }
          }
          graphParentUuid = parent;
        }
        const graphMessage = objectValue(record.message);
        const graphModel = kind === "assistant" && typeof graphMessage?.model === "string" &&
            graphMessage.model !== ""
          ? graphMessage.model
          : undefined;
        graph.set(uuid, {
          recordNumber: recordCount,
          parentUuid: graphParentUuid,
          kind,
          ...(graphModel === undefined ? {} : { model: graphModel }),
          ...(typeof record.cwd === "string" && path.isAbsolute(record.cwd)
            ? { cwd: path.normalize(record.cwd) }
            : {}),
          ...(typeof record.version === "string" && record.version !== ""
            ? { version: record.version }
            : {}),
        });
        recordGraphUuid = uuid;
        previousGraphUuid = uuid;
        if (kind === "assistant") {
          const supersededUuids = record.supersedes === undefined
            ? undefined
            : canonicalUuidList(record.supersedes);
          if (supersededUuids !== undefined) {
            pendingRetractionSignals.set(uuid, {
              replacementUuid: uuid,
              supersededUuids,
            });
          } else if (record.supersedes !== undefined &&
            !(Array.isArray(record.supersedes) && record.supersedes.length === 0)) {
            unsupportedMessageRetractions++;
          }
        }
        if (kind !== "user" && kind !== "assistant") {
          nonMessageGraphRecords++;
          if (skippedTurnDuration) {
            turnDurationRecordCount++;
            portableTurnDurationRecordCount++;
            pendingTurnDurationUuid = uuid;
          } else if (skippedModelRefusalFallback) {
            modelRefusalFallbackRecordCount++;
            portableModelRefusalFallbackRecordCount++;
            if (closesMessageRetraction && refusalFallback !== undefined && retractionSignal !== undefined) {
              messageRetractionEpisodes.push(retractionSignal);
              for (const [candidateUuid, candidate] of pendingRetractionSignals) {
                if (candidate.replacementUuid === retractionSignal.replacementUuid) {
                  pendingRetractionSignals.delete(candidateUuid);
                }
              }
            }
          } else if (refusalFallback !== undefined && refusalFallback.retractedMessageUuids.length !== 0) {
            unsupportedMessageRetractions++;
            if (retractionSignal !== undefined) {
              pendingRetractionSignals.delete(retractionSignal.replacementUuid);
            }
          } else if (skippedAwaySummary) {
            awaySummaryRecordCount++;
            portableAwaySummaryRecordCount++;
          } else if (skippedEmptyTaskReminder) {
            emptyTaskReminderRecordCount++;
            portableEmptyTaskReminderRecordCount++;
          } else if (projectedWorkReminderRecord !== undefined) {
            if (projectedWorkReminderRecord.kind === "task_reminder") {
              taskReminderRecordCount++;
              portableTaskReminderRecordCount++;
              taskReminderItemCount += projectedWorkReminderRecord.itemCount;
              portableTaskReminderItemCount += projectedWorkReminderRecord.itemCount;
              taskReminderDetailItemCount += projectedWorkReminderRecord.detailItemCount;
              portableTaskReminderDetailItemCount += projectedWorkReminderRecord.detailItemCount;
            } else {
              todoReminderRecordCount++;
              portableTodoReminderRecordCount++;
              todoReminderItemCount += projectedWorkReminderRecord.itemCount;
              portableTodoReminderItemCount += projectedWorkReminderRecord.itemCount;
              todoReminderDetailItemCount += projectedWorkReminderRecord.detailItemCount;
              portableTodoReminderDetailItemCount += projectedWorkReminderRecord.detailItemCount;
            }
          } else if (skippedQueuedCommand) {
            queuedCommandRecordCount++;
            portableQueuedCommandRecordCount++;
          } else if (skippedAgentListingDelta) {
            agentListingDeltaRecordCount++;
            portableAgentListingDeltaRecordCount++;
          } else if (skippedDeferredToolsDelta) {
            deferredToolsDeltaRecordCount++;
            portableDeferredToolsDeltaRecordCount++;
          } else if (skippedCommandPermissions) {
            commandPermissionsRecordCount++;
            portableCommandPermissionsRecordCount++;
          } else if (projectedStructuredOutputCall !== undefined && structuredOutputRecordUuid === uuid) {
            structuredOutputRecordCount++;
            projectedStructuredOutputCall.structuredOutput = {
              recordUuid: uuid,
              data: structuredOutputAttachment!.data,
            };
            projectedStructuredOutputCall.resultParentUuids.add(uuid);
          } else if (projectedSkillListing !== undefined) {
            skillListingRecordCount++;
            portableSkillListingRecordCount++;
          } else if (projectedCriticalSystemReminder !== undefined) {
            criticalSystemReminderRecordCount++;
            portableCriticalSystemReminderRecordCount++;
          } else if (projectedNestedMemory !== undefined) {
            nestedMemoryRecordCount++;
            portableNestedMemoryRecordCount++;
            loadedNestedMemoryPaths.add(projectedNestedMemory.path);
          } else if (projectedRelevantMemories !== undefined) {
            relevantMemoryRecordCount++;
            portableRelevantMemoryRecordCount++;
            relevantMemoryItemCount += projectedRelevantMemories.paths.length;
            portableRelevantMemoryItemCount += projectedRelevantMemories.paths.length;
            for (const memoryPath of projectedRelevantMemories.paths) {
              surfacedRelevantMemoryPaths.add(memoryPath);
            }
          } else if (projectedAmbientUserContext !== undefined) {
            ambientUserContextRecordCount++;
            portableAmbientUserContextRecordCount++;
          } else if (skippedEditedImage) {
            editedImageRecordCount++;
            portableEditedImageRecordCount++;
          } else if (skippedRuntimeUsageReminder === "token_usage") {
            tokenUsageRecordCount++;
            portableTokenUsageRecordCount++;
          } else if (skippedRuntimeUsageReminder === "total_tokens_reminder") {
            totalTokensReminderRecordCount++;
            portableTotalTokensReminderRecordCount++;
          } else if (skippedRuntimeUsageReminder === "budget_usd") {
            budgetUsdRecordCount++;
            portableBudgetUsdRecordCount++;
          } else if (skippedToolSearchUsageReminder) {
            toolSearchUsageReminderRecordCount++;
            portableToolSearchUsageReminderRecordCount++;
          } else if (projectedMcpInstructionsDelta !== undefined) {
            mcpInstructionsDeltaRecordCount++;
            portableMcpInstructionsDeltaRecordCount++;
          } else if (skippedMcpDroppedToolsDelta) {
            mcpDroppedToolsDeltaRecordCount++;
            portableMcpDroppedToolsDeltaRecordCount++;
          } else if (skippedPostToolUseHook) {
            postToolUseHookRecordCount++;
            portablePostToolUseHookRecordCount++;
            for (const candidate of eligiblePostToolUseHookCandidates) {
              postToolUseHookCandidates.add(candidate);
            }
          } else if (skippedStopHook) {
            stopHookRecordCount++;
            portableStopHookRecordCount++;
            if (stopHook !== undefined) {
              pendingStopHook = {
                uuid,
                toolUseId: stopHook.toolUseId,
                command: stopHook.command,
                durationMs: stopHook.durationMs,
              };
            }
          } else if (skippedHookProgress) {
            hookProgressRecordCount++;
            portableHookProgressRecordCount++;
            if (hookProgress!.hookEvent === "SessionStart" || hookProgress!.hookEvent === "PostToolUse") {
              pendingHookProgress = { ...hookProgress!, uuid };
            } else if (hookProgress!.hookEvent === "Stop") {
              pendingStopHook = {
                uuid,
                toolUseId: hookProgress!.toolUseId,
                command: hookProgress!.command,
              };
            }
          } else if (hookRuntime !== undefined || hookPermissionDecisionId !== undefined) {
            if (hookRuntime?.kind === "non_blocking_error") {
              hookNonBlockingErrorRecordCount++;
              portableHookNonBlockingErrorRecordCount++;
            } else if (hookRuntime?.kind === "execution_error") {
              hookExecutionErrorRecordCount++;
              portableHookExecutionErrorRecordCount++;
            } else if (hookRuntime?.kind === "cancelled") {
              hookCancelledRecordCount++;
              portableHookCancelledRecordCount++;
            } else {
              hookPermissionDecisionRecordCount++;
              portableHookPermissionDecisionRecordCount++;
            }
            const toolUseId = hookRuntime?.toolUseId ?? hookPermissionDecisionId!;
            const call = openToolCalls.get(toolUseId);
            const parent = canonicalRecordUuid(record.parentUuid);
            if (call !== undefined && parent !== undefined && call.resultParentUuids.has(parent)) {
              call.resultParentUuids.add(uuid);
            }
          } else if (skippedSystemMessageCarrier) {
            hookSystemMessageRecordCount++;
            portableHookSystemMessageRecordCount++;
            pendingSessionStartSystemMessageCarrier = { ...systemMessageCarrier!, uuid };
          } else if (skippedHookSystemMessage) {
            hookSystemMessageRecordCount++;
            portableHookSystemMessageRecordCount++;
          } else if (projectedHookContextCarrier !== undefined) {
            hookContextCarrierRecordCount++;
            portableHookContextCarrierRecordCount++;
            hookAdditionalContextValueCount++;
            portableHookAdditionalContextValueCount++;
            const extendsCarrierChain = eligibleProjectedHookContexts.length !== 0 &&
              hookContextParent === eligibleProjectedHookContexts.at(-1)!.uuid &&
              eligibleProjectedHookContexts.every((carrier) =>
                carrier.hookEvent === projectedHookContextCarrier.hookEvent);
            pendingProjectedHookContexts = [
              ...(extendsCarrierChain ? eligibleProjectedHookContexts : []),
              { ...projectedHookContextCarrier, uuid },
            ];
          } else if (projectedHookAdditionalContext !== undefined) {
            hookAdditionalContextRecordCount++;
            portableHookAdditionalContextRecordCount++;
            hookAdditionalContextValueCount += projectedHookAdditionalContextValues.length;
            portableHookAdditionalContextValueCount += projectedHookAdditionalContextValues.length;
          } else if (projectedAsyncHookContext !== undefined) {
            asyncHookContextRecordCount++;
            portableAsyncHookContextRecordCount++;
          } else {
            portableNonMessageGraphRecords++;
          }
          if (mcpInstructionsTransitionValid) {
            for (const name of mcpInstructionsDelta.addedNames) {
              announcedMcpInstructionServers.add(name);
            }
            for (const name of mcpInstructionsDelta.removedNames) {
              announcedMcpInstructionServers.delete(name);
            }
          }
          if (mcpDroppedToolsTransitionValid) {
            for (const entry of mcpDroppedToolsDelta) {
              announcedMcpDroppedToolEntries.add(entry);
            }
          }
        }
      } else if (mainContentReplacementRecord !== undefined) {
        contentReplacementRecordCount++;
        contentReplacementItemCount += mainContentReplacementRecord.replacements.length;
        for (const replacement of mainContentReplacementRecord.replacements) {
          currentContentReplacements.set(replacement.callId, replacement);
        }
      } else if (record.uuid !== undefined || Object.hasOwn(record, "parentUuid")) {
        identityFailures.add("unclassified_graph_record");
      } else if (titleRecord !== undefined) {
        sessionTitleRecordCount++;
      } else if (skippedSessionSummary) {
        sessionSummaryRecordCount++;
      } else if (skippedLastPrompt) {
        lastPromptRecordCount++;
      } else if (skippedQueueOperation) {
        queueOperationRecordCount++;
      } else if (skippedSessionEnd) {
        sessionEndRecordCount++;
      } else if (fileCheckpointRecord) {
        fileCheckpointRecordCount++;
      } else if (worktreeStateRecord) {
        worktreeStateRecordCount++;
      } else if (permissionModeRecord) {
        permissionModeRecordCount++;
      } else if (relocatedRecord !== undefined) {
        relocatedRecordCount++;
        relocatedCwd = relocatedRecord;
        observedRelocatedCwds.add(relocatedRecord);
      } else if (agentNameRecord) {
        agentDisplayRecordCount++;
      } else if (agentColorRecord) {
        agentDisplayRecordCount++;
      } else if (agentSettingRecord) {
        agentSettingRecordCount++;
      } else if (sessionModeRecord) {
        sessionModeRecordCount++;
        sessionMode = record.mode as "normal" | "coordinator";
      } else if (isolationLatchRecord) {
        isolationLatchRecordCount++;
      } else if (sessionTagRecord) {
        sessionTagRecordCount++;
      } else if (pullRequestLink !== undefined) {
        pullRequestLinkRecordCount++;
        currentPullRequestLink = pullRequestLink;
      } else if (artifactLink !== undefined) {
        frameLinkRecordCount++;
        currentArtifactLinks.delete(artifactLink.url);
        currentArtifactLinks.set(artifactLink.url, artifactLink.message);
      } else if (bridgeSessionRecord) {
        bridgeSessionRecordCount++;
      } else if (historySuppressionRecord) {
        historySuppressionRecordCount++;
      } else if (observerRefRecord) {
        observerRefRecordCount++;
      } else {
        unknownNonGraphRecordCount++;
      }

      if (recordGraphUuid !== undefined && pendingCompactBoundary !== undefined && !compactSummary) {
        compactionShapeValid = false;
        pendingCompactBoundary = undefined;
      }
      const hookContexts = projectedAsyncHookContext !== undefined
        ? [projectedAsyncHookContext.context]
        : projectedHookContextCarrier === undefined
          ? projectedHookAdditionalContextValues
          : [projectedHookContextCarrier.context];
      if (recordGraphUuid !== undefined && hookContexts.length !== 0) {
        flushPending();
        pushConversation(projectedHistoricalSystemContext(
          hookContexts,
          when,
          "hook_additional_context",
        ), [recordGraphUuid]);
      }
      if (recordGraphUuid !== undefined && projectedSkillListing !== undefined) {
        flushPending();
        pushConversation(projectedHistoricalSystemContext(
          [projectedSkillListing],
          when,
          "skill_listing",
        ), [recordGraphUuid]);
      }
      if (recordGraphUuid !== undefined && projectedCriticalSystemReminder !== undefined) {
        flushPending();
        pushConversation(projectedHistoricalSystemContext(
          [projectedCriticalSystemReminder],
          when,
          "critical_system_reminder",
        ), [recordGraphUuid]);
      }
      if (recordGraphUuid !== undefined && projectedNestedMemory !== undefined) {
        flushPending();
        pushConversation(projectedHistoricalSystemContext(
          [projectedNestedMemory.text],
          when,
          "nested_memory",
        ), [recordGraphUuid]);
      }
      if (recordGraphUuid !== undefined && projectedRelevantMemories !== undefined) {
        flushPending();
        pushConversation(projectedHistoricalSystemContext(
          projectedRelevantMemories.contexts,
          when,
          "relevant_memories",
        ), [recordGraphUuid]);
      }
      if (recordGraphUuid !== undefined && projectedAmbientUserContext !== undefined) {
        flushPending();
        pushConversation(projectedHistoricalSystemContext(
          [projectedAmbientUserContext.text],
          when,
          "ambient_user_context",
        ), [recordGraphUuid]);
      }
      if (recordGraphUuid !== undefined && projectedMcpInstructionsDelta !== undefined) {
        flushPending();
        pushConversation(projectedHistoricalSystemContext(
          [projectedMcpInstructionsDelta.text],
          when,
          "mcp_instructions_delta",
        ), [recordGraphUuid]);
      }
      if (recordGraphUuid !== undefined && projectedWorkReminderRecord !== undefined) {
        flushPending();
        pushConversation(projectedWorkReminder(projectedWorkReminderRecord, when), [recordGraphUuid]);
      }
      if (compactBoundary) {
        const toolsClosed = openToolCalls.size === 0 && openServerCalls.size === 0 &&
          pendingReadPdf === undefined &&
          pendingBlocks.length === 0 && pendingKinds.length === 0 && pendingText.length === 0;
        const partial = toolsClosed ? partialCompactBoundary(record, recordGraphUuid) : undefined;
        pendingCompactBoundary = {
          uuid: recordGraphUuid ?? "",
          fullValid: toolsClosed && fullCompactBoundary(record, recordGraphUuid),
          ...(partial === undefined ? {} : { partial }),
        };
      }

      if (kind === "user" || kind === "assistant") {
        if (recordGraphUuid !== undefined && pendingReadPdf !== undefined) {
          const pending = pendingReadPdf;
          pendingReadPdf = undefined;
          if (
            verifiedReadPdfMetaCarrier(record, pending.resultRecordUuid, pending.resource) &&
            pendingBlocks[pending.blockPosition] === pending.resultBlock
          ) {
            pendingBlocks[pending.blockPosition] = {
              kind: "historical_tool",
              tool: { ...pending.resultBlock.tool, resources: [managedResourceReference(pending.resource)] },
            };
            managedResources.set(
              `${pending.resource.sha256}\0${pending.resource.relativePath}`,
              pending.resource,
            );
            pendingNotes.push("claude.read_pdf_resource.managed");
            continue;
          }
          pendingNotes.push("claude.tool_result_mirror.invalid");
        }
        if (compactSummary) {
          flushPending();
          const fullCheckpoint = fullCompactSummary(record, recordGraphUuid, pendingCompactBoundary);
          const partialKind = partialCompactSummaryKind(record, recordGraphUuid, pendingCompactBoundary);
          const partialBoundary = pendingCompactBoundary?.partial;
          pendingCompactBoundary = undefined;
          const checkpoint: CompactCheckpoint | undefined = fullCheckpoint && recordGraphUuid !== undefined
            ? { kind: "full", summaryIndex: conversation.length, summaryUuid: recordGraphUuid }
            : partialKind !== undefined && partialBoundary !== undefined && recordGraphUuid !== undefined
              ? {
                kind: partialKind,
                summaryIndex: conversation.length,
                summaryUuid: recordGraphUuid,
                boundary: partialBoundary,
              }
              : undefined;
          if (checkpoint !== undefined) {
            compactCheckpoints.push(checkpoint);
            resetPortableCompactionState(record);
          } else {
            compactionShapeValid = false;
          }
          pushConversation(projectCompactSummary(record, when), recordGraphUuid === undefined ? [] : [recordGraphUuid]);
          continue;
        }
        const backgroundContext = projectedBackgroundAgentRetry ?? projectedBackgroundAgentPeer ??
          projectedBackgroundAgentNotification;
        if (kind === "user" && backgroundContext !== undefined) {
          flushPending();
          const contentKind = projectedBackgroundAgentRetry !== undefined
            ? "background_agent_retry" as const
            : projectedBackgroundAgentPeer !== undefined
              ? "background_agent_peer_message" as const
              : "background_agent_notification" as const;
          if (contentKind === "background_agent_retry") {
            backgroundAgentRetryRecordCount++;
            portableBackgroundAgentRetryRecordCount++;
          } else if (contentKind === "background_agent_peer_message") {
            backgroundAgentPeerMessageRecordCount++;
            portableBackgroundAgentPeerMessageRecordCount++;
          } else {
            backgroundAgentNotificationRecordCount++;
            portableBackgroundAgentNotificationRecordCount++;
          }
          pushConversation(
            projectedHistoricalSystemContext([backgroundContext.context], when, contentKind),
            recordGraphUuid === undefined ? [] : [recordGraphUuid],
          );
          continue;
        }
        if (kind === "user" && record.isMeta === true) {
          flushPending();
          pushConversation({
            kind: "gap",
            code: "claude.content.meta_message",
            label: "Claude internal meta message is preserved only in native history",
            timestamp: when,
          }, recordGraphUuid === undefined ? [] : [recordGraphUuid]);
          continue;
        }
        const messageEnvelope = objectValue(record.message);
        if (kind === "assistant" && typeof messageEnvelope?.model === "string" && messageEnvelope.model !== "") {
          model = messageEnvelope.model;
        }
        if (
          kind === "assistant" && recordGraphUuid !== undefined &&
          pendingRetractionSignals.has(recordGraphUuid) && portableMetadataStateClosed
        ) flushPending();
        const deferredServerCallIds = new Set(openServerCalls.keys());
        const projectedMessage = projectMessage(
          record,
          kind,
          when,
          recordGraphUuid,
          openServerCalls,
        );
        apiCompactionBlockCount += projectedMessage?.apiCompactionBlockCount ?? 0;
        if (projectedMessage?.item.kind === "gap") {
          pushConversation(
            projectedMessage.item,
            recordGraphUuid === undefined ? [] : [recordGraphUuid],
          );
          continue;
        }
        if (projectedMessage === undefined) continue;
        let projected = projectedMessage.item;
        if (projected.kind !== "message") continue;
        const tools = (projected.portableBlocks ?? []).filter((block): block is Extract<
          PortableContextBlock,
          { readonly kind: "historical_tool" }
        > => block.kind === "historical_tool");
        const calls = tools.filter((block) => block.tool.phase === "call");
        const results = tools.filter((block) => block.tool.phase === "result");
        const serverCalls = calls.filter((block) => isClaudeServerToolCall(block.tool));
        const serverCallIds = new Set([
          ...deferredServerCallIds,
          ...serverCalls.map((call) => call.tool.callId),
        ]);
        const serverResults = results.filter((result) => serverCallIds.has(result.tool.callId));
        const clientCalls = calls.filter((block) => !isClaudeServerToolCall(block.tool));
        const clientResults = results.filter((result) => !serverCallIds.has(result.tool.callId));
        const observedCall = projected.contentKinds?.some((value) => value === "tool_use") ?? false;
        const observedResult = projected.contentKinds?.some((value) =>
          value === "tool_result" || value === "tool_result_image" || value === "tool_result_resource" ||
          value === "tool_result_reference") ?? false;
        const pauseTurn = projected.portableNotes?.includes(CLAUDE_SERVER_PAUSE_TURN_NOTE) ?? false;
        if (projectedMessage.apiCompaction !== undefined) {
          const envelope = objectValue(record.message);
          const compactionValid = kind === "assistant" && envelope?.stop_reason === "end_turn" &&
            (envelope.stop_sequence === undefined || envelope.stop_sequence === null) &&
            (record.error === undefined || record.error === null) &&
            pendingBlocks.length === 0 && pendingKinds.length === 0 && pendingText.length === 0 &&
            openToolCalls.size === 0 && openServerCalls.size === 0 && pendingReadPdf === undefined &&
            !observedCall && !observedResult && calls.length === 0 && results.length === 0 &&
            (projected.contentKinds?.length ?? 0) !== 0 &&
            projected.contentKinds!.every((contentKind) => contentKind === "text") &&
            compactBoundaryCount === 0 && compactSummaryCount === 0 &&
            apiCompactCheckpoints.length === 0;
          if (compactionValid) {
            pushConversation(
              projectApiCompactSummary(projectedMessage.apiCompaction, when),
              recordGraphUuid === undefined ? [] : [recordGraphUuid],
            );
            apiCompactCheckpoints.push({ kind: "api", summaryIndex: conversation.length - 1 });
            resetPortableCompactionState(record);
          } else {
            projected = {
              ...projected,
              portableNotes: [
                ...(projected.portableNotes ?? []),
                "claude.api_compaction.unsupported",
              ],
            };
          }
        }

        if (kind === "assistant" && deferredServerCallIds.size !== 0) {
          const deferredResults = serverResults.filter((result) =>
            deferredServerCallIds.has(result.tool.callId));
          const deferredResultIds = new Set(deferredResults.map((result) => result.tool.callId));
          let leadingServerResults = 0;
          for (const contentKind of projected.contentKinds ?? []) {
            if (!isClaudeServerToolResultKind(contentKind)) break;
            leadingServerResults++;
          }
          const pauseParentMatches = pendingServerPauseRecordUuid === undefined ||
            canonicalRecordUuid(record.parentUuid) === pendingServerPauseRecordUuid;
          if (
            deferredResults.length !== deferredServerCallIds.size ||
            deferredResultIds.size !== deferredServerCallIds.size ||
            leadingServerResults !== deferredServerCallIds.size ||
            [...deferredServerCallIds].some((callId) => !deferredResultIds.has(callId)) ||
            !pauseParentMatches
          ) pendingNotes.push("claude.tool_relation.invalid");
          for (const result of deferredResults) openServerCalls.delete(result.tool.callId);
          pendingServerPauseRecordUuid = undefined;
        }

        if (kind === "assistant" && pauseTurn) {
          for (const resource of projectedMessage.managedResources) {
            managedResources.set(`${resource.sha256}\0${resource.relativePath}`, resource);
          }
          appendPending(projected, recordGraphUuid);
          const contentKinds = projected.contentKinds ?? [];
          const serverCallKindCount = contentKinds.filter((value) =>
            value === "server_tool_use" || value === "mcp_tool_use").length;
          const serverResultKindCount = contentKinds.filter(isClaudeServerToolResultKind).length;
          const closedServerCallIds = new Set(serverResults.map((result) => result.tool.callId));
          const unresolvedServerCalls = serverCalls.filter((call) => !closedServerCallIds.has(call.tool.callId));
          const trailingKinds = contentKinds.slice(-unresolvedServerCalls.length);
          const pauseValid = recordGraphUuid !== undefined && openToolCalls.size === 0 &&
            openServerCalls.size === 0 && clientCalls.length === 0 && clientResults.length === 0 &&
            serverCalls.length === serverCallKindCount && serverResults.length === serverResultKindCount &&
            unresolvedServerCalls.length !== 0 && trailingKinds.every((value) =>
              value === "server_tool_use" || value === "mcp_tool_use") &&
            unresolvedServerCalls.every((call) =>
              !openToolCalls.has(call.tool.callId) && !openServerCalls.has(call.tool.callId));
          if (!pauseValid) {
            pendingNotes.push("claude.tool_relation.invalid");
          } else {
            for (const call of unresolvedServerCalls) openServerCalls.set(call.tool.callId, call.tool);
            pendingServerPauseRecordUuid = recordGraphUuid;
          }
          continue;
        }

        if (kind === "assistant" && observedCall) {
          appendPending(projected, recordGraphUuid);
          if (clientCalls.length !== projected.contentKinds?.filter((value) => value === "tool_use").length ||
            recordGraphUuid === undefined) pendingNotes.push("claude.tool_relation.invalid");
          for (const call of clientCalls) {
            if (
              openToolCalls.has(call.tool.callId) || openServerCalls.has(call.tool.callId) ||
              recordGraphUuid === undefined
            ) {
              pendingNotes.push("claude.tool_relation.invalid");
            } else {
              openToolCalls.set(call.tool.callId, {
                recordUuid: recordGraphUuid,
                tool: call.tool,
                resultParentUuids: new Set([recordGraphUuid]),
              });
            }
          }
          const closedServerCallIds = new Set(serverResults.map((result) => result.tool.callId));
          for (const call of serverCalls) {
            if (closedServerCallIds.has(call.tool.callId)) continue;
            if (openToolCalls.has(call.tool.callId) || openServerCalls.has(call.tool.callId)) {
              pendingNotes.push("claude.tool_relation.invalid");
            } else {
              openServerCalls.set(call.tool.callId, call.tool);
            }
          }
          continue;
        }
        if (kind === "user" && observedResult) {
          const backgroundResult = clientResults.length === 1 ? clientResults[0] : undefined;
          const backgroundCall = backgroundResult === undefined
            ? undefined
            : openToolCalls.get(backgroundResult.tool.callId);
          const backgroundLaunch = backgroundCall === undefined || backgroundResult === undefined ||
              recordGraphUuid === undefined || backgroundAgentLaunchesByAgentId.has(
                objectValue(record.toolUseResult)?.agentId as string,
              )
            ? undefined
            : backgroundAgentLaunchRecord(record, backgroundCall, backgroundResult.tool, recordGraphUuid);
          let projectedForPending = projected;
          if (backgroundLaunch !== undefined && backgroundResult !== undefined) {
            const neutralResult: Extract<PortableContextBlock, { readonly kind: "historical_tool" }> = {
              kind: "historical_tool",
              tool: { ...backgroundResult.tool, output: backgroundLaunch.neutralOutput },
            };
            projectedForPending = {
              ...projected,
              text: visibleTool(neutralResult),
              portableBlocks: projected.portableBlocks!.map((block) =>
                block === backgroundResult ? neutralResult : block),
            };
          }
          appendPending(projectedForPending, recordGraphUuid);
          pendingNotes.push("claude.tool_carriers.coalesced");
          if (
            clientResults.length !== projected.contentKinds?.filter((value) =>
              value === "tool_result" || value === "tool_result_image" || value === "tool_result_resource" ||
              value === "tool_result_reference").length ||
            (projected.portableBlocks ?? []).some((block) => block.kind === "text") ||
            projected.contentKinds?.some((value) =>
              value !== "tool_result" && value !== "tool_result_image" && value !== "tool_result_resource" &&
              value !== "tool_result_reference")
          ) pendingNotes.push("claude.tool_control_content.invalid");
          const parent = canonicalRecordUuid(record.parentUuid);
          for (const result of clientResults) {
            const call = openToolCalls.get(result.tool.callId);
            if (call === undefined || parent === undefined || !call.resultParentUuids.has(parent)) {
              pendingNotes.push("claude.tool_relation.invalid");
              continue;
            }
            postToolUseHookCandidates.add(result.tool.callId);
            if (record.sourceToolAssistantUUID !== undefined) {
              if (canonicalRecordUuid(record.sourceToolAssistantUUID) === call.recordUuid) {
                pendingNotes.push("claude.tool_source_identity.skipped");
              } else {
                pendingNotes.push("claude.tool_relation.invalid");
              }
            }
            if (backgroundLaunch !== undefined && result === backgroundResult) {
              backgroundAgentLaunchesByAgentId.set(backgroundLaunch.agentId, backgroundLaunch);
              backgroundAgentLaunchesByResultUuid.set(backgroundLaunch.resultRecordUuid, backgroundLaunch);
              pendingNotes.push("claude.background_agent_launch.materialized");
              openToolCalls.delete(result.tool.callId);
              continue;
            }
            const imageResult = projected.contentKinds?.includes("tool_result_image") ?? false;
            const resourceResult = imageResult ||
              (projected.contentKinds?.includes("tool_result_resource") ?? false);
            const referenceResult = (result.tool.references?.length ?? 0) !== 0;
            const structuredMetadata = portableToolOutputHasStructuredMetadata(result.tool.output);
            if (call.tool.name === "StructuredOutput") {
              const sourceIdentityMatches = record.sourceToolAssistantUUID !== undefined &&
                canonicalRecordUuid(record.sourceToolAssistantUUID) === call.recordUuid;
              if (
                call.structuredOutput === undefined || clientResults.length !== 1 ||
                parent !== call.structuredOutput.recordUuid || !sourceIdentityMatches ||
                pendingBlocks.indexOf(result) < 0 ||
                !verifiedStructuredOutputResult(
                  record.toolUseResult,
                  result.tool.output,
                  call.structuredOutput.data,
                )
              ) {
                pendingNotes.push("claude.tool_relation.invalid");
              } else {
                portableStructuredOutputRecordCount++;
              }
            } else if (referenceResult && !resourceResult) {
              const sourceIdentityMatches = record.sourceToolAssistantUUID !== undefined &&
                canonicalRecordUuid(record.sourceToolAssistantUUID) === call.recordUuid;
              if (!sourceIdentityMatches || pendingBlocks.indexOf(result) < 0) {
                pendingNotes.push("claude.tool_relation.invalid");
              } else if (record.toolUseResult !== undefined) {
                pendingNotes.push("claude.tool_result_mirror.skipped");
              }
            } else if (resourceResult) {
              const resultResources = clientResults.length === 1
                ? projectedMessage.managedResources
                : [];
              const imageResource = projectedMessage.managedResources.length === 1 && clientResults.length === 1
                ? projectedMessage.managedResources[0]
                : undefined;
              const sourceIdentityMatches = record.sourceToolAssistantUUID !== undefined &&
                canonicalRecordUuid(record.sourceToolAssistantUUID) === call.recordUuid;
              const position = pendingBlocks.indexOf(result);
              const knownReadCarrier = call.tool.name === "Read";
              const knownReplCarrier = call.tool.name === "REPL";
              const mirrorValid = knownReadCarrier
                ? imageResult && imageResource !== undefined &&
                  verifiedReadImageResultMirror(record.toolUseResult, call.tool, result.tool, imageResource)
                : knownReplCarrier && verifiedReplResourceResultMirror(
                    record.toolUseResult,
                    call.tool,
                    result.tool,
                    resultResources,
                  );
              if (!sourceIdentityMatches || position < 0 || resultResources.length === 0 ||
                ((knownReadCarrier || knownReplCarrier) && !mirrorValid)) {
                pendingNotes.push("claude.tool_result_mirror.invalid");
              } else {
                for (const resource of resultResources) {
                  managedResources.set(`${resource.sha256}\0${resource.relativePath}`, resource);
                }
                if (knownReadCarrier) pendingNotes.push("claude.read_image_resource.managed");
                else if (knownReplCarrier) pendingNotes.push("claude.repl_resource.managed");
                else {
                  pendingNotes.push("claude.tool_result_resource.managed");
                  if (record.toolUseResult !== undefined) {
                    pendingNotes.push("claude.tool_result_mirror.skipped");
                  }
                }
              }
            } else if (structuredMetadata) {
              const sourceIdentityMatches = record.sourceToolAssistantUUID !== undefined &&
                canonicalRecordUuid(record.sourceToolAssistantUUID) === call.recordUuid;
              if (!sourceIdentityMatches || pendingBlocks.indexOf(result) < 0) {
                pendingNotes.push("claude.tool_relation.invalid");
              } else if (record.toolUseResult !== undefined) {
                pendingNotes.push("claude.tool_result_mirror.skipped");
              }
            } else if (record.toolUseResult !== undefined) {
              const sourceIdentityMatches = record.sourceToolAssistantUUID !== undefined &&
                canonicalRecordUuid(record.sourceToolAssistantUUID) === call.recordUuid;
              const pdfResource = sourceIdentityMatches && clientResults.length === 1 && recordGraphUuid !== undefined
                ? verifiedReadPdfResultMirror(record.toolUseResult, call.tool, result.tool)
                : undefined;
              const position = pendingBlocks.indexOf(result);
              if (pdfResource !== undefined && position >= 0) {
                pendingReadPdf = {
                  resultRecordUuid: recordGraphUuid!,
                  resultBlock: result,
                  blockPosition: position,
                  resource: pdfResource,
                };
                openToolCalls.delete(result.tool.callId);
                continue;
              }
              const mirror = sourceIdentityMatches && clientResults.length === 1
                ? verifiedReadResultMirror(record.toolUseResult, call.tool, result.tool)
                : undefined;
              if (mirror?.resource !== undefined) {
                const { bytes: _bytes, ...reference } = mirror.resource;
                if (position < 0) {
                  pendingNotes.push("claude.tool_result_mirror.invalid");
                } else {
                  pendingBlocks[position] = {
                    kind: "historical_tool",
                    tool: { ...result.tool, resources: [reference] },
                  };
                  managedResources.set(`${reference.sha256}\0${reference.relativePath}`, mirror.resource);
                  pendingNotes.push("claude.read_resource.managed");
                }
              } else if (mirror !== undefined) {
                pendingNotes.push("claude.tool_result_mirror.skipped");
              } else if (
                sourceIdentityMatches && clientResults.length === 1 && position >= 0 &&
                verifiedPreToolUseBlockingMirror(record.toolUseResult, call.tool, result.tool)
              ) {
                pendingNotes.push("claude.pre_tool_use_block.preserved");
                pendingNotes.push("claude.tool_result_mirror.skipped");
              } else if (verifiedSupplementalToolResultMirror(record.toolUseResult, call.tool, result.tool)) {
                pendingNotes.push("claude.tool_result_mirror.skipped");
              } else {
                pendingNotes.push("claude.tool_result_mirror.invalid");
              }
            }
            openToolCalls.delete(result.tool.callId);
          }
          continue;
        }
        if (kind === "user") {
          flushPending();
          for (const resource of projectedMessage.managedResources) {
            managedResources.set(`${resource.sha256}\0${resource.relativePath}`, resource);
          }
          const conversationIndex = conversation.length;
          pushConversation(projected, recordGraphUuid === undefined ? [] : [recordGraphUuid]);
          if (recordGraphUuid !== undefined) portableUserMessageUuids.add(recordGraphUuid);
          if (recordGraphUuid !== undefined && plainPortableMessage(projected)) {
            portableConversationIndexes.set(recordGraphUuid, conversationIndex);
          }
          if (firstUser === "") {
            const firstText = projected.portableBlocks?.find((block): block is Extract<
              PortableContextBlock,
              { readonly kind: "text" }
            > => block.kind === "text");
            firstUser = firstText?.text ?? projected.text;
          }
          continue;
        }
        for (const resource of projectedMessage.managedResources) {
          managedResources.set(`${resource.sha256}\0${resource.relativePath}`, resource);
        }
        if (pendingKinds.length !== 0 || pendingBlocks.length !== 0 || pendingText.length !== 0) {
          appendPending(projected, recordGraphUuid);
          flushPending();
        } else {
          const conversationIndex = conversation.length;
          pushConversation(projected, recordGraphUuid === undefined ? [] : [recordGraphUuid]);
          if (recordGraphUuid !== undefined && plainPortableMessage(projected)) {
            portableConversationIndexes.set(recordGraphUuid, conversationIndex);
          }
        }
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (pendingReadPdf !== undefined) pendingNotes.push("claude.tool_result_mirror.invalid");
  flushPending();
  if (currentPullRequestLink !== undefined) pushConversation(currentPullRequestLink);
  for (const artifact of currentArtifactLinks.values()) pushConversation(artifact);
  if (pendingCompactBoundary !== undefined) compactionShapeValid = false;
  unsupportedMessageRetractions += pendingRetractionSignals.size;

  if (recordCount === 0) identityFailures.add("empty_transcript");
  if (roots.length === 0) identityFailures.add("graph_root_missing");
  if (identityFailures.size !== 0) {
    throw new Error(
      `Claude Code transcript lacks a verified native identity (${[...identityFailures].sort().join(", ")}): ${filePath}`,
    );
  }
  const createdAt = Number.isFinite(createdMillis) ? new Date(createdMillis).toISOString() : fallbackTimestamp;
  const updatedAt = Number.isFinite(updatedMillis) ? new Date(updatedMillis).toISOString() : fallbackTimestamp;
  const cwds = [...observedCwds].sort();
  const relocatedCwds = [...observedRelocatedCwds].sort();
  const versions = [...observedVersions].sort();
  const nativeSummary: Record<string, JsonValue> = {
    firstRootRecordUuid: roots[0]!,
    rootRecordCount: roots.length,
    graphRecordCount: graph.size,
    graphDiscontinuities,
    toolResultGraphReturns,
    nonMessageGraphRecords,
    modelRefusalFallbackRecordCount,
    turnDurationRecordCount,
    postToolUseHookRecordCount,
    stopHookRecordCount,
    hookProgressRecordCount,
    hookNonBlockingErrorRecordCount,
    hookExecutionErrorRecordCount,
    hookCancelledRecordCount,
    hookPermissionDecisionRecordCount,
    structuredOutputRecordCount,
    hookSystemMessageRecordCount,
    awaySummaryRecordCount,
    emptyTaskReminderRecordCount,
    taskReminderRecordCount,
    taskReminderItemCount,
    taskReminderDetailItemCount,
    todoReminderRecordCount,
    todoReminderItemCount,
    todoReminderDetailItemCount,
    queuedCommandRecordCount,
    agentListingDeltaRecordCount,
    skillListingRecordCount,
    criticalSystemReminderRecordCount,
    nestedMemoryRecordCount,
    relevantMemoryRecordCount,
    relevantMemoryItemCount,
    ambientUserContextRecordCount,
    editedImageRecordCount,
    tokenUsageRecordCount,
    totalTokensReminderRecordCount,
    budgetUsdRecordCount,
    toolSearchUsageReminderRecordCount,
    mcpInstructionsDeltaRecordCount,
    mcpDroppedToolsDeltaRecordCount,
    deferredToolsDeltaRecordCount,
    commandPermissionsRecordCount,
    hookContextCarrierRecordCount,
    hookAdditionalContextRecordCount,
    hookAdditionalContextValueCount,
    asyncHookContextRecordCount,
    backgroundAgentRetryRecordCount,
    backgroundAgentPeerMessageRecordCount,
    backgroundAgentNotificationRecordCount,
    compactBoundaryCount,
    compactSummaryCount,
    apiCompactionBlockCount,
    sessionTitleRecordCount,
    sessionSummaryRecordCount,
    lastPromptRecordCount,
    queueOperationRecordCount,
    sessionEndRecordCount,
    fileCheckpointRecordCount,
    worktreeStateRecordCount,
    permissionModeRecordCount,
    relocatedRecordCount,
    agentDisplayRecordCount,
    agentSettingRecordCount,
    sessionModeRecordCount,
    sessionMode,
    isolationLatchRecordCount,
    sessionTagRecordCount,
    pullRequestLinkRecordCount,
    frameLinkRecordCount,
    frameLinkReferenceCount: currentArtifactLinks.size,
    bridgeSessionRecordCount,
    historySuppressionRecordCount,
    observerRefRecordCount,
    contentReplacementRecordCount,
    contentReplacementItemCount,
    contentReplacementCurrentCount: currentContentReplacements.size,
    contentReplacementAppliedCount: 0,
    contentReplacementInactiveCount: 0,
    contentReplacementUnsupportedCount: 0,
    messageRetractionEpisodeCount: messageRetractionEpisodes.length,
    messageRetractionRecordCount: messageRetractionEpisodes.reduce(
      (count, episode) => count + episode.supersededUuids.length,
      0,
    ),
    messageRetractionAppliedCount: 0,
    messageRetractionUnsupportedCount: unsupportedMessageRetractions,
    unknownNonGraphRecordCount,
    recordCount,
    observedCwds: cwds,
    observedRelocatedCwds: relocatedCwds,
    latestObservedCwd,
    relocatedCwd,
    observedVersions: versions,
    warnings: [...warnings].sort(),
  };
  const resolvedCompactCheckpoints = compactCheckpoints.map((checkpoint): MaterializableCompactCheckpoint | undefined =>
    checkpoint.kind === "full"
      ? {
        kind: checkpoint.kind,
        summaryIndex: checkpoint.summaryIndex,
        preservedConversationIndexes: [],
        expectedGraphDiscontinuities: 0,
        preservedUuids: [],
        nondurablePreservedMessages: 0,
      }
      : materializablePartialCheckpoint(checkpoint, graph, portableConversationIndexes));
  const validCompactCheckpointCount = resolvedCompactCheckpoints.filter((checkpoint) =>
    checkpoint !== undefined).length;
  const nativeCompactCheckpoint = resolvedCompactCheckpoints.at(-1);
  const materializedNativeCompaction = apiCompactionBlockCount === 0 && compactBoundaryCount !== 0 &&
    compactionShapeValid &&
    compactBoundaryCount === compactSummaryCount && compactBoundaryCount === validCompactCheckpointCount &&
    nativeCompactCheckpoint !== undefined;
  const apiCompactCheckpoint: MaterializableCompactCheckpoint | undefined =
    compactBoundaryCount === 0 && compactSummaryCount === 0 && apiCompactionBlockCount === 1 &&
      apiCompactCheckpoints.length === 1
      ? {
        ...apiCompactCheckpoints[0]!,
        preservedConversationIndexes: [],
        expectedGraphDiscontinuities: 0,
        preservedUuids: [],
        nondurablePreservedMessages: 0,
      }
      : undefined;
  const latestCompactCheckpoint = materializedNativeCompaction
    ? nativeCompactCheckpoint
    : apiCompactCheckpoint;
  const materializedCompaction = latestCompactCheckpoint !== undefined;
  const compactedPortableConversation = materializedCompaction
    ? materializeCompactConversation(conversation, latestCompactCheckpoint!)
    : [...conversation];
  const materializedMessageRetractions = materializeMessageRetractions(
    compactedPortableConversation,
    conversationSourceUuids,
    messageRetractionEpisodes,
    unsupportedMessageRetractions,
    materializedCompaction,
  );
  const materializedContentReplacements = materializeContentReplacements(
    conversation,
    materializedMessageRetractions.conversation,
    currentContentReplacements,
    materializedCompaction || materializedMessageRetractions.applied !== 0,
  );
  const portableConversation = materializedContentReplacements.conversation;
  if (materializedCompaction && latestCompactCheckpoint!.preservedUuids.length !== 0) {
    for (const uuid of latestCompactCheckpoint!.preservedUuids) {
      const graphRecord = graph.get(uuid);
      if (graphRecord?.cwd !== undefined) portableObservedCwds.add(graphRecord.cwd);
      if (graphRecord?.version !== undefined) portableObservedVersions.add(graphRecord.version);
    }
  }
  const portableCwds = [...portableObservedCwds].sort();
  const portableVersions = [...portableObservedVersions].sort();
  const portableNativeSummary: JsonValue = materializedCompaction
    ? {
      ...nativeSummary,
      graphDiscontinuities: Math.max(
        0,
        portableGraphDiscontinuities - latestCompactCheckpoint!.expectedGraphDiscontinuities,
      ),
      toolResultGraphReturns: portableToolResultGraphReturns,
      nonMessageGraphRecords: portableNonMessageGraphRecords,
      modelRefusalFallbackRecordCount: portableModelRefusalFallbackRecordCount,
      turnDurationRecordCount: portableTurnDurationRecordCount,
      postToolUseHookRecordCount: portablePostToolUseHookRecordCount,
      stopHookRecordCount: portableStopHookRecordCount,
      hookProgressRecordCount: portableHookProgressRecordCount,
      hookNonBlockingErrorRecordCount: portableHookNonBlockingErrorRecordCount,
      hookExecutionErrorRecordCount: portableHookExecutionErrorRecordCount,
      hookCancelledRecordCount: portableHookCancelledRecordCount,
      hookPermissionDecisionRecordCount: portableHookPermissionDecisionRecordCount,
      structuredOutputRecordCount: portableStructuredOutputRecordCount,
      hookSystemMessageRecordCount: portableHookSystemMessageRecordCount,
      awaySummaryRecordCount: portableAwaySummaryRecordCount,
      emptyTaskReminderRecordCount: portableEmptyTaskReminderRecordCount,
      taskReminderRecordCount: portableTaskReminderRecordCount,
      taskReminderItemCount: portableTaskReminderItemCount,
      taskReminderDetailItemCount: portableTaskReminderDetailItemCount,
      todoReminderRecordCount: portableTodoReminderRecordCount,
      todoReminderItemCount: portableTodoReminderItemCount,
      todoReminderDetailItemCount: portableTodoReminderDetailItemCount,
      queuedCommandRecordCount: portableQueuedCommandRecordCount,
      agentListingDeltaRecordCount: portableAgentListingDeltaRecordCount,
      skillListingRecordCount: portableSkillListingRecordCount,
      criticalSystemReminderRecordCount: portableCriticalSystemReminderRecordCount,
      nestedMemoryRecordCount: portableNestedMemoryRecordCount,
      relevantMemoryRecordCount: portableRelevantMemoryRecordCount,
      relevantMemoryItemCount: portableRelevantMemoryItemCount,
      ambientUserContextRecordCount: portableAmbientUserContextRecordCount,
      editedImageRecordCount: portableEditedImageRecordCount,
      tokenUsageRecordCount: portableTokenUsageRecordCount,
      totalTokensReminderRecordCount: portableTotalTokensReminderRecordCount,
      budgetUsdRecordCount: portableBudgetUsdRecordCount,
      toolSearchUsageReminderRecordCount: portableToolSearchUsageReminderRecordCount,
      mcpInstructionsDeltaRecordCount: portableMcpInstructionsDeltaRecordCount,
      mcpDroppedToolsDeltaRecordCount: portableMcpDroppedToolsDeltaRecordCount,
      deferredToolsDeltaRecordCount: portableDeferredToolsDeltaRecordCount,
      commandPermissionsRecordCount: portableCommandPermissionsRecordCount,
      hookContextCarrierRecordCount: portableHookContextCarrierRecordCount,
      hookAdditionalContextRecordCount: portableHookAdditionalContextRecordCount,
      hookAdditionalContextValueCount: portableHookAdditionalContextValueCount,
      asyncHookContextRecordCount: portableAsyncHookContextRecordCount,
      backgroundAgentRetryRecordCount: portableBackgroundAgentRetryRecordCount,
      backgroundAgentPeerMessageRecordCount: portableBackgroundAgentPeerMessageRecordCount,
      backgroundAgentNotificationRecordCount: portableBackgroundAgentNotificationRecordCount,
      compactBoundaryCount: 0,
      compactSummaryCount: 0,
      apiCompactionBlockCount: 0,
      nondurablePreservedMessages: latestCompactCheckpoint!.nondurablePreservedMessages,
      contentReplacementAppliedCount: materializedContentReplacements.applied,
      contentReplacementInactiveCount: materializedContentReplacements.inactive,
      contentReplacementUnsupportedCount: materializedContentReplacements.unsupported,
      messageRetractionAppliedCount: materializedMessageRetractions.applied,
      messageRetractionUnsupportedCount: materializedMessageRetractions.unsupported,
      observedCwds: portableCwds,
      observedVersions: portableVersions,
    }
    : modelRefusalFallbackRecordCount !== 0 || turnDurationRecordCount !== 0 ||
      postToolUseHookRecordCount !== 0 ||
      stopHookRecordCount !== 0 || hookProgressRecordCount !== 0 ||
      hookNonBlockingErrorRecordCount !== 0 || hookExecutionErrorRecordCount !== 0 ||
      hookCancelledRecordCount !== 0 ||
      hookPermissionDecisionRecordCount !== 0 ||
      structuredOutputRecordCount !== 0 ||
      hookSystemMessageRecordCount !== 0 ||
      awaySummaryRecordCount !== 0 || emptyTaskReminderRecordCount !== 0 ||
      taskReminderRecordCount !== 0 || todoReminderRecordCount !== 0 ||
      queuedCommandRecordCount !== 0 || agentListingDeltaRecordCount !== 0 ||
      skillListingRecordCount !== 0 || criticalSystemReminderRecordCount !== 0 ||
      nestedMemoryRecordCount !== 0 || relevantMemoryRecordCount !== 0 ||
      ambientUserContextRecordCount !== 0 ||
      editedImageRecordCount !== 0 ||
      tokenUsageRecordCount !== 0 || totalTokensReminderRecordCount !== 0 || budgetUsdRecordCount !== 0 ||
      toolSearchUsageReminderRecordCount !== 0 ||
      mcpInstructionsDeltaRecordCount !== 0 ||
      mcpDroppedToolsDeltaRecordCount !== 0 ||
      deferredToolsDeltaRecordCount !== 0 ||
      commandPermissionsRecordCount !== 0 ||
      hookContextCarrierRecordCount !== 0 ||
      hookAdditionalContextRecordCount !== 0 || asyncHookContextRecordCount !== 0 ||
      backgroundAgentRetryRecordCount !== 0 || backgroundAgentPeerMessageRecordCount !== 0 ||
      backgroundAgentNotificationRecordCount !== 0 || contentReplacementRecordCount !== 0
      ? {
        ...nativeSummary,
        graphDiscontinuities: portableGraphDiscontinuities,
        toolResultGraphReturns: portableToolResultGraphReturns,
        nonMessageGraphRecords: portableNonMessageGraphRecords,
        modelRefusalFallbackRecordCount: portableModelRefusalFallbackRecordCount,
        turnDurationRecordCount: portableTurnDurationRecordCount,
        postToolUseHookRecordCount: portablePostToolUseHookRecordCount,
        stopHookRecordCount: portableStopHookRecordCount,
        hookProgressRecordCount: portableHookProgressRecordCount,
        hookNonBlockingErrorRecordCount: portableHookNonBlockingErrorRecordCount,
        hookExecutionErrorRecordCount: portableHookExecutionErrorRecordCount,
        hookCancelledRecordCount: portableHookCancelledRecordCount,
        hookPermissionDecisionRecordCount: portableHookPermissionDecisionRecordCount,
        structuredOutputRecordCount: portableStructuredOutputRecordCount,
        hookSystemMessageRecordCount: portableHookSystemMessageRecordCount,
        awaySummaryRecordCount: portableAwaySummaryRecordCount,
        emptyTaskReminderRecordCount: portableEmptyTaskReminderRecordCount,
        taskReminderRecordCount: portableTaskReminderRecordCount,
        taskReminderItemCount: portableTaskReminderItemCount,
        taskReminderDetailItemCount: portableTaskReminderDetailItemCount,
        todoReminderRecordCount: portableTodoReminderRecordCount,
        todoReminderItemCount: portableTodoReminderItemCount,
        todoReminderDetailItemCount: portableTodoReminderDetailItemCount,
        queuedCommandRecordCount: portableQueuedCommandRecordCount,
        agentListingDeltaRecordCount: portableAgentListingDeltaRecordCount,
        skillListingRecordCount: portableSkillListingRecordCount,
        criticalSystemReminderRecordCount: portableCriticalSystemReminderRecordCount,
        nestedMemoryRecordCount: portableNestedMemoryRecordCount,
        relevantMemoryRecordCount: portableRelevantMemoryRecordCount,
        relevantMemoryItemCount: portableRelevantMemoryItemCount,
        ambientUserContextRecordCount: portableAmbientUserContextRecordCount,
        editedImageRecordCount: portableEditedImageRecordCount,
        tokenUsageRecordCount: portableTokenUsageRecordCount,
        totalTokensReminderRecordCount: portableTotalTokensReminderRecordCount,
        budgetUsdRecordCount: portableBudgetUsdRecordCount,
        toolSearchUsageReminderRecordCount: portableToolSearchUsageReminderRecordCount,
        mcpInstructionsDeltaRecordCount: portableMcpInstructionsDeltaRecordCount,
        mcpDroppedToolsDeltaRecordCount: portableMcpDroppedToolsDeltaRecordCount,
        deferredToolsDeltaRecordCount: portableDeferredToolsDeltaRecordCount,
        commandPermissionsRecordCount: portableCommandPermissionsRecordCount,
        hookContextCarrierRecordCount: portableHookContextCarrierRecordCount,
        hookAdditionalContextRecordCount: portableHookAdditionalContextRecordCount,
        hookAdditionalContextValueCount: portableHookAdditionalContextValueCount,
        asyncHookContextRecordCount: portableAsyncHookContextRecordCount,
        backgroundAgentRetryRecordCount: portableBackgroundAgentRetryRecordCount,
        backgroundAgentPeerMessageRecordCount: portableBackgroundAgentPeerMessageRecordCount,
        backgroundAgentNotificationRecordCount: portableBackgroundAgentNotificationRecordCount,
        contentReplacementAppliedCount: materializedContentReplacements.applied,
        contentReplacementInactiveCount: materializedContentReplacements.inactive,
        contentReplacementUnsupportedCount: materializedContentReplacements.unsupported,
        messageRetractionAppliedCount: materializedMessageRetractions.applied,
        messageRetractionUnsupportedCount: materializedMessageRetractions.unsupported,
        observedCwds: portableCwds,
        observedVersions: portableVersions,
      }
      : nativeSummary;
  const allManagedResources = [...managedResources.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath));
  const activeResourceKeys = portableResourceKeys(portableConversation);
  const portableManagedResources = materializedCompaction || materializedMessageRetractions.applied !== 0
    ? allManagedResources.filter((resource) => activeResourceKeys.has(`${resource.sha256}\0${resource.relativePath}`))
    : allManagedResources;
  return {
    nativeId,
    firstRootRecordUuid: roots[0]!,
    title: compactTitle(customTitle || generatedTitle || firstUser),
    context: relocatedCwd || latestObservedCwd,
    model,
    createdAt,
    updatedAt,
    conversation,
    observedCwds: cwds,
    observedRelocatedCwds: relocatedCwds,
    sessionMode,
    observedVersions: versions,
    recordCount,
    warnings: [...warnings].sort(),
    nativeSummary,
    managedResources: allManagedResources,
    portableConversation,
    portableNativeSummary,
    portableManagedResources,
    materializedCompactionCheckpoints: materializedCompaction ? 1 : 0,
    materializedContentReplacements: materializedContentReplacements.applied,
    materializedMessageRetractions: materializedMessageRetractions.applied,
  };
}
