import { createHash } from "node:crypto";
import path from "node:path";

import {
  createManagedResourceObject,
  MANAGED_TEXT_MEDIA_TYPE,
  managedResourceName,
  type ManagedResourceObject,
} from "../../../domain/resource.js";
import { readStableSmallFile } from "../../../infrastructure/files.js";
import { canonicalClaudeUuid } from "../identity.js";
import { forEachClaudeJsonlRecord } from "../jsonl.js";

const MAX_TOOL_RESULT_BYTES = 64 * 1024 * 1024;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(?:txt|json)$/;
const PERSISTED_OPEN = "<persisted-output>";
const PERSISTED_CLOSE = "</persisted-output>";
const PATH_LABEL = "Full output saved to: ";
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface ClaudeToolResultFile {
  readonly relativePath: string;
  readonly role: "tool-result";
  readonly filePath: string;
}

export interface ClaudeToolResultBinding {
  readonly callId: string;
  readonly referencePath: string;
  readonly transcriptPath: string;
  readonly file: ClaudeToolResultFile;
}

export interface ClaudeManagedToolResultBinding extends ClaudeToolResultBinding {
  readonly resource: ManagedResourceObject;
}

export interface ClaudeContentReplacement {
  readonly callId: string;
  readonly replacement: string;
  readonly referencePath: string;
}

export interface ClaudeContentReplacementRecord {
  readonly agentId?: string;
  readonly replacements: readonly ClaudeContentReplacement[];
}

export interface ClaudeToolResultOptions {
  readonly transcripts: readonly string[];
  readonly files: readonly ClaudeToolResultFile[];
  readonly sessionId: string;
  readonly projectCarrier: string;
  readonly expectedConfigRoot?: string;
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

function pathParts(relativePath: string): string[] {
  const parts = relativePath.split("/");
  return parts[0] === "claude" ? parts.slice(1) : parts;
}

export function claudeToolResultPathName(
  relativePath: string,
  projectCarrier: string,
  sessionId: string,
): string | undefined {
  const parts = pathParts(relativePath);
  if (
    parts.length !== 5 || parts[0] !== "projects" || parts[1] !== projectCarrier ||
    parts[2] !== sessionId || parts[3] !== "tool-results" || !FILE_NAME.test(parts[4]!)
  ) return undefined;
  return parts[4];
}

function textValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const block = objectValue(raw);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
}

function persistedReference(content: unknown): string | undefined {
  let result: string | undefined;
  for (const text of textValues(content)) {
    const mentionsPersistence = text.includes(PERSISTED_OPEN) || text.includes(PERSISTED_CLOSE) || text.includes(PATH_LABEL);
    if (!mentionsPersistence) continue;
    if (!text.startsWith(`${PERSISTED_OPEN}\n`) || !text.endsWith(`\n${PERSISTED_CLOSE}`)) {
      throw new Error("Claude persisted tool-result wrapper is invalid");
    }
    const preview = text.indexOf("\n\nPreview (");
    if (preview < 0) throw new Error("Claude persisted tool-result preview is missing");
    const paths = text.slice(0, preview).split("\n").flatMap((line) => {
      const index = line.indexOf(PATH_LABEL);
      return index < 0 ? [] : [line.slice(index + PATH_LABEL.length)];
    });
    if (paths.length !== 1 || paths[0] === "" || result !== undefined) {
      throw new Error("Claude persisted tool-result reference is ambiguous");
    }
    result = paths[0];
  }
  return result;
}

export function claudeContentReplacementRecord(
  record: Record<string, unknown>,
  expectedSessionId: string,
): ClaudeContentReplacementRecord | undefined {
  if (
    !hasOnlyFields(record, ["type", "sessionId", "agentId", "replacements", "uuid", "timestamp"]) ||
    record.type !== "content-replacement" || !Array.isArray(record.replacements) ||
    record.replacements.length === 0 ||
    typeof record.sessionId !== "string" ||
    (record.agentId !== undefined &&
      (typeof record.agentId !== "string" || !AGENT_ID.test(record.agentId))) ||
    (record.uuid === undefined) !== (record.timestamp === undefined) ||
    (record.uuid !== undefined && typeof record.uuid !== "string") ||
    (record.timestamp !== undefined &&
      (typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp))))
  ) return undefined;
  try {
    if (canonicalClaudeUuid(record.sessionId) !== canonicalClaudeUuid(expectedSessionId)) return undefined;
    if (record.uuid !== undefined) canonicalClaudeUuid(record.uuid);
  } catch {
    return undefined;
  }
  const replacements: ClaudeContentReplacement[] = [];
  const callIds = new Set<string>();
  for (const raw of record.replacements) {
    const item = objectValue(raw);
    if (
      item === undefined || !hasOnlyFields(item, ["kind", "toolUseId", "replacement"]) ||
      item.kind !== "tool-result" || typeof item.toolUseId !== "string" || item.toolUseId === "" ||
      Buffer.byteLength(item.toolUseId, "utf8") > 1024 || /[\u0000-\u001f\u007f]/.test(item.toolUseId) ||
      callIds.has(item.toolUseId) || typeof item.replacement !== "string"
    ) return undefined;
    let referencePath: string | undefined;
    try { referencePath = persistedReference(item.replacement); } catch { return undefined; }
    if (referencePath === undefined) return undefined;
    callIds.add(item.toolUseId);
    replacements.push({ callId: item.toolUseId, replacement: item.replacement, referencePath });
  }
  return {
    ...(record.agentId === undefined ? {} : { agentId: record.agentId as string }),
    replacements,
  };
}

