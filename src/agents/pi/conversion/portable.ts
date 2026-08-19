import {
  conversionStatus,
  normalizeConversionFindings,
  type ConversionFinding,
  type PortableSourceNormalization,
  type PreparedPortableSource,
} from "../../../domain/conversion.js";
import type { AgentSnapshot, JsonValue, StoredSession } from "../../../domain/history.js";
import {
  hasClosedHistoricalToolSequence,
  PORTABLE_CONTEXT_SCHEMA,
  renderPortableContextMessage,
  type PortableContextBlock,
  type PortableContextMessage,
} from "../../../domain/portable-context.js";
import {
  createManagedResourceObject,
  decodeCanonicalBase64,
  managedResourceName,
  managedResourceReference,
  type ManagedResourceObject,
} from "../../../domain/resource.js";
import { snapshotRawPath } from "../../../infrastructure/history-store.js";
import { parsePiSession, type ParsedPiSession, type PiSessionEntry } from "../history/session.js";
import { readPiNativeDescriptor } from "../migration/archive.js";

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function blocked(code: string, count = 1): ConversionFinding {
  return { code, disposition: "blocked", count };
}

function textBlocks(value: JsonValue | undefined): Array<Record<string, JsonValue>> {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const block = objectValue(item);
        return block === undefined ? [] : [block];
      })
    : typeof value === "string"
      ? [{ type: "text", text: value }]
      : [];
}

function messageTime(message: Readonly<Record<string, JsonValue>>, fallback: string): string {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString()
    : fallback;
}

function portableImage(
  block: Readonly<Record<string, JsonValue>>,
  source: StoredSession,
  entry: PiSessionEntry,
  index: number,
): ManagedResourceObject | undefined {
  if (typeof block.data !== "string" || typeof block.mimeType !== "string") return undefined;
  const bytes = decodeCanonicalBase64(block.data);
  if (bytes === undefined) return undefined;
  const fallback = managedResourceName("", block.mimeType);
  const suffix = fallback.startsWith("attachment") ? fallback.slice("attachment".length) : ".bin";
  const name = managedResourceName(`pi-${entry.id}-${index}${suffix}`, block.mimeType);
  return createManagedResourceObject({
    bytes,
    mediaType: block.mimeType,
    name,
    sourceReference: `pi.session:${source.nativeId}#${entry.id}/content/${index}`,
  });
}

interface PortableBuild {
  readonly messages: PortableContextMessage[];
  readonly resources: ManagedResourceObject[];
  readonly findings: ConversionFinding[];
  invalidContent: number;
  invalidSequence: number;
  invalidTimestamp: number;
  previousTime: number;
  toolEvidence: number;
  reasoningEvidence: number;
  imageEvidence: number;
  coalescedMessages: number;
}

function addResource(build: PortableBuild, resource: ManagedResourceObject): void {
  if (!build.resources.some((item) => item.relativePath === resource.relativePath)) build.resources.push(resource);
}

function appendMessage(
  build: PortableBuild,
  role: "user" | "assistant",
  blocks: readonly PortableContextBlock[],
  timestamp: string,
  model: string,
): void {
  if (blocks.length === 0) {
    build.invalidContent++;
    return;
  }
  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant) || instant < build.previousTime) build.invalidTimestamp++;
  if (Number.isFinite(instant)) build.previousTime = instant;
  const previous = build.messages.at(-1);
  if (previous?.role === role) {
    build.messages[build.messages.length - 1] = {
      ...previous,
      blocks: [...previous.blocks, ...blocks],
      timestamp,
      model: role === "assistant" ? model || previous.model : "",
    };
    build.coalescedMessages++;
    return;
  }
  build.messages.push({
    ordinal: build.messages.length,
    role,
    blocks,
    timestamp,
    model: role === "assistant" ? model : "",
  });
}

function userBlocks(
  build: PortableBuild,
  source: StoredSession,
  entry: PiSessionEntry,
  content: JsonValue | undefined,
): PortableContextBlock[] {
  const result: PortableContextBlock[] = [];
  for (const [index, block] of textBlocks(content).entries()) {
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text !== "") result.push({ kind: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      const resource = portableImage(block, source, entry, index);
      if (resource === undefined) {
        build.invalidContent++;
      } else {
        addResource(build, resource);
        result.push({ kind: "historical_resource", resource: managedResourceReference(resource) });
        build.imageEvidence++;
      }
      continue;
    }
    build.invalidContent++;
  }
  return result;
}

function assistantBlocks(
  build: PortableBuild,
  entry: PiSessionEntry,
  content: JsonValue | undefined,
): PortableContextBlock[] {
  const result: PortableContextBlock[] = [];
  for (const block of textBlocks(content)) {
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text !== "") result.push({ kind: "text", text: block.text });
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      if (block.thinking !== "") {
        result.push({ kind: "historical_reasoning_trace", text: block.thinking });
        build.reasoningEvidence++;
      }
      continue;
    }
    if (
      block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string" &&
      objectValue(block.arguments) !== undefined
    ) {
      const input = objectValue(block.arguments)!;
      result.push({
        kind: "historical_tool",
        tool: {
          phase: "call",
          callId: block.id,
          name: block.name,
          namespace: "pi",
          input,
        },
      });
      build.toolEvidence++;
      continue;
    }
    build.invalidContent++;
  }
  return result;
}

