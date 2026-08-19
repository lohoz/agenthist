import path from "node:path";

import {
  conversionStatus,
  normalizeConversionFindings,
  type ConversionFinding,
  type PortableSourceNormalization,
  type PreparedPortableSource,
} from "../../../domain/conversion.js";
import type {
  AgentSnapshot,
  ConversationItem,
  ConversationMessage,
  JsonValue,
  StoredSession,
} from "../../../domain/history.js";
import {
  PORTABLE_CONTEXT_SCHEMA,
  renderPortableContextMessage,
  type PortableContextBlock,
  type PortableContextMessage,
  type PortableContextSession,
} from "../../../domain/portable-context.js";
import type { ManagedResourceObject } from "../../../domain/resource.js";
import { snapshotRawPath } from "../../../infrastructure/history-store.js";
import { readOpenCodeNativeDescriptor } from "../migration/archive.js";
import { OPENCODE_LEGACY_COMPACTION_TAIL_NOTE } from "../history/derived-part-projection.js";
import {
  OPENCODE_HISTORY_DATABASE_RELATIVE_PATH,
  readOpenCodeHistory,
} from "../history/reader.js";
import {
  isOpenCodeBackgroundTaskNotification,
  projectedOpenCodeBackgroundTask,
  projectedOpenCodeForegroundTask,
  type OpenCodeTaskDescriptor,
} from "../history/task-projection.js";
import { loadOpenCodeToolOutputResources } from "../tool-output.js";

const OPENCODE_BACKGROUND_TASK_NOTE = "opencode.background_task.started";
const OPENCODE_BACKGROUND_TASK_UPDATE_NOTE = "opencode.background_task.updated";
const OPENCODE_LEGACY_SYNTHETIC_NOTE = "opencode.legacy_synthetic.carrier";

export interface OpenCodePortableSourceLoader {
  prepare(source: StoredSession): PreparedPortableSource;
}

export async function createOpenCodePortableSourceLoader(
  stateDirectory: string,
  snapshot: AgentSnapshot,
): Promise<OpenCodePortableSourceLoader> {
  if (snapshot.agent !== "opencode") throw new Error("OpenCode portable loader received another Agent snapshot");
  const bySessionRef = new Map(snapshot.sessions.map((session) => [session.sessionRef, session]));
  const toolOutputs = new Map(snapshot.sessions.map((session) => [
    session.nativeId,
    readOpenCodeNativeDescriptor(session).toolOutputs,
  ]));
  const loaded = await loadOpenCodeToolOutputResources(
    toolOutputs,
    (relativePath) => snapshotRawPath(stateDirectory, snapshot, relativePath),
  );
  const resources = readOpenCodeHistory({
    databasePath: snapshotRawPath(stateDirectory, snapshot, OPENCODE_HISTORY_DATABASE_RELATIVE_PATH),
    databaseRelativePath: OPENCODE_HISTORY_DATABASE_RELATIVE_PATH,
    sidecarFiles: snapshot.auxiliaryFiles.filter((item) => item.startsWith("opencode/session_diff/")),
    toolOutputs,
    toolOutputResources: loaded.byNativePath,
  }).managedResources;
  return {
    prepare(source: StoredSession): PreparedPortableSource {
      if (
        source.agent !== "opencode" ||
        bySessionRef.get(source.sessionRef)?.nativeId !== source.nativeId
      ) throw new Error(`OpenCode portable source is outside the snapshot: ${source.sessionRef}`);
      return {
        source,
        normalization: normalizeOpenCodePortableContext(source),
        resources: resources.get(source.sessionRef) ?? [],
      };
    },
  };
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function strings(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? [...value] : undefined;
}

interface OpenCodeTodoItem {
  readonly position: number;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
  readonly priority: "high" | "medium" | "low";
}

type OpenCodeTodoState =
  | { readonly status: "empty" }
  | { readonly status: "verified"; readonly items: readonly OpenCodeTodoItem[] }
  | { readonly status: "unverified"; readonly count: number };

function hasOnlyFields(value: Record<string, JsonValue>, allowed: readonly string[]): boolean {
  const fields = new Set(allowed);
  return Object.keys(value).every((field) => fields.has(field));
}

function openCodeTodoState(value: JsonValue | undefined): OpenCodeTodoState | undefined {
  const state = objectValue(value);
  if (state?.status === "empty") return hasOnlyFields(state, ["status"]) ? { status: "empty" } : undefined;
  if (state?.status === "unverified") {
    return hasOnlyFields(state, ["status", "count"]) &&
      typeof state.count === "number" && Number.isSafeInteger(state.count) && state.count > 0
      ? { status: "unverified", count: state.count }
      : undefined;
  }
  if (state?.status !== "verified" || !hasOnlyFields(state, ["status", "items"]) || !Array.isArray(state.items)) {
    return undefined;
  }
  const items: OpenCodeTodoItem[] = [];
  for (const [ordinal, value] of state.items.entries()) {
    const item = objectValue(value);
    if (
      item === undefined || !hasOnlyFields(item, ["position", "content", "status", "priority"]) ||
      item.position !== ordinal || typeof item.content !== "string" ||
      item.status !== "pending" && item.status !== "in_progress" &&
      item.status !== "completed" && item.status !== "cancelled" ||
      item.priority !== "high" && item.priority !== "medium" && item.priority !== "low"
    ) return undefined;
    items.push({
      position: ordinal,
      content: item.content,
      status: item.status,
      priority: item.priority,
    });
  }
  return items.length === 0 ? undefined : { status: "verified", items };
}

function hasSessionPermission(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "string") return true;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return true; }
  return !Array.isArray(parsed) || parsed.length !== 0;
}

