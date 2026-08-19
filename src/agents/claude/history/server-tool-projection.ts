import type {
  HistoricalReferenceEvidence,
  HistoricalToolEvidence,
  PortableContextBlock,
  PortableContextJson,
} from "../../../domain/portable-context.js";
import { validHistoricalReference } from "../../../domain/portable-context.js";
import {
  createManagedResourceObject,
  decodeCanonicalBase64,
  MANAGED_TEXT_MEDIA_TYPE,
  managedResourceReference,
  managedResourceName,
  type ManagedResourceObject,
} from "../../../domain/resource.js";
import { projectClaudeTextCitations } from "./client-tool-projection.js";

type HistoricalToolBlock = Extract<PortableContextBlock, { readonly kind: "historical_tool" }>;

export interface ProjectedClaudeServerToolResult {
  readonly block: HistoricalToolBlock;
  readonly managedResources: readonly ManagedResourceObject[];
  readonly notes: readonly string[];
}

const DIRECT_SERVER_TOOL_NAMES = new Set([
  "advisor",
  "bash_code_execution",
  "code_execution",
  "text_editor_code_execution",
  "tool_search_tool_bm25",
  "tool_search_tool_regex",
  "web_fetch",
  "web_search",
]);
const DIRECT_SERVER_RESULT_KINDS = new Set([
  "advisor_tool_result",
  "bash_code_execution_tool_result",
  "code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "web_fetch_tool_result",
  "web_search_tool_result",
]);
const CODE_EXECUTION_ERROR_CODES = new Set([
  "execution_time_exceeded",
  "invalid_tool_input",
  "too_many_requests",
  "unavailable",
]);
const BASH_CODE_EXECUTION_ERROR_CODES = new Set([
  ...CODE_EXECUTION_ERROR_CODES,
  "output_file_too_large",
]);
const TOOL_SEARCH_ERROR_CODES = new Set([
  "execution_time_exceeded",
  "invalid_tool_input",
  "too_many_requests",
  "unavailable",
]);
const TEXT_EDITOR_ERROR_CODES = new Set([
  "execution_time_exceeded",
  "file_not_found",
  "invalid_tool_input",
  "too_many_requests",
  "unavailable",
]);
const ADVISOR_ERROR_CODES = new Set([
  "execution_time_exceeded",
  "max_uses_exceeded",
  "model_not_found",
  "overloaded",
  "prompt_too_long",
  "too_many_requests",
  "unavailable",
]);
const ADVISOR_STOP_REASONS = new Set([
  "compaction",
  "end_turn",
  "max_tokens",
  "model_context_window_exceeded",
  "pause_turn",
  "refusal",
  "stop_sequence",
  "tool_use",
]);
const WEB_SEARCH_ERROR_CODES = new Set([
  "invalid_tool_input",
  "max_uses_exceeded",
  "query_too_long",
  "request_too_large",
  "too_many_requests",
  "unavailable",
]);
const WEB_FETCH_ERROR_CODES = new Set([
  "invalid_tool_input",
  "max_uses_exceeded",
  "too_many_requests",
  "unavailable",
  "unsupported_content_type",
  "url_not_accessible",
  "url_not_allowed",
  "url_not_in_prior_context",
  "url_too_long",
]);

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((name) => names.has(name));
}

function implicitOrDirectCaller(value: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, "caller")) return true;
  const caller = objectValue(value.caller);
  return caller !== undefined && hasOnlyFields(caller, ["type"]) && caller.type === "direct";
}

function projectServerToolError(
  content: Record<string, unknown>,
  callId: string,
  errorKind: string,
  errorCodes: ReadonlySet<string>,
  requireMessage = false,
): ProjectedClaudeServerToolResult | undefined {
  if (
    !hasOnlyFields(content, requireMessage ? ["type", "error_code", "error_message"] : ["type", "error_code"]) ||
    content.type !== errorKind || typeof content.error_code !== "string" ||
    !errorCodes.has(content.error_code) ||
    (requireMessage && !(content.error_message === null || typeof content.error_message === "string"))
  ) return undefined;
  return {
    block: {
      kind: "historical_tool",
      tool: {
        phase: "result",
        callId,
        error: {
          type: errorKind,
          error_code: content.error_code,
          ...(requireMessage ? { error_message: content.error_message as string | null } : {}),
        },
      },
    },
    managedResources: [],
    notes: [],
  };
}

function portableHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function nullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDirectServerToolResultKind(kind: string): boolean {
  return DIRECT_SERVER_RESULT_KINDS.has(kind);
}

function projectDirectServerToolCall(
  block: Record<string, unknown>,
): HistoricalToolBlock | undefined {
  const input = objectValue(block.input);
  if (
    !hasOnlyFields(block, ["type", "id", "name", "input", "caller"]) ||
    block.type !== "server_tool_use" || typeof block.name !== "string" ||
    !DIRECT_SERVER_TOOL_NAMES.has(block.name) ||
    typeof block.id !== "string" || block.id === "" || input === undefined ||
    !implicitOrDirectCaller(block)
  ) return undefined;
  if (block.name === "advisor" && !hasOnlyFields(input, [])) return undefined;
  if (
    (block.name === "tool_search_tool_bm25" || block.name === "tool_search_tool_regex") &&
    (!hasOnlyFields(input, ["query"]) || typeof input.query !== "string" || input.query === "")
  ) return undefined;
  return {
    kind: "historical_tool",
    tool: {
      phase: "call",
      callId: block.id,
      name: block.name,
      namespace: "anthropic.server",
      input: input as PortableContextJson,
    },
  };
}

function projectMcpServerToolCall(
  block: Record<string, unknown>,
): HistoricalToolBlock | undefined {
  if (
    !hasOnlyFields(block, ["type", "id", "name", "server_name", "input"]) ||
    block.type !== "mcp_tool_use" || typeof block.id !== "string" || block.id === "" ||
    typeof block.name !== "string" || block.name === "" ||
    typeof block.server_name !== "string" || block.server_name === "" ||
    !Object.hasOwn(block, "input")
  ) return undefined;
  return {
    kind: "historical_tool",
    tool: {
      phase: "call",
      callId: block.id,
      name: block.name,
      namespace: "anthropic.mcp",
      input: {
        server_name: block.server_name,
        arguments: block.input as PortableContextJson,
      },
    },
  };
}

function projectMcpResultContent(value: unknown): PortableContextJson | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const content: PortableContextJson[] = [];
  for (const raw of value) {
    const text = objectValue(raw);
    if (
      text === undefined || !hasOnlyFields(text, ["type", "text", "citations"]) ||
      text.type !== "text" || typeof text.text !== "string"
    ) return undefined;
    const citations = Object.hasOwn(text, "citations")
      ? projectClaudeTextCitations(text.citations, "response")
      : undefined;
    if (Object.hasOwn(text, "citations") && citations === undefined) return undefined;
    content.push({
      type: "text",
      text: text.text,
      ...(citations === undefined ? {} : { citations }),
    });
  }
  return content;
}

function projectMcpServerToolResult(
  block: Record<string, unknown>,
  call: HistoricalToolEvidence,
): ProjectedClaudeServerToolResult | undefined {
  const content = projectMcpResultContent(block.content);
  if (
    !hasOnlyFields(block, ["type", "tool_use_id", "is_error", "content"]) ||
    block.type !== "mcp_tool_result" || block.tool_use_id !== call.callId ||
    typeof block.is_error !== "boolean" || content === undefined
  ) return undefined;
  const payload: PortableContextJson = {
    type: "mcp_tool_result",
    is_error: block.is_error,
    content,
  };
  return {
    block: {
      kind: "historical_tool",
      tool: block.is_error
        ? { phase: "result", callId: call.callId, error: payload }
        : { phase: "result", callId: call.callId, output: payload },
    },
    managedResources: [],
    notes: [],
  };
}

