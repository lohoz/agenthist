import { DatabaseSync } from "node:sqlite";

import type { JsonValue } from "../../../domain/history.js";
import { decodeSQLiteValue, encodeSQLiteValue, quoteSQLiteIdentifier } from "../../../infrastructure/sqlite.js";
import type { ThreadColumn } from "./database.js";
import { canonicalCodexSessionId } from "../identity.js";
import { codexSQLiteStorePaths } from "./stores.js";

const REQUIRED_GOAL_COLUMNS = [
  "thread_id",
  "goal_id",
  "objective",
  "status",
  "token_budget",
  "tokens_used",
  "time_used_seconds",
  "created_at_ms",
  "updated_at_ms",
] as const;

export type ThreadGoalRow = Record<string, JsonValue>;

export interface CodexGoalStore {
  readonly databasePath: string;
  readonly hasContinuationDeferrals: boolean;
}

function tableNames(database: DatabaseSync): Set<string> {
  const rows = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<Record<string, unknown>>;
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
}

function inspectTableSchema(database: DatabaseSync, table: string): Map<string, ThreadColumn> {
  const rows = database.prepare(`PRAGMA table_info(${quoteSQLiteIdentifier(table)})`).all() as Array<Record<string, unknown>>;
  const result = new Map<string, ThreadColumn>();
  for (const row of rows) {
    if (typeof row.name !== "string" || result.has(row.name)) {
      throw new Error(`Codex ${table} schema is invalid`);
    }
    result.set(row.name, {
      name: row.name,
      notNull: row.notnull === 1,
      defaultValue: row.dflt_value,
      primaryKey: typeof row.pk === "number" && row.pk !== 0,
    });
  }
  return result;
}

export function inspectThreadGoalSchema(database: DatabaseSync): Map<string, ThreadColumn> | undefined {
  if (!tableNames(database).has("thread_goals")) return undefined;
  const result = inspectTableSchema(database, "thread_goals");
  for (const required of REQUIRED_GOAL_COLUMNS) {
    if (!result.has(required)) throw new Error(`Codex thread_goals is missing column: ${required}`);
  }
  if (!result.get("thread_id")?.primaryKey || [...result.values()].filter((column) => column.primaryKey).length !== 1) {
    throw new Error("Codex thread_goals must use thread_id as its primary key");
  }
  return result;
}

export function inspectThreadGoalDeferralSchema(database: DatabaseSync): Map<string, ThreadColumn> | undefined {
  if (!tableNames(database).has("thread_goal_continuation_deferrals")) return undefined;
  const result = inspectTableSchema(database, "thread_goal_continuation_deferrals");
  if (!result.has("thread_id")) {
    throw new Error("Codex thread_goal_continuation_deferrals is missing column: thread_id");
  }
  if (!result.get("thread_id")?.primaryKey || [...result.values()].filter((column) => column.primaryKey).length !== 1) {
    throw new Error("Codex thread_goal_continuation_deferrals must use thread_id as its primary key");
  }
  return result;
}

function jsonRow(row: Record<string, unknown>): ThreadGoalRow {
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, encodeSQLiteValue(value)]));
}

