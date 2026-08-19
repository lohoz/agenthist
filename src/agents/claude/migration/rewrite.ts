import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";

import {
  verifiedClaudeBridgeSessionRecord,
  verifiedClaudeRelocatedRecord,
  verifiedClaudeWorktreeStateRecord,
} from "../history/transcript.js";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/.test(value[index]!)) index++;
  return index;
}

function stringEnd(value: string, start: number): number {
  if (value[start] !== '"') throw new Error("Claude transcript JSON string is invalid");
  let escaped = false;
  for (let index = start + 1; index < value.length; index++) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') return index + 1;
  }
  throw new Error("Claude transcript JSON string is unterminated");
}

function valueEnd(value: string, start: number): number {
  if (value[start] === '"') return stringEnd(value, start);
  if (value[start] === "{" || value[start] === "[") {
    const opening = value[start]!;
    const closing = opening === "{" ? "}" : "]";
    let depth = 0;
    for (let index = start; index < value.length; index++) {
      const character = value[index]!;
      if (character === '"') {
        index = stringEnd(value, index) - 1;
        continue;
      }
      if (character === opening) depth++;
      if (character === closing && --depth === 0) return index + 1;
    }
    throw new Error("Claude transcript JSON value is unterminated");
  }
  let index = start;
  while (index < value.length && value[index] !== "," && value[index] !== "}") index++;
  while (index > start && /\s/.test(value[index - 1]!)) index--;
  return index;
}

function rewriteTopLevelCwd(line: string, mapCwd: (value: string) => string): string {
  JSON.parse(line);
  let index = skipWhitespace(line, 0);
  if (line[index] !== "{") throw new Error("Claude transcript record is not an object");
  index++;
  let replacement: { readonly start: number; readonly end: number; readonly value: string } | undefined;
  while (true) {
    index = skipWhitespace(line, index);
    if (line[index] === "}") break;
    const keyStart = index;
    const keyEnd = stringEnd(line, keyStart);
    const key = JSON.parse(line.slice(keyStart, keyEnd)) as unknown;
    index = skipWhitespace(line, keyEnd);
    if (line[index] !== ":") throw new Error("Claude transcript object separator is invalid");
    index = skipWhitespace(line, index + 1);
    const start = index;
    const end = valueEnd(line, start);
    if (key === "cwd") {
      if (replacement !== undefined || line[start] !== '"') throw new Error("Claude transcript cwd field is ambiguous");
      const cwd = JSON.parse(line.slice(start, end)) as unknown;
      if (typeof cwd !== "string") throw new Error("Claude transcript cwd is not a string");
      replacement = { start, end, value: JSON.stringify(mapCwd(cwd)) };
    }
    index = skipWhitespace(line, end);
    if (line[index] === ",") {
      index++;
      continue;
    }
    if (line[index] === "}") break;
    throw new Error("Claude transcript object is invalid");
  }
  return replacement === undefined
    ? line
    : `${line.slice(0, replacement.start)}${replacement.value}${line.slice(replacement.end)}`;
}

function rewriteStringReferences(
  line: string,
  replacements: readonly (readonly [string, string])[],
): string {
  if (replacements.length === 0) return line;
  let cursor = 0;
  let index = 0;
  let output = "";
  while (index < line.length) {
    if (line[index] !== '"') {
      index++;
      continue;
    }
    const end = stringEnd(line, index);
    const isKey = line[skipWhitespace(line, end)] === ":";
    if (!isKey) {
      const value = JSON.parse(line.slice(index, end)) as unknown;
      if (typeof value !== "string") throw new Error("Claude transcript string token is invalid");
      let rewritten = value;
      for (const [source, destination] of replacements) rewritten = rewritten.replaceAll(source, destination);
      if (rewritten !== value) {
        output += `${line.slice(cursor, index)}${JSON.stringify(rewritten)}`;
        cursor = end;
      }
    }
    index = end;
  }
  return cursor === 0 ? line : `${output}${line.slice(cursor)}`;
}

