import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { JsonValue } from "../../../domain/history.js";
import type { PortableContextBlock } from "../../../domain/portable-context.js";
import { managedResourceReference, type ManagedResourceObject } from "../../../domain/resource.js";
import { projectOpenCodeToolAttachments } from "./file-part-projection.js";
import { verifyOpenCodeTask } from "./task-projection.js";
import type { OpenCodeToolOutputDescriptor } from "../tool-output.js";

interface OpenCodeMessageIdentity {
  readonly messageId: string;
  readonly sessionId: string;
}

export interface ProjectedOpenCodeTool {
  readonly block?: PortableContextBlock;
  readonly notes?: readonly string[];
  readonly managedResources?: readonly ManagedResourceObject[];
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((name) => names.has(name));
}

function emptyObject(value: unknown): boolean {
  return value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0);
}

function portableTransportMetadata(value: unknown): boolean {
  if (emptyObject(value)) return true;
  const metadata = objectValue(value);
  const openai = objectValue(metadata?.openai);
  return metadata !== undefined && hasOnlyFields(metadata, ["openai"]) && openai !== undefined &&
    hasOnlyFields(openai, ["itemId"]) && typeof openai.itemId === "string" && openai.itemId !== "";
}

function toolTime(value: unknown, status: "completed" | "error"): { readonly compacted: boolean } | undefined {
  if (value === undefined) return { compacted: false };
  const time = objectValue(value);
  const start = integer(time?.start);
  const end = integer(time?.end);
  const compacted = integer(time?.compacted);
  if (
    time === undefined || !hasOnlyFields(time, status === "completed" ? ["start", "end", "compacted"] : ["start", "end"]) ||
    start === undefined || start < 0 || end === undefined || end < start ||
    (status === "completed" && time.compacted !== undefined &&
      (compacted === undefined || compacted < end))
  ) return undefined;
  return { compacted: status === "completed" && compacted !== undefined };
}

function verifiedReadMetadata(
  name: string,
  input: unknown,
  output: unknown,
  value: unknown,
): boolean {
  if (emptyObject(value)) return true;
  const metadata = objectValue(value);
  const inputObject = objectValue(input);
  const display = objectValue(metadata?.display);
  const filePath = text(inputObject?.filePath);
  const preview = text(metadata?.preview);
  if (
    name !== "read" || metadata === undefined || display === undefined || filePath === undefined ||
    !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath || preview === undefined ||
    typeof output !== "string" || !output.includes(filePath) || !output.includes(preview) ||
    !hasOnlyFields(metadata, ["preview", "truncated", "loaded", "display"]) ||
    metadata.truncated !== false || !Array.isArray(metadata.loaded) || metadata.loaded.length !== 0 ||
    !hasOnlyFields(display, ["type", "path", "text", "lineStart", "lineEnd", "totalLines", "truncated"]) ||
    display.type !== "file" || display.path !== filePath || display.text !== preview || display.truncated !== false
  ) return false;
  const lineStart = integer(display.lineStart);
  const lineEnd = integer(display.lineEnd);
  const totalLines = integer(display.totalLines);
  return lineStart !== undefined && lineStart >= 1 && lineEnd !== undefined && lineEnd >= lineStart &&
    totalLines !== undefined && totalLines >= lineEnd;
}

function verifiedStructuredOutput(
  name: string,
  input: unknown,
  output: unknown,
  title: unknown,
  value: unknown,
  timeValue: unknown,
  attachments: unknown,
  expected: unknown,
): boolean {
  const metadata = objectValue(value);
  const time = objectValue(timeValue);
  const start = integer(time?.start);
  const end = integer(time?.end);
  return name === "StructuredOutput" && expected !== undefined &&
    isDeepStrictEqual(input, expected) && output === "Structured output captured successfully." &&
    title === "Structured Output" && metadata !== undefined &&
    hasOnlyFields(metadata, ["valid"]) && metadata.valid === true && attachments === undefined &&
    time !== undefined && hasOnlyFields(time, ["start", "end"]) &&
    start !== undefined && start >= 0 && end !== undefined && end >= start;
}

