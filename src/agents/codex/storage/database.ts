import { DatabaseSync } from "node:sqlite";

import type { JsonValue } from "../../../domain/history.js";
import {
  decodeSQLiteValue,
  encodeSQLiteValue,
  quoteSQLiteIdentifier,
} from "../../../infrastructure/sqlite.js";
import { canonicalCodexSessionId } from "../identity.js";

export type ThreadRow = Record<string, JsonValue>;
export type ThreadDynamicToolRow = Record<string, JsonValue>;
export type ThreadSpawnEdgeRow = Record<string, JsonValue>;

export interface ThreadColumn {
  readonly name: string;
  readonly notNull: boolean;
  readonly defaultValue: unknown;
  readonly primaryKey: boolean;
}

const REQUIRED_THREAD_COLUMNS = [
  "id",
  "rollout_path",
  "created_at",
  "updated_at",
  "model_provider",
  "cwd",
  "title",
  "archived",
  "first_user_message",
  "model",
] as const;

const UNSUPPORTED_RELATION_TABLES = [
  { table: "agent_job_items", columns: ["assigned_thread_id"] },
] as const;

const REQUIRED_DYNAMIC_TOOL_COLUMNS = [
  "thread_id",
  "position",
  "name",
  "description",
  "input_schema",
] as const;

const REQUIRED_SPAWN_EDGE_COLUMNS = [
  "parent_thread_id",
  "child_thread_id",
  "status",
] as const;

export const jsonSQLiteValue = encodeSQLiteValue;
export const sqliteInput = decodeSQLiteValue;
export const quoteIdentifier = quoteSQLiteIdentifier;

export function inspectThreadSchema(database: DatabaseSync): Map<string, ThreadColumn> {
  const rows = database.prepare("PRAGMA table_info(threads)").all() as Array<Record<string, unknown>>;
  if (rows.length === 0) throw new Error("Codex database has no threads table");
  const result = new Map<string, ThreadColumn>();
  for (const row of rows) {
    if (typeof row.name !== "string" || result.has(row.name)) {
      throw new Error("Codex threads schema is invalid");
    }
    result.set(row.name, {
      name: row.name,
      notNull: row.notnull === 1,
      defaultValue: row.dflt_value,
      primaryKey: row.pk === 1,
    });
  }
  for (const required of REQUIRED_THREAD_COLUMNS) {
    if (!result.has(required)) throw new Error(`Codex threads table is missing column: ${required}`);
  }
  return result;
}

function tableNames(database: DatabaseSync): Set<string> {
  const rows = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<Record<string, unknown>>;
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
}

export function hasThreadTable(database: DatabaseSync): boolean {
  return tableNames(database).has("threads");
}

export function inspectDynamicToolSchema(database: DatabaseSync): Map<string, ThreadColumn> | undefined {
  if (!tableNames(database).has("thread_dynamic_tools")) return undefined;
  const rows = database.prepare("PRAGMA table_info(thread_dynamic_tools)").all() as Array<Record<string, unknown>>;
  const result = new Map<string, ThreadColumn>();
  for (const row of rows) {
    if (typeof row.name !== "string" || result.has(row.name)) {
      throw new Error("Codex thread_dynamic_tools schema is invalid");
    }
    result.set(row.name, {
      name: row.name,
      notNull: row.notnull === 1,
      defaultValue: row.dflt_value,
      primaryKey: typeof row.pk === "number" && row.pk !== 0,
    });
  }
  for (const required of REQUIRED_DYNAMIC_TOOL_COLUMNS) {
    if (!result.has(required)) throw new Error(`Codex thread_dynamic_tools is missing column: ${required}`);
  }
  return result;
}

export function inspectThreadSpawnSchema(database: DatabaseSync): Map<string, ThreadColumn> | undefined {
  if (!tableNames(database).has("thread_spawn_edges")) return undefined;
  const rows = database.prepare("PRAGMA table_info(thread_spawn_edges)").all() as Array<Record<string, unknown>>;
  const result = new Map<string, ThreadColumn>();
  for (const row of rows) {
    if (typeof row.name !== "string" || result.has(row.name)) {
      throw new Error("Codex thread_spawn_edges schema is invalid");
    }
    result.set(row.name, {
      name: row.name,
      notNull: row.notnull === 1,
      defaultValue: row.dflt_value,
      primaryKey: typeof row.pk === "number" && row.pk !== 0,
    });
  }
  for (const required of REQUIRED_SPAWN_EDGE_COLUMNS) {
    if (!result.has(required)) throw new Error(`Codex thread_spawn_edges is missing column: ${required}`);
  }
  return result;
}

