import { constants, createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { canonicalCodexSessionId } from "../identity.js";
import { parseCodexRollout, type CodexHistoryBase } from "./rollout.js";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface CodexMetadataRewrite {
  readonly nativeId: string;
  readonly beforeProvider: string;
  readonly afterProvider: string;
  readonly beforeCwd: string;
  readonly afterCwd: string;
  readonly historyBase?: {
    readonly before: CodexHistoryBase;
    readonly after: CodexHistoryBase;
  };
}

export interface CodexMetadataRewriteResult {
  readonly byteOffsetDelta: number;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

function whitespace(value: string, position: number): number {
  while (position < value.length) {
    const character = value.charCodeAt(position);
    if (character !== 0x20 && character !== 0x09 && character !== 0x0a && character !== 0x0d) break;
    position++;
  }
  return position;
}

function stringEnd(value: string, position: number): number {
  if (value[position] !== '"') throw new Error("expected a JSON string");
  let escaped = false;
  for (let index = position + 1; index < value.length; index++) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      JSON.parse(value.slice(position, index + 1));
      return index + 1;
    } else if (value.charCodeAt(index) < 0x20) {
      throw new Error("invalid control character in JSON string");
    }
  }
  throw new Error("unterminated JSON string");
}

function valueEnd(value: string, position: number, depth: number): number {
  if (depth > 256 || position >= value.length) throw new Error("JSON nesting exceeds limits");
  const first = value[position]!;
  if (first === '"') return stringEnd(value, position);
  if (first === "{" || first === "[") {
    const object = first === "{";
    const closing = object ? "}" : "]";
    position++;
    for (;;) {
      position = whitespace(value, position);
      if (position >= value.length) throw new Error("unterminated JSON composite");
      if (value[position] === closing) return position + 1;
      if (object) {
        position = whitespace(value, stringEnd(value, position));
        if (value[position] !== ":") throw new Error("JSON object member has no colon");
        position = whitespace(value, position + 1);
      }
      position = whitespace(value, valueEnd(value, position, depth + 1));
      if (value[position] === closing) return position + 1;
      if (value[position] !== ",") throw new Error("invalid JSON composite separator");
      position++;
    }
  }
  let end = position;
  while (end < value.length && !",}] \t\r\n".includes(value[end]!)) end++;
  if (end === position) throw new Error("invalid JSON scalar");
  JSON.parse(value.slice(position, end));
  return end;
}

function objectMember(value: string, wanted: string): Span {
  let position = whitespace(value, 0);
  if (value[position] !== "{") throw new Error("JSON value is not an object");
  position++;
  let found: Span | undefined;
  for (;;) {
    position = whitespace(value, position);
    if (position >= value.length) throw new Error("unterminated JSON object");
    if (value[position] === "}") {
      if (whitespace(value, position + 1) !== value.length) throw new Error("trailing JSON object data");
      if (found === undefined) throw new Error(`JSON member is missing: ${wanted}`);
      return found;
    }
    const keyStart = position;
    const keyEnd = stringEnd(value, position);
    const key = JSON.parse(value.slice(keyStart, keyEnd)) as unknown;
    if (typeof key !== "string") throw new Error("invalid JSON object key");
    position = whitespace(value, keyEnd);
    if (value[position] !== ":") throw new Error("JSON object member has no colon");
    const start = whitespace(value, position + 1);
    const end = valueEnd(value, start, 1);
    if (key === wanted) {
      if (found !== undefined) throw new Error(`duplicate JSON member: ${wanted}`);
      found = { start, end };
    }
    position = whitespace(value, end);
    if (value[position] === ",") {
      position++;
    } else if (value[position] !== "}") {
      throw new Error("invalid JSON object separator");
    }
  }
}

function patchMetadata(record: string, rewrite: CodexMetadataRewrite): string {
  const payload = objectMember(record, "payload");
  const payloadValue = record.slice(payload.start, payload.end);
  const replacements: Array<{ readonly start: number; readonly end: number; readonly value: string }> = [];
  for (const field of [
    { name: "model_provider", before: rewrite.beforeProvider, after: rewrite.afterProvider },
    { name: "cwd", before: rewrite.beforeCwd, after: rewrite.afterCwd },
  ]) {
    const span = objectMember(payloadValue, field.name);
    const current = JSON.parse(payloadValue.slice(span.start, span.end)) as unknown;
    if (current !== field.before) throw new Error(`Codex metadata ${field.name} changed before rewrite`);
    if (field.before !== field.after) {
      replacements.push({
        start: payload.start + span.start,
        end: payload.start + span.end,
        value: JSON.stringify(field.after),
      });
    }
  }
  if (rewrite.historyBase !== undefined) {
    const historySpan = objectMember(payloadValue, "history_base");
    const historyValue = payloadValue.slice(historySpan.start, historySpan.end);
    const current = JSON.parse(historyValue) as unknown;
    const before = rewrite.historyBase.before;
    const after = rewrite.historyBase.after;
    if (
      current === null || typeof current !== "object" || Array.isArray(current) ||
      (current as Record<string, unknown>).thread_id !== before.threadId ||
      (current as Record<string, unknown>).end_ordinal_exclusive !== before.endOrdinalExclusive ||
      (current as Record<string, unknown>).end_byte_offset !== before.endByteOffset ||
      after.threadId !== before.threadId || after.endOrdinalExclusive !== before.endOrdinalExclusive ||
      !Number.isSafeInteger(after.endByteOffset) || after.endByteOffset <= 0
    ) throw new Error("Codex metadata history_base changed before rewrite");
    if (after.endByteOffset !== before.endByteOffset) {
      const offsetSpan = objectMember(historyValue, "end_byte_offset");
      replacements.push({
        start: payload.start + historySpan.start + offsetSpan.start,
        end: payload.start + historySpan.start + offsetSpan.end,
        value: String(after.endByteOffset),
      });
    }
  }
  replacements.sort((left, right) => right.start - left.start);
  let result = record;
  for (const replacement of replacements) {
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  }
  JSON.parse(result);
  return result;
}