export function projectOpenCodeTool(
  data: Record<string, unknown>,
  identity: OpenCodeMessageIdentity,
  toolOutputs: readonly OpenCodeToolOutputDescriptor[],
  toolOutputResources: ReadonlyMap<string, ManagedResourceObject>,
  expectedStructured: unknown,
): ProjectedOpenCodeTool {
  if (!hasOnlyFields(data, ["type", "tool", "callID", "state", "metadata"]) ||
    !portableTransportMetadata(data.metadata)) {
    return {};
  }
  const name = text(data.tool);
  const callId = text(data.callID);
  const state = objectValue(data.state);
  const status = text(state?.status);
  if (name === undefined || name === "" || callId === undefined || callId === "" || state === undefined ||
    (status !== "completed" && status !== "error")) {
    return {};
  }
  const allowed = status === "completed"
    ? ["status", "input", "output", "title", "metadata", "time", "attachments"]
    : ["status", "input", "error", "metadata", "time"];
  const input = state.input;
  if (!hasOnlyFields(state, allowed) || objectValue(input) === undefined) return {};
  const time = toolTime(state.time, status);
  if (time === undefined) return {};
  const validatedInlineResources = status === "completed"
    ? projectOpenCodeToolAttachments(state.attachments, identity)
    : [];
  if (validatedInlineResources === undefined) return {};
  const outputPresent = Object.hasOwn(state, "output");
  const errorPresent = Object.hasOwn(state, "error");
  if ((status === "completed" && (!outputPresent || typeof state.output !== "string")) ||
    (status === "error" && (!errorPresent || typeof state.error !== "string"))) {
    return {};
  }
  let toolOutputResource: ManagedResourceObject | undefined;
  let toolOutputNote: string | undefined;
  const structuredOutput = name === "StructuredOutput";
  const task = status === "completed" && state.title === objectValue(input)?.description &&
    state.attachments === undefined
    ? verifyOpenCodeTask({
        name,
        parameters: input,
        output: state.output,
        metadata: state.metadata,
        identity,
      })
    : undefined;
  const stateMetadata = objectValue(state.metadata);
  if (structuredOutput) {
    if (!verifiedStructuredOutput(
      name,
      input,
      state.output,
      state.title,
      state.metadata,
      state.time,
      state.attachments,
      expectedStructured,
    )) return {};
  } else if (task !== undefined) {
    // The parent transcript already contains the task result replayed to its model.
  } else if (stateMetadata?.truncated === true) {
    const nativePath = text(stateMetadata.outputPath);
    const descriptor = nativePath === undefined
      ? undefined
      : toolOutputs.find((item) => item.nativePath === nativePath);
    if (
      descriptor === undefined || typeof state.output !== "string" || !state.output.includes(descriptor.nativePath)
    ) return {};
    if (descriptor.available) {
      const resource = toolOutputResources.get(descriptor.nativePath);
      if (resource === undefined) return {};
      if (!time.compacted) {
        toolOutputResource = resource;
        toolOutputNote = "opencode.tool_output.managed";
      }
    } else {
      if (!time.compacted) toolOutputNote = "opencode.tool_output.unavailable";
    }
  } else if (!verifiedReadMetadata(name, input, state.output, state.metadata)) return {};
  if (state.title !== undefined && typeof state.title !== "string") return {};
  if (state.time !== undefined && objectValue(state.time) === undefined) return {};
  const notes = [
    ...(data.metadata === undefined ? [] : ["opencode.tool_metadata.skipped"]),
    ...(state.title === undefined ? [] : ["opencode.tool_title.skipped"]),
    ...(state.metadata === undefined ? [] : ["opencode.tool_metadata.skipped"]),
    ...(state.time === undefined ? [] : ["opencode.tool_timing.skipped"]),
  ];
  const managedResources = [
    ...(time.compacted ? [] : validatedInlineResources),
    ...(toolOutputResource === undefined ? [] : [toolOutputResource]),
  ];
  return {
    block: {
      kind: "historical_tool",
      tool: {
        phase: "exchange",
        callId,
        name,
        status,
        input: input as JsonValue,
        ...(outputPresent
          ? { output: time.compacted ? "[Old tool result content cleared]" : state.output as string }
          : {}),
        ...(errorPresent ? { error: state.error as string } : {}),
        ...(managedResources.length === 0
          ? {}
          : { resources: managedResources.map(managedResourceReference) }),
      },
    },
    notes: [
      ...notes,
      ...(time.compacted
        ? ["opencode.tool_output.compacted"]
        : validatedInlineResources.map(() => "opencode.inline_resource.managed")),
      ...(toolOutputNote === undefined ? [] : [toolOutputNote]),
      ...(structuredOutput ? ["opencode.structured_output.closed"] : []),
      ...(task?.kind === "foreground_completed" || task?.kind === "foreground_resumed"
        ? ["opencode.task_result.closed"]
        : []),
      ...(task?.kind === "background_started" ? ["opencode.background_task.started"] : []),
      ...(task?.kind === "background_updated" ? ["opencode.background_task.updated"] : []),
    ],
    managedResources,
  };
}