interface ObjectEntry {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

function objectEntries(value: string, start: number, description: string): ObjectEntry[] {
  if (value[start] !== "{") throw new Error(`Claude transcript ${description} is not an object`);
  const entries: ObjectEntry[] = [];
  let index = start + 1;
  while (true) {
    index = skipWhitespace(value, index);
    if (value[index] === "}") return entries;
    const keyStart = index;
    const keyEnd = stringEnd(value, keyStart);
    const key = JSON.parse(value.slice(keyStart, keyEnd)) as unknown;
    if (typeof key !== "string") throw new Error(`Claude transcript ${description} key is invalid`);
    index = skipWhitespace(value, keyEnd);
    if (value[index] !== ":") throw new Error(`Claude transcript ${description} separator is invalid`);
    index = skipWhitespace(value, index + 1);
    const fieldStart = index;
    const fieldEnd = valueEnd(value, fieldStart);
    entries.push({ key, start: fieldStart, end: fieldEnd });
    index = skipWhitespace(value, fieldEnd);
    if (value[index] === ",") {
      index++;
      continue;
    }
    if (value[index] === "}") return entries;
    throw new Error(`Claude transcript ${description} is invalid`);
  }
}

function singleEntry(entries: readonly ObjectEntry[], key: string, description: string): ObjectEntry | undefined {
  const matches = entries.filter((entry) => entry.key === key);
  if (matches.length > 1) throw new Error(`Claude transcript ${description} field is ambiguous`);
  return matches[0];
}

function checkpointRealParentEntries(line: string): ObjectEntry[] {
  const top = objectEntries(line, skipWhitespace(line, 0), "record");
  const typeEntry = singleEntry(top, "type", "type");
  if (typeEntry === undefined || line[typeEntry.start] !== '"') return [];
  const type = JSON.parse(line.slice(typeEntry.start, typeEntry.end)) as unknown;
  if (type === "file-history-delta") {
    const backup = singleEntry(top, "backup", "checkpoint backup");
    if (backup === undefined || line[backup.start] !== "{") return [];
    const parent = singleEntry(
      objectEntries(line, backup.start, "checkpoint backup"),
      "realParentDir",
      "checkpoint realParentDir",
    );
    return parent === undefined ? [] : [parent];
  }
  if (type !== "file-history-snapshot") return [];
  const snapshot = singleEntry(top, "snapshot", "checkpoint snapshot");
  if (snapshot === undefined || line[snapshot.start] !== "{") return [];
  const tracked = singleEntry(
    objectEntries(line, snapshot.start, "checkpoint snapshot"),
    "trackedFileBackups",
    "checkpoint trackedFileBackups",
  );
  if (tracked === undefined || line[tracked.start] !== "{") return [];
  const result: ObjectEntry[] = [];
  for (const backup of objectEntries(line, tracked.start, "checkpoint trackedFileBackups")) {
    if (line[backup.start] !== "{") continue;
    const parent = singleEntry(
      objectEntries(line, backup.start, "checkpoint backup"),
      "realParentDir",
      "checkpoint realParentDir",
    );
    if (parent !== undefined) result.push(parent);
  }
  return result;
}

function rewriteCheckpointRealParents(line: string, replacements: ReadonlyMap<string, string>): string {
  if (replacements.size === 0) return line;
  const rewritten = checkpointRealParentEntries(line).map((entry) => {
    if (line[entry.start] !== '"') throw new Error("Claude checkpoint realParentDir is not a string");
    const value = JSON.parse(line.slice(entry.start, entry.end)) as unknown;
    if (typeof value !== "string") throw new Error("Claude checkpoint realParentDir is not a string");
    const replacement = replacements.get(value);
    if (replacement === undefined) throw new Error("Claude checkpoint realParentDir was not assessed");
    return { ...entry, value: JSON.stringify(replacement) };
  }).sort((left, right) => right.start - left.start);
  let result = line;
  for (const entry of rewritten) {
    result = `${result.slice(0, entry.start)}${entry.value}${result.slice(entry.end)}`;
  }
  return result;
}

function clearVerifiedWorktreeState(line: string, sessionId: string | undefined): string {
  if (sessionId === undefined) return line;
  const parsed = JSON.parse(line) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return line;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "worktree-state") return line;
  if (!verifiedClaudeWorktreeStateRecord(record, sessionId)) {
    throw new Error("Claude worktree-state record cannot be safely cleared");
  }
  const entries = objectEntries(line, skipWhitespace(line, 0), "worktree-state record");
  const state = singleEntry(entries, "worktreeSession", "worktree-state");
  if (state === undefined) throw new Error("Claude worktree-state record is incomplete");
  return line.slice(state.start, state.end) === "null"
    ? line
    : `${line.slice(0, state.start)}null${line.slice(state.end)}`;
}

function clearVerifiedBridgeSession(line: string, sessionId: string | undefined): string {
  if (sessionId === undefined) return line;
  const parsed = JSON.parse(line) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return line;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "bridge-session") return line;
  if (!verifiedClaudeBridgeSessionRecord(record, sessionId)) {
    throw new Error("Claude bridge-session record cannot be safely cleared");
  }
  if (record.bridgeSessionId === "") return line;
  return JSON.stringify({
    type: "bridge-session",
    sessionId,
    bridgeSessionId: "",
    lastSequenceNum: 0,
  });
}