function integer(value: JsonValue | undefined): boolean {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function validateThreadGoalRow(value: unknown, threadId: string): ThreadGoalRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Codex thread goal state is invalid: ${threadId}`);
  }
  const row = { ...value } as ThreadGoalRow;
  if (
    row.thread_id !== threadId || typeof row.goal_id !== "string" || row.goal_id === "" ||
    typeof row.objective !== "string" || typeof row.status !== "string" || row.status === "" ||
    !(row.token_budget === null || integer(row.token_budget)) ||
    !integer(row.tokens_used) || !integer(row.time_used_seconds) ||
    !integer(row.created_at_ms) || !integer(row.updated_at_ms)
  ) {
    throw new Error(`Codex thread goal state is invalid: ${threadId}`);
  }
  return row;
}

export function readThreadGoalRows(database: DatabaseSync): Map<string, ThreadGoalRow> | undefined {
  if (inspectThreadGoalSchema(database) === undefined) return undefined;
  const rows = database.prepare("SELECT * FROM thread_goals ORDER BY thread_id").all() as Array<Record<string, unknown>>;
  const result = new Map<string, ThreadGoalRow>();
  for (const raw of rows) {
    if (typeof raw.thread_id !== "string") throw new Error("Codex thread_goals contains an invalid thread ID");
    const threadId = canonicalCodexSessionId(raw.thread_id);
    if (raw.thread_id !== threadId || result.has(threadId)) {
      throw new Error("Codex thread_goals contains a duplicate or non-canonical thread ID");
    }
    result.set(threadId, validateThreadGoalRow(jsonRow(raw), threadId));
  }
  return result;
}

export function readThreadGoalRow(database: DatabaseSync, threadId: string): ThreadGoalRow | undefined {
  if (inspectThreadGoalSchema(database) === undefined) return undefined;
  const raw = database.prepare("SELECT * FROM thread_goals WHERE thread_id = ?").get(threadId) as
    Record<string, unknown> | undefined;
  return raw === undefined ? undefined : validateThreadGoalRow(jsonRow(raw), threadId);
}

export function validateThreadGoalShape(
  row: ThreadGoalRow,
  columns: ReadonlyMap<string, ThreadColumn>,
): void {
  for (const name of Object.keys(row)) {
    if (!columns.has(name)) throw new Error(`target Codex schema cannot preserve source goal column: ${name}`);
  }
  for (const column of columns.values()) {
    if (!Object.hasOwn(row, column.name) && column.notNull && column.defaultValue === null && !column.primaryKey) {
      throw new Error(`target Codex schema requires unavailable goal column: ${column.name}`);
    }
  }
}

export function threadGoalRowsEqual(expected: ThreadGoalRow | null, actual: ThreadGoalRow | undefined): boolean {
  if (expected === null) return actual === undefined;
  if (actual === undefined) return false;
  return Object.entries(expected).every(([name, value]) => JSON.stringify(actual[name]) === JSON.stringify(value));
}

export function insertThreadGoalRow(database: DatabaseSync, row: ThreadGoalRow): void {
  const names = Object.keys(row).sort();
  const sql = `INSERT INTO thread_goals (${names.map(quoteSQLiteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
  database.prepare(sql).run(...names.map((name) => decodeSQLiteValue(row[name]!)));
}

export function deleteThreadGoalRow(database: DatabaseSync, threadId: string): void {
  const result = database.prepare("DELETE FROM thread_goals WHERE thread_id = ?").run(threadId);
  if (result.changes !== 1) throw new Error(`Codex thread goal changed while deleting: ${threadId}`);
}

export function readThreadGoalContinuationDeferral(database: DatabaseSync, threadId: string): boolean {
  if (inspectThreadGoalDeferralSchema(database) === undefined) return false;
  return database.prepare(
    "SELECT 1 AS present FROM thread_goal_continuation_deferrals WHERE thread_id = ? LIMIT 1",
  ).get(threadId) !== undefined;
}

export function validateThreadGoalDeferralTarget(database: DatabaseSync): boolean {
  const columns = inspectThreadGoalDeferralSchema(database);
  if (columns === undefined) return false;
  for (const column of columns.values()) {
    if (column.name !== "thread_id" && column.notNull && column.defaultValue === null && !column.primaryKey) {
      throw new Error(`target Codex schema requires unavailable goal deferral column: ${column.name}`);
    }
  }
  return true;
}

export function insertThreadGoalContinuationDeferral(database: DatabaseSync, threadId: string): void {
  const result = database.prepare(
    "INSERT INTO thread_goal_continuation_deferrals (thread_id) VALUES (?)",
  ).run(threadId);
  if (result.changes !== 1) throw new Error(`Codex thread goal deferral changed while inserting: ${threadId}`);
}

export function deleteThreadGoalContinuationDeferral(database: DatabaseSync, threadId: string): void {
  const result = database.prepare(
    "DELETE FROM thread_goal_continuation_deferrals WHERE thread_id = ?",
  ).run(threadId);
  if (result.changes !== 1) throw new Error(`Codex thread goal deferral changed while deleting: ${threadId}`);
}

function hasGoalTables(database: DatabaseSync): boolean {
  const names = tableNames(database);
  return names.has("thread_goals") || names.has("thread_goal_continuation_deferrals");
}

function inspectGoalStore(databasePath: string): CodexGoalStore | undefined {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    try {
      if (!hasGoalTables(database)) return undefined;
    } catch {
      return undefined;
    }
    if (inspectThreadGoalSchema(database) === undefined) {
      if (inspectThreadGoalDeferralSchema(database) !== undefined) {
        throw new Error(`Codex goal database has deferrals without goals: ${databasePath}`);
      }
      return undefined;
    }
    return {
      databasePath,
      hasContinuationDeferrals: validateThreadGoalDeferralTarget(database),
    };
  } finally {
    database.close();
  }
}

export async function resolveCodexGoalStore(
  sqliteHome: string,
): Promise<CodexGoalStore | undefined> {
  const candidates: CodexGoalStore[] = [];
  for (const databasePath of await codexSQLiteStorePaths(sqliteHome)) {
    const store = inspectGoalStore(databasePath);
    if (store !== undefined) candidates.push(store);
  }
  if (candidates.length > 1) {
    throw new Error("Codex SQLite home contains multiple usable thread goal stores");
  }
  return candidates[0];
}
