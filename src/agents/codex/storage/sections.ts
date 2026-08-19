import { DatabaseSync } from "node:sqlite";

import type { JsonValue } from "../../../domain/history.js";
import {
  decodeSQLiteValue,
  encodeSQLiteValue,
  quoteSQLiteIdentifier,
} from "../../../infrastructure/sqlite.js";
import type { ThreadColumn, ThreadRow } from "./database.js";

export type ThreadSectionRow = Record<string, JsonValue>;

const REQUIRED_SECTION_COLUMNS = ["id", "name"] as const;

function tableExists(database: DatabaseSync, name: string): boolean {
  return database.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(name) !== undefined;
}

export function inspectThreadSectionSchema(
  database: DatabaseSync,
): Map<string, ThreadColumn> | undefined {
  if (!tableExists(database, "thread_sections")) return undefined;
  const rows = database.prepare("PRAGMA table_info(thread_sections)").all() as Array<Record<string, unknown>>;
  const result = new Map<string, ThreadColumn>();
  for (const row of rows) {
    if (typeof row.name !== "string" || result.has(row.name)) {
      throw new Error("Codex thread_sections schema is invalid");
    }
    result.set(row.name, {
      name: row.name,
      notNull: row.notnull === 1,
      defaultValue: row.dflt_value,
      primaryKey: typeof row.pk === "number" && row.pk !== 0,
    });
  }
  for (const required of REQUIRED_SECTION_COLUMNS) {
    if (!result.has(required)) throw new Error(`Codex thread_sections is missing column: ${required}`);
  }
  if (!result.get("id")!.primaryKey) throw new Error("Codex thread_sections ID is not a primary key");
  return result;
}

export function validateThreadSectionRow(value: unknown): ThreadSectionRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex thread section row is invalid");
  }
  const row = { ...value } as ThreadSectionRow;
  if (typeof row.id !== "string" || row.id === "" || typeof row.name !== "string") {
    throw new Error("Codex thread section row is invalid");
  }
  return row;
}

export function readThreadSectionRows(database: DatabaseSync): Map<string, ThreadSectionRow> {
  if (inspectThreadSectionSchema(database) === undefined) return new Map();
  const rows = database.prepare("SELECT * FROM thread_sections ORDER BY id").all() as Array<Record<string, unknown>>;
  const result = new Map<string, ThreadSectionRow>();
  for (const raw of rows) {
    const row = validateThreadSectionRow(Object.fromEntries(
      Object.entries(raw).map(([name, value]) => [name, encodeSQLiteValue(value)]),
    ));
    const id = row.id as string;
    if (result.has(id)) throw new Error(`Codex thread_sections contains a duplicate ID: ${id}`);
    result.set(id, row);
  }
  return result;
}

export function readThreadSectionRow(
  database: DatabaseSync,
  sectionId: string,
): ThreadSectionRow | undefined {
  if (inspectThreadSectionSchema(database) === undefined) return undefined;
  const raw = database.prepare("SELECT * FROM thread_sections WHERE id = ?").get(sectionId) as
    | Record<string, unknown>
    | undefined;
  return raw === undefined
    ? undefined
    : validateThreadSectionRow(Object.fromEntries(
      Object.entries(raw).map(([name, value]) => [name, encodeSQLiteValue(value)]),
    ));
}

export function readThreadSectionReferenceIds(database: DatabaseSync, sectionId: string): string[] {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(threads)").all() as Array<Record<string, unknown>>)
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
  if (!columns.has("thread_section_id")) return [];
  const rows = database.prepare(
    "SELECT id FROM threads WHERE thread_section_id = ? ORDER BY id",
  ).all(sectionId) as Array<Record<string, unknown>>;
  if (rows.some((row) => typeof row.id !== "string")) {
    throw new Error(`Codex thread section has an invalid reference: ${sectionId}`);
  }
  return rows.map((row) => row.id as string);
}

export function threadSectionForThread(
  thread: ThreadRow | undefined,
  sections: ReadonlyMap<string, ThreadSectionRow>,
): ThreadSectionRow | null {
  if (thread === undefined) return null;
  const sectionId = thread.thread_section_id;
  if (sectionId === undefined || sectionId === null) return null;
  if (typeof sectionId !== "string" || sectionId === "") {
    throw new Error(`Codex thread has an invalid section ID: ${String(thread.id ?? "unknown")}`);
  }
  const section = sections.get(sectionId);
  if (section === undefined) {
    throw new Error(`Codex thread section is missing: ${sectionId}`);
  }
  return section;
}

export function validateThreadSectionShape(
  row: ThreadSectionRow,
  columns: ReadonlyMap<string, ThreadColumn>,
): void {
  validateThreadSectionRow(row);
  for (const name of Object.keys(row)) {
    if (!columns.has(name)) throw new Error(`target Codex schema cannot preserve source thread section column: ${name}`);
  }
  for (const column of columns.values()) {
    if (!Object.hasOwn(row, column.name) && column.notNull && column.defaultValue === null && !column.primaryKey) {
      throw new Error(`target Codex schema requires unavailable thread section column: ${column.name}`);
    }
  }
}

export function validateThreadSectionTarget(database: DatabaseSync, row: ThreadSectionRow | null): void {
  if (row === null) return;
  const columns = inspectThreadSectionSchema(database);
  if (columns === undefined) throw new Error("target Codex has no thread_sections table");
  validateThreadSectionShape(row, columns);
}

export function threadSectionRowsEqual(
  expected: ThreadSectionRow | null | undefined,
  actual: ThreadSectionRow | null | undefined,
): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;
  return Object.entries(expected).every(([name, value]) => JSON.stringify(actual[name]) === JSON.stringify(value));
}

export function insertThreadSectionRow(database: DatabaseSync, row: ThreadSectionRow): void {
  validateThreadSectionTarget(database, row);
  const names = Object.keys(row).sort();
  database.prepare(
    `INSERT INTO thread_sections (${names.map(quoteSQLiteIdentifier).join(", ")}) ` +
      `VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...names.map((name) => decodeSQLiteValue(row[name]!)));
}

export function deleteUnreferencedThreadSectionRow(database: DatabaseSync, sectionId: string): void {
  const columns = inspectThreadSectionSchema(database);
  if (columns === undefined) throw new Error("target Codex has no thread_sections table");
  const threadColumns = new Set(
    (database.prepare("PRAGMA table_info(threads)").all() as Array<Record<string, unknown>>)
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
  if (!threadColumns.has("thread_section_id")) {
    throw new Error("target Codex threads table cannot reference thread sections");
  }
  const result = database.prepare(`
    DELETE FROM thread_sections
    WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM threads WHERE thread_section_id = ?)
  `).run(sectionId, sectionId);
  if (result.changes !== 1) {
    throw new Error(`Codex thread section is still referenced or changed: ${sectionId}`);
  }
}