function rewriteVerifiedRelocatedCwd(
  line: string,
  sessionId: string | undefined,
  mapCwd: (value: string) => string,
): string {
  if (sessionId === undefined) return line;
  const parsed = JSON.parse(line) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return line;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "relocated") return line;
  const relocatedCwd = verifiedClaudeRelocatedRecord(record, sessionId);
  if (relocatedCwd === undefined) throw new Error("Claude relocated record cannot be safely projected");
  const entries = objectEntries(line, skipWhitespace(line, 0), "relocated record");
  const field = singleEntry(entries, "relocatedCwd", "relocated");
  if (field === undefined || line[field.start] !== '"') {
    throw new Error("Claude relocated record is incomplete");
  }
  return `${line.slice(0, field.start)}${JSON.stringify(mapCwd(relocatedCwd))}${line.slice(field.end)}`;
}

export interface ClaudeTranscriptProjectionOptions {
  readonly referenceReplacements?: ReadonlyMap<string, string>;
  readonly checkpointParentReplacements?: ReadonlyMap<string, string>;
  readonly clearWorktreeStateForSession?: string;
  readonly clearBridgeSessionForSession?: string;
  readonly rewriteRelocatedCwdForSession?: string;
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten === 0) throw new Error("Claude transcript projection made no progress");
    offset += result.bytesWritten;
  }
}

async function writeFrame(
  output: Awaited<ReturnType<typeof open>>,
  frame: Buffer,
  terminated: boolean,
  mapCwd: (value: string) => string,
  replacements: readonly (readonly [string, string])[],
  checkpointParentReplacements: ReadonlyMap<string, string>,
  clearWorktreeStateForSession: string | undefined,
  clearBridgeSessionForSession: string | undefined,
  rewriteRelocatedCwdForSession: string | undefined,
): Promise<void> {
  let body = frame;
  let terminator = terminated ? Buffer.from("\n") : Buffer.alloc(0);
  if (terminated && body.at(-1) === 0x0d) {
    body = body.subarray(0, -1);
    terminator = Buffer.from("\r\n");
  }
  if (body.byteLength > MAX_RECORD_BYTES) throw new Error("Claude transcript record exceeds projection limits");
  if (body.byteLength === 0) {
    await writeAll(output, terminator);
    return;
  }
  const line = decoder.decode(body);
  const cwdProjected = rewriteTopLevelCwd(line, mapCwd);
  const relocatedProjected = rewriteVerifiedRelocatedCwd(
    cwdProjected,
    rewriteRelocatedCwdForSession,
    mapCwd,
  );
  const worktreeProjected = clearVerifiedWorktreeState(relocatedProjected, clearWorktreeStateForSession);
  const bridgeProjected = clearVerifiedBridgeSession(worktreeProjected, clearBridgeSessionForSession);
  const checkpointProjected = rewriteCheckpointRealParents(bridgeProjected, checkpointParentReplacements);
  await writeAll(output, Buffer.from(rewriteStringReferences(checkpointProjected, replacements), "utf8"));
  await writeAll(output, terminator);
}

export async function projectClaudeTranscript(
  sourcePath: string,
  destinationPath: string,
  mapCwd: (value: string) => string,
  options: ClaudeTranscriptProjectionOptions = {},
): Promise<void> {
  const referenceReplacements = options.referenceReplacements ?? new Map();
  const checkpointParentReplacements = options.checkpointParentReplacements ?? new Map();
  const replacements = [...referenceReplacements]
    .filter(([source, destination]) => source !== destination)
    .sort(([left], [right]) => right.length - left.length);
  if (replacements.some(([source, destination]) => source === "" || destination === "")) {
    throw new Error("Claude transcript reference projection is invalid");
  }
  const output = await open(
    destinationPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const input = createReadStream(sourcePath);
    try {
      for await (const raw of input) {
        const chunk = raw as Buffer<ArrayBufferLike>;
        pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
        let newline;
        while ((newline = pending.indexOf(0x0a)) >= 0) {
          await writeFrame(
            output,
            pending.subarray(0, newline),
            true,
            mapCwd,
            replacements,
            checkpointParentReplacements,
            options.clearWorktreeStateForSession,
            options.clearBridgeSessionForSession,
            options.rewriteRelocatedCwdForSession,
          );
          pending = pending.subarray(newline + 1);
        }
        if (pending.byteLength > MAX_RECORD_BYTES + 1) throw new Error("Claude transcript record exceeds projection limits");
      }
    } finally {
      input.destroy();
    }
    if (pending.byteLength !== 0) {
      await writeFrame(
        output,
        pending,
        false,
        mapCwd,
        replacements,
        checkpointParentReplacements,
        options.clearWorktreeStateForSession,
        options.clearBridgeSessionForSession,
        options.rewriteRelocatedCwdForSession,
      );
    }
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(destinationPath, { force: true });
    throw error;
  } finally {
    try { await output.close(); } catch { /* failure path already closed it */ }
  }
}
