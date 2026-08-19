import { readStableSmallFile } from "../../../infrastructure/files.js";
import { forEachClaudeJsonlRecord } from "../jsonl.js";

const MAX_METADATA_BYTES = 1024 * 1024;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SUBAGENT_METADATA_FIELDS = new Set([
  "agentType", "description", "name", "spawnDepth", "toolUseId",
]);

export type ClaudeSubagentFileRole = "subagent-transcript" | "subagent-metadata";

export interface ClaudeSubagentFile {
  readonly relativePath: string;
  readonly role: ClaudeSubagentFileRole;
  readonly filePath: string;
}

export interface ClaudeSubagentBundle {
  readonly agentId: string;
  readonly toolUseId: string;
  readonly transcript: ClaudeSubagentFile;
  readonly metadata: ClaudeSubagentFile;
  readonly observedCwds: readonly string[];
  readonly searchText: readonly string[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readableTextContent(value: unknown): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const block = objectValue(raw);
    return block?.type === "text" && typeof block.text === "string" && block.text !== ""
      ? [block.text]
      : [];
  });
}

function readableMessageContent(value: unknown): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const block = objectValue(raw);
    if (block?.type === "text" && typeof block.text === "string" && block.text !== "") return [block.text];
    if (block?.type === "tool_use" && typeof block.name === "string" && block.name !== "") {
      return [`Tool: ${block.name}`];
    }
    return block?.type === "tool_result" ? readableTextContent(block.content) : [];
  });
}

function pathParts(relativePath: string): string[] {
  const parts = relativePath.split("/");
  return parts[0] === "claude" ? parts.slice(1) : parts;
}

