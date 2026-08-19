import type { PortableContextBlock } from "../../../domain/portable-context.js";

interface ProjectedOpenCodeReadablePart {
  readonly text?: string;
  readonly block?: PortableContextBlock;
  readonly notes?: readonly string[];
  readonly gap?: string;
  readonly gapCode?: string;
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

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTime(value: unknown): boolean {
  if (value === undefined) return true;
  const time = objectValue(value);
  if (
    time === undefined || !hasOnlyFields(time, ["start", "end"]) ||
    !nonNegativeInteger(time.start) ||
    (time.end !== undefined && (!nonNegativeInteger(time.end) || time.end < time.start))
  ) return false;
  return true;
}

function validRequiredTime(value: unknown): boolean {
  return value !== undefined && validTime(value);
}

export function projectOpenCodeTextPart(
  data: Record<string, unknown>,
  role: "user" | "assistant",
): ProjectedOpenCodeReadablePart {
  if (
    !hasOnlyFields(data, ["type", "text", "synthetic", "ignored", "time", "metadata"]) ||
    data.type !== "text" || typeof data.text !== "string" ||
    (data.synthetic !== undefined && typeof data.synthetic !== "boolean") ||
    (data.ignored !== undefined && typeof data.ignored !== "boolean") ||
    !validTime(data.time) ||
    (data.metadata !== undefined && objectValue(data.metadata) === undefined)
  ) {
    return { gap: "text part metadata is invalid", gapCode: "opencode.part.text_invalid" };
  }
  if (data.text === "") {
    return { gap: "empty text part", gapCode: "opencode.part.text_empty" };
  }
  if (role === "user" && data.ignored === true) {
    return { gap: `ignored user text: ${data.text}`, gapCode: "opencode.part.text_ignored" };
  }
  const notes = data.synthetic === undefined && data.ignored === undefined &&
    data.time === undefined && data.metadata === undefined
    ? []
    : [
        "opencode.text_attributes.skipped",
        ...(data.synthetic === true ? ["opencode.legacy_synthetic.carrier"] : []),
      ];
  return {
    text: data.text,
    block: { kind: "text", text: data.text },
    notes,
  };
}

export function projectOpenCodeReasoningPart(
  data: Record<string, unknown>,
): ProjectedOpenCodeReadablePart {
  if (
    !hasOnlyFields(data, ["type", "text", "metadata", "time"]) ||
    data.type !== "reasoning" || typeof data.text !== "string" ||
    (data.metadata !== undefined && objectValue(data.metadata) === undefined) ||
    !validRequiredTime(data.time)
  ) {
    return { gap: "reasoning part metadata is invalid", gapCode: "opencode.part.reasoning_invalid" };
  }
  if (data.text.trim() === "") return {};
  return {
    text: `[reasoning]\n${data.text}`,
    block: { kind: "historical_reasoning_trace", text: data.text },
    notes: [
      "opencode.reasoning_timing.skipped",
      ...(data.metadata === undefined ? [] : ["opencode.reasoning_provider_metadata.skipped"]),
    ],
  };
}