export function readThreadRow(database: DatabaseSync, id: string): ThreadRow | undefined {
  const row = database.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row === undefined
    ? undefined
    : Object.fromEntries(Object.entries(row).map(([name, value]) => [name, jsonSQLiteValue(value)]));
}

export function readThreadRows(database: DatabaseSync): Map<string, ThreadRow> {
  inspectThreadSchema(database);
  const rows = database.prepare("SELECT * FROM threads ORDER BY id").all() as Array<Record<string, unknown>>;
  const result = new Map<string, ThreadRow>();
  for (const row of rows) {
    if (typeof row.id !== "string") throw new Error("Codex threads table contains an invalid session ID");
    const id = row.id.toLowerCase();
    if (result.has(id)) throw new Error("Codex threads table contains a duplicate session ID");
    result.set(id, Object.fromEntries(Object.entries(row).map(([name, value]) => [name, jsonSQLiteValue(value)])));
  }
  return result;
}

export function validateThreadShape(thread: ThreadRow, columns: ReadonlyMap<string, ThreadColumn>): void {
  for (const name of Object.keys(thread)) {
    if (!columns.has(name)) throw new Error(`target Codex schema cannot preserve source thread column: ${name}`);
  }
  for (const column of columns.values()) {
    if (!Object.hasOwn(thread, column.name) && column.notNull && column.defaultValue === null && !column.primaryKey) {
      throw new Error(`target Codex schema requires unavailable thread column: ${column.name}`);
    }
  }
}

export function threadRowsEqual(expected: ThreadRow, actual: ThreadRow | undefined): boolean {
  if (actual === undefined) return false;
  return Object.entries(expected).every(([name, value]) => JSON.stringify(actual[name]) === JSON.stringify(value));
}

export function insertThreadRow(database: DatabaseSync, thread: ThreadRow): void {
  const names = Object.keys(thread).sort();
  const sql = `INSERT INTO threads (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
  database.prepare(sql).run(...names.map((name) => sqliteInput(thread[name]!)));
}

export function updateThreadRow(database: DatabaseSync, before: ThreadRow, after: ThreadRow): void {
  const id = before.id;
  if (typeof id !== "string" || after.id !== id) throw new Error("Codex thread update identity is invalid");
  const names = Object.keys(after)
    .filter((name) => name !== "id" && JSON.stringify(before[name]) !== JSON.stringify(after[name]))
    .sort();
  if (names.length === 0) return;
  const result = database.prepare(
    `UPDATE threads SET ${names.map((name) => `${quoteIdentifier(name)} = ?`).join(", ")} WHERE id = ?`,
  ).run(...names.map((name) => sqliteInput(after[name]!)), id);
  if (result.changes !== 1) throw new Error(`Codex thread changed while updating: ${id}`);
}

export function deleteThreadRow(database: DatabaseSync, id: string): void {
  const result = database.prepare("DELETE FROM threads WHERE id = ?").run(id);
  if (result.changes !== 1) throw new Error(`Codex thread changed while deleting: ${id}`);
}

function validInputSchema(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function validateDynamicToolRow(row: ThreadDynamicToolRow, threadId: string): void {
  if (
    row.thread_id !== threadId || typeof row.position !== "number" ||
    !Number.isSafeInteger(row.position) || row.position < 0 ||
    typeof row.name !== "string" || row.name === "" || typeof row.description !== "string" ||
    typeof row.input_schema !== "string" || !validInputSchema(row.input_schema) ||
    (row.defer_loading !== undefined && row.defer_loading !== 0 && row.defer_loading !== 1) ||
    (row.namespace !== undefined && row.namespace !== null &&
      (typeof row.namespace !== "string" || row.namespace === ""))
  ) {
    throw new Error(`Codex thread_dynamic_tools row is invalid: ${threadId}`);
  }
}

export function validateThreadDynamicTools(
  value: unknown,
  threadId: string,
): ThreadDynamicToolRow[] {
  if (!Array.isArray(value)) throw new Error(`Codex dynamic tool state is unavailable: ${threadId}`);
  const rows: ThreadDynamicToolRow[] = [];
  let fields: string | undefined;
  let previousPosition = -1;
  for (const raw of value) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Codex dynamic tool state is invalid: ${threadId}`);
    }
    const row = { ...raw } as unknown as ThreadDynamicToolRow;
    validateDynamicToolRow(row, threadId);
    const currentFields = Object.keys(row).sort().join("\0");
    if ((fields !== undefined && fields !== currentFields) || (row.position as number) <= previousPosition) {
      throw new Error(`Codex dynamic tool state is invalid: ${threadId}`);
    }
    fields = currentFields;
    previousPosition = row.position as number;
    rows.push(row);
  }
  return rows;
}