function replaceableToolResultContent(content: unknown): boolean {
  if (typeof content === "string") return content !== "" && persistedReference(content) === undefined;
  if (!Array.isArray(content) || content.length === 0) return false;
  let size = 0;
  for (const raw of content) {
    const block = objectValue(raw);
    if (
      block === undefined || !hasOnlyFields(block, ["type", "text"]) ||
      block.type !== "text" || typeof block.text !== "string"
    ) return false;
    size += block.text.length;
  }
  return size !== 0;
}

function referenceName(
  referencePath: string,
  projectCarrier: string,
  sessionId: string,
  expectedConfigRoot: string | undefined,
): string {
  if (!path.isAbsolute(referencePath) || path.normalize(referencePath) !== referencePath) {
    throw new Error("Claude persisted tool-result reference is not a canonical absolute path");
  }
  const name = path.basename(referencePath);
  if (!FILE_NAME.test(name)) throw new Error("Claude persisted tool-result filename is invalid");
  const expectedSuffix = path.join("projects", projectCarrier, sessionId, "tool-results", name);
  const parts = referencePath.split(path.sep);
  const suffixParts = expectedSuffix.split(path.sep);
  if (parts.length <= suffixParts.length ||
    !suffixParts.every((part, index) => parts[parts.length - suffixParts.length + index] === part)) {
    throw new Error("Claude persisted tool-result reference belongs to another session");
  }
  if (expectedConfigRoot !== undefined && referencePath !== path.join(expectedConfigRoot, expectedSuffix)) {
    throw new Error("Claude persisted tool-result reference is outside the config root");
  }
  return name;
}

async function validatedFileBytes(file: ClaudeToolResultFile): Promise<Buffer> {
  const bytes = await readStableSmallFile(file.filePath, MAX_TOOL_RESULT_BYTES);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Claude persisted tool result is not UTF-8 text"); }
  if (file.relativePath.endsWith(".json")) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error("Claude persisted JSON tool result is invalid"); }
    if (!Array.isArray(value) || value.some((raw) => objectValue(raw)?.type !== "text")) {
      throw new Error("Claude persisted JSON tool result has unsupported content");
    }
  }
  return bytes;
}

function managedToolResult(
  binding: ClaudeToolResultBinding,
  bytes: Buffer,
): ManagedResourceObject {
  const mediaType = binding.file.relativePath.endsWith(".json")
    ? "application/json"
    : MANAGED_TEXT_MEDIA_TYPE;
  const name = managedResourceName(path.basename(binding.referencePath), mediaType);
  const sourceIdentity = createHash("sha256").update(binding.referencePath).digest("hex");
  const resource = createManagedResourceObject({
    bytes,
    mediaType,
    name,
    sourceReference: `claude:tool-result:${sourceIdentity}`,
  });
  if (resource === undefined) {
    throw new Error("Claude persisted tool result cannot form a managed resource");
  }
  return resource;
}

interface InspectedClaudeToolResultBinding extends ClaudeToolResultBinding {
  readonly resource?: ManagedResourceObject;
}