function projectExecutionResult(
  block: Record<string, unknown>,
  callId: string,
  family: "bash_code_execution" | "code_execution",
): ProjectedClaudeServerToolResult | undefined {
  const content = objectValue(block.content);
  const resultKind = `${family}_tool_result`;
  const contentKind = `${family}_result`;
  const errorKind = `${family}_tool_result_error`;
  if (
    !hasOnlyFields(block, ["type", "tool_use_id", "content"]) ||
    block.type !== resultKind || block.tool_use_id !== callId ||
    content === undefined
  ) return undefined;
  if (content.type === errorKind) {
    const errorCodes = family === "bash_code_execution"
      ? BASH_CODE_EXECUTION_ERROR_CODES
      : CODE_EXECUTION_ERROR_CODES;
    return projectServerToolError(content, callId, errorKind, errorCodes);
  }
  const outputFiles = projectExecutionOutputFiles(content.content, family);
  if (
    family === "code_execution" && content.type === "encrypted_code_execution_result" &&
    hasOnlyFields(content, ["type", "content", "encrypted_stdout", "return_code", "stderr"]) &&
    outputFiles !== undefined && typeof content.encrypted_stdout === "string" &&
    Number.isSafeInteger(content.return_code) && typeof content.stderr === "string"
  ) {
    return {
      block: {
        kind: "historical_tool",
        tool: {
          phase: "result",
          callId,
          output: {
            type: "encrypted_code_execution_result",
            content: outputFiles.content,
            encrypted_stdout_omitted: true,
            return_code: content.return_code as number,
            stderr: content.stderr,
          },
          ...(outputFiles.references.length === 0 ? {} : { references: outputFiles.references }),
        },
      },
      managedResources: [],
      notes: [
        "claude.server_code_execution_encrypted_stdout.skipped",
        ...(outputFiles.content.length === 0 ? [] : ["claude.server_execution_output_file.reference_only"]),
      ],
    };
  }
  if (
    !hasOnlyFields(content, ["type", "content", "return_code", "stderr", "stdout"]) ||
    content.type !== contentKind || outputFiles === undefined ||
    !Number.isSafeInteger(content.return_code) || typeof content.stderr !== "string" ||
    typeof content.stdout !== "string"
  ) return undefined;
  return {
    block: {
      kind: "historical_tool",
      tool: {
        phase: "result",
        callId,
        output: {
          type: contentKind,
          content: outputFiles.content,
          return_code: content.return_code as number,
          stderr: content.stderr,
          stdout: content.stdout,
        },
        ...(outputFiles.references.length === 0 ? {} : { references: outputFiles.references }),
      },
    },
    managedResources: [],
    notes: outputFiles.content.length === 0
      ? []
      : ["claude.server_execution_output_file.reference_only"],
  };
}

interface ProjectedExecutionOutputFiles {
  readonly content: readonly PortableContextJson[];
  readonly references: readonly HistoricalReferenceEvidence[];
}

function projectExecutionOutputFiles(
  value: unknown,
  family: "bash_code_execution" | "code_execution",
): ProjectedExecutionOutputFiles | undefined {
  if (!Array.isArray(value)) return undefined;
  const outputKind = family === "bash_code_execution"
    ? "bash_code_execution_output"
    : "code_execution_output";
  const outputFiles: PortableContextJson[] = [];
  const references = new Map<string, HistoricalReferenceEvidence>();
  for (const raw of value) {
    const output = objectValue(raw);
    if (
      output === undefined || !hasOnlyFields(output, ["type", "file_id"]) ||
      output.type !== outputKind || typeof output.file_id !== "string" || output.file_id === ""
    ) return undefined;
    outputFiles.push({ type: outputKind, file_id: output.file_id });
    const reference: HistoricalReferenceEvidence = {
      type: "file",
      namespace: "anthropic.files",
      locator: output.file_id,
    };
    if (!validHistoricalReference(reference)) return undefined;
    references.set(reference.locator, reference);
  }
  return { content: outputFiles, references: [...references.values()] };
}

