import path from "node:path";

import {
  conversionStatus,
  normalizeConversionFindings,
  type ConversionFinding,
  type PortableSourceNormalization,
  type PreparedPortableSource,
} from "../../../domain/conversion.js";
import type { AgentSnapshot, ConversationItem, JsonValue, StoredSession } from "../../../domain/history.js";
import {
  hasClosedHistoricalToolSequence,
  PORTABLE_CONTEXT_SCHEMA,
  renderPortableContextMessage,
  validHistoricalReference,
  type HistoricalToolEvidence,
  type PortableContextBlock,
  type PortableContextMessage,
  type PortableContextSession,
} from "../../../domain/portable-context.js";
import { managedResourceReference, type ManagedResourceObject } from "../../../domain/resource.js";
import { snapshotRawPath } from "../../../infrastructure/history-store.js";
import { readClaudeDescriptor } from "../migration/archive.js";
import {
  loadClaudeToolResultResources,
  type ClaudeManagedToolResultBinding,
  type ClaudeToolResultFile,
} from "../sidecars/tool-result.js";
import {
  CLAUDE_COMPACTION_SUMMARY_NOTE,
  CLAUDE_CONTENT_REPLACEMENT_NOTE,
  parseClaudeTranscript,
  type ParsedClaudeTranscript,
} from "../history/transcript.js";
import {
  validateClaudeTaskList,
  type ClaudeTaskFile,
  type ClaudeTaskItem,
  type ClaudeTaskList,
} from "../sidecars/task.js";

export interface MaterializedClaudePortableSource {
  readonly source: StoredSession;
  readonly resources: readonly ManagedResourceObject[];
  readonly materializedCompactionCheckpoints: number;
  readonly materializedContentReplacements: number;
  readonly materializedMessageRetractions: number;
  readonly materializedRetainedToolResults: number;
  readonly skippedPrivateRetainedToolResults: number;
  readonly inactiveRetainedToolResults: number;
  readonly unmaterializedRetainedToolResults: number;
}

export interface ClaudePortableMaterializationOptions {
  readonly mainTranscriptPath: string;
  readonly retainedToolResults?: readonly ClaudeManagedToolResultBinding[];
  readonly taskList?: ClaudeTaskList;
}

const REASONING_KINDS = new Set(["thinking", "redacted_thinking"]);
const RESOURCE_KINDS = new Set(["image", "document", "file"]);
const REFERENCE_KINDS = new Set(["container_upload", "document_reference", "image_reference"]);
const SESSION_REFERENCE_KINDS = new Set(["session_pull_request", "session_artifact"]);
const HISTORICAL_CONTEXT_KINDS = new Set([
  "hook_additional_context",
  "skill_listing",
  "critical_system_reminder",
  "nested_memory",
  "relevant_memories",
  "ambient_user_context",
  "mcp_instructions_delta",
  "background_agent_retry",
  "background_agent_peer_message",
  "background_agent_notification",
]);

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function integer(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function strings(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? [...value] : undefined;
}

function blocked(code: string, count = 1): ConversionFinding {
  return { code, disposition: "blocked", count };
}

function classifyKind(kind: string, counts: Map<string, number>): void {
  let category: string;
  if (kind === "text" || kind === "historical_event") return;
  if (REASONING_KINDS.has(kind)) category = "reasoning";
  else if (kind.includes("tool")) category = "tool";
  else if (RESOURCE_KINDS.has(kind) || kind.includes("resource")) category = "resource";
  else if (REFERENCE_KINDS.has(kind)) category = "reference";
  else category = "unknown";
  counts.set(category, (counts.get(category) ?? 0) + 1);
}

function historicalToolResults(
  conversation: readonly ConversationItem[],
): ReadonlyMap<string, readonly HistoricalToolEvidence[]> {
  const results = new Map<string, HistoricalToolEvidence[]>();
  for (const item of conversation) {
    if (item.kind !== "message") continue;
    for (const block of item.portableBlocks ?? []) {
      if (block.kind !== "historical_tool" || block.tool.phase !== "result") continue;
      const matches = results.get(block.tool.callId) ?? [];
      matches.push(block.tool);
      results.set(block.tool.callId, matches);
    }
  }
  return results;
}

function sameResourceIdentity(left: ManagedResourceObject, right: ManagedResourceObject): boolean {
  return left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes &&
    left.mediaType === right.mediaType && left.name === right.name && left.relativePath === right.relativePath;
}

function attachRetainedToolResults(
  conversation: readonly ConversationItem[],
  parsed: ParsedClaudeTranscript,
  options: ClaudePortableMaterializationOptions,
): {
  readonly conversation: readonly ConversationItem[];
  readonly resources: readonly ManagedResourceObject[];
  readonly materialized: number;
  readonly skippedPrivate: number;
  readonly inactive: number;
  readonly unmaterialized: number;
} {
  const retained = options.retainedToolResults ?? [];
  const activeResults = historicalToolResults(conversation);
  const allResults = historicalToolResults(parsed.conversation);
  const resourcesByPath = new Map(parsed.portableManagedResources.map((resource) => [resource.relativePath, resource]));
  const mainBindings = new Map<string, ClaudeManagedToolResultBinding[]>();
  let skippedPrivate = 0;
  for (const binding of retained) {
    if (binding.transcriptPath !== options.mainTranscriptPath) {
      skippedPrivate++;
      continue;
    }
    const grouped = mainBindings.get(binding.callId) ?? [];
    grouped.push(binding);
    mainBindings.set(binding.callId, grouped);
  }

  const attachments = new Map<string, ManagedResourceObject>();
  let inactive = 0;
  let unmaterialized = 0;
  for (const [callId, bindings] of mainBindings) {
    if (bindings.length !== 1) {
      unmaterialized += bindings.length;
      continue;
    }
    const active = activeResults.get(callId) ?? [];
    if (active.length === 0 && (
      parsed.materializedCompactionCheckpoints !== 0 || parsed.materializedMessageRetractions !== 0
    ) &&
      (allResults.get(callId)?.length ?? 0) === 1) {
      inactive++;
      continue;
    }
    if (active.length !== 1 || (active[0]!.resources?.length ?? 0) !== 0) {
      unmaterialized++;
      continue;
    }
    const loaded = bindings[0]!.resource;
    const existing = resourcesByPath.get(loaded.relativePath);
    if (existing !== undefined && !sameResourceIdentity(existing, loaded)) {
      unmaterialized++;
      continue;
    }
    const resource = existing ?? loaded;
    resourcesByPath.set(resource.relativePath, resource);
    attachments.set(callId, resource);
  }

  const attached = new Set<string>();
  const materializedConversation = conversation.map((item): ConversationItem => {
    if (item.kind !== "message" || item.portableBlocks === undefined) return item;
    let changed = false;
    const portableBlocks = item.portableBlocks.map((block) => {
      if (block.kind !== "historical_tool" || block.tool.phase !== "result") return block;
      const resource = attachments.get(block.tool.callId);
      if (resource === undefined || attached.has(block.tool.callId)) return block;
      changed = true;
      attached.add(block.tool.callId);
      return {
        ...block,
        tool: { ...block.tool, resources: [managedResourceReference(resource)] },
      };
    });
    return changed ? { ...item, portableBlocks } : item;
  });
  if (attached.size !== attachments.size) unmaterialized += attachments.size - attached.size;
  return {
    conversation: materializedConversation,
    resources: [...resourcesByPath.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)),
    materialized: attached.size,
    skippedPrivate,
    inactive,
    unmaterialized,
  };
}

function materializeClaudePortableSource(
  source: StoredSession,
  parsed: ParsedClaudeTranscript,
  options: ClaudePortableMaterializationOptions,
): MaterializedClaudePortableSource {
  if (source.agent !== "claude" || parsed.nativeId !== source.nativeId) {
    throw new Error("Claude portable materializer received a different transcript identity");
  }
  const baseConversation = source.conversation.length !== 0 &&
      parsed.materializedCompactionCheckpoints === 0 &&
      parsed.materializedContentReplacements === 0 && parsed.materializedMessageRetractions === 0
    ? source.conversation
    : parsed.portableConversation;
  const retained = attachRetainedToolResults(baseConversation, parsed, options);
  const native = objectValue(source.native);
  if (native === undefined) throw new Error("Claude portable materializer cannot update missing native metadata");
  const taskListRevision = options.taskList === undefined
    ? undefined
    : {
        tasks: options.taskList.tasks.map((task) => ({
          id: task.id,
          subject: task.subject,
          description: task.description,
          ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
          ...(task.owner === undefined ? {} : { owner: task.owner }),
          status: task.status,
          blocks: [...task.blocks],
          blockedBy: [...task.blockedBy],
          metadataPresent: task.metadataPresent,
        })),
        ...(options.taskList.highwatermark === undefined ? {} : { highwatermark: options.taskList.highwatermark }),
      };
  return {
    source: {
      ...source,
      conversation: retained.conversation,
      native: {
        ...native,
        transcript: parsed.portableNativeSummary,
        ...(taskListRevision === undefined ? {} : { portableTaskList: taskListRevision }),
      },
    },
    resources: retained.resources,
    materializedCompactionCheckpoints: parsed.materializedCompactionCheckpoints,
    materializedContentReplacements: parsed.materializedContentReplacements,
    materializedMessageRetractions: parsed.materializedMessageRetractions,
    materializedRetainedToolResults: retained.materialized,
    skippedPrivateRetainedToolResults: retained.skippedPrivate,
    inactiveRetainedToolResults: retained.inactive,
    unmaterializedRetainedToolResults: retained.unmaterialized,
  };
}