async function inspectClaudeToolResults(
  options: ClaudeToolResultOptions,
  materializeResources: boolean,
): Promise<readonly InspectedClaudeToolResultBinding[]> {
  const calls = new Map<string, string>();
  const results = new Map<string, Array<{
    readonly transcriptPath: string;
    readonly replaceable: boolean;
    readonly persistedReference?: string;
  }>>();
  const pending: Array<{ readonly callId: string; readonly referencePath: string; readonly transcriptPath: string }> = [];
  const replacements = new Map<string, {
    readonly callId: string;
    readonly referencePath: string;
    readonly transcriptPath: string;
  }>();
  for (const transcriptPath of options.transcripts) {
    await forEachClaudeJsonlRecord(transcriptPath, (record) => {
      if (record.type === "content-replacement") {
        const replacementRecord = claudeContentReplacementRecord(record, options.sessionId);
        if (replacementRecord === undefined) throw new Error("Claude content replacement record is invalid");
        for (const replacement of replacementRecord.replacements) {
          replacements.set(`${transcriptPath}\0${replacement.callId}`, {
            callId: replacement.callId,
            referencePath: replacement.referencePath,
            transcriptPath,
          });
        }
        return;
      }
      const message = objectValue(record.message);
      if (!Array.isArray(message?.content)) return;
      if (message.role === "assistant") {
        for (const raw of message.content) {
          const block = objectValue(raw);
          if (block?.type !== "tool_use" || typeof block.id !== "string" || block.id === "") continue;
          if (calls.has(block.id)) throw new Error("Claude tool use ID is duplicated across native transcripts");
          calls.set(block.id, transcriptPath);
        }
        return;
      }
      if (message.role !== "user") return;
      for (const raw of message.content) {
        const block = objectValue(raw);
        if (block?.type !== "tool_result") continue;
        const referencePath = persistedReference(block.content);
        const grouped = results.get(block.tool_use_id as string) ?? [];
        if (typeof block.tool_use_id === "string" && block.tool_use_id !== "") {
          grouped.push({
            transcriptPath,
            replaceable: replaceableToolResultContent(block.content),
            ...(referencePath === undefined ? {} : { persistedReference: referencePath }),
          });
          results.set(block.tool_use_id, grouped);
        }
        if (referencePath === undefined) continue;
        if (typeof block.tool_use_id !== "string" || block.tool_use_id === "") {
          throw new Error("Claude persisted tool result has no tool use ID");
        }
        pending.push({ callId: block.tool_use_id, referencePath, transcriptPath });
      }
    });
  }

  for (const replacement of replacements.values()) {
    const matchingResults = (results.get(replacement.callId) ?? []).filter((result) =>
      result.transcriptPath === replacement.transcriptPath);
    if (
      calls.get(replacement.callId) !== replacement.transcriptPath || matchingResults.length !== 1 ||
      !matchingResults[0]!.replaceable || matchingResults[0]!.persistedReference !== undefined ||
      pending.some((item) =>
        item.callId === replacement.callId && item.transcriptPath === replacement.transcriptPath)
    ) throw new Error("Claude content replacement is not paired with one replaceable tool result");
    pending.push(replacement);
  }

  const files = new Map<string, ClaudeToolResultFile>();
  for (const file of options.files) {
    const name = claudeToolResultPathName(file.relativePath, options.projectCarrier, options.sessionId);
    if (name === undefined || files.has(name)) throw new Error("Claude persisted tool-result carrier path is invalid");
    files.set(name, file);
  }
  const bindings: InspectedClaudeToolResultBinding[] = [];
  const referenced = new Set<string>();
  for (const item of pending) {
    if (calls.get(item.callId) !== item.transcriptPath) {
      throw new Error("Claude persisted tool result is not paired in its transcript");
    }
    const name = referenceName(
      item.referencePath,
      options.projectCarrier,
      options.sessionId,
      options.expectedConfigRoot,
    );
    const file = files.get(name);
    if (file === undefined || referenced.has(name)) {
      throw new Error("Claude persisted tool-result carrier closure is incomplete");
    }
    referenced.add(name);
    const bytes = await validatedFileBytes(file);
    const binding: ClaudeToolResultBinding = { ...item, file };
    bindings.push({
      ...binding,
      ...(materializeResources ? { resource: managedToolResult(binding, bytes) } : {}),
    });
  }
  if (referenced.size !== files.size) throw new Error("Claude persisted tool-result carrier is unreferenced");
  return bindings.sort((left, right) => left.file.relativePath.localeCompare(right.file.relativePath));
}

export async function validateClaudeToolResults(
  options: ClaudeToolResultOptions,
): Promise<readonly ClaudeToolResultBinding[]> {
  return (await inspectClaudeToolResults(options, false)).map((binding) => ({
    callId: binding.callId,
    referencePath: binding.referencePath,
    transcriptPath: binding.transcriptPath,
    file: binding.file,
  }));
}

export async function loadClaudeToolResultResources(
  options: ClaudeToolResultOptions,
): Promise<readonly ClaudeManagedToolResultBinding[]> {
  return (await inspectClaudeToolResults(options, true)).map((binding) => {
    if (binding.resource === undefined) throw new Error("Claude persisted tool result resource is missing");
    return {
      callId: binding.callId,
      referencePath: binding.referencePath,
      transcriptPath: binding.transcriptPath,
      file: binding.file,
      resource: binding.resource,
    };
  });
}
