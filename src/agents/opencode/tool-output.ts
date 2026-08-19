import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  createManagedResourceObject,
  MANAGED_TEXT_MEDIA_TYPE,
  MAX_MANAGED_RESOURCE_BYTES,
  managedResourceName,
  type ManagedResourceObject,
} from "../../domain/resource.js";
import { copyStableFile, readStableSmallFile } from "../../infrastructure/files.js";
import { quoteSQLiteIdentifier } from "../../infrastructure/sqlite.js";
import {
  openCodeStringColumn,
  openCodeTableSchema,
  readOpenCodeTableRows,
  validateOpenCodeHistoryDatabase,
} from "./storage/database.js";

const CAPTURE_PREFIX = "opencode/tool-output";

export interface OpenCodeToolOutputDescriptor {
  readonly nativePath: string;
  readonly relativePath: string;
  readonly available: boolean;
}

interface ToolOutputReference {
  readonly sessionId: string;
  readonly nativePath: string;
}

export interface CaptureOpenCodeToolOutputsResult {
  readonly bySession: ReadonlyMap<string, readonly OpenCodeToolOutputDescriptor[]>;
  readonly capturedFiles: readonly string[];
  readonly warnings: readonly string[];
}

export interface LoadOpenCodeToolOutputResourcesResult {
  readonly byNativePath: ReadonlyMap<string, ManagedResourceObject>;
  readonly warnings: readonly string[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function partReference(data: unknown, sessionId: string): ToolOutputReference | undefined {
  if (typeof data !== "string") return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return undefined; }
  const part = objectValue(parsed);
  const state = objectValue(part?.state);
  const metadata = objectValue(state?.metadata);
  const nativePath = metadata?.outputPath;
  if (
    part?.type !== "tool" || state?.status !== "completed" || metadata?.truncated !== true ||
    typeof nativePath !== "string" || !path.isAbsolute(nativePath) || path.normalize(nativePath) !== nativePath ||
    typeof state.output !== "string" || !state.output.includes(nativePath)
  ) return undefined;
  return { sessionId, nativePath };
}

function sessionMessageReferences(data: unknown, type: unknown, sessionId: string): ToolOutputReference[] {
  if (type !== "assistant" || typeof data !== "string") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return []; }
  const message = objectValue(parsed);
  if (!Array.isArray(message?.content)) return [];
  const result: ToolOutputReference[] = [];
  for (const raw of message.content) {
    const content = objectValue(raw);
    const state = objectValue(content?.state);
    if (content?.type !== "tool" || state?.status !== "completed" || !Array.isArray(state.outputPaths) ||
      !Array.isArray(state.content)) continue;
    const text = state.content.flatMap((item) => {
      const value = objectValue(item);
      return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
    });
    for (const nativePath of state.outputPaths) {
      if (
        typeof nativePath !== "string" || !path.isAbsolute(nativePath) || path.normalize(nativePath) !== nativePath ||
        !text.some((value) => value.includes(nativePath))
      ) continue;
      result.push({ sessionId, nativePath });
    }
  }
  return result;
}

function references(databasePath: string): ToolOutputReference[] {
  const database = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true });
  try {
    const schema = validateOpenCodeHistoryDatabase(database);
    const result: ToolOutputReference[] = [];
    const part = openCodeTableSchema(schema, "part")!;
    const partData = part.columns.findIndex((column) => column.name === "data");
    if (partData < 0) throw new Error("OpenCode part data capability is unavailable");
    for (const row of readOpenCodeTableRows(database, part)) {
      const sessionId = openCodeStringColumn(row, part.columns, "session_id");
      if (sessionId === undefined) continue;
      const found = partReference(row[partData], sessionId);
      if (found !== undefined) result.push(found);
    }
    const current = openCodeTableSchema(schema, "session_message");
    const currentData = current?.columns.findIndex((column) => column.name === "data") ?? -1;
    if (current !== undefined && currentData >= 0) {
      for (const row of readOpenCodeTableRows(database, current)) {
        const sessionId = openCodeStringColumn(row, current.columns, "session_id");
        if (sessionId === undefined) continue;
        result.push(...sessionMessageReferences(
          row[currentData],
          openCodeStringColumn(row, current.columns, "type"),
          sessionId,
        ));
      }
    }
    return result;
  } finally {
    database.close();
  }
}

