import path from "node:path";

import {
  conversionStatus,
  normalizeConversionFindings,
  type ConversionFinding,
  type PortableSourceNormalization,
  type PreparedPortableSource,
} from "../../../domain/conversion.js";
import type { AgentSnapshot, StoredSession } from "../../../domain/history.js";
import {
  hasClosedHistoricalToolSequence,
  PORTABLE_CONTEXT_SCHEMA,
  renderPortableContextMessage,
  type PortableContextMessage,
  type PortableContextSession,
} from "../../../domain/portable-context.js";
import type { ManagedResourceObject } from "../../../domain/resource.js";
import { snapshotRawPath } from "../../../infrastructure/history-store.js";
import {
  readCodexDynamicTools,
  readCodexGoal,
  readCodexLineage,
  readCodexSection,
  readCodexSpawn,
  readCodexUnsupportedRelationStatus,
  validateCodexHistoryBaseBoundary,
} from "../migration/archive.js";
import {
  parseCodexRollout,
  parseCodexRolloutPrefix,
  type CodexHistoryBase,
  type ParsedCodexRollout,
} from "../history/rollout.js";

export interface CodexPortableMaterializer {
  prepare(source: StoredSession): Promise<PreparedPortableSource>;
}

function parsedLineage(parsed: ParsedCodexRollout): ReturnType<typeof readCodexLineage> {
  return {
    historyMode: parsed.historyMode,
    sessionId: parsed.sessionId,
    subagentHistoryStartOrdinal: parsed.subagentHistoryStartOrdinal ?? null,
    forkedFromId: parsed.forkedFromId ?? null,
    parentThreadId: parsed.parentThreadId ?? null,
    historyBase: parsed.historyBase ?? null,
  };
}

function managedResourceKey(resource: ManagedResourceObject): string {
  return JSON.stringify([
    resource.sha256,
    resource.sizeBytes,
    resource.mediaType,
    resource.name,
    resource.sourceReference,
    resource.relativePath,
  ]);
}

function mergeManagedResources(
  ...groups: readonly (readonly ManagedResourceObject[])[]
): ManagedResourceObject[] {
  const merged = new Map<string, ManagedResourceObject>();
  for (const resource of groups.flat()) {
    const key = managedResourceKey(resource);
    const existing = merged.get(key);
    if (existing !== undefined && !Buffer.from(existing.bytes).equals(Buffer.from(resource.bytes))) {
      throw new Error("Codex managed resource identity contains different bytes across paginated history");
    }
    merged.set(key, resource);
  }
  return [...merged.values()];
}