function toolResultBlock(
  build: PortableBuild,
  source: StoredSession,
  entry: PiSessionEntry,
  message: Readonly<Record<string, JsonValue>>,
): PortableContextBlock | undefined {
  if (typeof message.toolCallId !== "string" || typeof message.isError !== "boolean") return undefined;
  const text: string[] = [];
  const resources: ManagedResourceObject[] = [];
  for (const [index, block] of textBlocks(message.content).entries()) {
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
    } else if (block.type === "image") {
      const resource = portableImage(block, source, entry, index);
      if (resource === undefined) return undefined;
      addResource(build, resource);
      resources.push(resource);
      build.imageEvidence++;
    } else {
      return undefined;
    }
  }
  build.toolEvidence++;
  const evidence = {
    phase: "result" as const,
    callId: message.toolCallId,
    ...(message.isError
      ? { error: { text, images: resources.map((item) => ({ mediaType: item.mediaType, sha256: item.sha256 })) } }
      : { output: { text, images: resources.map((item) => ({ mediaType: item.mediaType, sha256: item.sha256 })) } }),
    ...(resources.length === 0 ? {} : { resources: resources.map(managedResourceReference) }),
  };
  return { kind: "historical_tool", tool: evidence };
}

function buildPortableContext(
  source: StoredSession,
  parsed: ParsedPiSession,
): { readonly normalization: PortableSourceNormalization; readonly resources: readonly ManagedResourceObject[] } {
  const build: PortableBuild = {
    messages: [],
    resources: [],
    findings: [],
    invalidContent: 0,
    invalidSequence: 0,
    invalidTimestamp: 0,
    previousTime: Number.NEGATIVE_INFINITY,
    toolEvidence: 0,
    reasoningEvidence: 0,
    imageEvidence: 0,
    coalescedMessages: 0,
  };
  let compactions = 0;
  let branchSummaries = 0;
  let customMessages = 0;
  let metadataEntries = 0;
  for (const entry of parsed.activeEntries) {
    if (entry.type === "message") {
      const message = objectValue(entry.record.message)!;
      const role = message.role;
      const timestamp = messageTime(message, entry.timestamp);
      if (role === "user") {
        appendMessage(build, "user", userBlocks(build, source, entry, message.content), timestamp, "");
      } else if (role === "assistant") {
        appendMessage(
          build,
          "assistant",
          assistantBlocks(build, entry, message.content),
          timestamp,
          typeof message.model === "string" ? message.model : source.model,
        );
      } else if (role === "toolResult") {
        const block = toolResultBlock(build, source, entry, message);
        if (block === undefined) build.invalidContent++;
        else appendMessage(build, "assistant", [block], timestamp, source.model);
      } else if (role === "bashExecution") {
        if (
          typeof message.command !== "string" || typeof message.output !== "string" ||
          typeof message.cancelled !== "boolean" || typeof message.truncated !== "boolean"
        ) {
          build.invalidContent++;
        } else {
          const failed = message.cancelled;
          appendMessage(build, "assistant", [{
            kind: "historical_tool",
            tool: {
              phase: "exchange",
              callId: entry.id,
              name: "bash",
              namespace: "pi",
              status: failed ? "error" : "completed",
              input: { command: message.command },
              ...(failed
                ? { error: { output: message.output, cancelled: true, truncated: message.truncated } }
                : { output: { output: message.output, truncated: message.truncated } }),
            },
          }], timestamp, source.model);
          build.toolEvidence++;
        }
      } else if (role === "custom") {
        appendMessage(build, "user", userBlocks(build, source, entry, message.content), timestamp, "");
        customMessages++;
      } else if (role === "branchSummary" || role === "compactionSummary") {
        const summary = typeof message.summary === "string" ? message.summary : "";
        appendMessage(build, "assistant", [{
          kind: "historical_event",
          event: role === "branchSummary" ? "Pi branch summary" : "Pi compaction summary",
          reason: summary,
        }], timestamp, source.model);
        if (role === "branchSummary") branchSummaries++;
        else compactions++;
      }
      continue;
    }
    if (entry.type === "custom_message") {
      appendMessage(build, "user", userBlocks(build, source, entry, entry.record.content), entry.timestamp, "");
      customMessages++;
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      const summary = typeof entry.record.summary === "string" ? entry.record.summary : "";
      appendMessage(build, "assistant", [{
        kind: "historical_event",
        event: entry.type === "compaction" ? "Pi compaction" : "Pi branch summary",
        reason: summary,
      }], entry.timestamp, source.model);
      if (entry.type === "compaction") compactions++;
      else branchSummaries++;
    } else {
      metadataEntries++;
    }
  }

  const inactive = parsed.entries.length - parsed.activeEntries.length;
  if (inactive !== 0) build.findings.push({ code: "pi.inactive_branch.skipped", disposition: "skipped", count: inactive });
  if (parsed.branchPoints !== 0) {
    build.findings.push({ code: "pi.branch_structure.skipped", disposition: "skipped", count: parsed.branchPoints });
  }
  if (source.nativeArchived) build.findings.push({ code: "pi.native_archive_state.skipped", disposition: "skipped", count: 1 });
  if (readPiNativeDescriptor(source).parentSessionRef !== null) {
    build.findings.push({ code: "pi.parent_session.skipped", disposition: "skipped", count: 1 });
  }
  if (metadataEntries !== 0) {
    build.findings.push({ code: "pi.session_metadata.skipped", disposition: "skipped", count: metadataEntries });
  }
  if (customMessages !== 0) {
    build.findings.push({ code: "pi.custom_message.materialized", disposition: "degraded", count: customMessages });
  }
  if (compactions !== 0) {
    build.findings.push({ code: "pi.compaction.materialized", disposition: "degraded", count: compactions });
  }
  if (branchSummaries !== 0) {
    build.findings.push({ code: "pi.branch_summary.materialized", disposition: "degraded", count: branchSummaries });
  }
  if (build.toolEvidence !== 0) {
    build.findings.push({ code: "pi.tool_history.degraded", disposition: "degraded", count: build.toolEvidence });
  }
  if (build.reasoningEvidence !== 0) {
    build.findings.push({ code: "pi.reasoning_trace.degraded", disposition: "degraded", count: build.reasoningEvidence });
  }
  if (build.imageEvidence !== 0) {
    build.findings.push({ code: "pi.inline_image.managed", disposition: "degraded", count: build.imageEvidence });
  }
  if (build.coalescedMessages !== 0) {
    build.findings.push({ code: "pi.messages.coalesced", disposition: "degraded", count: build.coalescedMessages });
  }
  if (build.messages.length === 0) build.findings.push(blocked("portable.messages.empty"));
  if (build.messages[0]?.role !== "user" || build.messages.at(-1)?.role !== "assistant") build.invalidSequence++;
  for (const [index, message] of build.messages.entries()) {
    build.messages[index] = { ...message, ordinal: index };
    try {
      if (!hasClosedHistoricalToolSequence(message.blocks)) throw new Error("tool sequence is incomplete");
      renderPortableContextMessage({ sourceAgent: "pi" }, message);
    } catch {
      build.invalidContent++;
    }
  }
  if (build.invalidTimestamp !== 0) {
    build.findings.push(blocked("portable.message_timestamp.invalid", build.invalidTimestamp));
  }
  if (build.invalidContent !== 0) {
    build.findings.push(blocked("portable.message_content.invalid", build.invalidContent));
  }
  if (build.invalidSequence !== 0) {
    build.findings.push(blocked("portable.message_sequence.unsupported", build.invalidSequence));
  }
  build.findings.push({ code: "pi.native_envelope.skipped", disposition: "skipped", count: 1 });
  if (source.provider !== "") {
    build.findings.push({ code: "pi.provider_metadata.skipped", disposition: "skipped", count: 1 });
  }
  const findings = normalizeConversionFindings(build.findings);
  const status = conversionStatus(findings);
  if (status === "blocked") return { normalization: { status, findings }, resources: [] };
  return {
    normalization: {
      status,
      findings,
      session: {
        schemaVersion: PORTABLE_CONTEXT_SCHEMA,
        sourceAgent: "pi",
        sourceSessionRef: source.sessionRef,
        sourceNativeId: source.nativeId,
        workingDirectory: source.context,
        defaultModel: source.model,
        title: source.title,
        messages: build.messages,
      },
    },
    resources: build.resources,
  };
}

export async function preparePiPortableSource(
  stateDirectory: string,
  snapshot: AgentSnapshot,
  source: StoredSession,
): Promise<PreparedPortableSource> {
  if (snapshot.agent !== "pi" || source.agent !== "pi" ||
    !snapshot.sessions.some((session) => session.sessionRef === source.sessionRef && session.nativeId === source.nativeId)) {
    throw new Error(`Pi portable source is outside the snapshot: ${source.sessionRef}`);
  }
  const descriptor = readPiNativeDescriptor(source);
  const parsed = await parsePiSession(
    snapshotRawPath(stateDirectory, snapshot, descriptor.relativePath),
    source.updatedAt,
  );
  if (parsed.header.id !== source.nativeId || parsed.header.cwd !== source.context) {
    throw new Error(`Pi portable source changed after capture: ${source.sessionRef}`);
  }
  const materialized = { ...source, conversation: parsed.conversation, searchText: parsed.searchText };
  const portable = buildPortableContext(materialized, parsed);
  return { source: materialized, normalization: portable.normalization, resources: portable.resources };
}
