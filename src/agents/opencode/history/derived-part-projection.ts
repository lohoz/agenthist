export const OPENCODE_LEGACY_COMPACTION_TAIL_NOTE = "opencode.legacy_compaction_tail.preserved";

export interface ProjectedOpenCodeDerivedPart {
  readonly kind: string;
  readonly label: string;
  readonly code: string;
}

export interface OpenCodeSubtaskDescriptor {
  readonly prompt: string;
  readonly description: string;
  readonly agent: string;
  readonly model?: {
    readonly providerID: string;
    readonly modelID: string;
  };
  readonly command?: string;
}

export interface OpenCodeCompactionDescriptor {
  readonly tailStartId?: string;
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

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

export function openCodeCompactionDescriptor(
  data: Record<string, unknown>,
): OpenCodeCompactionDescriptor | undefined {
  const tailStartId = data.tail_start_id;
  if (
    data.type !== "compaction" ||
    !hasOnlyFields(data, ["type", "auto", "overflow", "tail_start_id"]) ||
    typeof data.auto !== "boolean" || !optionalBoolean(data.overflow) ||
    (tailStartId !== undefined && (typeof tailStartId !== "string" || tailStartId === ""))
  ) return undefined;
  return typeof tailStartId === "string" ? { tailStartId } : {};
}

function validStepFinish(data: Record<string, unknown>): boolean {
  const tokens = objectValue(data.tokens);
  const cache = objectValue(tokens?.cache);
  return hasOnlyFields(data, ["type", "reason", "snapshot", "cost", "tokens"]) &&
    typeof data.reason === "string" && optionalString(data.snapshot) && finite(data.cost) &&
    tokens !== undefined && hasOnlyFields(tokens, ["total", "input", "output", "reasoning", "cache"]) &&
    (tokens.total === undefined || finite(tokens.total)) && finite(tokens.input) &&
    finite(tokens.output) && finite(tokens.reasoning) && cache !== undefined &&
    hasOnlyFields(cache, ["read", "write"]) && finite(cache.read) && finite(cache.write);
}

function patchFiles(data: Record<string, unknown>): readonly string[] | undefined {
  if (
    !hasOnlyFields(data, ["type", "hash", "files"]) ||
    typeof data.hash !== "string" || data.hash === "" ||
    !Array.isArray(data.files) || data.files.length === 0 ||
    !data.files.every((file): file is string => typeof file === "string" && file !== "")
  ) return undefined;
  return data.files;
}

export function openCodeAgentName(data: Record<string, unknown>): string | undefined {
  const source = data.source === undefined ? undefined : objectValue(data.source);
  const validSource = data.source === undefined ||
    (source !== undefined && hasOnlyFields(source, ["value", "start", "end"]) &&
      typeof source.value === "string" && nonNegativeInteger(source.start) &&
      nonNegativeInteger(source.end) && source.end >= source.start);
  if (
    data.type !== "agent" || !hasOnlyFields(data, ["type", "name", "source"]) ||
    typeof data.name !== "string" || data.name === "" || !validSource
  ) return undefined;
  return data.name;
}

export function openCodeSubtaskDescriptor(
  data: Record<string, unknown>,
): OpenCodeSubtaskDescriptor | undefined {
  const model = data.model === undefined ? undefined : objectValue(data.model);
  const command = typeof data.command === "string" ? data.command : undefined;
  if (
    data.type !== "subtask" ||
    !hasOnlyFields(data, ["type", "prompt", "description", "agent", "model", "command"]) ||
    typeof data.prompt !== "string" || typeof data.description !== "string" ||
    typeof data.agent !== "string" || data.agent === "" ||
    (data.command !== undefined && command === undefined) ||
    (data.model !== undefined && (
      model === undefined || !hasOnlyFields(model, ["providerID", "modelID"]) ||
      typeof model.providerID !== "string" || model.providerID === "" ||
      typeof model.modelID !== "string" || model.modelID === ""
    ))
  ) return undefined;
  return {
    prompt: data.prompt,
    description: data.description,
    agent: data.agent,
    ...(model === undefined ? {} : {
      model: { providerID: model.providerID as string, modelID: model.modelID as string },
    }),
    ...(command === undefined ? {} : { command }),
  };
}

export function projectOpenCodeDerivedPart(
  data: Record<string, unknown>,
): ProjectedOpenCodeDerivedPart | undefined {
  if (data.type === "step-start") {
    const valid = hasOnlyFields(data, ["type", "snapshot"]) && optionalString(data.snapshot);
    return {
      kind: "step-start",
      label: valid ? "step started" : "step-start metadata is invalid",
      code: valid ? "opencode.part.step_start" : "opencode.part.step_start_invalid",
    };
  }
  if (data.type === "step-finish") {
    const valid = validStepFinish(data);
    return {
      kind: "step-finish",
      label: valid ? `step finished${data.reason === "" ? "" : `: ${String(data.reason)}`}` : "step-finish metadata is invalid",
      code: valid ? "opencode.part.step_finish" : "opencode.part.step_finish_invalid",
    };
  }
  if (data.type === "patch") {
    const files = patchFiles(data);
    return {
      kind: "patch",
      label: files === undefined ? "patch metadata is invalid" : `workspace patch metadata: ${files.join(", ")}`,
      code: files === undefined ? "opencode.part.patch_invalid" : "opencode.part.patch",
    };
  }
  if (data.type === "compaction") {
    const valid = openCodeCompactionDescriptor(data) !== undefined;
    return {
      kind: "compaction",
      label: valid ? "compaction boundary" : "compaction metadata is invalid",
      code: valid ? "opencode.part.compaction" : "opencode.part.compaction_invalid",
    };
  }
  if (data.type === "agent") {
    const name = openCodeAgentName(data);
    return {
      kind: "agent",
      label: name === undefined ? "agent reference metadata is invalid" : `agent reference: ${name}`,
      code: name === undefined ? "opencode.part.agent_invalid" : "opencode.part.agent",
    };
  }
  if (data.type === "subtask") {
    const valid = openCodeSubtaskDescriptor(data) !== undefined;
    return {
      kind: "subtask",
      label: valid ? `subtask control: ${String(data.agent)}` : "subtask metadata is invalid",
      code: valid ? "opencode.part.subtask" : "opencode.part.subtask_invalid",
    };
  }
  return undefined;
}