export function createCodexPortableMaterializer(
  stateDirectory: string,
  snapshot: AgentSnapshot,
): CodexPortableMaterializer {
  if (snapshot.agent !== "codex") throw new Error("Codex materializer received another Agent snapshot");
  const sessions = snapshot.sessions;
  const byNativeId = new Map<string, StoredSession>();
  for (const session of sessions) {
    if (session.agent !== "codex") throw new Error("Codex materializer received another Agent");
    if (byNativeId.has(session.nativeId)) {
      throw new Error(`Codex materialization identity is ambiguous: ${session.nativeId}`);
    }
    byNativeId.set(session.nativeId, session);
  }
  const fullParses = new Map<string, Promise<ParsedCodexRollout>>();
  const prefixParses = new Map<string, Promise<ParsedCodexRollout>>();

  const rawPath = (session: StoredSession): string => {
    if (session.rawFiles.length !== 1) {
      throw new Error(`Codex rollout closure cannot be materialized: ${session.sessionRef}`);
    }
    return snapshotRawPath(stateDirectory, snapshot, session.rawFiles[0]!);
  };
  const fullParse = (session: StoredSession): Promise<ParsedCodexRollout> => {
    let parsed = fullParses.get(session.nativeId);
    if (parsed === undefined) {
      parsed = parseCodexRollout(rawPath(session));
      fullParses.set(session.nativeId, parsed);
    }
    return parsed;
  };
  const assertIdentity = (session: StoredSession, parsed: ParsedCodexRollout): void => {
    if (
      parsed.nativeId !== session.nativeId ||
      JSON.stringify(parsedLineage(parsed)) !== JSON.stringify(readCodexLineage(session))
    ) throw new Error(`Codex paginated source changed since scan: ${session.sessionRef}`);
  };
  const parseSegment = async (
    session: StoredSession,
    cutoff?: CodexHistoryBase,
  ): Promise<ParsedCodexRollout> => {
    const complete = await fullParse(session);
    assertIdentity(session, complete);
    if (cutoff === undefined) return complete;
    if (complete.historyMode !== "paginated") {
      throw new Error(`Codex history base does not reference paginated history: ${session.sessionRef}`);
    }
    await validateCodexHistoryBaseBoundary(
      rawPath(session),
      cutoff,
      complete.metadataEndByteOffset,
      session.sessionRef,
    );
    const key = `${session.nativeId}\0${cutoff.endByteOffset}`;
    let prefix = prefixParses.get(key);
    if (prefix === undefined) {
      prefix = parseCodexRolloutPrefix(rawPath(session), cutoff.endByteOffset);
      prefixParses.set(key, prefix);
    }
    const parsed = await prefix;
    assertIdentity(session, parsed);
    if (parsed.endOrdinalExclusive !== cutoff.endOrdinalExclusive) {
      throw new Error(`Codex paginated history ordinal and byte positions disagree: ${session.sessionRef}`);
    }
    return parsed;
  };

  interface SegmentResult {
    readonly conversation: StoredSession["conversation"];
    readonly resources: readonly ManagedResourceObject[];
    readonly segments: number;
    readonly compactionCheckpoints: number;
    readonly rollbackTurns: number;
  }
  const materializeSegment = async (
    session: StoredSession,
    cutoff: CodexHistoryBase | undefined,
    visiting: Set<string>,
  ): Promise<SegmentResult> => {
    if (visiting.has(session.nativeId)) {
      throw new Error(`Codex paginated history contains a cycle: ${session.sessionRef}`);
    }
    visiting.add(session.nativeId);
    try {
      const parsed = await parseSegment(session, cutoff);
      const base = parsed.historyBase;
      if (base === undefined) {
        return {
          conversation: parsed.portableConversation,
          resources: parsed.portableManagedResources,
          segments: 1,
          compactionCheckpoints: parsed.materializedCompactionCheckpoints,
          rollbackTurns: parsed.materializedRollbackTurns,
        };
      }
      const ancestor = byNativeId.get(base.threadId);
      if (ancestor === undefined) {
        throw new Error(`Codex paginated history base is missing: ${session.sessionRef}`);
      }
      const inherited = await materializeSegment(ancestor, base, visiting);
      if (parsed.materializedCompactionCheckpoints !== 0) {
        return {
          conversation: parsed.portableConversation,
          resources: parsed.portableManagedResources,
          segments: inherited.segments + 1,
          compactionCheckpoints: parsed.materializedCompactionCheckpoints,
          rollbackTurns: parsed.materializedRollbackTurns,
        };
      }
      return {
        conversation: [...inherited.conversation, ...parsed.portableConversation],
        resources: mergeManagedResources(inherited.resources, parsed.portableManagedResources),
        segments: inherited.segments + 1,
        compactionCheckpoints: inherited.compactionCheckpoints,
        rollbackTurns: inherited.rollbackTurns + parsed.materializedRollbackTurns,
      };
    } finally {
      visiting.delete(session.nativeId);
    }
  };

  return {
    async prepare(source: StoredSession): Promise<PreparedPortableSource> {
      if (source.agent !== "codex" || byNativeId.get(source.nativeId)?.sessionRef !== source.sessionRef) {
        throw new Error(`Codex materialization source is outside the snapshot: ${source.sessionRef}`);
      }
      if (source.rawFiles.length !== 1) {
        return {
          source,
          normalization: normalizeCodexPortableContext(source),
          resources: [],
        };
      }
      const result = await materializeSegment(source, undefined, new Set());
      const preparedSource = { ...source, conversation: result.conversation };
      return {
        source: preparedSource,
        normalization: normalizeCodexPortableContext(preparedSource, {
          materializedHistoryBaseSegments: result.segments - 1,
          materializedCompactionCheckpoints: result.compactionCheckpoints,
          materializedRollbackTurns: result.rollbackTurns,
        }),
        resources: result.resources,
      };
    },
  };
}

function blocked(code: string, count = 1): ConversionFinding {
  return { code, disposition: "blocked", count };
}