interface ClosedTaskChildren {
  readonly children: readonly string[];
  readonly foregroundResumeCount: number;
  readonly backgroundCount: number;
  readonly backgroundUpdateCount: number;
}

function backgroundNotificationText(item: ConversationItem): string | undefined {
  if (item.kind !== "message" || item.role !== "user") return undefined;
  const legacy = item.portableNotes?.includes(OPENCODE_LEGACY_SYNTHETIC_NOTE) === true;
  const current = item.portableNotes?.includes("opencode.session_message_synthetic.materialized") === true;
  if (legacy === current) return undefined;
  const expectedKind = legacy ? "text" : "synthetic";
  if (item.contentKinds?.length !== 1 || item.contentKinds[0] !== expectedKind) return undefined;
  const block = item.portableBlocks?.length === 1 ? item.portableBlocks[0] : undefined;
  return block?.kind === "text" ? block.text : undefined;
}

function closedTaskChildren(source: StoredSession): ClosedTaskChildren | undefined {
  let foregroundNotes = 0;
  let backgroundStartNotes = 0;
  let backgroundUpdateNotes = 0;
  const foreground: OpenCodeTaskDescriptor[] = [];
  const background: Array<{ readonly index: number; readonly task: OpenCodeTaskDescriptor }> = [];
  for (const [index, item] of source.conversation.entries()) {
    if (item.kind !== "message") continue;
    foregroundNotes += item.portableNotes?.filter((note) => note === "opencode.task_result.closed").length ?? 0;
    backgroundStartNotes += item.portableNotes?.filter((note) => note === OPENCODE_BACKGROUND_TASK_NOTE).length ?? 0;
    backgroundUpdateNotes += item.portableNotes
      ?.filter((note) => note === OPENCODE_BACKGROUND_TASK_UPDATE_NOTE).length ?? 0;
    for (const block of item.portableBlocks ?? []) {
      if (block.kind !== "historical_tool" || block.tool.name !== "task") continue;
      const output = block.tool.output;
      if (block.tool.status !== "completed" || typeof output !== "string") return undefined;
      const foregroundTask = projectedOpenCodeForegroundTask(block.tool.input, output);
      if (foregroundTask !== undefined) {
        foreground.push(foregroundTask);
        continue;
      }
      const task = projectedOpenCodeBackgroundTask(block.tool.input, output);
      if (task === undefined) return undefined;
      background.push({ index, task });
    }
  }
  const backgroundStarts = background.filter((item) => item.task.kind === "background_started");
  const backgroundUpdates = background.filter((item) => item.task.kind === "background_updated");
  if (
    foregroundNotes !== foreground.length || backgroundStartNotes !== backgroundStarts.length ||
    backgroundUpdateNotes !== backgroundUpdates.length
  ) return undefined;
  const foregroundByChild = new Map<string, OpenCodeTaskDescriptor[]>();
  for (const item of foreground) {
    const records = foregroundByChild.get(item.childId) ?? [];
    records.push(item);
    foregroundByChild.set(item.childId, records);
  }
  for (const records of foregroundByChild.values()) {
    if (
      records[0]?.kind !== "foreground_completed" ||
      records.slice(1).some((item) => item.kind !== "foreground_resumed")
    ) return undefined;
  }
  const byChild = new Map<string, Array<{ readonly index: number; readonly task: OpenCodeTaskDescriptor }>>();
  for (const item of background) {
    const records = byChild.get(item.task.childId) ?? [];
    records.push(item);
    byChild.set(item.task.childId, records);
  }
  const usedNotifications = new Set<number>();
  for (const records of byChild.values()) {
    const start = records[0];
    if (
      start?.task.kind !== "background_started" ||
      records.slice(1).some((item) => item.task.kind !== "background_updated")
    ) return undefined;
    const matches: number[] = [];
    for (let index = start.index + 1; index < source.conversation.length; index++) {
      const text = backgroundNotificationText(source.conversation[index]!);
      if (text !== undefined && isOpenCodeBackgroundTaskNotification(text, start.task)) matches.push(index);
    }
    if (
      matches.length !== 1 || matches[0]! <= records.at(-1)!.index ||
      usedNotifications.has(matches[0]!)
    ) return undefined;
    usedNotifications.add(matches[0]!);
  }
  const children = [...foregroundByChild.keys(), ...byChild.keys()];
  if (new Set(children).size !== children.length) return undefined;
  return {
    children: children.sort(),
    foregroundResumeCount: foreground.filter((item) => item.kind === "foreground_resumed").length,
    backgroundCount: backgroundStarts.length,
    backgroundUpdateCount: backgroundUpdates.length,
  };
}