export async function prepareClaudePortableSource(
  stateDirectory: string,
  snapshot: AgentSnapshot,
  source: StoredSession,
): Promise<PreparedPortableSource> {
  if (
    snapshot.agent !== "claude" || source.agent !== "claude" ||
    snapshot.sessions.find((session) => session.sessionRef === source.sessionRef)?.nativeId !== source.nativeId
  ) throw new Error(`Claude portable source is outside the snapshot: ${source.sessionRef}`);
  const descriptor = readClaudeDescriptor(source);
  const mainTranscriptPath = snapshotRawPath(
    stateDirectory,
    snapshot,
    descriptor.mainRelativePath,
  );
  const parsed = await parseClaudeTranscript(mainTranscriptPath, source.nativeId, source.updatedAt);
  const toolResultFiles: ClaudeToolResultFile[] = descriptor.relatedFiles.flatMap((file) =>
    file.role === "tool-result"
      ? [{
          relativePath: file.relativePath,
          role: "tool-result",
          filePath: snapshotRawPath(stateDirectory, snapshot, file.relativePath),
        }]
      : []);
  const retainedToolResults = toolResultFiles.length !== 0 &&
      !descriptor.blockers.includes("claude.native.tool_result_closure_unverified")
    ? await loadClaudeToolResultResources({
      transcripts: [
        mainTranscriptPath,
        ...descriptor.relatedFiles.flatMap((file) => file.role === "subagent-transcript"
          ? [snapshotRawPath(stateDirectory, snapshot, file.relativePath)]
          : []),
      ],
      files: toolResultFiles,
      sessionId: source.nativeId,
      projectCarrier: descriptor.projectCarrier,
    })
    : [];
  const taskFiles: ClaudeTaskFile[] = descriptor.relatedFiles.flatMap((file) =>
    file.role === "task-entry" || file.role === "task-highwatermark"
      ? [{
          relativePath: file.relativePath,
          role: file.role,
          filePath: snapshotRawPath(stateDirectory, snapshot, file.relativePath),
        }]
      : []);
  const taskList = descriptor.blockers.includes("claude.native.task_list_unverified")
    ? undefined
    : await validateClaudeTaskList({ sessionId: source.nativeId, files: taskFiles });
  const materialized = materializeClaudePortableSource(source, parsed, {
    mainTranscriptPath,
    retainedToolResults,
    ...(taskList === undefined ? {} : { taskList }),
  });
  return {
    source: materialized.source,
    normalization: normalizeClaudePortableContext(materialized.source, {
      materializedCompactionCheckpoints: materialized.materializedCompactionCheckpoints,
      materializedContentReplacements: materialized.materializedContentReplacements,
      materializedMessageRetractions: materialized.materializedMessageRetractions,
      materializedRetainedToolResults: materialized.materializedRetainedToolResults,
      skippedPrivateRetainedToolResults: materialized.skippedPrivateRetainedToolResults,
      inactiveRetainedToolResults: materialized.inactiveRetainedToolResults,
      unmaterializedRetainedToolResults: materialized.unmaterializedRetainedToolResults,
      ...(taskList === undefined ? {} : { taskList }),
    }),
    resources: materialized.resources,
  };
}