function databaseDynamicToolRows(database: DatabaseSync, threadId?: string): ThreadDynamicToolRow[] {
  if (inspectDynamicToolSchema(database) === undefined) return [];
  const raw = (threadId === undefined
    ? database.prepare("SELECT * FROM thread_dynamic_tools ORDER BY thread_id, position").all()
    : database.prepare("SELECT * FROM thread_dynamic_tools WHERE thread_id = ? ORDER BY position").all(threadId)
  ) as Array<Record<string, unknown>>;
  return raw.map((row) => Object.fromEntries(
    Object.entries(row).map(([name, value]) => [name, jsonSQLiteValue(value)]),
  ));
}

export function readThreadDynamicTools(database: DatabaseSync, threadId: string): ThreadDynamicToolRow[] {
  return validateThreadDynamicTools(databaseDynamicToolRows(database, threadId), threadId);
}

export function readAllThreadDynamicTools(database: DatabaseSync): Map<string, ThreadDynamicToolRow[]> {
  const result = new Map<string, ThreadDynamicToolRow[]>();
  for (const row of databaseDynamicToolRows(database)) {
    const threadId = typeof row.thread_id === "string" ? row.thread_id : "";
    const values = result.get(threadId) ?? [];
    values.push(row);
    result.set(threadId, values);
  }
  for (const [threadId, rows] of result) {
    result.set(threadId, validateThreadDynamicTools(rows, threadId));
  }
  return result;
}

export function validateDynamicToolTarget(
  database: DatabaseSync,
  rows: readonly ThreadDynamicToolRow[],
  threadId: string,
): void {
  validateThreadDynamicTools(rows, threadId);
  if (rows.length === 0) return;
  const columns = inspectDynamicToolSchema(database);
  if (columns === undefined) throw new Error("target Codex has no thread_dynamic_tools table");
  const sourceFields = Object.keys(rows[0]!).sort();
  const targetFields = [...columns.keys()].sort();
  if (JSON.stringify(sourceFields) !== JSON.stringify(targetFields)) {
    throw new Error("target Codex dynamic tool schema cannot preserve source rows");
  }
}

export function threadDynamicToolsEqual(
  expected: readonly ThreadDynamicToolRow[],
  actual: readonly ThreadDynamicToolRow[],
): boolean {
  return expected.length === actual.length && expected.every((row, index) => {
    const other = actual[index];
    if (other === undefined) return false;
    const names = new Set([...Object.keys(row), ...Object.keys(other)]);
    return [...names].every((name) => JSON.stringify(row[name]) === JSON.stringify(other[name]));
  });
}

export function insertThreadDynamicTools(
  database: DatabaseSync,
  rows: readonly ThreadDynamicToolRow[],
  threadId: string,
): void {
  validateDynamicToolTarget(database, rows, threadId);
  if (rows.length === 0) return;
  const names = Object.keys(rows[0]!).sort();
  const statement = database.prepare(
    `INSERT INTO thread_dynamic_tools (${names.map(quoteIdentifier).join(", ")}) ` +
    `VALUES (${names.map(() => "?").join(", ")})`,
  );
  for (const row of rows) statement.run(...names.map((name) => sqliteInput(row[name]!)));
}

export function deleteThreadDynamicTools(database: DatabaseSync, threadId: string): void {
  if (inspectDynamicToolSchema(database) === undefined) return;
  database.prepare("DELETE FROM thread_dynamic_tools WHERE thread_id = ?").run(threadId);
}

function canonicalThreadId(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const canonical = canonicalCodexSessionId(value);
    return canonical === value ? canonical : undefined;
  } catch {
    return undefined;
  }
}