function normalizeCodexPortableContext(
  source: StoredSession,
  options: {
    readonly materializedHistoryBaseSegments?: number;
    readonly materializedCompactionCheckpoints?: number;
    readonly materializedRollbackTurns?: number;
  } = {},
): PortableSourceNormalization {
  if (source.agent !== "codex") throw new Error("Codex portable normalizer received another Agent");
  const materializedHistoryBaseSegments = options.materializedHistoryBaseSegments ?? 0;
  const materializedCompactionCheckpoints = options.materializedCompactionCheckpoints ?? 0;
  const materializedRollbackTurns = options.materializedRollbackTurns ?? 0;
  if (!Number.isSafeInteger(materializedHistoryBaseSegments) || materializedHistoryBaseSegments < 0) {
    throw new Error("Codex materialized history segment count is invalid");
  }
  if (!Number.isSafeInteger(materializedCompactionCheckpoints) || materializedCompactionCheckpoints < 0) {
    throw new Error("Codex materialized compaction checkpoint count is invalid");
  }
  if (!Number.isSafeInteger(materializedRollbackTurns) || materializedRollbackTurns < 0) {
    throw new Error("Codex materialized rollback turn count is invalid");
  }
  const findings: ConversionFinding[] = [];
  if (readCodexUnsupportedRelationStatus(source) !== "empty") {
    findings.push(blocked("codex.native_relations.unsupported"));
  }
  const lineage = readCodexLineage(source);
  const spawn = readCodexSpawn(source);
  if (spawn.relationStatus !== "valid") {
    findings.push(blocked("codex.spawn_graph.unsupported"));
  } else if (spawn.componentNativeIds.length > 1 || spawn.incoming !== null) {
    findings.push({
      code: "codex.spawn_relation.skipped",
      disposition: "skipped",
      count: Math.max(1, spawn.componentNativeIds.length - 1),
    });
  }
  if (lineage.historyBase !== null) {
    findings.push(materializedHistoryBaseSegments === 0
      ? blocked("codex.paginated_lineage.unsupported")
      : {
        code: "codex.paginated_lineage.materialized",
        disposition: "skipped",
        count: materializedHistoryBaseSegments,
      });
  } else if (materializedHistoryBaseSegments !== 0) {
    throw new Error("Codex materialized history does not match its lineage");
  }
  if (lineage.subagentHistoryStartOrdinal !== null && lineage.subagentHistoryStartOrdinal > 1) {
    findings.push({
      code: "codex.subagent_inherited_context.materialized",
      disposition: "degraded",
      count: 1,
    });
  }
  if (
    lineage.parentThreadId !== null &&
    (spawn.incoming === null || spawn.incoming.parent_thread_id !== lineage.parentThreadId)
  ) {
    findings.push(blocked("codex.parent_thread.unsupported"));
  }
  if (lineage.forkedFromId !== null) {
    findings.push({ code: "codex.fork_lineage.skipped", disposition: "skipped", count: 1 });
  }
  if (materializedCompactionCheckpoints !== 0) {
    findings.push({
      code: "codex.replacement_history.materialized",
      disposition: "degraded",
      count: materializedCompactionCheckpoints,
    });
  }
  if (materializedRollbackTurns !== 0) {
    findings.push({
      code: "codex.thread_rollback.materialized",
      disposition: "degraded",
      count: materializedRollbackTurns,
    });
  }
  const dynamicTools = readCodexDynamicTools(source);
  if (dynamicTools.length !== 0) {
    findings.push({ code: "codex.dynamic_tools.skipped", disposition: "skipped", count: dynamicTools.length });
  }
  if (readCodexGoal(source) !== null) {
    findings.push({ code: "codex.thread_goal.skipped", disposition: "skipped", count: 1 });
  }
  if (readCodexSection(source) !== null) {
    findings.push({ code: "codex.thread_section.skipped", disposition: "skipped", count: 1 });
  }
  if (source.rawFiles.length !== 1) findings.push(blocked("codex.rollout_closure.unsupported"));
  if (!path.isAbsolute(source.context)) findings.push(blocked("portable.working_directory.invalid"));

  const gaps = source.conversation.filter((item) => item.kind === "gap");
  const reasoning = gaps.filter((item) => item.code === "codex.response.reasoning").length;
  const executionContext = gaps.filter((item) => item.code === "codex.response_context").length;
  const externalSessionImportMarkers = gaps.filter((item) =>
    item.code === "codex.external_session_import_marker").length;
  const compaction = gaps.filter((item) =>
    item.code === "codex.compacted" || item.code === "codex.response.compaction" ||
    item.code === "codex.response.context_compaction" || item.code === "codex.context_compacted" ||
    item.code === "codex.context_compacted_invalid").length;
  const worldState = gaps.filter((item) => item.code === "codex.world_state").length;
  const interAgentMetadata = gaps.filter((item) => item.code === "codex.inter_agent_communication_metadata").length;
  const interAgentCommunication = gaps.filter((item) =>
    item.code === "codex.inter_agent_communication" || item.code === "codex.response.agent_message").length;
  const threadRollback = gaps.filter((item) =>
    item.code === "codex.thread_rollback" || item.code === "codex.thread_rollback_invalid").length;
  const turnAborted = gaps.filter((item) =>
    item.code === "codex.turn_aborted" || item.code === "codex.turn_aborted_invalid" ||
    item.code === "codex.turn_aborted_marker_unpaired").length;
  const rolloutItems = gaps.filter((item) =>
    typeof item.code === "string" && item.code.startsWith("codex.rollout.")).length;
  const unprojectableTools = gaps.filter((item) =>
    item.code === "codex.response.function_call" || item.code === "codex.response.function_call_output" ||
    item.code === "codex.response.custom_tool_call" || item.code === "codex.response.custom_tool_call_output" ||
    item.code === "codex.response.local_shell_call" || item.code === "codex.response.web_search_call" ||
    item.code === "codex.response.image_generation_call" ||
    item.code === "codex.response.tool_search_call" || item.code === "codex.response.tool_search_output").length;
  const unprojectable = gaps.length - reasoning - executionContext - externalSessionImportMarkers - compaction -
    worldState - interAgentMetadata - interAgentCommunication - threadRollback - turnAborted - rolloutItems -
    unprojectableTools;
  if (reasoning !== 0) findings.push({ code: "codex.reasoning.skipped", disposition: "skipped", count: reasoning });
  if (executionContext !== 0) {
    findings.push({ code: "codex.execution_context.skipped", disposition: "skipped", count: executionContext });
  }
  if (externalSessionImportMarkers !== 0) {
    findings.push({
      code: "codex.external_session_import_marker.skipped",
      disposition: "skipped",
      count: externalSessionImportMarkers,
    });
  }
  if (compaction !== 0) findings.push(blocked("codex.compaction.unsupported", compaction));
  if (worldState !== 0) {
    findings.push({ code: "codex.world_state.skipped", disposition: "skipped", count: worldState });
  }
  if (interAgentMetadata !== 0) {
    findings.push({
      code: "codex.inter_agent_delivery_metadata.skipped",
      disposition: "skipped",
      count: interAgentMetadata,
    });
  }
  if (interAgentCommunication !== 0) {
    findings.push(blocked("codex.inter_agent_communication.unsupported", interAgentCommunication));
  }
  if (threadRollback !== 0) findings.push(blocked("codex.thread_rollback.unsupported", threadRollback));
  if (turnAborted !== 0) findings.push(blocked("codex.turn_aborted.unsupported", turnAborted));
  if (rolloutItems !== 0) findings.push(blocked("codex.rollout_item.unprojectable", rolloutItems));
  if (unprojectableTools !== 0) findings.push(blocked("codex.tool_history.unprojectable", unprojectableTools));
  if (unprojectable !== 0) findings.push(blocked("codex.native_content.unprojectable", unprojectable));
  const unsupportedRoles = source.conversation.filter((item) =>
    item.kind === "message" && item.role !== "user" && item.role !== "assistant").length;
  if (unsupportedRoles !== 0) findings.push(blocked("portable.message_role.unsupported", unsupportedRoles));

  const messages: PortableContextMessage[] = [];
  let previousRole: "user" | "assistant" | undefined;
  let previousTime = Number.NEGATIVE_INFINITY;
  let invalidTimestamp = 0;
  let invalidContent = 0;
  let invalidSequence = 0;
  let reasoningEvidence = 0;
  let toolEvidence = 0;
  let inputImageManagedEvidence = 0;
  let inputImageReferenceEvidence = 0;
  let inputAudioEvidence = 0;
  let coalescedAssistantMessages = 0;
  let coalescedCompactionUserMessages = 0;
  let inCompactionUserPrefix = materializedCompactionCheckpoints !== 0;
  const portableNotes = new Map<string, number>();
  for (const item of source.conversation) {
    if (item.kind !== "message" || (item.role !== "user" && item.role !== "assistant")) continue;
    const blocks = item.portableBlocks;
    if (blocks === undefined || item.contentKinds === undefined) {
      invalidContent++;
    } else {
      const observedTools = item.contentKinds.filter((kind) =>
        kind === "function_call" || kind === "function_call_output" ||
        kind === "custom_tool_call" || kind === "custom_tool_call_output" ||
        kind === "local_shell_call" || kind === "web_search_call" ||
        kind === "image_generation_call" ||
        kind === "tool_search_call" || kind === "tool_search_output").length;
      const projectedTools = blocks.filter((block) => block.kind === "historical_tool").length;
      const observedReasoning = item.contentKinds.filter((kind) => kind === "reasoning").length;
      const projectedReasoning = blocks.filter((block) => block.kind === "historical_reasoning").length;
      const observedImages = item.contentKinds.filter((kind) => kind === "input_image").length;
      const observedAudio = item.contentKinds.filter((kind) => kind === "input_audio").length;
      const projectedImageResources = blocks.filter((block, index) =>
        block.kind === "historical_resource" && item.contentKinds![index] === "input_image").length;
      const projectedImageReferences = blocks.filter((block, index) =>
        block.kind === "historical_reference" && block.reference.type === "image" &&
        block.reference.namespace === "codex.input_image_url" &&
        item.contentKinds![index] === "input_image").length;
      const projectedAudio = blocks.filter((block, index) =>
        block.kind === "historical_resource" && item.contentKinds![index] === "input_audio").length;
      const projectedResources = blocks.filter((block) => block.kind === "historical_resource").length;
      const projectedReferences = blocks.filter((block) => block.kind === "historical_reference").length;
      if (
        item.contentKinds.length !== blocks.length || observedTools !== projectedTools ||
        observedReasoning !== projectedReasoning ||
        observedImages !== projectedImageResources + projectedImageReferences ||
        observedAudio !== projectedAudio ||
        projectedResources !== projectedImageResources + projectedAudio ||
        projectedReferences !== projectedImageReferences ||
        (item.role === "user" && (projectedTools !== 0 || projectedReasoning !== 0)) ||
        (item.role !== "user" && (projectedResources !== 0 || projectedReferences !== 0)) ||
        !hasClosedHistoricalToolSequence(blocks)
      ) {
        invalidContent++;
      }
      reasoningEvidence += projectedReasoning;
      toolEvidence += projectedTools;
      inputImageManagedEvidence += projectedImageResources;
      inputImageReferenceEvidence += projectedImageReferences;
      inputAudioEvidence += projectedAudio;
      for (const note of item.portableNotes ?? []) {
        portableNotes.set(note, (portableNotes.get(note) ?? 0) + 1);
      }
    }
    const instant = Date.parse(item.timestamp);
    if (!Number.isFinite(instant) || instant < previousTime) invalidTimestamp++;
    if (Number.isFinite(instant)) previousTime = instant;
    const message: PortableContextMessage = {
      ordinal: messages.length,
      role: item.role,
      blocks: blocks ?? [],
      timestamp: Number.isFinite(instant) ? new Date(instant).toISOString() : item.timestamp,
      model: item.role === "assistant" ? (item.model ?? source.model) : "",
    };
    if (item.role === "assistant") inCompactionUserPrefix = false;
    if (previousRole === "assistant" && item.role === "assistant") {
      const previous = messages.at(-1)!;
      const combined: PortableContextMessage = {
        ...previous,
        blocks: [...previous.blocks, ...message.blocks],
        timestamp: message.timestamp,
        model: message.model || previous.model,
      };
      if (blocks !== undefined) {
        try {
          if (!hasClosedHistoricalToolSequence(combined.blocks)) throw new Error("tool sequence changed across messages");
          renderPortableContextMessage({ sourceAgent: "codex" }, combined);
        } catch {
          invalidContent++;
        }
      }
      messages[messages.length - 1] = combined;
      coalescedAssistantMessages++;
      continue;
    }
    if (
      previousRole === "user" && item.role === "user" &&
      inCompactionUserPrefix
    ) {
      const previous = messages.at(-1)!;
      const combined: PortableContextMessage = {
        ...previous,
        blocks: [...previous.blocks, ...message.blocks],
        timestamp: message.timestamp,
      };
      if (blocks !== undefined) {
        try {
          renderPortableContextMessage({ sourceAgent: "codex" }, combined);
        } catch {
          invalidContent++;
        }
      }
      messages[messages.length - 1] = combined;
      coalescedCompactionUserMessages++;
      continue;
    }
    if (previousRole === item.role) invalidSequence++;
    previousRole = item.role;
    if (blocks !== undefined) {
      try {
        renderPortableContextMessage({ sourceAgent: "codex" }, message);
      } catch {
        invalidContent++;
      }
    }
    messages.push(message);
  }
  if (reasoningEvidence !== 0) {
    findings.push({
      code: "codex.reasoning_summary.degraded",
      disposition: "degraded",
      count: reasoningEvidence,
    });
  }
  if (toolEvidence !== 0) {
    findings.push({ code: "codex.tool_history.degraded", disposition: "degraded", count: toolEvidence });
  }
  if (inputImageManagedEvidence !== 0) {
    findings.push({
      code: "codex.input_image.managed",
      disposition: "degraded",
      count: inputImageManagedEvidence,
    });
  }
  if (inputImageReferenceEvidence !== 0) {
    findings.push({
      code: "codex.input_image.reference_preserved",
      disposition: "degraded",
      count: inputImageReferenceEvidence,
    });
  }
  if (inputAudioEvidence !== 0) {
    findings.push({ code: "codex.input_audio.managed", disposition: "degraded", count: inputAudioEvidence });
  }
  if (coalescedAssistantMessages !== 0) {
    findings.push({
      code: "codex.assistant_messages.coalesced",
      disposition: "degraded",
      count: coalescedAssistantMessages,
    });
  }
  if (coalescedCompactionUserMessages !== 0) {
    findings.push({
      code: "codex.compaction_user_messages.coalesced",
      disposition: "degraded",
      count: coalescedCompactionUserMessages,
    });
  }
  const knownNotes = new Set([
    "codex.custom_tool_transport.skipped",
    "codex.local_shell_transport.skipped",
    "codex.image_generation_transport.skipped",
    "codex.tool_search_transport.skipped",
    "codex.web_search_transport.skipped",
    "codex.reasoning_raw.skipped",
    "codex.reasoning_encrypted.skipped",
    "codex.encrypted_function_args.skipped",
    "codex.tool_output_encrypted.skipped",
    "codex.tool_identity.skipped",
    "codex.tool_metadata.skipped",
    "codex.user_text_elements.skipped",
    "codex.user_skill_selection.skipped",
    "codex.user_mention_selection.skipped",
  ]);
  const degradedNotes = new Set([
    "codex.agent_message_context.materialized",
    "codex.memory_citation.materialized",
    "codex.subagent_inherited_user_messages.coalesced",
    "codex.turn_aborted.materialized",
    "codex.tool_output_audio.managed",
    "codex.tool_output_image.managed",
    "codex.tool_output_image.reference_preserved",
    "codex.image_generation_result.managed",
  ]);
  for (const [code, count] of portableNotes) {
    findings.push(degradedNotes.has(code)
      ? { code, disposition: "degraded", count }
      : knownNotes.has(code)
        ? { code, disposition: "skipped", count }
        : blocked("codex.tool_note.unknown", count));
  }
  if (messages.length === 0) findings.push(blocked("portable.messages.empty"));
  if (messages[0]?.role !== "user" || messages.at(-1)?.role !== "assistant") invalidSequence++;
  if (invalidTimestamp !== 0) findings.push(blocked("portable.message_timestamp.invalid", invalidTimestamp));
  if (invalidContent !== 0) findings.push(blocked("portable.message_content.invalid", invalidContent));
  if (invalidSequence !== 0) findings.push(blocked("portable.message_sequence.unsupported", invalidSequence));

  findings.push({ code: "codex.native_envelope.skipped", disposition: "skipped", count: 1 });
  if (source.provider !== "") findings.push({ code: "codex.provider_metadata.skipped", disposition: "skipped", count: 1 });
  if (source.nativeArchived) findings.push({ code: "codex.native_archive_state.skipped", disposition: "skipped", count: 1 });
  const normalized = normalizeConversionFindings(findings);
  const status = conversionStatus(normalized);
  if (status === "blocked") return { status, findings: normalized };
  return {
    status,
    findings: normalized,
    session: {
      schemaVersion: PORTABLE_CONTEXT_SCHEMA,
      sourceAgent: "codex",
      sourceSessionRef: source.sessionRef,
      sourceNativeId: source.nativeId,
      workingDirectory: path.normalize(source.context),
      defaultModel: source.model,
      title: source.title,
      messages,
    },
  };
}