function blocked(code: string, count = 1): ConversionFinding {
  return { code, disposition: "blocked", count };
}

function recordPortableNotes(target: Map<string, number>, notes: readonly string[]): void {
  for (const note of notes) {
    if (
      note === OPENCODE_BACKGROUND_TASK_NOTE || note === OPENCODE_BACKGROUND_TASK_UPDATE_NOTE ||
      note === OPENCODE_LEGACY_SYNTHETIC_NOTE
    ) continue;
    target.set(note, (target.get(note) ?? 0) + 1);
  }
}

function materializedLegacyCompactionTail(
  conversation: readonly ConversationItem[],
  compactionIndex: number,
): {
  readonly activeConversation: readonly ConversationItem[];
  readonly compactedPrefix: readonly ConversationItem[];
} | undefined {
  let tailStartIndex = compactionIndex;
  while (tailStartIndex > 0) {
    const item = conversation[tailStartIndex - 1];
    if (
      item?.kind !== "message" ||
      item.portableNotes?.includes(OPENCODE_LEGACY_COMPACTION_TAIL_NOTE) !== true
    ) break;
    tailStartIndex--;
  }
  if (tailStartIndex === compactionIndex) return undefined;
  const boundary = conversation[compactionIndex];
  const summary = conversation[compactionIndex + 1];
  if (boundary?.kind !== "message" || summary?.kind !== "message" || summary.role !== "assistant") return undefined;
  const tail = conversation.slice(tailStartIndex, compactionIndex);
  if (!tail.every((item): item is ConversationMessage => item.kind === "message")) return undefined;
  const retainedTail = tail.map((item): ConversationMessage => ({
    ...item,
    timestamp: summary.timestamp,
    portableNotes: [
      ...(item.portableNotes ?? []).filter((note) => note !== OPENCODE_LEGACY_COMPACTION_TAIL_NOTE),
      "opencode.legacy_compaction_tail_timestamp.rebased",
    ],
  }));
  const leadingAssistant = retainedTail[0]?.role === "assistant" ? retainedTail[0] : undefined;
  if (
    leadingAssistant !== undefined &&
    (summary.portableBlocks === undefined || leadingAssistant.portableBlocks === undefined)
  ) return undefined;
  const replaySummary: ConversationMessage = leadingAssistant === undefined
    ? summary
    : {
      ...summary,
      text: `${summary.text}\n\n${leadingAssistant.text}`,
      contentKinds: [...(summary.contentKinds ?? []), ...(leadingAssistant.contentKinds ?? [])],
      portableBlocks: [...summary.portableBlocks!, ...leadingAssistant.portableBlocks!],
      portableNotes: [
        ...(summary.portableNotes ?? []),
        ...(leadingAssistant.portableNotes ?? []),
        "opencode.legacy_compaction_tail_assistant.coalesced",
      ],
    };
  return {
    activeConversation: [
      boundary,
      replaySummary,
      ...retainedTail.slice(leadingAssistant === undefined ? 0 : 1),
      ...conversation.slice(compactionIndex + 2),
    ],
    compactedPrefix: conversation.slice(0, tailStartIndex),
  };
}