function relativeCapturePath(dataRoot: string, nativePath: string): string | undefined {
  const root = path.join(dataRoot, "tool-output");
  const relative = path.relative(root, nativePath);
  if (
    relative === "" || relative === "." || relative.startsWith("..") || path.isAbsolute(relative) ||
    relative.includes(path.sep) || relative.includes("\\")
  ) return undefined;
  return `${CAPTURE_PREFIX}/${relative}`;
}

async function requireToolOutputRoot(dataRoot: string): Promise<"present" | "missing"> {
  const root = path.join(dataRoot, "tool-output");
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`OpenCode tool-output carrier is not a real directory: ${root}`);
    }
    return "present";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export async function captureOpenCodeToolOutputs(
  databasePath: string,
  dataRoot: string,
  rawRoot: string,
): Promise<CaptureOpenCodeToolOutputsResult> {
  const candidates = references(databasePath);
  const canonical = new Map<string, { relativePath: string; sessions: Set<string> }>();
  let unclassified = 0;
  for (const item of candidates) {
    const relativePath = relativeCapturePath(dataRoot, item.nativePath);
    if (relativePath === undefined) {
      unclassified++;
      continue;
    }
    const grouped = canonical.get(item.nativePath) ?? { relativePath, sessions: new Set<string>() };
    grouped.sessions.add(item.sessionId);
    canonical.set(item.nativePath, grouped);
  }
  const ambiguous = new Set(
    [...canonical].filter(([, item]) => item.sessions.size !== 1).map(([nativePath]) => nativePath),
  );
  const rootState = canonical.size === 0 ? "missing" : await requireToolOutputRoot(dataRoot);
  const bySession = new Map<string, OpenCodeToolOutputDescriptor[]>();
  const capturedFiles: string[] = [];
  let missing = 0;
  for (const [nativePath, item] of [...canonical].sort(([left], [right]) => left.localeCompare(right))) {
    if (ambiguous.has(nativePath)) continue;
    let available = false;
    if (rootState === "present") {
      try {
        const info = await lstat(nativePath);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error(`OpenCode tool-output is not a regular file: ${nativePath}`);
        }
        const destination = path.join(rawRoot, ...item.relativePath.split("/"));
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await copyStableFile(nativePath, destination);
        available = true;
        capturedFiles.push(item.relativePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!available) missing++;
    const sessionId = [...item.sessions][0]!;
    const descriptors = bySession.get(sessionId) ?? [];
    descriptors.push({ nativePath, relativePath: item.relativePath, available });
    bySession.set(sessionId, descriptors);
  }
  const warnings = [
    ...(capturedFiles.length === 0 ? [] : [`captured ${capturedFiles.length} canonical OpenCode tool-output file(s)`]),
    ...(missing === 0 ? [] : [`${missing} referenced OpenCode tool-output file(s) were already unavailable`]),
    ...(unclassified === 0 ? [] : [`ignored ${unclassified} non-canonical OpenCode tool-output reference(s)`]),
    ...(ambiguous.size === 0 ? [] : [`ignored ${ambiguous.size} OpenCode tool-output file(s) with ambiguous session ownership`]),
  ];
  return {
    bySession: new Map([...bySession].map(([sessionId, items]) => [
      sessionId,
      [...items].sort((left, right) => left.nativePath.localeCompare(right.nativePath)),
    ])),
    capturedFiles: [...capturedFiles].sort(),
    warnings,
  };
}

export async function loadOpenCodeToolOutputResources(
  bySession: ReadonlyMap<string, readonly OpenCodeToolOutputDescriptor[]>,
  resolveRelativePath: (relativePath: string) => string,
): Promise<LoadOpenCodeToolOutputResourcesResult> {
  const descriptors = new Map<string, OpenCodeToolOutputDescriptor>();
  for (const values of bySession.values()) {
    for (const descriptor of values) {
      const existing = descriptors.get(descriptor.nativePath);
      if (
        existing !== undefined &&
        (existing.relativePath !== descriptor.relativePath || existing.available !== descriptor.available)
      ) throw new Error(`OpenCode tool-output descriptor identity is inconsistent: ${descriptor.nativePath}`);
      descriptors.set(descriptor.nativePath, descriptor);
    }
  }
  const resources = new Map<string, ManagedResourceObject>();
  let oversized = 0;
  let nonText = 0;
  for (const descriptor of [...descriptors.values()].sort((left, right) =>
    left.nativePath.localeCompare(right.nativePath))) {
    if (!descriptor.available) continue;
    const filePath = resolveRelativePath(descriptor.relativePath);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`captured OpenCode tool-output is not a regular file: ${descriptor.relativePath}`);
    }
    if (info.size > MAX_MANAGED_RESOURCE_BYTES) {
      oversized++;
      continue;
    }
    const bytes = await readStableSmallFile(filePath, MAX_MANAGED_RESOURCE_BYTES);
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(bytes)) {
      nonText++;
      continue;
    }
    const name = managedResourceName(path.basename(descriptor.nativePath), MANAGED_TEXT_MEDIA_TYPE);
    const sourceIdentity = createHash("sha256").update(descriptor.nativePath).digest("hex");
    const resource = createManagedResourceObject({
      bytes,
      mediaType: MANAGED_TEXT_MEDIA_TYPE,
      name,
      sourceReference: `opencode:tool-output:${sourceIdentity}`,
    });
    if (resource === undefined) {
      throw new Error(`captured OpenCode tool-output cannot form a managed resource: ${descriptor.relativePath}`);
    }
    resources.set(descriptor.nativePath, resource);
  }
  return {
    byNativePath: resources,
    warnings: [
      ...(oversized === 0 ? [] : [
        `${oversized} OpenCode tool-output file(s) exceed the cross-Agent managed-resource limit`,
      ]),
      ...(nonText === 0 ? [] : [
        `${nonText} OpenCode tool-output file(s) are not canonical UTF-8 text`,
      ]),
    ],
  };
}