function projectWebSearchResult(
  block: Record<string, unknown>,
  callId: string,
): ProjectedClaudeServerToolResult | undefined {
  if (
    !hasOnlyFields(block, ["type", "tool_use_id", "content", "caller"]) ||
    block.type !== "web_search_tool_result" || block.tool_use_id !== callId ||
    !implicitOrDirectCaller(block)
  ) return undefined;
  const error = objectValue(block.content);
  if (error !== undefined) {
    return projectServerToolError(
      error,
      callId,
      "web_search_tool_result_error",
      WEB_SEARCH_ERROR_CODES,
    );
  }
  if (!Array.isArray(block.content)) return undefined;
  const content: PortableContextJson[] = [];
  for (const raw of block.content) {
    const result = objectValue(raw);
    if (
      result === undefined ||
      !hasOnlyFields(result, ["type", "url", "title", "encrypted_content", "page_age"]) ||
      result.type !== "web_search_result" || !portableHttpUrl(result.url) ||
      typeof result.title !== "string" || result.title === "" ||
      typeof result.encrypted_content !== "string" || result.encrypted_content === "" ||
      !(result.page_age === null || typeof result.page_age === "string")
    ) return undefined;
    content.push({
      type: "web_search_result",
      url: result.url,
      title: result.title,
      page_age: result.page_age,
    });
  }
  return {
    block: {
      kind: "historical_tool",
      tool: {
        phase: "result",
        callId,
        output: { type: "web_search_tool_result", content },
      },
    },
    managedResources: [],
    notes: block.content.length === 0
      ? []
      : ["claude.server_web_search_encrypted_content.skipped"],
  };
}

function projectAdvisorResult(
  block: Record<string, unknown>,
  callId: string,
): ProjectedClaudeServerToolResult | undefined {
  const content = objectValue(block.content);
  if (
    !hasOnlyFields(block, ["type", "tool_use_id", "content"]) ||
    block.type !== "advisor_tool_result" || block.tool_use_id !== callId || content === undefined
  ) return undefined;
  if (content.type === "advisor_tool_result_error") {
    return projectServerToolError(
      content,
      callId,
      "advisor_tool_result_error",
      ADVISOR_ERROR_CODES,
    );
  }
  const stopReason = content.stop_reason;
  if (!(stopReason === null || typeof stopReason === "string" && ADVISOR_STOP_REASONS.has(stopReason))) {
    return undefined;
  }
  let output: PortableContextJson;
  let notes: readonly string[] = [];
  if (
    content.type === "advisor_result" &&
    hasOnlyFields(content, ["type", "text", "stop_reason"]) && typeof content.text === "string"
  ) {
    output = { type: content.type, text: content.text, stop_reason: stopReason };
  } else if (
    content.type === "advisor_redacted_result" &&
    hasOnlyFields(content, ["type", "encrypted_content", "stop_reason"]) &&
    typeof content.encrypted_content === "string" && content.encrypted_content !== ""
  ) {
    output = { type: content.type, stop_reason: stopReason };
    notes = ["claude.server_advisor_encrypted_content.skipped"];
  } else {
    return undefined;
  }
  return {
    block: {
      kind: "historical_tool",
      tool: { phase: "result", callId, output },
    },
    managedResources: [],
    notes,
  };
}

function projectToolSearchResult(
  block: Record<string, unknown>,
  callId: string,
): ProjectedClaudeServerToolResult | undefined {
  const result = objectValue(block.content);
  if (
    !hasOnlyFields(block, ["type", "tool_use_id", "content"]) ||
    block.type !== "tool_search_tool_result" || block.tool_use_id !== callId ||
    result === undefined
  ) return undefined;
  if (result.type === "tool_search_tool_result_error") {
    return projectServerToolError(
      result,
      callId,
      "tool_search_tool_result_error",
      TOOL_SEARCH_ERROR_CODES,
      true,
    );
  }
  if (
    !hasOnlyFields(result, ["type", "tool_references"]) ||
    result.type !== "tool_search_tool_search_result" || !Array.isArray(result.tool_references)
  ) return undefined;
  const toolReferences: PortableContextJson[] = [];
  for (const raw of result.tool_references) {
    const reference = objectValue(raw);
    if (
      reference === undefined || !hasOnlyFields(reference, ["type", "tool_name"]) ||
      reference.type !== "tool_reference" || typeof reference.tool_name !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(reference.tool_name)
    ) return undefined;
    toolReferences.push({ type: "tool_reference", tool_name: reference.tool_name });
  }
  return {
    block: {
      kind: "historical_tool",
      tool: {
        phase: "result",
        callId,
        output: {
          type: "tool_search_tool_search_result",
          tool_references: toolReferences,
        },
      },
    },
    managedResources: [],
    notes: ["claude.server_tool_search_result.preserved"],
  };
}