function normalizeClaudePortableContext(
  source: StoredSession,
  options: {
    readonly materializedCompactionCheckpoints?: number;
    readonly materializedContentReplacements?: number;
    readonly materializedMessageRetractions?: number;
    readonly materializedRetainedToolResults?: number;
    readonly skippedPrivateRetainedToolResults?: number;
    readonly inactiveRetainedToolResults?: number;
    readonly unmaterializedRetainedToolResults?: number;
    readonly taskList?: ClaudeTaskList;
  } = {},
): PortableSourceNormalization {
  if (source.agent !== "claude") throw new Error("Claude portable normalizer received another Agent");
  const materializedCompactionCheckpoints = options.materializedCompactionCheckpoints ?? 0;
  if (!Number.isSafeInteger(materializedCompactionCheckpoints) || materializedCompactionCheckpoints < 0) {
    throw new Error("Claude materialized compaction checkpoint count is invalid");
  }
  const materializedContentReplacements = options.materializedContentReplacements ?? 0;
  if (!Number.isSafeInteger(materializedContentReplacements) || materializedContentReplacements < 0) {
    throw new Error("Claude materialized content-replacement count is invalid");
  }
  const materializedMessageRetractions = options.materializedMessageRetractions ?? 0;
  if (!Number.isSafeInteger(materializedMessageRetractions) || materializedMessageRetractions < 0) {
    throw new Error("Claude materialized message-retraction count is invalid");
  }
  const materializedRetainedToolResults = options.materializedRetainedToolResults ?? 0;
  const skippedPrivateRetainedToolResults = options.skippedPrivateRetainedToolResults ?? 0;
  const inactiveRetainedToolResults = options.inactiveRetainedToolResults ?? 0;
  const unmaterializedRetainedToolResults = options.unmaterializedRetainedToolResults ?? 0;
  if ([
    materializedRetainedToolResults,
    skippedPrivateRetainedToolResults,
    inactiveRetainedToolResults,
    unmaterializedRetainedToolResults,
  ].some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("Claude retained tool-result count is invalid");
  }
  const findings: ConversionFinding[] = [];
  const descriptor = readClaudeDescriptor(source);
  if (descriptor.blockers.length !== 0) {
    findings.push(blocked("claude.native_relations.unsupported", descriptor.blockers.length));
  }
  const expectedRawFiles = [
    descriptor.mainRelativePath,
    ...descriptor.relatedFiles.map((file) => file.relativePath),
  ].sort();
  if (JSON.stringify([...source.rawFiles].sort()) !== JSON.stringify(expectedRawFiles)) {
    findings.push(blocked("claude.transcript_closure.unsupported"));
  }
  const relatedCounts = new Map<string, number>();
  for (const file of descriptor.relatedFiles) {
    relatedCounts.set(file.role, (relatedCounts.get(file.role) ?? 0) + 1);
  }
  const nativeBlockers = new Set(descriptor.blockers);
  const subagentTranscripts = relatedCounts.get("subagent-transcript") ?? 0;
  const subagentMetadata = relatedCounts.get("subagent-metadata") ?? 0;
  if (subagentTranscripts !== subagentMetadata) {
    findings.push(blocked("claude.native_relations.unsupported", Math.max(subagentTranscripts, subagentMetadata)));
  } else if (
    subagentTranscripts !== 0 && !nativeBlockers.has("claude.native.subagent_bundle_unverified")
  ) {
    findings.push({
      code: "claude.subagent_private_history.skipped",
      disposition: "skipped",
      count: subagentTranscripts,
    });
  }
  const checkpointBackups = relatedCounts.get("checkpoint-backup") ?? 0;
  if (
    checkpointBackups !== 0 && !nativeBlockers.has("claude.native.checkpoint_closure_unverified")
  ) {
    findings.push({
      code: "claude.file_checkpoint_state.skipped",
      disposition: "skipped",
      count: checkpointBackups,
    });
  }
  const retainedToolResults = relatedCounts.get("tool-result") ?? 0;
  const classifiedRetainedToolResults = materializedRetainedToolResults +
    skippedPrivateRetainedToolResults + inactiveRetainedToolResults + unmaterializedRetainedToolResults;
  if (
    retainedToolResults !== classifiedRetainedToolResults ||
    nativeBlockers.has("claude.native.tool_result_closure_unverified") ||
    unmaterializedRetainedToolResults !== 0
  ) {
    findings.push(blocked(
      "claude.retained_tool_result.unsupported",
      Math.max(1, retainedToolResults, unmaterializedRetainedToolResults),
    ));
  }
  if (materializedRetainedToolResults !== 0) {
    findings.push({
      code: "claude.retained_tool_result.managed",
      disposition: "synthesized",
      count: materializedRetainedToolResults,
    });
  }
  if (skippedPrivateRetainedToolResults !== 0) {
    findings.push({
      code: "claude.subagent_retained_tool_result.skipped",
      disposition: "skipped",
      count: skippedPrivateRetainedToolResults,
    });
  }
  if (inactiveRetainedToolResults !== 0) {
    findings.push({
      code: "claude.inactive_retained_tool_result.skipped",
      disposition: "skipped",
      count: inactiveRetainedToolResults,
    });
  }
  const taskEntries = relatedCounts.get("task-entry") ?? 0;
  const taskList = options.taskList;
  let historicalWorkState: Extract<PortableContextBlock, { readonly kind: "historical_work_state" }> | undefined;
  if (taskEntries !== (taskList?.tasks.length ?? 0)) {
    if (taskEntries !== 0) findings.push(blocked("claude.task_list.unsupported", taskEntries));
  } else if (taskList !== undefined) {
    const activeTasks = taskList.tasks.filter((task): task is ClaudeTaskItem & {
      readonly status: "pending" | "in_progress";
    } => task.status !== "completed");
    const activeIds = new Set(activeTasks.map((task) => task.id));
    const completedTasks = taskList.tasks.length - activeTasks.length;
    const metadataTasks = taskList.tasks.filter((task) => task.metadataPresent).length;
    if (activeTasks.length !== 0) {
      historicalWorkState = {
        kind: "historical_work_state",
        workState: {
          sourceKind: "task_list",
          items: activeTasks.map((task) => ({
            id: task.id,
            title: task.subject,
            description: task.description,
            ...(task.activeForm === undefined ? {} : { activeLabel: task.activeForm }),
            ...(task.owner === undefined ? {} : { assignee: task.owner }),
            status: task.status,
            blocks: task.blocks.filter((id) => activeIds.has(id)),
            blockedBy: task.blockedBy.filter((id) => activeIds.has(id)),
          })),
        },
      };
      findings.push({ code: "claude.task_list.degraded", disposition: "degraded", count: activeTasks.length });
    }
    if (completedTasks !== 0) {
      findings.push({ code: "claude.completed_task.skipped", disposition: "skipped", count: completedTasks });
    }
    if (metadataTasks !== 0) {
      findings.push({ code: "claude.task_metadata.skipped", disposition: "skipped", count: metadataTasks });
    }
  }
  const taskHighwatermarks = relatedCounts.get("task-highwatermark") ?? 0;
  if (taskHighwatermarks !== 0) {
    findings.push({
      code: "claude.task_highwatermark.skipped",
      disposition: "skipped",
      count: taskHighwatermarks,
    });
  }
  const sessionSidecars = relatedCounts.get("session-sidecar") ?? 0;
  if (sessionSidecars !== 0) {
    findings.push({
      code: "claude.session_sidecar.skipped",
      disposition: "skipped",
      count: sessionSidecars,
    });
  }
  const knownRelatedRoles = new Set([
    "subagent-transcript",
    "subagent-metadata",
    "checkpoint-backup",
    "tool-result",
    "session-sidecar",
    "task-entry",
    "task-highwatermark",
  ]);
  const unknownRelated = descriptor.relatedFiles.filter((file) => !knownRelatedRoles.has(file.role)).length;
  if (unknownRelated !== 0) findings.push(blocked("claude.native_relations.unsupported", unknownRelated));
  if (!path.isAbsolute(source.context)) findings.push(blocked("portable.working_directory.invalid"));
  if (materializedCompactionCheckpoints !== 0) {
    findings.push({
      code: "claude.compaction.materialized",
      disposition: "degraded",
      count: materializedCompactionCheckpoints,
    });
  }

  const native = objectValue(source.native);
  const transcript = objectValue(native?.transcript);
  const observedCwds = strings(transcript?.observedCwds);
  const observedRelocatedCwds = strings(transcript?.observedRelocatedCwds);
  const latestObservedCwd = typeof transcript?.latestObservedCwd === "string"
    ? transcript.latestObservedCwd
    : undefined;
  const relocatedCwd = typeof transcript?.relocatedCwd === "string"
    ? transcript.relocatedCwd
    : undefined;
  const graphDiscontinuities = integer(transcript?.graphDiscontinuities);
  const toolResultGraphReturns = integer(transcript?.toolResultGraphReturns);
  const nonMessageGraphRecords = integer(transcript?.nonMessageGraphRecords);
  const modelRefusalFallbackRecordCount = integer(transcript?.modelRefusalFallbackRecordCount);
  const turnDurationRecordCount = integer(transcript?.turnDurationRecordCount);
  const postToolUseHookRecordCount = integer(transcript?.postToolUseHookRecordCount);
  const stopHookRecordCount = integer(transcript?.stopHookRecordCount);
  const hookProgressRecordCount = integer(transcript?.hookProgressRecordCount);
  const hookNonBlockingErrorRecordCount = integer(transcript?.hookNonBlockingErrorRecordCount);
  const hookExecutionErrorRecordCount = integer(transcript?.hookExecutionErrorRecordCount);
  const hookCancelledRecordCount = integer(transcript?.hookCancelledRecordCount);
  const hookPermissionDecisionRecordCount = integer(transcript?.hookPermissionDecisionRecordCount);
  const structuredOutputRecordCount = integer(transcript?.structuredOutputRecordCount);
  const hookSystemMessageRecordCount = integer(transcript?.hookSystemMessageRecordCount);
  const awaySummaryRecordCount = integer(transcript?.awaySummaryRecordCount);
  const emptyTaskReminderRecordCount = integer(transcript?.emptyTaskReminderRecordCount);
  const taskReminderRecordCount = integer(transcript?.taskReminderRecordCount);
  const taskReminderItemCount = integer(transcript?.taskReminderItemCount);
  const taskReminderDetailItemCount = integer(transcript?.taskReminderDetailItemCount);
  const todoReminderRecordCount = integer(transcript?.todoReminderRecordCount);
  const todoReminderItemCount = integer(transcript?.todoReminderItemCount);
  const todoReminderDetailItemCount = integer(transcript?.todoReminderDetailItemCount);
  const queuedCommandRecordCount = integer(transcript?.queuedCommandRecordCount);
  const agentListingDeltaRecordCount = integer(transcript?.agentListingDeltaRecordCount);
  const skillListingRecordCount = integer(transcript?.skillListingRecordCount);
  const criticalSystemReminderRecordCount = integer(transcript?.criticalSystemReminderRecordCount);
  const nestedMemoryRecordCount = integer(transcript?.nestedMemoryRecordCount);
  const relevantMemoryRecordCount = integer(transcript?.relevantMemoryRecordCount);
  const relevantMemoryItemCount = integer(transcript?.relevantMemoryItemCount);
  const ambientUserContextRecordCount = integer(transcript?.ambientUserContextRecordCount);
  const editedImageRecordCount = integer(transcript?.editedImageRecordCount);
  const tokenUsageRecordCount = integer(transcript?.tokenUsageRecordCount);
  const totalTokensReminderRecordCount = integer(transcript?.totalTokensReminderRecordCount);
  const budgetUsdRecordCount = integer(transcript?.budgetUsdRecordCount);
  const toolSearchUsageReminderRecordCount = integer(transcript?.toolSearchUsageReminderRecordCount);
  const mcpInstructionsDeltaRecordCount = integer(transcript?.mcpInstructionsDeltaRecordCount);
  const mcpDroppedToolsDeltaRecordCount = integer(transcript?.mcpDroppedToolsDeltaRecordCount);
  const deferredToolsDeltaRecordCount = integer(transcript?.deferredToolsDeltaRecordCount);
  const commandPermissionsRecordCount = integer(transcript?.commandPermissionsRecordCount);
  const hookContextCarrierRecordCount = integer(transcript?.hookContextCarrierRecordCount);
  const hookAdditionalContextRecordCount = integer(transcript?.hookAdditionalContextRecordCount);
  const hookAdditionalContextValueCount = integer(transcript?.hookAdditionalContextValueCount);
  const asyncHookContextRecordCount = integer(transcript?.asyncHookContextRecordCount);
  const backgroundAgentRetryRecordCount = integer(transcript?.backgroundAgentRetryRecordCount);
  const backgroundAgentPeerMessageRecordCount = integer(transcript?.backgroundAgentPeerMessageRecordCount);
  const backgroundAgentNotificationRecordCount = integer(transcript?.backgroundAgentNotificationRecordCount);
  const compactBoundaryCount = integer(transcript?.compactBoundaryCount);
  const compactSummaryCount = integer(transcript?.compactSummaryCount);
  const apiCompactionBlockCount = integer(transcript?.apiCompactionBlockCount);
  const sessionTitleRecordCount = integer(transcript?.sessionTitleRecordCount);
  const sessionSummaryRecordCount = integer(transcript?.sessionSummaryRecordCount);
  const lastPromptRecordCount = integer(transcript?.lastPromptRecordCount);
  const queueOperationRecordCount = integer(transcript?.queueOperationRecordCount);
  const sessionEndRecordCount = integer(transcript?.sessionEndRecordCount);
  const fileCheckpointRecordCount = integer(transcript?.fileCheckpointRecordCount);
  const worktreeStateRecordCount = integer(transcript?.worktreeStateRecordCount);
  const permissionModeRecordCount = integer(transcript?.permissionModeRecordCount);
  const relocatedRecordCount = integer(transcript?.relocatedRecordCount);
  const agentDisplayRecordCount = integer(transcript?.agentDisplayRecordCount);
  const agentSettingRecordCount = integer(transcript?.agentSettingRecordCount);
  const sessionModeRecordCount = integer(transcript?.sessionModeRecordCount);
  const isolationLatchRecordCount = integer(transcript?.isolationLatchRecordCount);
  const sessionTagRecordCount = integer(transcript?.sessionTagRecordCount);
  const pullRequestLinkRecordCount = integer(transcript?.pullRequestLinkRecordCount);
  const frameLinkRecordCount = integer(transcript?.frameLinkRecordCount);
  const frameLinkReferenceCount = integer(transcript?.frameLinkReferenceCount);
  const bridgeSessionRecordCount = integer(transcript?.bridgeSessionRecordCount);
  const historySuppressionRecordCount = integer(transcript?.historySuppressionRecordCount);
  const observerRefRecordCount = integer(transcript?.observerRefRecordCount);
  const contentReplacementRecordCount = integer(transcript?.contentReplacementRecordCount);
  const contentReplacementItemCount = integer(transcript?.contentReplacementItemCount);
  const contentReplacementCurrentCount = integer(transcript?.contentReplacementCurrentCount);
  const contentReplacementAppliedCount = integer(transcript?.contentReplacementAppliedCount);
  const contentReplacementInactiveCount = integer(transcript?.contentReplacementInactiveCount);
  const contentReplacementUnsupportedCount = integer(transcript?.contentReplacementUnsupportedCount);
  const messageRetractionEpisodeCount = integer(transcript?.messageRetractionEpisodeCount);
  const messageRetractionRecordCount = integer(transcript?.messageRetractionRecordCount);
  const messageRetractionAppliedCount = integer(transcript?.messageRetractionAppliedCount);
  const messageRetractionUnsupportedCount = integer(transcript?.messageRetractionUnsupportedCount);
  const unknownNonGraphRecordCount = integer(transcript?.unknownNonGraphRecordCount);
  const nondurablePreservedMessages = integer(transcript?.nondurablePreservedMessages);
  if (
    observedCwds === undefined || observedRelocatedCwds === undefined ||
    latestObservedCwd === undefined || relocatedCwd === undefined ||
    graphDiscontinuities === undefined || toolResultGraphReturns === undefined ||
    nonMessageGraphRecords === undefined || modelRefusalFallbackRecordCount === undefined ||
    turnDurationRecordCount === undefined ||
    postToolUseHookRecordCount === undefined || stopHookRecordCount === undefined ||
    hookProgressRecordCount === undefined || hookNonBlockingErrorRecordCount === undefined ||
    hookExecutionErrorRecordCount === undefined ||
    hookCancelledRecordCount === undefined ||
    hookPermissionDecisionRecordCount === undefined ||
    structuredOutputRecordCount === undefined ||
    hookSystemMessageRecordCount === undefined ||
    awaySummaryRecordCount === undefined ||
    emptyTaskReminderRecordCount === undefined ||
    taskReminderRecordCount === undefined || taskReminderItemCount === undefined ||
    taskReminderDetailItemCount === undefined ||
    todoReminderRecordCount === undefined || todoReminderItemCount === undefined ||
    todoReminderDetailItemCount === undefined ||
    queuedCommandRecordCount === undefined || agentListingDeltaRecordCount === undefined ||
    skillListingRecordCount === undefined || criticalSystemReminderRecordCount === undefined ||
    nestedMemoryRecordCount === undefined || relevantMemoryRecordCount === undefined ||
    relevantMemoryItemCount === undefined || ambientUserContextRecordCount === undefined ||
    editedImageRecordCount === undefined ||
    tokenUsageRecordCount === undefined || totalTokensReminderRecordCount === undefined ||
    budgetUsdRecordCount === undefined || toolSearchUsageReminderRecordCount === undefined ||
    mcpInstructionsDeltaRecordCount === undefined ||
    mcpDroppedToolsDeltaRecordCount === undefined ||
    deferredToolsDeltaRecordCount === undefined ||
    commandPermissionsRecordCount === undefined ||
    hookContextCarrierRecordCount === undefined || hookAdditionalContextRecordCount === undefined ||
    hookAdditionalContextValueCount === undefined || asyncHookContextRecordCount === undefined ||
    backgroundAgentRetryRecordCount === undefined || backgroundAgentPeerMessageRecordCount === undefined ||
    backgroundAgentNotificationRecordCount === undefined ||
    compactBoundaryCount === undefined || compactSummaryCount === undefined ||
    apiCompactionBlockCount === undefined ||
    sessionTitleRecordCount === undefined || sessionSummaryRecordCount === undefined ||
    lastPromptRecordCount === undefined ||
    queueOperationRecordCount === undefined || sessionEndRecordCount === undefined ||
    fileCheckpointRecordCount === undefined || worktreeStateRecordCount === undefined ||
    permissionModeRecordCount === undefined || relocatedRecordCount === undefined ||
    agentDisplayRecordCount === undefined ||
    agentSettingRecordCount === undefined || sessionModeRecordCount === undefined ||
    isolationLatchRecordCount === undefined ||
    sessionTagRecordCount === undefined ||
    pullRequestLinkRecordCount === undefined ||
    frameLinkRecordCount === undefined || frameLinkReferenceCount === undefined ||
    bridgeSessionRecordCount === undefined ||
    historySuppressionRecordCount === undefined ||
    observerRefRecordCount === undefined ||
    contentReplacementRecordCount === undefined ||
    contentReplacementItemCount === undefined ||
    contentReplacementCurrentCount === undefined ||
    contentReplacementAppliedCount === undefined ||
    contentReplacementInactiveCount === undefined ||
    contentReplacementUnsupportedCount === undefined ||
    messageRetractionEpisodeCount === undefined ||
    messageRetractionRecordCount === undefined ||
    messageRetractionAppliedCount === undefined ||
    messageRetractionUnsupportedCount === undefined ||
    unknownNonGraphRecordCount === undefined ||
    (materializedCompactionCheckpoints !== 0 && nondurablePreservedMessages === undefined)
  ) {
    findings.push(blocked("claude.graph_capability.unavailable"));
  } else {
    const historicalCwdsValid = observedCwds.length !== 0 && observedCwds.every((value) =>
      path.isAbsolute(value) && path.normalize(value) === value);
    const relocatedCwdsValid = observedRelocatedCwds.every((value) =>
      path.isAbsolute(value) && path.normalize(value) === value);
    const effectiveCwd = relocatedRecordCount === 0 ? latestObservedCwd : relocatedCwd;
    const relocationStateValid = relocatedRecordCount === 0
      ? relocatedCwd === "" && observedRelocatedCwds.length === 0
      : path.isAbsolute(relocatedCwd) && path.normalize(relocatedCwd) === relocatedCwd &&
        observedRelocatedCwds.includes(relocatedCwd) && observedRelocatedCwds.length <= relocatedRecordCount;
    if (
      !historicalCwdsValid || !relocatedCwdsValid || !relocationStateValid ||
      !path.isAbsolute(latestObservedCwd) || path.normalize(latestObservedCwd) !== latestObservedCwd ||
      path.normalize(effectiveCwd) !== path.normalize(source.context)
    ) {
      findings.push(blocked("claude.working_directories.unsupported", Math.max(1, observedCwds.length)));
    }
    if (
      messageRetractionAppliedCount !== materializedMessageRetractions ||
      messageRetractionAppliedCount + messageRetractionUnsupportedCount !== messageRetractionEpisodeCount ||
      messageRetractionUnsupportedCount !== 0 ||
      messageRetractionRecordCount < messageRetractionEpisodeCount
    ) {
      findings.push(blocked(
        "claude.message_retraction.unsupported",
        Math.max(1, messageRetractionEpisodeCount, messageRetractionUnsupportedCount),
      ));
    } else if (messageRetractionAppliedCount !== 0) {
      findings.push({
        code: "claude.message_retraction.materialized",
        disposition: "degraded",
        count: messageRetractionAppliedCount,
      });
    }
    if (observedCwds.length > 1) {
      findings.push({
        code: "claude.working_directory_history.degraded",
        disposition: "degraded",
        count: observedCwds.length - 1,
      });
    }
    if (relocatedRecordCount !== 0) {
      findings.push({
        code: "claude.session_relocation.degraded",
        disposition: "degraded",
        count: relocatedRecordCount,
      });
    }
    if (toolResultGraphReturns > graphDiscontinuities) {
      findings.push(blocked("claude.graph_capability.unavailable"));
    } else {
      const unsupportedGraphDiscontinuities = graphDiscontinuities - toolResultGraphReturns;
      if (unsupportedGraphDiscontinuities !== 0) {
        findings.push(blocked("claude.message_graph.nonlinear", unsupportedGraphDiscontinuities));
      }
      if (toolResultGraphReturns !== 0) {
        findings.push({
          code: "claude.tool_graph.coalesced",
          disposition: "degraded",
          count: toolResultGraphReturns,
        });
      }
    }
    const otherNonMessageGraphRecords = Math.max(0, nonMessageGraphRecords - compactBoundaryCount);
    if (otherNonMessageGraphRecords !== 0) {
      findings.push(blocked("claude.non_message_graph.unprojectable", otherNonMessageGraphRecords));
    }
    if (modelRefusalFallbackRecordCount !== 0) {
      findings.push({
        code: "claude.model_refusal_fallback.skipped",
        disposition: "skipped",
        count: modelRefusalFallbackRecordCount,
      });
    }
    if (turnDurationRecordCount !== 0) {
      findings.push({
        code: "claude.turn_duration.skipped",
        disposition: "skipped",
        count: turnDurationRecordCount,
      });
    }
    if (postToolUseHookRecordCount !== 0) {
      findings.push({
        code: "claude.post_tool_use_hook_stdout.skipped",
        disposition: "skipped",
        count: postToolUseHookRecordCount,
      });
    }
    if (stopHookRecordCount !== 0) {
      findings.push({
        code: "claude.stop_hook_metadata.skipped",
        disposition: "skipped",
        count: stopHookRecordCount,
      });
    }
    if (hookProgressRecordCount !== 0) {
      findings.push({
        code: "claude.hook_progress.skipped",
        disposition: "skipped",
        count: hookProgressRecordCount,
      });
    }
    if (hookNonBlockingErrorRecordCount !== 0) {
      findings.push({
        code: "claude.hook_non_blocking_error.skipped",
        disposition: "skipped",
        count: hookNonBlockingErrorRecordCount,
      });
    }
    if (hookExecutionErrorRecordCount !== 0) {
      findings.push({
        code: "claude.hook_error_during_execution.skipped",
        disposition: "skipped",
        count: hookExecutionErrorRecordCount,
      });
    }
    if (hookCancelledRecordCount !== 0) {
      findings.push({
        code: "claude.hook_cancelled.skipped",
        disposition: "skipped",
        count: hookCancelledRecordCount,
      });
    }
    if (hookPermissionDecisionRecordCount !== 0) {
      findings.push({
        code: "claude.hook_permission_decision.skipped",
        disposition: "skipped",
        count: hookPermissionDecisionRecordCount,
      });
    }
    if (structuredOutputRecordCount !== 0) {
      findings.push({
        code: "claude.structured_output.closed",
        disposition: "exact",
        count: structuredOutputRecordCount,
      });
    }
    if (hookSystemMessageRecordCount !== 0) {
      findings.push({
        code: "claude.hook_system_message.skipped",
        disposition: "skipped",
        count: hookSystemMessageRecordCount,
      });
    }
    if (awaySummaryRecordCount !== 0) {
      findings.push({
        code: "claude.session_recap.skipped",
        disposition: "skipped",
        count: awaySummaryRecordCount,
      });
    }
    if (emptyTaskReminderRecordCount !== 0) {
      findings.push({
        code: "claude.empty_task_reminder.skipped",
        disposition: "skipped",
        count: emptyTaskReminderRecordCount,
      });
    }
    if (
      taskReminderItemCount < taskReminderRecordCount ||
      taskReminderDetailItemCount > taskReminderItemCount
    ) {
      findings.push(blocked("claude.task_reminder.unsupported", Math.max(1, taskReminderRecordCount)));
    } else {
      if (taskReminderRecordCount !== 0) {
        findings.push({
          code: "claude.task_reminder.degraded",
          disposition: "degraded",
          count: taskReminderRecordCount,
        });
      }
      if (taskReminderDetailItemCount !== 0) {
        findings.push({
          code: "claude.task_reminder_detail.skipped",
          disposition: "skipped",
          count: taskReminderDetailItemCount,
        });
      }
    }
    if (
      todoReminderItemCount < todoReminderRecordCount ||
      todoReminderDetailItemCount > todoReminderItemCount
    ) {
      findings.push(blocked("claude.todo_reminder.unsupported", Math.max(1, todoReminderRecordCount)));
    } else {
      if (todoReminderRecordCount !== 0) {
        findings.push({
          code: "claude.todo_reminder.degraded",
          disposition: "degraded",
          count: todoReminderRecordCount,
        });
      }
      if (todoReminderDetailItemCount !== 0) {
        findings.push({
          code: "claude.todo_reminder_detail.skipped",
          disposition: "skipped",
          count: todoReminderDetailItemCount,
        });
      }
    }
    if (queuedCommandRecordCount !== 0) {
      findings.push({
        code: "claude.queued_command.skipped",
        disposition: "skipped",
        count: queuedCommandRecordCount,
      });
    }
    if (agentListingDeltaRecordCount !== 0) {
      findings.push({
        code: "claude.agent_listing.skipped",
        disposition: "skipped",
        count: agentListingDeltaRecordCount,
      });
    }
    if (skillListingRecordCount !== 0) {
      findings.push({
        code: "claude.skill_listing.degraded",
        disposition: "degraded",
        count: skillListingRecordCount,
      });
    }
    if (criticalSystemReminderRecordCount !== 0) {
      findings.push({
        code: "claude.critical_system_reminder.degraded",
        disposition: "degraded",
        count: criticalSystemReminderRecordCount,
      });
    }
    if (nestedMemoryRecordCount !== 0) {
      findings.push({
        code: "claude.nested_memory.degraded",
        disposition: "degraded",
        count: nestedMemoryRecordCount,
      });
    }
    if (relevantMemoryItemCount !== 0) {
      findings.push({
        code: "claude.relevant_memories.degraded",
        disposition: "degraded",
        count: relevantMemoryItemCount,
      });
    }
    if (ambientUserContextRecordCount !== 0) {
      findings.push({
        code: "claude.ambient_user_context.degraded",
        disposition: "degraded",
        count: ambientUserContextRecordCount,
      });
    }
    if (editedImageRecordCount !== 0) {
      findings.push({
        code: "claude.edited_image_file.skipped",
        disposition: "skipped",
        count: editedImageRecordCount,
      });
    }
    if (tokenUsageRecordCount !== 0) {
      findings.push({
        code: "claude.token_usage.skipped",
        disposition: "skipped",
        count: tokenUsageRecordCount,
      });
    }
    if (totalTokensReminderRecordCount !== 0) {
      findings.push({
        code: "claude.total_tokens_reminder.skipped",
        disposition: "skipped",
        count: totalTokensReminderRecordCount,
      });
    }
    if (budgetUsdRecordCount !== 0) {
      findings.push({
        code: "claude.budget_usd.skipped",
        disposition: "skipped",
        count: budgetUsdRecordCount,
      });
    }
    if (toolSearchUsageReminderRecordCount !== 0) {
      findings.push({
        code: "claude.tool_search_usage_reminder.skipped",
        disposition: "skipped",
        count: toolSearchUsageReminderRecordCount,
      });
    }
    if (mcpInstructionsDeltaRecordCount !== 0) {
      findings.push({
        code: "claude.mcp_instructions_delta.degraded",
        disposition: "degraded",
        count: mcpInstructionsDeltaRecordCount,
      });
    }
    if (mcpDroppedToolsDeltaRecordCount !== 0) {
      findings.push({
        code: "claude.mcp_dropped_tools_delta.skipped",
        disposition: "skipped",
        count: mcpDroppedToolsDeltaRecordCount,
      });
    }
    if (deferredToolsDeltaRecordCount !== 0) {
      findings.push({
        code: "claude.deferred_tools_delta.skipped",
        disposition: "skipped",
        count: deferredToolsDeltaRecordCount,
      });
    }
    if (commandPermissionsRecordCount !== 0) {
      findings.push({
        code: "claude.command_permissions.skipped",
        disposition: "skipped",
        count: commandPermissionsRecordCount,
      });
    }
    if (hookContextCarrierRecordCount !== 0) {
      findings.push({
        code: "claude.hook_context_carrier.skipped",
        disposition: "skipped",
        count: hookContextCarrierRecordCount,
      });
    }
    if (hookAdditionalContextValueCount !== 0) {
      findings.push({
        code: "claude.hook_additional_context.degraded",
        disposition: "degraded",
        count: hookAdditionalContextValueCount,
      });
    }
    if (asyncHookContextRecordCount !== 0) {
      findings.push({
        code: "claude.async_hook_context.degraded",
        disposition: "degraded",
        count: asyncHookContextRecordCount,
      });
    }
    if (backgroundAgentRetryRecordCount !== 0) {
      findings.push({
        code: "claude.background_agent_retry.degraded",
        disposition: "degraded",
        count: backgroundAgentRetryRecordCount,
      });
    }
    if (backgroundAgentPeerMessageRecordCount !== 0) {
      findings.push({
        code: "claude.background_agent_peer_message.degraded",
        disposition: "degraded",
        count: backgroundAgentPeerMessageRecordCount,
      });
    }
    if (backgroundAgentNotificationRecordCount !== 0) {
      findings.push({
        code: "claude.background_agent_notification.degraded",
        disposition: "degraded",
        count: backgroundAgentNotificationRecordCount,
      });
    }
    if (compactBoundaryCount !== 0 || compactSummaryCount !== 0 || apiCompactionBlockCount !== 0) {
      findings.push(blocked(
        "claude.compaction.unsupported",
        Math.max(compactBoundaryCount, compactSummaryCount, apiCompactionBlockCount),
      ));
    }
    if (nondurablePreservedMessages !== undefined && nondurablePreservedMessages !== 0) {
      findings.push({
        code: "claude.compaction_nondurable_message.skipped",
        disposition: "skipped",
        count: nondurablePreservedMessages,
      });
    }
    if (sessionTitleRecordCount !== 0) {
      findings.push({
        code: "claude.session_title.preserved",
        disposition: "exact",
        count: 1,
      });
      if (sessionTitleRecordCount > 1) findings.push({
        code: "claude.session_title_revision.skipped",
        disposition: "skipped",
        count: sessionTitleRecordCount - 1,
      });
    }
    if (sessionSummaryRecordCount !== 0) {
      findings.push({
        code: "claude.session_summary_index.skipped",
        disposition: "skipped",
        count: sessionSummaryRecordCount,
      });
    }
    if (lastPromptRecordCount !== 0) {
      findings.push({
        code: "claude.resume_index.skipped",
        disposition: "skipped",
        count: lastPromptRecordCount,
      });
    }
    if (queueOperationRecordCount !== 0) {
      findings.push({
        code: "claude.command_queue_audit.skipped",
        disposition: "skipped",
        count: queueOperationRecordCount,
      });
    }
    if (sessionEndRecordCount !== 0) {
      findings.push({
        code: "claude.session_end_marker.skipped",
        disposition: "skipped",
        count: sessionEndRecordCount,
      });
    }
    if (fileCheckpointRecordCount !== 0) {
      findings.push({
        code: "claude.file_checkpoint_record.skipped",
        disposition: "skipped",
        count: fileCheckpointRecordCount,
      });
    }
    if (worktreeStateRecordCount !== 0) {
      findings.push({
        code: "claude.worktree_binding.skipped",
        disposition: "skipped",
        count: worktreeStateRecordCount,
      });
    }
    if (permissionModeRecordCount !== 0) {
      findings.push({
        code: "claude.permission_mode.skipped",
        disposition: "skipped",
        count: permissionModeRecordCount,
      });
    }
    if (agentDisplayRecordCount !== 0) {
      findings.push({
        code: "claude.agent_display.skipped",
        disposition: "skipped",
        count: agentDisplayRecordCount,
      });
    }
    if (agentSettingRecordCount !== 0) {
      findings.push({
        code: "claude.session_agent.skipped",
        disposition: "skipped",
        count: agentSettingRecordCount,
      });
    }
    if (sessionModeRecordCount !== 0) {
      findings.push({
        code: "claude.session_mode.skipped",
        disposition: "skipped",
        count: sessionModeRecordCount,
      });
    }
    if (isolationLatchRecordCount !== 0) {
      findings.push({
        code: "claude.isolation_latch.skipped",
        disposition: "skipped",
        count: isolationLatchRecordCount,
      });
    }
    if (sessionTagRecordCount !== 0) {
      findings.push({
        code: "claude.session_tag.skipped",
        disposition: "skipped",
        count: sessionTagRecordCount,
      });
    }
    if (pullRequestLinkRecordCount !== 0) {
      findings.push({
        code: "claude.session_pull_request.reference_preserved",
        disposition: "degraded",
        count: 1,
      });
      if (pullRequestLinkRecordCount > 1) findings.push({
        code: "claude.session_pull_request_revision.skipped",
        disposition: "skipped",
        count: pullRequestLinkRecordCount - 1,
      });
    }
    if (frameLinkReferenceCount !== 0) {
      findings.push({
        code: "claude.session_artifact.reference_preserved",
        disposition: "degraded",
        count: frameLinkReferenceCount,
      });
    }
    if (frameLinkRecordCount > frameLinkReferenceCount) {
      findings.push({
        code: "claude.session_artifact_revision.skipped",
        disposition: "skipped",
        count: frameLinkRecordCount - frameLinkReferenceCount,
      });
    }
    if (bridgeSessionRecordCount !== 0) {
      findings.push({
        code: "claude.remote_control_binding.skipped",
        disposition: "skipped",
        count: bridgeSessionRecordCount,
      });
    }
    if (historySuppressionRecordCount !== 0) {
      findings.push({
        code: "claude.history_backfill_suppression.skipped",
        disposition: "skipped",
        count: historySuppressionRecordCount,
      });
    }
    if (observerRefRecordCount !== 0) {
      findings.push({
        code: "claude.observer_binding.skipped",
        disposition: "skipped",
        count: observerRefRecordCount,
      });
    }
    if (
      contentReplacementRecordCount > contentReplacementItemCount ||
      contentReplacementCurrentCount > contentReplacementItemCount ||
      contentReplacementCurrentCount !== contentReplacementAppliedCount +
        contentReplacementInactiveCount + contentReplacementUnsupportedCount ||
      contentReplacementAppliedCount !== materializedContentReplacements
    ) {
      findings.push(blocked("claude.content_replacement.unsupported", Math.max(
        1,
        contentReplacementRecordCount,
        contentReplacementItemCount,
      )));
    } else {
      if (contentReplacementItemCount > contentReplacementCurrentCount) {
        findings.push({
          code: "claude.content_replacement_revision.skipped",
          disposition: "skipped",
          count: contentReplacementItemCount - contentReplacementCurrentCount,
        });
      }
      if (contentReplacementInactiveCount !== 0) {
        findings.push({
          code: "claude.content_replacement_inactive.skipped",
          disposition: "skipped",
          count: contentReplacementInactiveCount,
        });
      }
      if (contentReplacementUnsupportedCount !== 0) {
        findings.push(blocked("claude.content_replacement.unsupported", contentReplacementUnsupportedCount));
      }
    }
    if (unknownNonGraphRecordCount !== 0) {
      findings.push(blocked("claude.non_graph_record.unprojectable", unknownNonGraphRecordCount));
    }
  }

  const contentCounts = new Map<string, number>();
  const messages: PortableContextMessage[] = [];
  let previousRole: "user" | "assistant" | undefined;
  let previousTime = Number.NEGATIVE_INFINITY;
  let invalidTimestamp = 0;
  let invalidContent = 0;
  let invalidSequence = 0;
  let toolEvidence = 0;
  let resourceEvidence = 0;
  let referenceEvidence = 0;
  let reasoningSummary = 0;
  let assistantErrors = 0;
  let assistantCompletionFailures = 0;
  let coalescedCompactionUserMessages = 0;
  let inCompactionUserPrefix = false;
  const pendingHistoricalBlocks: Array<Extract<
    PortableContextBlock,
    { readonly kind: "historical_context" | "historical_work_state" }
  >> = [];
  let pendingHistoricalBlockTimestamp = "";
  let hookContextEvidence = 0;
  let skillListingEvidence = 0;
  let criticalSystemReminderEvidence = 0;
  let nestedMemoryEvidence = 0;
  let relevantMemoryRecordEvidence = 0;
  let relevantMemoryEvidence = 0;
  let ambientUserContextEvidence = 0;
  let mcpInstructionsDeltaEvidence = 0;
  let backgroundAgentRetryEvidence = 0;
  let backgroundAgentPeerMessageEvidence = 0;
  let backgroundAgentNotificationEvidence = 0;
  let taskReminderEvidence = 0;
  let taskReminderItemEvidence = 0;
  let todoReminderEvidence = 0;
  let todoReminderItemEvidence = 0;
  const sessionReferences: Array<Extract<
    PortableContextBlock,
    { readonly kind: "historical_reference" }
  >> = [];
  const portableNotes = new Map<string, number>();
  for (const item of source.conversation) {
    if (item.kind === "gap") {
      if (item.code === "claude.compact_summary.unprojectable") continue;
      if (item.code === "claude.assistant_error.unsupported") {
        assistantErrors++;
        continue;
      }
      if (item.code === "claude.assistant_completion.unsupported") {
        assistantCompletionFailures++;
        continue;
      }
      const kind = item.code?.startsWith("claude.content.") ? item.code.slice("claude.content.".length) : "unknown";
      classifyKind(kind, contentCounts);
      continue;
    }
    if (item.role === "system" && item.contentKinds?.length === 1 && item.contentKinds[0] === "compact_summary") {
      continue;
    }
    const itemContentKinds = item.contentKinds ?? [];
    const sessionReferenceKind = itemContentKinds.length === 1 &&
      SESSION_REFERENCE_KINDS.has(itemContentKinds[0]!);
    if (item.role === "system" && sessionReferenceKind) {
      const blocks = item.portableBlocks;
      const references = blocks?.filter((block): block is Extract<
        PortableContextBlock,
        { readonly kind: "historical_reference" }
      > => block.kind === "historical_reference");
      if (
        blocks === undefined || references === undefined || references.length !== 1 ||
        references.length !== blocks.length || item.text === "" ||
        references[0]!.reference.namespace !==
          (itemContentKinds[0] === "session_pull_request" ? "claude.pull_request" : "claude.artifact") ||
        !validHistoricalReference(references[0]!.reference)
      ) {
        invalidContent++;
      } else {
        sessionReferences.push(references[0]!);
      }
      continue;
    }
    const historicalContextKind = itemContentKinds.length !== 0 &&
      itemContentKinds.every((kind) => kind === itemContentKinds[0]) &&
      HISTORICAL_CONTEXT_KINDS.has(itemContentKinds[0]!)
      ? itemContentKinds[0]
      : undefined;
    if (item.role === "system" && historicalContextKind !== undefined) {
      const instant = Date.parse(item.timestamp);
      if (!Number.isFinite(instant) || instant < previousTime) invalidTimestamp++;
      if (Number.isFinite(instant)) previousTime = instant;
      const blocks = item.portableBlocks;
      const contexts = blocks?.filter((block): block is Extract<
        PortableContextBlock,
        { readonly kind: "historical_context" }
      > => block.kind === "historical_context");
      if (
        blocks === undefined || contexts === undefined || contexts.length === 0 ||
        contexts.length !== blocks.length || contexts.length !== itemContentKinds.length ||
        contexts.some((block) => block.context.sourceRole !== "system" || block.context.text === "") ||
        contexts.map((block) => block.context.text).join("\n\n") !== item.text
      ) {
        invalidContent++;
        continue;
      }
      if (historicalContextKind === "hook_additional_context") hookContextEvidence += contexts.length;
      else if (historicalContextKind === "skill_listing") skillListingEvidence += contexts.length;
      else if (historicalContextKind === "critical_system_reminder") {
        criticalSystemReminderEvidence += contexts.length;
      } else if (historicalContextKind === "mcp_instructions_delta") {
        mcpInstructionsDeltaEvidence += contexts.length;
      } else if (historicalContextKind === "nested_memory") {
        nestedMemoryEvidence += contexts.length;
      } else if (historicalContextKind === "relevant_memories") {
        relevantMemoryRecordEvidence++;
        relevantMemoryEvidence += contexts.length;
      } else if (historicalContextKind === "ambient_user_context") {
        ambientUserContextEvidence += contexts.length;
      } else if (historicalContextKind === "background_agent_retry") {
        backgroundAgentRetryEvidence += contexts.length;
      } else if (historicalContextKind === "background_agent_peer_message") {
        backgroundAgentPeerMessageEvidence += contexts.length;
      } else {
        backgroundAgentNotificationEvidence += contexts.length;
      }
      const previous = messages.at(-1);
      if (pendingHistoricalBlocks.length === 0 && previous?.role === "user") {
        const combined: PortableContextMessage = {
          ...previous,
          blocks: [...previous.blocks, ...contexts],
        };
        try { renderPortableContextMessage({ sourceAgent: "claude" }, combined); } catch { invalidContent++; }
        messages[messages.length - 1] = combined;
      } else {
        pendingHistoricalBlocks.push(...contexts);
        pendingHistoricalBlockTimestamp = Number.isFinite(instant)
          ? new Date(instant).toISOString()
          : item.timestamp;
      }
      continue;
    }
    if (
      item.role === "system" && itemContentKinds.length === 1 &&
      (itemContentKinds[0] === "task_reminder" || itemContentKinds[0] === "todo_reminder")
    ) {
      const instant = Date.parse(item.timestamp);
      if (!Number.isFinite(instant) || instant < previousTime) invalidTimestamp++;
      if (Number.isFinite(instant)) previousTime = instant;
      const blocks = item.portableBlocks;
      const workStates = blocks?.filter((block): block is Extract<
        PortableContextBlock,
        { readonly kind: "historical_work_state" }
      > => block.kind === "historical_work_state");
      if (
        blocks === undefined || workStates === undefined || blocks.length !== 1 || workStates.length !== 1 ||
        workStates[0]!.workState.sourceKind !== itemContentKinds[0] ||
        workStates[0]!.workState.items.length === 0 ||
        workStates[0]!.workState.items.some((task) =>
          task.description !== "" || task.activeLabel !== undefined || task.assignee !== undefined ||
          task.priority !== undefined || task.blocks.length !== 0 || task.blockedBy.length !== 0) ||
        item.text !== workStates[0]!.workState.items.map((task) => {
          const prefix = itemContentKinds[0] === "task_reminder" ? `#${task.id}` : task.id;
          return `${prefix}. [${task.status}] ${task.title}`;
        }).join("\n")
      ) {
        invalidContent++;
        continue;
      }
      const workState = workStates[0]!;
      const previous = messages.at(-1);
      if (previous?.role === "user" && pendingHistoricalBlocks.length === 0) {
        const combined: PortableContextMessage = {
          ...previous,
          blocks: [...previous.blocks, workState],
        };
        try { renderPortableContextMessage({ sourceAgent: "claude" }, combined); } catch { invalidContent++; }
        messages[messages.length - 1] = combined;
      } else {
        pendingHistoricalBlocks.push(workState);
        pendingHistoricalBlockTimestamp = Number.isFinite(instant)
          ? new Date(instant).toISOString()
          : item.timestamp;
      }
      if (itemContentKinds[0] === "task_reminder") {
        taskReminderEvidence++;
        taskReminderItemEvidence += workState.workState.items.length;
      } else {
        todoReminderEvidence++;
        todoReminderItemEvidence += workState.workState.items.length;
      }
      continue;
    }
    if (item.role !== "user" && item.role !== "assistant") {
      findings.push(blocked("portable.message_role.unsupported"));
      continue;
    }
    if (item.contentKinds === undefined) {
      findings.push(blocked("claude.content_kinds.unavailable"));
    } else {
      item.contentKinds.forEach((kind) => classifyKind(kind, contentCounts));
    }
    const blocks = item.portableBlocks;
    const textKinds = item.contentKinds?.filter((kind) => kind === "text").length ?? 0;
    const observedTools = item.contentKinds?.filter((kind) => kind.includes("tool")).length ?? 0;
    const projectedTools = blocks?.filter((block) => block.kind === "historical_tool").length ?? 0;
    const observedResources = item.contentKinds?.filter((kind) => RESOURCE_KINDS.has(kind)).length ?? 0;
    const projectedResources = blocks?.filter((block) => block.kind === "historical_resource").length ?? 0;
    const observedReferences = item.contentKinds?.filter((kind) => REFERENCE_KINDS.has(kind)).length ?? 0;
    const projectedReferences = blocks?.filter((block) => block.kind === "historical_reference").length ?? 0;
    const observedReasoning = item.contentKinds?.filter((kind) => REASONING_KINDS.has(kind)).length ?? 0;
    const projectedReasoning = blocks?.filter((block) => block.kind === "historical_reasoning").length ?? 0;
    const projectedCitations = blocks?.filter((block) => block.kind === "historical_citations").length ?? 0;
    const projectedEvents = blocks?.filter((block) => block.kind === "historical_event").length ?? 0;
    const toolsValid = blocks !== undefined && observedTools === projectedTools &&
      (item.role === "assistant" || projectedTools === 0) && hasClosedHistoricalToolSequence(blocks);
    const resourcesValid = observedResources === projectedResources &&
      (item.role === "user" || projectedResources === 0);
    const referencesValid = observedReferences === projectedReferences;
    const reasoningValid = projectedReasoning <= observedReasoning &&
      (item.role === "assistant" || projectedReasoning === 0);
    const eventsValid = projectedEvents === (item.contentKinds?.filter((kind) => kind === "historical_event").length ?? 0) &&
      (item.role === "assistant" || projectedEvents === 0);
    if (
      blocks === undefined ||
      blocks.length !== textKinds + projectedTools + projectedResources + projectedReferences + projectedReasoning +
        projectedCitations + projectedEvents ||
      !toolsValid || !resourcesValid || !referencesValid || !reasoningValid || !eventsValid
    ) {
      invalidContent++;
    } else {
      toolEvidence += projectedTools;
      resourceEvidence += projectedResources;
      referenceEvidence += projectedReferences;
      reasoningSummary += projectedReasoning;
    }
    if (item.portableNotes?.includes(CLAUDE_COMPACTION_SUMMARY_NOTE)) {
      inCompactionUserPrefix = true;
    }
    for (const note of item.portableNotes ?? []) {
      if (note === CLAUDE_COMPACTION_SUMMARY_NOTE) continue;
      portableNotes.set(note, (portableNotes.get(note) ?? 0) + 1);
    }
    const instant = Date.parse(item.timestamp);
    if (!Number.isFinite(instant) || instant < previousTime) invalidTimestamp++;
    if (Number.isFinite(instant)) previousTime = instant;
    let messageBlocks = blocks ?? [];
    if (pendingHistoricalBlocks.length !== 0) {
      if (item.role === "user") {
        messageBlocks = [...pendingHistoricalBlocks, ...messageBlocks];
      } else {
        const contextMessage: PortableContextMessage = {
          ordinal: messages.length,
          role: "user",
          blocks: [...pendingHistoricalBlocks],
          timestamp: pendingHistoricalBlockTimestamp,
          model: "",
        };
        if (previousRole === "user") invalidSequence++;
        try { renderPortableContextMessage({ sourceAgent: "claude" }, contextMessage); } catch { invalidContent++; }
        messages.push(contextMessage);
        previousRole = "user";
      }
      pendingHistoricalBlocks.length = 0;
      pendingHistoricalBlockTimestamp = "";
    }
    const message: PortableContextMessage = {
      ordinal: messages.length,
      role: item.role,
      blocks: messageBlocks,
      timestamp: Number.isFinite(instant) ? new Date(instant).toISOString() : item.timestamp,
      model: item.role === "assistant" ? (item.model ?? source.model) : "",
    };
    if (item.role === "assistant") inCompactionUserPrefix = false;
    if (previousRole === "user" && item.role === "user" && inCompactionUserPrefix) {
      const previous = messages.at(-1)!;
      const combined: PortableContextMessage = {
        ...previous,
        blocks: [...previous.blocks, ...message.blocks],
        timestamp: message.timestamp,
      };
      if (blocks !== undefined) {
        try { renderPortableContextMessage({ sourceAgent: "claude" }, combined); } catch { invalidContent++; }
      }
      messages[messages.length - 1] = combined;
      coalescedCompactionUserMessages++;
      continue;
    }
    if (previousRole === item.role) invalidSequence++;
    previousRole = item.role;
    if (blocks !== undefined) {
      try { renderPortableContextMessage({ sourceAgent: "claude" }, message); } catch { invalidContent++; }
    }
    messages.push(message);
  }
  if (pendingHistoricalBlocks.length !== 0) {
    const contextMessage: PortableContextMessage = {
      ordinal: messages.length,
      role: "user",
      blocks: [...pendingHistoricalBlocks],
      timestamp: pendingHistoricalBlockTimestamp,
      model: "",
    };
    if (previousRole === "user") invalidSequence++;
    try { renderPortableContextMessage({ sourceAgent: "claude" }, contextMessage); } catch { invalidContent++; }
    messages.push(contextMessage);
  }
  if (historicalWorkState !== undefined) {
    const userIndex = messages.findLastIndex((message) => message.role === "user");
    if (userIndex < 0) {
      invalidContent++;
    } else {
      const user = messages[userIndex]!;
      const combined: PortableContextMessage = { ...user, blocks: [...user.blocks, historicalWorkState] };
      try { renderPortableContextMessage({ sourceAgent: "claude" }, combined); } catch { invalidContent++; }
      messages[userIndex] = combined;
    }
  }
  const pullRequestReferences = sessionReferences.filter((block) =>
    block.reference.namespace === "claude.pull_request");
  const artifactReferences = sessionReferences.filter((block) =>
    block.reference.namespace === "claude.artifact");
  if (
    pullRequestReferences.length !== (pullRequestLinkRecordCount === 0 ? 0 : 1) ||
    artifactReferences.length !== frameLinkReferenceCount ||
    new Set(artifactReferences.map((block) => block.reference.locator)).size !== artifactReferences.length
  ) invalidContent++;
  if ((portableNotes.get(CLAUDE_CONTENT_REPLACEMENT_NOTE) ?? 0) !== materializedContentReplacements) {
    invalidContent++;
  }
  if (sessionReferences.length !== 0) {
    const userIndex = messages.findLastIndex((message) => message.role === "user");
    if (userIndex < 0) {
      invalidContent++;
    } else {
      const user = messages[userIndex]!;
      const combined: PortableContextMessage = { ...user, blocks: [...user.blocks, ...sessionReferences] };
      try { renderPortableContextMessage({ sourceAgent: "claude" }, combined); } catch { invalidContent++; }
      messages[userIndex] = combined;
    }
  }
  if (
    hookAdditionalContextValueCount !== undefined && asyncHookContextRecordCount !== undefined &&
    hookContextEvidence !== hookAdditionalContextValueCount + asyncHookContextRecordCount
  ) invalidContent++;
  if (skillListingRecordCount !== undefined && skillListingEvidence !== skillListingRecordCount) {
    invalidContent++;
  }
  if (
    criticalSystemReminderRecordCount !== undefined &&
    criticalSystemReminderEvidence !== criticalSystemReminderRecordCount
  ) {
    invalidContent++;
  }
  if (nestedMemoryRecordCount !== undefined && nestedMemoryEvidence !== nestedMemoryRecordCount) {
    invalidContent++;
  }
  if (
    relevantMemoryRecordCount !== undefined && relevantMemoryItemCount !== undefined &&
    (relevantMemoryRecordEvidence !== relevantMemoryRecordCount ||
      relevantMemoryRecordCount > relevantMemoryItemCount ||
      relevantMemoryEvidence !== relevantMemoryItemCount)
  ) {
    invalidContent++;
  }
  if (
    ambientUserContextRecordCount !== undefined &&
    ambientUserContextEvidence !== ambientUserContextRecordCount
  ) {
    invalidContent++;
  }
  if (
    mcpInstructionsDeltaRecordCount !== undefined &&
    mcpInstructionsDeltaEvidence !== mcpInstructionsDeltaRecordCount
  ) {
    invalidContent++;
  }
  if (
    taskReminderRecordCount !== undefined && taskReminderEvidence !== taskReminderRecordCount ||
    taskReminderItemCount !== undefined && taskReminderItemEvidence !== taskReminderItemCount
  ) {
    invalidContent++;
  }
  if (
    todoReminderRecordCount !== undefined && todoReminderEvidence !== todoReminderRecordCount ||
    todoReminderItemCount !== undefined && todoReminderItemEvidence !== todoReminderItemCount
  ) {
    invalidContent++;
  }
  if (
    backgroundAgentRetryRecordCount !== undefined &&
      backgroundAgentRetryEvidence !== backgroundAgentRetryRecordCount ||
    backgroundAgentPeerMessageRecordCount !== undefined &&
      backgroundAgentPeerMessageEvidence !== backgroundAgentPeerMessageRecordCount ||
    backgroundAgentNotificationRecordCount !== undefined &&
      backgroundAgentNotificationEvidence !== backgroundAgentNotificationRecordCount
  ) invalidContent++;
  const reasoning = Math.max(0, (contentCounts.get("reasoning") ?? 0) - reasoningSummary);
  const tool = contentCounts.get("tool") ?? 0;
  const resource = contentCounts.get("resource") ?? 0;
  const reference = contentCounts.get("reference") ?? 0;
  const unknown = contentCounts.get("unknown") ?? 0;
  if (reasoning !== 0) findings.push({ code: "claude.reasoning.skipped", disposition: "skipped", count: reasoning });
  if (reasoningSummary !== 0) {
    findings.push({ code: "claude.reasoning_summary.degraded", disposition: "degraded", count: reasoningSummary });
  }
  if (toolEvidence !== 0) {
    findings.push({ code: "claude.tool_history.degraded", disposition: "degraded", count: toolEvidence });
  }
  if (tool > toolEvidence) findings.push(blocked("claude.tool_history.unprojectable", tool - toolEvidence));
  if (resource > resourceEvidence) {
    findings.push(blocked("claude.resource_history.unprojectable", resource - resourceEvidence));
  }
  if (reference > referenceEvidence) {
    findings.push(blocked("claude.reference_history.unprojectable", reference - referenceEvidence));
  }
  if (unknown !== 0) findings.push(blocked("claude.native_content.unprojectable", unknown));
  if (assistantErrors !== 0) findings.push(blocked("claude.assistant_error.unsupported", assistantErrors));
  if (assistantCompletionFailures !== 0) {
    findings.push(blocked("claude.assistant_completion.unsupported", assistantCompletionFailures));
  }
  if (coalescedCompactionUserMessages !== 0) {
    findings.push({
      code: "claude.compaction_user_messages.coalesced",
      disposition: "degraded",
      count: coalescedCompactionUserMessages,
    });
  }
  const skippedNotes = new Set([
    "claude.tool_result_mirror.skipped",
    "claude.tool_source_identity.skipped",
    "claude.server_advisor_encrypted_content.skipped",
    "claude.server_code_execution_encrypted_stdout.skipped",
    "claude.mcp_server_configuration.skipped",
    "claude.server_tool_caller.skipped",
    "claude.server_web_search_encrypted_content.skipped",
    "claude.api_compaction_encrypted_content.skipped",
    "claude.tool_cache_control.skipped",
    "claude.assistant_stop_reason.skipped",
    "claude.thinking_signature.skipped",
  ]);
  const degradedNotes = new Set([
    "claude.assistant_truncation.materialized",
    "claude.compaction_preserved_timestamp.rebased",
    CLAUDE_CONTENT_REPLACEMENT_NOTE,
    "claude.container_upload.reference_only",
    "claude.server_pause_turn.materialized",
    "claude.server_execution_output_file.reference_only",
    "claude.tool_carriers.coalesced",
    "claude.user_document_file.reference_only",
    "claude.user_document_url.reference_only",
    "claude.user_image_file.reference_only",
    "claude.user_image_url.reference_only",
    "claude.tool_result_document_file.reference_only",
    "claude.tool_result_document_url.reference_only",
    "claude.tool_result_image_file.reference_only",
    "claude.tool_result_image_url.reference_only",
  ]);
  const synthesizedNotes = new Set([
    "claude.read_resource.managed",
    "claude.read_image_resource.managed",
    "claude.read_pdf_resource.managed",
    "claude.repl_resource.managed",
    "claude.pre_tool_use_block.preserved",
    "claude.tool_result_resource.managed",
    "claude.tool_search_result.preserved",
    "claude.tool_reference.preserved",
    "claude.tool_content_document.preserved",
    "claude.server_tool_search_result.preserved",
    "claude.text_citations.preserved",
    "claude.server_web_fetch_resource.managed",
    "claude.user_image.managed",
    "claude.user_document.managed",
    "claude.background_agent_launch.materialized",
  ]);
  const blockedNotes = new Set([
    "claude.tool_control_content.invalid",
    "claude.tool_relation.invalid",
    "claude.tool_result_mirror.invalid",
    "claude.assistant_error.unsupported",
    "claude.assistant_completion.unsupported",
    "claude.api_compaction.unsupported",
  ]);
  for (const [code, count] of portableNotes) {
    if (skippedNotes.has(code)) findings.push({ code, disposition: "skipped", count });
    else if (degradedNotes.has(code)) findings.push({ code, disposition: "degraded", count });
    else if (synthesizedNotes.has(code)) findings.push({ code, disposition: "synthesized", count });
    else if (blockedNotes.has(code)) findings.push(blocked(code, count));
    else findings.push(blocked("claude.tool_note.unknown", count));
  }
  if (messages.length === 0) findings.push(blocked("portable.messages.empty"));
  if (messages[0]?.role !== "user" || messages.at(-1)?.role !== "assistant") invalidSequence++;
  if (invalidTimestamp !== 0) findings.push(blocked("portable.message_timestamp.invalid", invalidTimestamp));
  if (invalidContent !== 0) findings.push(blocked("portable.message_content.invalid", invalidContent));
  if (invalidSequence !== 0) findings.push(blocked("portable.message_sequence.unsupported", invalidSequence));

  findings.push({ code: "claude.native_envelope.skipped", disposition: "skipped", count: 1 });
  const normalized = normalizeConversionFindings(findings);
  const status = conversionStatus(normalized);
  if (status === "blocked") return { status, findings: normalized };
  return {
    status,
    findings: normalized,
    session: {
      schemaVersion: PORTABLE_CONTEXT_SCHEMA,
      sourceAgent: "claude",
      sourceSessionRef: source.sessionRef,
      sourceNativeId: source.nativeId,
      workingDirectory: path.normalize(source.context),
      defaultModel: source.model,
      title: source.title,
      messages,
    },
  };
}