export function validateOpenCodeToolOutputDescriptors(
  databasePath: string,
  bySession: ReadonlyMap<string, readonly OpenCodeToolOutputDescriptor[]>,
): void {
  const actual = new Set(references(databasePath).map((item) => `${item.sessionId}\0${item.nativePath}`));
  const seen = new Set<string>();
  for (const [sessionId, descriptors] of bySession) {
    for (const descriptor of descriptors) {
      const name = path.basename(descriptor.nativePath);
      const key = `${sessionId}\0${descriptor.nativePath}`;
      if (
        name === "" || name === "." || name === ".." || name.includes("\\") ||
        descriptor.relativePath !== `${CAPTURE_PREFIX}/${name}` || !actual.has(key) || seen.has(key)
      ) throw new Error(`OpenCode tool-output descriptor disagrees with history: ${sessionId}`);
      seen.add(key);
    }
  }
}

export function projectOpenCodeToolOutputPaths(
  databasePath: string,
  mappings: ReadonlyMap<string, string>,
): void {
  if (mappings.size === 0) return;
  const database = new DatabaseSync(databasePath, { readBigInts: true });
  try {
    const schema = validateOpenCodeHistoryDatabase(database);
    const changes: Array<{
      readonly table: "part" | "session_message";
      readonly id: string;
      readonly data: string;
    }> = [];
    const used = new Set<string>();
    const part = openCodeTableSchema(schema, "part")!;
    const partData = part.columns.findIndex((column) => column.name === "data");
    if (partData < 0) throw new Error("OpenCode part data capability is unavailable");
    for (const row of readOpenCodeTableRows(database, part)) {
      const partId = openCodeStringColumn(row, part.columns, "id");
      const sessionId = openCodeStringColumn(row, part.columns, "session_id");
      if (partId === undefined || sessionId === undefined) continue;
      const found = partReference(row[partData], sessionId);
      if (found === undefined) continue;
      const target = mappings.get(found.nativePath);
      if (target === undefined) continue;
      used.add(found.nativePath);
      if (target === found.nativePath) continue;
      const parsed = JSON.parse(row[partData] as string) as Record<string, unknown>;
      const state = objectValue(parsed.state)!;
      const metadata = objectValue(state.metadata)!;
      state.metadata = { ...metadata, outputPath: target };
      state.output = (state.output as string).split(found.nativePath).join(target);
      parsed.state = state;
      changes.push({ table: "part", id: partId, data: JSON.stringify(parsed) });
    }
    const current = openCodeTableSchema(schema, "session_message");
    const currentData = current?.columns.findIndex((column) => column.name === "data") ?? -1;
    if (current !== undefined && currentData >= 0) {
      for (const row of readOpenCodeTableRows(database, current)) {
        const messageId = openCodeStringColumn(row, current.columns, "id");
        const data = row[currentData];
        if (messageId === undefined || openCodeStringColumn(row, current.columns, "type") !== "assistant" ||
          typeof data !== "string") continue;
        let parsedValue: unknown;
        try { parsedValue = JSON.parse(data); } catch { continue; }
        const parsed = objectValue(parsedValue);
        if (parsed === undefined || !Array.isArray(parsed.content)) continue;
        let changed = false;
        for (const raw of parsed.content) {
          const content = objectValue(raw);
          const state = objectValue(content?.state);
          if (content?.type !== "tool" || state?.status !== "completed" ||
            !Array.isArray(state.outputPaths) || !Array.isArray(state.content)) continue;
          for (const [index, nativePath] of state.outputPaths.entries()) {
            if (typeof nativePath !== "string") continue;
            const target = mappings.get(nativePath);
            if (target === undefined) continue;
            let marker = false;
            for (const item of state.content) {
              const value = objectValue(item);
              if (value?.type !== "text" || typeof value.text !== "string" || !value.text.includes(nativePath)) continue;
              marker = true;
              if (target !== nativePath) value.text = value.text.split(nativePath).join(target);
            }
            if (!marker) throw new Error(`OpenCode session_message tool-output marker is missing: ${messageId}`);
            used.add(nativePath);
            if (target !== nativePath) {
              state.outputPaths[index] = target;
              changed = true;
            }
          }
        }
        if (changed) changes.push({ table: "session_message", id: messageId, data: JSON.stringify(parsed) });
      }
    }
    const unused = [...mappings.keys()].find((nativePath) => !used.has(nativePath));
    if (unused !== undefined) throw new Error(`OpenCode tool-output descriptor is not present in history: ${unused}`);
    database.exec("BEGIN IMMEDIATE");
    try {
      const updates = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
      for (const table of ["part", ...(current === undefined ? [] : ["session_message"])] as const) {
        updates.set(
          table,
          database.prepare(
            `UPDATE ${quoteSQLiteIdentifier(table)} SET ${quoteSQLiteIdentifier("data")} = ? ` +
            `WHERE ${quoteSQLiteIdentifier("id")} = ?`,
          ),
        );
      }
      for (const change of changes) {
        const result = updates.get(change.table)!.run(change.data, change.id);
        if (result.changes !== 1 && result.changes !== 1n) {
          throw new Error(`OpenCode tool-output ${change.table} changed during projection: ${change.id}`);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* SQLite transaction may already be closed */ }
      throw error;
    }
    validateOpenCodeHistoryDatabase(database);
  } finally {
    database.close();
  }
}