function projectTextEditorResult(
  block: Record<string, unknown>,
  call: HistoricalToolEvidence,
): ProjectedClaudeServerToolResult | undefined {
  const content = objectValue(block.content);
  const input = objectValue(call.input);
  if (
    !hasOnlyFields(block, ["type", "tool_use_id", "content"]) ||
    block.type !== "text_editor_code_execution_tool_result" || block.tool_use_id !== call.callId ||
    content === undefined || input === undefined
  ) return undefined;
  if (content.type === "text_editor_code_execution_tool_result_error") {
    return projectServerToolError(
      content,
      call.callId,
      "text_editor_code_execution_tool_result_error",
      TEXT_EDITOR_ERROR_CODES,
      true,
    );
  }

  let output: PortableContextJson;
  if (content.type === "text_editor_code_execution_view_result") {
    if (
      !hasOnlyFields(input, ["command", "path"]) || input.command !== "view" ||
      typeof input.path !== "string" || input.path === "" ||
      !hasOnlyFields(content, ["type", "content", "file_type", "num_lines", "start_line", "total_lines"]) ||
      content.file_type !== "text" || typeof content.content !== "string" ||
      !nullableNonNegativeInteger(content.num_lines) ||
      !nullableNonNegativeInteger(content.start_line) ||
      !nullableNonNegativeInteger(content.total_lines)
    ) return undefined;
    output = {
      type: content.type,
      content: content.content,
      file_type: content.file_type,
      num_lines: content.num_lines,
      start_line: content.start_line,
      total_lines: content.total_lines,
    };
  } else if (content.type === "text_editor_code_execution_create_result") {
    if (
      !hasOnlyFields(input, ["command", "file_text", "path"]) || input.command !== "create" ||
      typeof input.path !== "string" || input.path === "" || typeof input.file_text !== "string" ||
      !hasOnlyFields(content, ["type", "is_file_update"]) || typeof content.is_file_update !== "boolean"
    ) return undefined;
    output = { type: content.type, is_file_update: content.is_file_update };
  } else if (content.type === "text_editor_code_execution_str_replace_result") {
    if (
      !hasOnlyFields(input, ["command", "new_str", "old_str", "path"]) || input.command !== "str_replace" ||
      typeof input.path !== "string" || input.path === "" ||
      typeof input.old_str !== "string" || input.old_str === "" || typeof input.new_str !== "string" ||
      !hasOnlyFields(content, ["type", "lines", "new_lines", "new_start", "old_lines", "old_start"]) ||
      !(content.lines === null || Array.isArray(content.lines) && content.lines.every((line) => typeof line === "string")) ||
      !nullableNonNegativeInteger(content.new_lines) ||
      !nullableNonNegativeInteger(content.new_start) ||
      !nullableNonNegativeInteger(content.old_lines) ||
      !nullableNonNegativeInteger(content.old_start)
    ) return undefined;
    output = {
      type: content.type,
      lines: content.lines as string[] | null,
      new_lines: content.new_lines,
      new_start: content.new_start,
      old_lines: content.old_lines,
      old_start: content.old_start,
    };
  } else {
    return undefined;
  }
  return {
    block: {
      kind: "historical_tool",
      tool: { phase: "result", callId: call.callId, output },
    },
    managedResources: [],
    notes: [],
  };
}