export function validateThreadSpawnEdge(value: unknown, childThreadId: string): ThreadSpawnEdgeRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Codex thread_spawn_edges row is invalid: ${childThreadId}`);
  }
  const row = { ...value } as ThreadSpawnEdgeRow;
  if (
    canonicalThreadId(row.parent_thread_id) === undefined ||
    canonicalThreadId(row.child_thread_id) !== childThreadId ||
    typeof row.status !== "string" || row.status === ""
  ) {
    throw new Error(`Codex thread_spawn_edges row is invalid: ${childThreadId}`);
  }
  return row;
}

export function readThreadSpawnEdges(database: DatabaseSync): Map<string, ThreadSpawnEdgeRow> {
  if (inspectThreadSpawnSchema(database) === undefined) return new Map();
  const raw = database.prepare("SELECT * FROM thread_spawn_edges ORDER BY child_thread_id").all() as Array<Record<string, unknown>>;
  const result = new Map<string, ThreadSpawnEdgeRow>();
  for (const value of raw) {
    const childThreadId = canonicalThreadId(value.child_thread_id as JsonValue);
    if (childThreadId === undefined || result.has(childThreadId)) {
      throw new Error("Codex thread_spawn_edges contains an invalid or duplicate child ID");
    }
    const row = Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, jsonSQLiteValue(item)]),
    );
    result.set(childThreadId, validateThreadSpawnEdge(row, childThreadId));
  }
  return result;
}

export function threadSpawnEdgesEqual(
  expected: ThreadSpawnEdgeRow | null | undefined,
  actual: ThreadSpawnEdgeRow | null | undefined,
): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...names].every((name) => JSON.stringify(expected[name]) === JSON.stringify(actual[name]));
}

export function validateThreadSpawnTarget(
  database: DatabaseSync,
  edge: ThreadSpawnEdgeRow | null,
  childThreadId: string,
): void {
  if (edge === null) return;
  const row = validateThreadSpawnEdge(edge, childThreadId);
  const columns = inspectThreadSpawnSchema(database);
  if (columns === undefined) throw new Error("target Codex has no thread_spawn_edges table");
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...columns.keys()].sort())) {
    throw new Error("target Codex spawn-edge schema cannot preserve source rows");
  }
}

export function insertThreadSpawnEdge(database: DatabaseSync, edge: ThreadSpawnEdgeRow, childThreadId: string): void {
  validateThreadSpawnTarget(database, edge, childThreadId);
  const names = Object.keys(edge).sort();
  database.prepare(
    `INSERT INTO thread_spawn_edges (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...names.map((name) => sqliteInput(edge[name]!)));
}

export function deleteThreadSpawnEdge(database: DatabaseSync, childThreadId: string): void {
  if (inspectThreadSpawnSchema(database) === undefined) return;
  const result = database.prepare("DELETE FROM thread_spawn_edges WHERE child_thread_id = ?").run(childThreadId);
  if (result.changes !== 1) throw new Error(`Codex spawn edge changed while deleting: ${childThreadId}`);
}

export function threadSpawnComponents(
  threadIds: ReadonlySet<string>,
  edges: ReadonlyMap<string, ThreadSpawnEdgeRow>,
): {
  readonly components: ReadonlyMap<string, readonly string[]>;
  readonly invalidThreadIds: ReadonlySet<string>;
} {
  const neighbors = new Map([...threadIds].map((id) => [id, new Set<string>()]));
  const invalid = new Set<string>();
  for (const edge of edges.values()) {
    const parent = edge.parent_thread_id as string;
    const child = edge.child_thread_id as string;
    if (threadIds.has(parent) && threadIds.has(child)) {
      neighbors.get(parent)!.add(child);
      neighbors.get(child)!.add(parent);
    } else {
      if (threadIds.has(parent)) invalid.add(parent);
      if (threadIds.has(child)) invalid.add(child);
    }
  }
  const components = new Map<string, readonly string[]>();
  for (const id of [...threadIds].sort()) {
    if (components.has(id)) continue;
    const pending = [id];
    const members = new Set<string>();
    while (pending.length !== 0) {
      const current = pending.pop()!;
      if (members.has(current)) continue;
      members.add(current);
      pending.push(...neighbors.get(current)!);
    }
    const ordered = [...members].sort();
    if (ordered.some((member) => invalid.has(member))) {
      for (const member of ordered) invalid.add(member);
    }
    for (const member of ordered) components.set(member, ordered);
  }
  return { components, invalidThreadIds: invalid };
}

export function unsupportedRelatedThreadIds(database: DatabaseSync, ids: readonly string[]): ReadonlySet<string> {
  if (ids.length === 0) return new Set();
  const tables = tableNames(database);
  const related = new Set<string>();
  for (const relation of UNSUPPORTED_RELATION_TABLES) {
    if (!tables.has(relation.table)) continue;
    const columns = new Set(
      (database.prepare(`PRAGMA table_info(${quoteIdentifier(relation.table)})`).all() as Array<Record<string, unknown>>)
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (relation.columns.some((column) => !columns.has(column))) {
      throw new Error(`Codex relation table has an unsupported shape: ${relation.table}`);
    }
    for (const column of relation.columns) {
      const statement = database.prepare(
        `SELECT 1 AS present FROM ${quoteIdentifier(relation.table)} WHERE ${quoteIdentifier(column)} = ? LIMIT 1`,
      );
      for (const id of ids) {
        if (statement.get(id) !== undefined) related.add(id);
      }
    }
  }
  return related;
}