export function claudeSubagentPathIdentity(
  relativePath: string,
  projectCarrier: string,
  sessionId: string,
): { readonly role: ClaudeSubagentFileRole; readonly agentId: string } | undefined {
  const parts = pathParts(relativePath);
  if (
    parts.length !== 5 || parts[0] !== "projects" || parts[1] !== projectCarrier ||
    parts[2] !== sessionId || parts[3] !== "subagents"
  ) return undefined;
  const transcript = /^agent-([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jsonl$/.exec(parts[4]!);
  if (transcript !== null) return { role: "subagent-transcript", agentId: transcript[1]! };
  const metadata = /^agent-([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.meta\.json$/.exec(parts[4]!);
  return metadata === null ? undefined : { role: "subagent-metadata", agentId: metadata[1]! };
}

async function mainToolUseIds(filePath: string): Promise<ReadonlySet<string>> {
  const result = new Set<string>();
  await forEachClaudeJsonlRecord(filePath, (record) => {
    const message = objectValue(record.message);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    for (const raw of message.content) {
      const block = objectValue(raw);
      if (block?.type !== "tool_use" || typeof block.id !== "string" || block.id === "") continue;
      if (result.has(block.id)) throw new Error("Claude main transcript contains a duplicate tool use ID");
      result.add(block.id);
    }
  });
  return result;
}

async function subagentMetadata(filePath: string): Promise<{ readonly toolUseId: string }> {
  const bytes = await readStableSmallFile(filePath, MAX_METADATA_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Claude subagent metadata is invalid JSON"); }
  const metadata = objectValue(parsed);
  if (
    metadata === undefined || Object.keys(metadata).some((field) => !SUBAGENT_METADATA_FIELDS.has(field)) ||
    typeof metadata.agentType !== "string" || metadata.agentType === "" ||
    typeof metadata.description !== "string" ||
    (metadata.name !== undefined && !AGENT_ID.test(typeof metadata.name === "string" ? metadata.name : "")) ||
    metadata.spawnDepth !== 1 ||
    typeof metadata.toolUseId !== "string" || metadata.toolUseId === ""
  ) throw new Error("Claude subagent metadata is incomplete");
  return { toolUseId: metadata.toolUseId };
}

async function validateSubagentTranscript(
  filePath: string,
  sessionId: string,
  agentId: string,
  allowedCwds: ReadonlySet<string>,
): Promise<{ readonly observedCwds: readonly string[]; readonly searchText: readonly string[] }> {
  if (!AGENT_ID.test(agentId)) throw new Error("Claude subagent ID is invalid");
  const observedCwds = new Set<string>();
  const searchText: string[] = [];
  let messages = 0;
  await forEachClaudeJsonlRecord(filePath, (record) => {
    if (record.sessionId !== undefined && record.sessionId !== sessionId) {
      throw new Error("Claude subagent transcript belongs to another session");
    }
    if (record.agentId !== undefined && record.agentId !== agentId) {
      throw new Error("Claude subagent transcript has another agent ID");
    }
    if (record.isSidechain !== undefined && record.isSidechain !== true) {
      throw new Error("Claude subagent transcript is not a sidechain");
    }
    if (record.cwd !== undefined) {
      if (typeof record.cwd !== "string" || !allowedCwds.has(record.cwd)) {
        throw new Error("Claude subagent transcript cwd is outside the main session");
      }
      observedCwds.add(record.cwd);
    }
    if (record.type === "user" || record.type === "assistant") {
      if (
        record.sessionId !== sessionId || record.agentId !== agentId || record.isSidechain !== true ||
        typeof record.cwd !== "string"
      ) throw new Error("Claude subagent message identity is incomplete");
      messages++;
      const message = objectValue(record.message);
      if (message?.role === record.type) searchText.push(...readableMessageContent(message.content));
    }
  });
  if (messages === 0 || observedCwds.size === 0) throw new Error("Claude subagent transcript has no message history");
  return { observedCwds: [...observedCwds].sort(), searchText };
}

export async function validateClaudeSubagentBundles(options: {
  readonly mainTranscriptPath: string;
  readonly sessionId: string;
  readonly projectCarrier: string;
  readonly allowedCwds: readonly string[];
  readonly files: readonly ClaudeSubagentFile[];
}): Promise<readonly ClaudeSubagentBundle[]> {
  if (options.files.length === 0) return [];
  const mainIds = await mainToolUseIds(options.mainTranscriptPath);
  const grouped = new Map<string, Partial<Record<ClaudeSubagentFileRole, ClaudeSubagentFile>>>();
  for (const file of options.files) {
    const identity = claudeSubagentPathIdentity(file.relativePath, options.projectCarrier, options.sessionId);
    if (identity === undefined || identity.role !== file.role) {
      throw new Error("Claude subagent carrier path is invalid");
    }
    const group = grouped.get(identity.agentId) ?? {};
    if (group[file.role] !== undefined) throw new Error("Claude subagent carrier is duplicated");
    group[file.role] = file;
    grouped.set(identity.agentId, group);
  }
  const result: ClaudeSubagentBundle[] = [];
  const claimedToolUses = new Set<string>();
  const allowedCwds = new Set(options.allowedCwds);
  for (const [agentId, group] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    const transcript = group["subagent-transcript"];
    const metadata = group["subagent-metadata"];
    if (transcript === undefined || metadata === undefined) throw new Error("Claude subagent carrier pair is incomplete");
    const parsedMetadata = await subagentMetadata(metadata.filePath);
    if (!mainIds.has(parsedMetadata.toolUseId) || claimedToolUses.has(parsedMetadata.toolUseId)) {
      throw new Error("Claude subagent metadata is not linked to one main tool use");
    }
    claimedToolUses.add(parsedMetadata.toolUseId);
    const parsedTranscript = await validateSubagentTranscript(
      transcript.filePath,
      options.sessionId,
      agentId,
      allowedCwds,
    );
    result.push({
      agentId,
      toolUseId: parsedMetadata.toolUseId,
      transcript,
      metadata,
      observedCwds: parsedTranscript.observedCwds,
      searchText: parsedTranscript.searchText,
    });
  }
  return result;
}