function metadataId(payload: Record<string, unknown>): string {
  const id = payload.id;
  const session = payload.session_id;
  if (typeof id !== "string" || (session !== undefined && typeof session !== "string")) {
    throw new Error("Codex session metadata identity is invalid");
  }
  if (typeof session === "string") canonicalCodexSessionId(session);
  return canonicalCodexSessionId(id);
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, value: Buffer): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const result = await handle.write(value, offset, value.byteLength - offset, null);
    if (result.bytesWritten === 0) throw new Error("Codex rollout rewrite made no progress");
    offset += result.bytesWritten;
  }
}

export async function rewriteCodexMetadata(
  inputPath: string,
  outputPath: string,
  rawRewrite: CodexMetadataRewrite,
): Promise<CodexMetadataRewriteResult> {
  const rewrite = { ...rawRewrite, nativeId: canonicalCodexSessionId(rawRewrite.nativeId) };
  if (
    rewrite.beforeProvider === "" || rewrite.afterProvider === "" ||
    rewrite.beforeCwd === "" || rewrite.afterCwd === ""
  ) {
    throw new Error("Codex metadata rewrite values cannot be blank");
  }
  const input = createReadStream(inputPath);
  const output = await open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let metadataRecords = 0;
  let matchingRecords = 0;
  let byteOffsetDelta = 0;
  const processLine = async (raw: Buffer): Promise<void> => {
    const hasNewline = raw.byteLength > 0 && raw[raw.byteLength - 1] === 0x0a;
    const line = hasNewline ? raw.subarray(0, raw.byteLength - 1) : raw;
    if (line.byteLength > MAX_RECORD_BYTES) throw new Error("Codex rollout record is too large during rewrite");
    let start = 0;
    let end = line.byteLength;
    while (start < end && [0x20, 0x09, 0x0d].includes(line[start]!)) start++;
    while (end > start && [0x20, 0x09, 0x0d].includes(line[end - 1]!)) end--;
    let rendered = line;
    if (start < end) {
      const record = decoder.decode(line.subarray(start, end));
      const event = JSON.parse(record) as unknown;
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        throw new Error("Codex rollout event is invalid during rewrite");
      }
      const object = event as Record<string, unknown>;
      if (object.type === "session_meta") {
        metadataRecords++;
        const payload = object.payload;
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("Codex session metadata is invalid during rewrite");
        }
        const id = metadataId(payload as Record<string, unknown>);
        if (id === rewrite.nativeId) {
          if (metadataRecords !== 1 || ++matchingRecords !== 1) {
            throw new Error("Codex target session metadata is ambiguous during rewrite");
          }
          const patched = Buffer.from(patchMetadata(record, rewrite), "utf8");
          rendered = Buffer.concat([line.subarray(0, start), patched, line.subarray(end)]);
          byteOffsetDelta = rendered.byteLength - line.byteLength;
        }
      }
    }
    await writeAll(output, hasNewline ? Buffer.concat([rendered, Buffer.from("\n")]) : rendered);
  };
  try {
    for await (const rawChunk of input) {
      const chunk = rawChunk as Buffer;
      pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        await processLine(pending.subarray(0, newline + 1));
        pending = pending.subarray(newline + 1);
      }
      if (pending.byteLength > MAX_RECORD_BYTES + 1) throw new Error("Codex rollout record is too large during rewrite");
    }
    if (pending.byteLength > 0) await processLine(pending);
    if (matchingRecords !== 1) {
      throw new Error("Codex rollout has no unique metadata record to rewrite");
    }
    await output.sync();
  } catch (error) {
    input.destroy();
    await output.close();
    await rm(outputPath, { force: true });
    throw error;
  } finally {
    input.destroy();
    try { await output.close(); } catch { /* the failure path already closed it */ }
  }
  const parsed = await parseCodexRollout(outputPath);
  const expectedHistoryBase = rewrite.historyBase?.after;
  if (
    parsed.nativeId !== rewrite.nativeId || parsed.provider !== rewrite.afterProvider || parsed.cwd !== rewrite.afterCwd ||
    (expectedHistoryBase !== undefined && JSON.stringify(parsed.historyBase) !== JSON.stringify(expectedHistoryBase))
  ) {
    await rm(outputPath, { force: true });
    throw new Error("Codex rollout rewrite verification failed");
  }
  return { byteOffsetDelta };
}