function projectWebFetchResult(
  block: Record<string, unknown>,
  call: HistoricalToolEvidence,
): ProjectedClaudeServerToolResult | undefined {
  const result = objectValue(block.content);
  const callInput = objectValue(call.input);
  const document = objectValue(result?.content);
  const source = objectValue(document?.source);
  const citations = objectValue(document?.citations);
  if (
    !hasOnlyFields(block, ["type", "tool_use_id", "content", "caller"]) ||
    block.type !== "web_fetch_tool_result" || block.tool_use_id !== call.callId ||
    !implicitOrDirectCaller(block) ||
    result === undefined
  ) return undefined;
  if (result.type === "web_fetch_tool_result_error") {
    return projectServerToolError(
      result,
      call.callId,
      "web_fetch_tool_result_error",
      WEB_FETCH_ERROR_CODES,
    );
  }
  if (
    callInput === undefined || !hasOnlyFields(callInput, ["url"]) ||
    !hasOnlyFields(result, ["type", "content", "retrieved_at", "url"]) ||
    result.type !== "web_fetch_result" || !portableHttpUrl(result.url) || callInput.url !== result.url ||
    !(result.retrieved_at === null || validTimestamp(result.retrieved_at)) ||
    document === undefined || !hasOnlyFields(document, ["type", "source", "title", "citations"]) ||
    document.type !== "document" || !(document.title === null || typeof document.title === "string") ||
    !(document.citations === null ||
      citations !== undefined && hasOnlyFields(citations, ["enabled"]) && typeof citations.enabled === "boolean") ||
    source === undefined || !hasOnlyFields(source, ["type", "media_type", "data"]) ||
    typeof source.data !== "string" || source.data === ""
  ) return undefined;

  let bytes: Buffer;
  let mediaType: string;
  let filename: string;
  if (source.type === "text" && source.media_type === "text/plain") {
    bytes = Buffer.from(source.data, "utf8");
    mediaType = MANAGED_TEXT_MEDIA_TYPE;
    filename = "web-fetch.txt";
  } else if (source.type === "base64" && source.media_type === "application/pdf") {
    const decoded = decodeCanonicalBase64(source.data);
    if (decoded === undefined) return undefined;
    bytes = decoded;
    mediaType = source.media_type;
    filename = "web-fetch.pdf";
  } else {
    return undefined;
  }

  const name = managedResourceName(filename, mediaType);
  const resource = createManagedResourceObject({
    bytes,
    mediaType,
    name,
    sourceReference: (sha256) =>
      `claude:server-web-fetch:${call.callId}:sha256:${sha256}`,
  });
  if (resource === undefined) return undefined;
  const portableCitations: PortableContextJson = document.citations === null
    ? null
    : { enabled: citations!.enabled as boolean };
  return {
    block: {
      kind: "historical_tool",
      tool: {
        phase: "result",
        callId: call.callId,
        output: {
          type: "web_fetch_result",
          url: result.url,
          retrieved_at: result.retrieved_at,
          content: {
            type: "document",
            title: document.title,
            citations: portableCitations,
            source: {
              type: "managed_resource",
              media_type: resource.mediaType,
              resource_relative_path: resource.relativePath,
            },
          },
        },
        resources: [managedResourceReference(resource)],
      },
    },
    managedResources: [resource],
    notes: ["claude.server_web_fetch_resource.managed"],
  };
}

function projectDirectServerToolResult(
  block: Record<string, unknown>,
  call: HistoricalToolEvidence,
): ProjectedClaudeServerToolResult | undefined {
  if (call.phase !== "call") return undefined;
  if (call.name === "advisor") return projectAdvisorResult(block, call.callId);
  if (call.name === "code_execution" || call.name === "bash_code_execution") {
    return projectExecutionResult(block, call.callId, call.name);
  }
  if (call.name === "tool_search_tool_bm25" || call.name === "tool_search_tool_regex") {
    return projectToolSearchResult(block, call.callId);
  }
  if (call.name === "text_editor_code_execution") return projectTextEditorResult(block, call);
  if (call.name === "web_search") return projectWebSearchResult(block, call.callId);
  if (call.name === "web_fetch") return projectWebFetchResult(block, call);
  return undefined;
}

export function isClaudeServerToolResultKind(kind: string): boolean {
  return kind === "mcp_tool_result" || isDirectServerToolResultKind(kind);
}

export function isClaudeServerToolCall(call: HistoricalToolEvidence): boolean {
  return call.phase === "call" &&
    (call.namespace === "anthropic.server" || call.namespace === "anthropic.mcp");
}

export function projectClaudeServerToolCall(
  block: Record<string, unknown>,
): HistoricalToolBlock | undefined {
  return block.type === "mcp_tool_use"
    ? projectMcpServerToolCall(block)
    : projectDirectServerToolCall(block);
}

export function projectClaudeServerToolResult(
  block: Record<string, unknown>,
  call: HistoricalToolEvidence,
): ProjectedClaudeServerToolResult | undefined {
  if (call.namespace === "anthropic.mcp") return projectMcpServerToolResult(block, call);
  if (call.namespace === "anthropic.server") return projectDirectServerToolResult(block, call);
  return undefined;
}