function normalizeOpenCodePortableContext(source: StoredSession): PortableSourceNormalization {
  if (source.agent !== "opencode") throw new Error("OpenCode portable normalizer received another Agent");
  const findings: ConversionFinding[] = [];
  const native = objectValue(source.native);
  const nativeSession = objectValue(native?.session);
  const carrier = objectValue(native?.carrier);
  const sidecars = strings(carrier?.sidecars);
  const plan = carrier?.plan;
  const component = strings(native?.componentNativeIds);
  const children = strings(native?.childNativeIds);
  const parentId = native?.parentId;
  const todoState = openCodeTodoState(native?.todoState);
  const taskClosure = closedTaskChildren(source);
  if (native?.relationStatus !== "valid") findings.push(blocked("opencode.native_relations.invalid"));
  if (native?.pendingInputStatus === "present") {
    findings.push(blocked("opencode.pending_input.present"));
  } else if (native?.pendingInputStatus !== "empty") {
    findings.push(blocked("opencode.pending_input.unclassified"));
  }
  if (native?.revertStatus === "present") {
    findings.push(blocked("opencode.revert.present"));
  } else if (native?.revertStatus !== "empty") {
    findings.push(blocked("opencode.revert.unclassified"));
  }
  let historicalWorkState: Extract<PortableContextBlock, { readonly kind: "historical_work_state" }> | undefined;
  if (todoState === undefined) {
    findings.push(blocked("opencode.todo_list.unsupported"));
  } else if (todoState.status === "unverified") {
    findings.push(blocked("opencode.todo_list.unsupported", todoState.count));
  } else if (todoState.status === "verified") {
    const active = todoState.items.filter((item): item is OpenCodeTodoItem & {
      readonly status: "pending" | "in_progress";
    } => item.status === "pending" || item.status === "in_progress");
    if (active.length !== 0) {
      historicalWorkState = {
        kind: "historical_work_state",
        workState: {
          sourceKind: "todo_list",
          items: active.map((item) => ({
            id: String(item.position),
            title: item.content,
            description: "",
            priority: item.priority,
            status: item.status,
            blocks: [],
            blockedBy: [],
          })),
        },
      };
      findings.push({ code: "opencode.todo_list.degraded", disposition: "degraded", count: active.length });
    }
    const completed = todoState.items.filter((item) => item.status === "completed").length;
    const cancelled = todoState.items.filter((item) => item.status === "cancelled").length;
    if (completed !== 0) {
      findings.push({ code: "opencode.completed_todo.skipped", disposition: "skipped", count: completed });
    }
    if (cancelled !== 0) {
      findings.push({ code: "opencode.cancelled_todo.skipped", disposition: "skipped", count: cancelled });
    }
  }
  if (sidecars === undefined) {
    findings.push(blocked("opencode.session_sidecar.unassigned"));
  } else {
    const expectedSessionDiff = `opencode/session_diff/${source.nativeId}.json`;
    const ownedSessionDiff = sidecars.filter((sidecar) => sidecar === expectedSessionDiff).length;
    const unassignedSidecars = sidecars.length - ownedSessionDiff;
    if (ownedSessionDiff === 1) {
      findings.push({ code: "opencode.session_diff.skipped", disposition: "skipped", count: 1 });
    } else if (ownedSessionDiff > 1) {
      findings.push(blocked("opencode.session_sidecar.unassigned", ownedSessionDiff));
    }
    if (unassignedSidecars !== 0) {
      findings.push(blocked("opencode.session_sidecar.unassigned", unassignedSidecars));
    }
  }
  if (typeof plan === "string") {
    findings.push({ code: "opencode.session_plan.skipped", disposition: "skipped", count: 1 });
  } else if (plan !== null) {
    findings.push(blocked("opencode.session_plan.unclassified"));
  }
  const canonicalComponent = component === undefined ? undefined : [...new Set(component)].sort();
  const canonicalChildren = children === undefined ? undefined : [...new Set(children)].sort();
  if (
    component === undefined || component.length === 0 ||
    JSON.stringify(component) !== JSON.stringify(canonicalComponent) || !component.includes(source.nativeId) ||
    children === undefined || JSON.stringify(children) !== JSON.stringify(canonicalChildren) ||
    children.some((nativeId) => nativeId === source.nativeId || !component.includes(nativeId)) ||
    (parentId !== null && (typeof parentId !== "string" || !component.includes(parentId)))
  ) {
    findings.push(blocked("opencode.session_component.unsupported"));
  } else if (taskClosure === undefined || JSON.stringify(taskClosure.children) !== JSON.stringify(children)) {
    findings.push(blocked("opencode.task_relation.unclosed"));
  } else if (component.length > 1) {
    findings.push({
      code: "opencode.session_relation.skipped",
      disposition: "skipped",
      count: component.length - 1,
    });
  }
  if (taskClosure?.backgroundCount !== undefined && taskClosure.backgroundCount !== 0) {
    findings.push({
      code: "opencode.background_task.closed",
      disposition: "exact",
      count: taskClosure.backgroundCount,
    });
  }
  if (taskClosure?.foregroundResumeCount !== undefined && taskClosure.foregroundResumeCount !== 0) {
    findings.push({
      code: "opencode.task_result.resumed",
      disposition: "exact",
      count: taskClosure.foregroundResumeCount,
    });
  }
  if (taskClosure?.backgroundUpdateCount !== undefined && taskClosure.backgroundUpdateCount !== 0) {
    findings.push({
      code: "opencode.background_task.updated",
      disposition: "exact",
      count: taskClosure.backgroundUpdateCount,
    });
  }
  if (!path.isAbsolute(source.context)) findings.push(blocked("portable.working_directory.invalid"));

  const compactionIndex = source.conversation.findLastIndex((item) =>
    item.kind === "message" && item.contentKinds?.length === 1 && item.contentKinds[0] === "compaction" &&
    (item.portableNotes?.includes("opencode.session_message_compaction.materialized") === true ||
      item.portableNotes?.includes("opencode.legacy_compaction.materialized") === true)
  );
  const materializedCompaction = compactionIndex < 0 ? undefined : source.conversation[compactionIndex];
  const materializedLegacyCompaction = materializedCompaction?.kind === "message" &&
    materializedCompaction.portableNotes?.includes("opencode.legacy_compaction.materialized") === true;
  const legacyTail = materializedLegacyCompaction
    ? materializedLegacyCompactionTail(source.conversation, compactionIndex)
    : undefined;
  const compactedPrefix = compactionIndex < 0
    ? []
    : legacyTail?.compactedPrefix ?? source.conversation.slice(0, compactionIndex);
  const activeConversation = compactionIndex < 0
    ? source.conversation
    : legacyTail?.activeConversation ?? source.conversation.slice(compactionIndex);
  const allGaps = source.conversation.filter((item) => item.kind === "gap");
  const gaps = activeConversation.filter((item) => item.kind === "gap");
  const lifecycle = gaps.filter((item) =>
    item.code === "opencode.part.step_start" || item.code === "opencode.part.step_finish").length;
  const patch = gaps.filter((item) => item.code === "opencode.part.patch").length;
  const compactionPart = gaps.filter((item) => item.code === "opencode.part.compaction").length;
  const compactionSummary = gaps.filter((item) => item.code === "opencode.message.compaction_summary").length;
  const compactionEvent = gaps.filter((item) => item.code === "opencode.session_message.compaction_event").length;
  const systemEvent = gaps.filter((item) => item.code === "opencode.session_message.system_event").length;
  const shellEvent = gaps.filter((item) => item.code === "opencode.session_message.shell_event.unclosed").length;
  const syntheticEvent = gaps.filter((item) => item.code === "opencode.session_message.synthetic_event.unclosed").length;
  const assistantError = gaps.filter((item) => item.code === "opencode.message.assistant_error").length;
  const agentReference = gaps.filter((item) => item.code === "opencode.part.agent").length;
  const subtask = gaps.filter((item) => item.code === "opencode.part.subtask").length;
  const ignoredText = gaps.filter((item) => item.code === "opencode.part.text_ignored").length;
  const emptyText = gaps.filter((item) => item.code === "opencode.part.text_empty").length;
  const tool = gaps.filter((item) => item.code === "opencode.part.tool").length;
  const file = gaps.filter((item) => item.code === "opencode.part.file").length;
  const sessionTool = gaps.filter((item) => item.code === "opencode.session_message.tool").length;
  const sessionFile = gaps.filter((item) => item.code === "opencode.session_message.files").length;
  const sessionReference = gaps.filter((item) => item.code === "opencode.session_message.references").length;
  const mixedCarrier = gaps.filter((item) => item.code === "opencode.message_carriers.mixed").length;
  const invalidSessionMessage = gaps.filter((item) => item.code === "opencode.session_message.invalid").length;
  const incompleteSessionMessage = gaps.filter((item) => item.code === "opencode.session_message.incomplete").length;
  const emptySessionMessage = gaps.filter((item) => item.code === "opencode.session_message.empty").length;
  const sessionControl = gaps.filter((item) => item.code === "opencode.session_message.control").length;
  const nativeSessionContext = allGaps.filter((item) => item.code === "opencode.session_message.native_context").length;
  const activeNativeSessionContext = gaps.filter((item) =>
    item.code === "opencode.session_message.native_context").length;
  const other = gaps.length - lifecycle - patch - compactionPart - compactionSummary - compactionEvent - systemEvent -
    shellEvent - syntheticEvent - assistantError -
    agentReference - subtask - ignoredText - emptyText - tool - file -
    sessionTool - sessionFile - sessionReference - mixedCarrier -
    invalidSessionMessage - incompleteSessionMessage - emptySessionMessage - sessionControl -
    activeNativeSessionContext;
  if (compactedPrefix.length !== 0) {
    findings.push({
      code: materializedLegacyCompaction
        ? "opencode.legacy_compacted_prefix.skipped"
        : "opencode.session_message_compacted_prefix.skipped",
      disposition: "skipped",
      count: compactedPrefix.length,
    });
  }
  if (lifecycle !== 0) findings.push({ code: "opencode.step_lifecycle.skipped", disposition: "skipped", count: lifecycle });
  if (patch !== 0) findings.push({ code: "opencode.patch_metadata.skipped", disposition: "skipped", count: patch });
  if (compactionPart !== 0 || compactionSummary !== 0 || compactionEvent !== 0) {
    findings.push(blocked(
      "opencode.compaction.unsupported",
      Math.max(compactionPart, compactionSummary) + compactionEvent,
    ));
  }
  if (systemEvent !== 0) {
    findings.push(blocked("opencode.session_message.context.unsupported", systemEvent));
  }
  if (shellEvent !== 0) findings.push(blocked("opencode.session_message.shell_event.unclosed", shellEvent));
  if (syntheticEvent !== 0) {
    findings.push(blocked("opencode.session_message.synthetic_event.unclosed", syntheticEvent));
  }
  if (assistantError !== 0) findings.push(blocked("opencode.assistant_error.unsupported", assistantError));
  if (agentReference !== 0) findings.push(blocked("opencode.agent_reference.unsupported", agentReference));
  if (subtask !== 0) findings.push(blocked("opencode.subtask.unsupported", subtask));
  if (ignoredText !== 0) findings.push({ code: "opencode.ignored_text.skipped", disposition: "skipped", count: ignoredText });
  if (emptyText !== 0) findings.push({ code: "opencode.empty_text.skipped", disposition: "skipped", count: emptyText });
  if (tool !== 0 || sessionTool !== 0) {
    findings.push(blocked("opencode.tool_history.unprojectable", tool + sessionTool));
  }
  if (file !== 0 || sessionFile !== 0) {
    findings.push(blocked("opencode.file_history.unprojectable", file + sessionFile));
  }
  if (sessionReference !== 0) {
    findings.push(blocked("opencode.reference_history.unprojectable", sessionReference));
  }
  if (mixedCarrier !== 0) findings.push(blocked("opencode.message_carriers.mixed", mixedCarrier));
  if (invalidSessionMessage !== 0) {
    findings.push(blocked("opencode.session_message.invalid", invalidSessionMessage));
  }
  if (incompleteSessionMessage !== 0) {
    findings.push(blocked("opencode.session_message.incomplete", incompleteSessionMessage));
  }
  if (emptySessionMessage !== 0) findings.push(blocked("opencode.session_message.empty", emptySessionMessage));
  if (sessionControl !== 0) {
    findings.push({ code: "opencode.session_message_control.skipped", disposition: "skipped", count: sessionControl });
  }
  const compactedNativeSessionContext = nativeSessionContext - activeNativeSessionContext;
  if (compactedNativeSessionContext !== 0) {
    findings.push(blocked("opencode.session_message.native_context", compactedNativeSessionContext));
  }
  if (other !== 0) findings.push(blocked("opencode.native_content.unprojectable", other));

  const messages: PortableContextMessage[] = [];
  const validateContent = new Set<number>();
  const pendingSystemContext: Array<Extract<PortableContextBlock, { readonly kind: "historical_context" }>> = [];
  let previousRole: "user" | "assistant" | undefined;
  let previousTime = Number.NEGATIVE_INFINITY;
  let invalidTimestamp = 0;
  let invalidContent = 0;
  let invalidSequence = 0;
  let systemContextRows = 0;
  let reasoning = 0;
  let reasoningTrace = 0;
  let toolEvidence = 0;
  const portableNotes = new Map<string, number>();
  for (const item of activeConversation) {
    if (item.kind !== "message") continue;
    if (item.role === "system") {
      systemContextRows++;
      const instant = Date.parse(item.timestamp);
      if (!Number.isFinite(instant) || instant < previousTime) invalidTimestamp++;
      if (Number.isFinite(instant)) previousTime = instant;
      const blocks = item.portableBlocks;
      const block = blocks?.length === 1 && blocks[0]?.kind === "historical_context"
        ? blocks[0]
        : undefined;
      if (
        block === undefined || block.context.sourceRole !== "system" || block.context.text !== item.text ||
        item.contentKinds?.length !== 1 || item.contentKinds[0] !== "system"
      ) {
        invalidContent++;
        continue;
      }
      recordPortableNotes(portableNotes, item.portableNotes ?? []);
      const previous = messages.at(-1);
      if (previous?.role === "user" && pendingSystemContext.length === 0) {
        messages[messages.length - 1] = { ...previous, blocks: [...previous.blocks, block] };
      } else {
        pendingSystemContext.push(block);
      }
      continue;
    }
    if (item.role !== "user" && item.role !== "assistant") continue;
    const kinds = item.contentKinds ?? ["text"];
    const observedReasoning = kinds.filter((kind) => kind === "reasoning").length;
    const skippedLegacyFiles = item.portableNotes?.filter((note) =>
      note === "opencode.legacy_file_part.skipped"
    ).length ?? 0;
    const blocks = item.portableBlocks;
    if (blocks === undefined) {
      invalidContent++;
      reasoning += observedReasoning;
    } else {
      const observedTools = kinds.filter((kind) => kind === "tool").length;
      const projectedTools = blocks.filter((block) => block.kind === "historical_tool").length;
      const observedResources = kinds.filter((kind) => kind === "file" || kind === "reference").length;
      const projectedResources = blocks.filter((block) =>
        block.kind === "historical_resource" || block.kind === "historical_reference"
      ).length;
      const projectedReasoning = blocks.filter((block) => block.kind === "historical_reasoning_trace").length;
      if (skippedLegacyFiles > observedResources || observedTools !== projectedTools ||
        observedResources - skippedLegacyFiles !== projectedResources ||
        projectedReasoning > observedReasoning || item.role === "user" && projectedReasoning !== 0) invalidContent++;
      reasoning += Math.max(0, observedReasoning - projectedReasoning);
      reasoningTrace += projectedReasoning;
      toolEvidence += projectedTools;
      recordPortableNotes(portableNotes, item.portableNotes ?? []);
    }
    if (blocks?.length === 0 && skippedLegacyFiles !== 0 && skippedLegacyFiles === kinds.length) continue;
    const instant = Date.parse(item.timestamp);
    if (!Number.isFinite(instant) || instant < previousTime) invalidTimestamp++;
    let messageBlocks = blocks ?? [];
    if (pendingSystemContext.length !== 0) {
      if (item.role === "user") {
        messageBlocks = [...pendingSystemContext, ...messageBlocks];
      } else {
        invalidSequence += pendingSystemContext.length;
      }
      pendingSystemContext.length = 0;
    }
    if (previousRole === item.role) invalidSequence++;
    previousRole = item.role;
    if (Number.isFinite(instant)) previousTime = instant;
    const message: PortableContextMessage = {
      ordinal: messages.length,
      role: item.role,
      blocks: messageBlocks,
      timestamp: Number.isFinite(instant) ? new Date(instant).toISOString() : item.timestamp,
      model: item.role === "assistant" ? (item.model ?? source.model) : "",
    };
    if (blocks !== undefined) validateContent.add(message.ordinal);
    messages.push(message);
  }
  if (pendingSystemContext.length !== 0) invalidSequence += pendingSystemContext.length;
  if (historicalWorkState !== undefined) {
    const userIndex = messages.findLastIndex((message) => message.role === "user");
    if (userIndex < 0) {
      invalidContent++;
    } else {
      const user = messages[userIndex]!;
      const combined: PortableContextMessage = { ...user, blocks: [...user.blocks, historicalWorkState] };
      try { renderPortableContextMessage({ sourceAgent: "opencode" }, combined); } catch { invalidContent++; }
      messages[userIndex] = combined;
    }
  }
  if (activeNativeSessionContext !== systemContextRows) {
    findings.push(blocked(
      "opencode.session_message.native_context",
      Math.max(activeNativeSessionContext, systemContextRows),
    ));
  }
  for (const message of messages) {
    if (!validateContent.has(message.ordinal)) continue;
    try {
      renderPortableContextMessage({ sourceAgent: "opencode" }, message);
    } catch {
      invalidContent++;
    }
  }
  if (reasoning !== 0) findings.push({ code: "opencode.reasoning.skipped", disposition: "skipped", count: reasoning });
  if (reasoningTrace !== 0) {
    findings.push({ code: "opencode.reasoning_trace.degraded", disposition: "degraded", count: reasoningTrace });
  }
  if (toolEvidence !== 0) {
    findings.push({ code: "opencode.tool_history.degraded", disposition: "degraded", count: toolEvidence });
  }
  const knownNotes = new Set([
    "opencode.tool_metadata.skipped",
    "opencode.tool_title.skipped",
    "opencode.tool_timing.skipped",
    "opencode.text_attributes.skipped",
    "opencode.reasoning_provider_metadata.skipped",
    "opencode.reasoning_timing.skipped",
    "opencode.agent_reference.part_skipped",
    "opencode.session_message_agent_reference.skipped",
    "opencode.session_message_metadata.skipped",
    "opencode.session_message_attributes.skipped",
    "opencode.session_message_reasoning_provider_metadata.skipped",
    "opencode.session_message_reasoning_timing.skipped",
    "opencode.session_message_tool_attachments.skipped",
    "opencode.session_message_tool_transport.skipped",
    "opencode.legacy_file_part.skipped",
  ]);
  for (const [code, count] of portableNotes) {
    if (code === "opencode.assistant_rows.coalesced") {
      findings.push({ code, disposition: "degraded", count });
    } else if (code === "opencode.assistant_abort.materialized") {
      findings.push({ code, disposition: "degraded", count });
    } else if (code === "opencode.inline_resource.managed") {
      findings.push({ code, disposition: "exact", count });
    } else if (code === "opencode.file_part.managed") {
      findings.push({ code, disposition: "synthesized", count });
    } else if (code === "opencode.file_source.preserved") {
      findings.push({ code, disposition: "synthesized", count });
    } else if (code === "opencode.file_source.skipped") {
      findings.push({ code, disposition: "skipped", count });
    } else if (code === "opencode.file_url.reference_preserved") {
      findings.push({ code, disposition: "degraded", count });
    } else if (code === "opencode.session_message_reference.preserved") {
      findings.push({ code, disposition: "degraded", count });
    } else if (code === "opencode.session_message_file.managed") {
      findings.push({ code, disposition: "synthesized", count });
    } else if (code === "opencode.session_message_file_metadata.skipped") {
      findings.push({ code, disposition: "skipped", count });
    } else if (code === "opencode.session_message_tool_file.managed") {
      findings.push({ code, disposition: "exact", count });
    } else if (code === "opencode.session_message_tool_content_file.reference_preserved") {
      findings.push({ code, disposition: "degraded", count });
    } else if (code === "opencode.session_message_tool_attachment.managed") {
      findings.push({ code, disposition: "exact", count });
    } else if (code === "opencode.session_message_tool_attachment.reference_preserved") {
      findings.push({ code, disposition: "degraded", count });
    } else if (code === "opencode.session_message_tool_attachment_metadata.skipped") {
      findings.push({ code, disposition: "skipped", count });
    } else if (code === "opencode.session_message_tool_structured.closed") {
      findings.push({ code, disposition: "exact", count });
    } else if (code === "opencode.session_message_tool_structured.skipped") {
      findings.push({ code, disposition: "skipped", count });
    } else if (code === "opencode.session_message_tool_provider_result.closed") {
      findings.push({ code, disposition: "exact", count });
    } else if (code === "opencode.session_message_tool_result.skipped" ||
      code === "opencode.session_message_tool_provider_fallback.skipped") {
      findings.push({ code, disposition: "skipped", count });
    } else if (code === "opencode.session_message_shell.materialized") {
      findings.push({ code, disposition: "synthesized", count });
    } else if (code === "opencode.session_message_synthetic.materialized") {
      findings.push({ code, disposition: "synthesized", count });
    } else if (code === "opencode.session_message_system_context.materialized") {
      findings.push({ code, disposition: "degraded", count });
    } else if (code === "opencode.session_message_compaction.materialized") {
      findings.push({ code, disposition: "synthesized", count });
    } else if (code === "opencode.legacy_compaction.materialized") {
      findings.push({ code, disposition: "synthesized", count });
    } else if (code === "opencode.legacy_compaction_tail_timestamp.rebased") {
      findings.push({ code, disposition: "degraded", count });
    } else if (code === "opencode.legacy_compaction_tail_assistant.coalesced") {
      findings.push({ code, disposition: "degraded", count });
    } else if (code === "opencode.subtask.materialized") {
      findings.push({ code, disposition: "synthesized", count });
    } else if (code === "opencode.session_message_assistant_error.materialized") {
      findings.push({ code, disposition: "degraded", count });
    } else if (code === "opencode.tool_output.managed") {
      findings.push({ code, disposition: "exact", count });
    } else if (code === "opencode.tool_output.unavailable") {
      findings.push({ code, disposition: "skipped", count });
    } else if (code === "opencode.tool_output.compacted") {
      findings.push({ code, disposition: "skipped", count });
    } else if (code === "opencode.structured_output.closed") {
      findings.push({ code, disposition: "exact", count });
    } else if (code === "opencode.task_result.closed") {
      findings.push({ code, disposition: "exact", count });
    } else {
      findings.push(knownNotes.has(code)
        ? { code, disposition: "skipped", count }
        : blocked("opencode.tool_note.unknown", count));
    }
  }
  if (messages.length === 0) findings.push(blocked("portable.messages.empty"));
  if (messages[0]?.role !== "user" || messages.at(-1)?.role !== "assistant") invalidSequence++;
  if (invalidTimestamp !== 0) findings.push(blocked("portable.message_timestamp.invalid", invalidTimestamp));
  if (invalidContent !== 0) findings.push(blocked("portable.message_content.invalid", invalidContent));
  if (invalidSequence !== 0) findings.push(blocked("portable.message_sequence.unsupported", invalidSequence));

  findings.push({ code: "opencode.native_envelope.skipped", disposition: "skipped", count: 1 });
  if (typeof nativeSession?.agent === "string" && nativeSession.agent !== "") {
    findings.push({ code: "opencode.session_agent.skipped", disposition: "skipped", count: 1 });
  }
  if (
    nativeSession !== undefined && Object.hasOwn(nativeSession, "permission") &&
    hasSessionPermission(nativeSession.permission)
  ) {
    findings.push({ code: "opencode.session_permission.skipped", disposition: "skipped", count: 1 });
  }
  if (source.provider !== "") findings.push({ code: "opencode.provider_metadata.skipped", disposition: "skipped", count: 1 });
  if (source.nativeArchived) findings.push({ code: "opencode.native_archive_state.skipped", disposition: "skipped", count: 1 });
  const normalized = normalizeConversionFindings(findings);
  const status = conversionStatus(normalized);
  if (status === "blocked") return { status, findings: normalized };
  return {
    status,
    findings: normalized,
    session: {
      schemaVersion: PORTABLE_CONTEXT_SCHEMA,
      sourceAgent: "opencode",
      sourceSessionRef: source.sessionRef,
      sourceNativeId: source.nativeId,
      workingDirectory: path.normalize(source.context),
      defaultModel: source.model,
      title: source.title,
      messages,
    },
  };
}
