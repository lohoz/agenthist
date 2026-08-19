import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { JsonValue } from "../../../domain/history.js";
import { decodeSQLiteValue, encodeSQLiteValue, quoteSQLiteIdentifier } from "../../../infrastructure/sqlite.js";
import {
  inspectOpenCodeImportTargetSchema,
  openCodeStringColumn,
  openCodeTableSchema,
  readOpenCodeTableRows,
  validateOpenCodeHistoryDatabase,
  type OpenCodeColumn,
  type OpenCodeHistorySchema,
  type OpenCodeHistoryTable,
  type OpenCodeTableSchema,
} from "./database.js";

const INSERT_ORDER: readonly OpenCodeHistoryTable[] = [
  "project",
  "session",
  "event_sequence",
  "message",
  "part",
  "todo",
  "session_context_epoch",
  "session_input",
  "session_message",
  "event",
];

const OWNER_COLUMN: Readonly<Partial<Record<OpenCodeHistoryTable, string>>> = {
  session: "id",
  event: "aggregate_id",
  event_sequence: "aggregate_id",
  message: "session_id",
  part: "session_id",
  session_context_epoch: "session_id",
  session_input: "session_id",
  session_message: "session_id",
  todo: "session_id",
};

export type OpenCodeRowPosition = "absent" | "exact" | "diverged";
export type OpenCodeImportClassification = "new" | "already_present" | "conflict";

export interface OpenCodeInsertedRow {
  readonly table: OpenCodeHistoryTable;
  readonly key: readonly JsonValue[];
}

export interface OpenCodeSessionAssessment {
  readonly nativeId: string;
  readonly classification: OpenCodeImportClassification;
  readonly reason?: string;
}

export interface OpenCodeTargetAssessment {
  readonly sessions: readonly OpenCodeSessionAssessment[];
  readonly insertedRows: readonly OpenCodeInsertedRow[];
  readonly conflicts: readonly string[];
}

interface NativeRow {
  readonly table: OpenCodeTableSchema;
  readonly values: readonly SQLInputValue[];
  readonly keyColumns: readonly string[];
  readonly keyValues: readonly SQLInputValue[];
  readonly persistedKey: OpenCodeInsertedRow;
  readonly owner?: string;
}

function primaryKeyColumns(table: OpenCodeTableSchema): string[] {
  const columns = table.columns
    .filter((column) => column.primaryKeyOrder > 0)
    .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder)
    .map((column) => column.name);
  if (columns.length === 0) throw new Error(`OpenCode ${table.name} history has no primary key capability`);
  return columns;
}

function columnIndex(columns: readonly OpenCodeColumn[], name: string): number {
  const index = columns.findIndex((column) => column.name === name);
  if (index < 0) throw new Error(`OpenCode table lacks required column: ${name}`);
  return index;
}

function rowKey(table: OpenCodeTableSchema, values: readonly SQLInputValue[]): OpenCodeInsertedRow {
  const key = primaryKeyColumns(table).map((name) => values[columnIndex(table.columns, name)]!);
  if (key.some((value) => value === null)) throw new Error(`OpenCode ${table.name} row has a NULL primary key`);
  return { table: table.name, key: key.map(encodeSQLiteValue) };
}

function rowToken(row: OpenCodeInsertedRow): string {
  return `${row.table}\0${JSON.stringify(row.key)}`;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) return Buffer.from(left).equals(Buffer.from(right));
  return Object.is(left, right);
}

function rowsEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]));
}

function sourceRows(database: DatabaseSync, schema: OpenCodeHistorySchema): NativeRow[] {
  const result: NativeRow[] = [];
  for (const name of INSERT_ORDER) {
    const table = openCodeTableSchema(schema, name);
    if (table === undefined) continue;
    const keyColumns = primaryKeyColumns(table);
    const ownerColumn = OWNER_COLUMN[name];
    for (const values of readOpenCodeTableRows(database, table)) {
      const persistedKey = rowKey(table, values);
      const owner = ownerColumn === undefined ? undefined : openCodeStringColumn(values, table.columns, ownerColumn);
      result.push({
        table,
        values,
        keyColumns,
        keyValues: persistedKey.key.map(decodeSQLiteValue),
        persistedKey,
        ...(owner === undefined ? {} : { owner }),
      });
    }
  }
  return result;
}

function targetTableCompatibility(source: OpenCodeTableSchema, target: OpenCodeTableSchema | undefined): void {
  if (target === undefined) throw new Error(`target OpenCode database lacks history table: ${source.name}`);
  const targetByName = new Map(target.columns.map((column) => [column.name, column]));
  for (const column of source.columns) {
    if (!targetByName.has(column.name)) {
      throw new Error(`target OpenCode ${source.name} table cannot preserve source column: ${column.name}`);
    }
  }
  const sourcePrimary = primaryKeyColumns(source);
  const targetPrimary = primaryKeyColumns(target);
  if (sourcePrimary.join("\0") !== targetPrimary.join("\0")) {
    throw new Error(`target OpenCode ${source.name} primary key capability differs`);
  }
  const sourceNames = new Set(source.columns.map((column) => column.name));
  for (const column of target.columns) {
    if (!sourceNames.has(column.name) && column.notNull && column.defaultValue === null && column.primaryKeyOrder === 0) {
      throw new Error(`target OpenCode ${source.name} requires unavailable column: ${column.name}`);
    }
  }
}

function targetRow(database: DatabaseSync, row: NativeRow): readonly SQLInputValue[] | undefined {
  const projection = row.table.columns.map((column) => quoteSQLiteIdentifier(column.name)).join(", ");
  const predicate = row.keyColumns.map((column) => `${quoteSQLiteIdentifier(column)} = ?`).join(" AND ");
  const statement = database.prepare(
    `SELECT ${projection} FROM ${quoteSQLiteIdentifier(row.table.name)} WHERE ${predicate}`,
  );
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  const values = statement.all(...row.keyValues) as unknown[];
  if (values.length > 1) throw new Error(`target OpenCode ${row.table.name} primary key is not unique`);
  const found = values[0];
  if (found === undefined) return undefined;
  if (!Array.isArray(found)) throw new Error(`target OpenCode ${row.table.name} returned an invalid row`);
  return found as SQLInputValue[];
}

function position(database: DatabaseSync, row: NativeRow): OpenCodeRowPosition {
  const actual = targetRow(database, row);
  if (actual === undefined) return "absent";
  return rowsEqual(row.values, actual) ? "exact" : "diverged";
}

function ownedCount(database: DatabaseSync, table: OpenCodeTableSchema, owner: string): number {
  const ownerColumn = OWNER_COLUMN[table.name];
  if (ownerColumn === undefined) return 0;
  const statement = database.prepare(
    `SELECT count(*) AS count FROM ${quoteSQLiteIdentifier(table.name)} WHERE ${quoteSQLiteIdentifier(ownerColumn)} = ?`,
  );
  statement.setReadBigInts(true);
  const value = (statement.get(owner) as Record<string, unknown> | undefined)?.count;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(`target OpenCode ${table.name} row count is invalid`);
}

function inspectTargetSchemas(
  source: OpenCodeHistorySchema,
  target: OpenCodeHistorySchema,
): void {
  for (const sourceTable of source.tables) {
    targetTableCompatibility(sourceTable, openCodeTableSchema(target, sourceTable.name));
  }
}

export function assessOpenCodeTarget(sourcePath: string, targetPath: string): OpenCodeTargetAssessment {
  const source = new DatabaseSync(sourcePath, { readOnly: true, readBigInts: true });
  const target = new DatabaseSync(targetPath, { readOnly: true, readBigInts: true, timeout: 5_000 });
  try {
    const sourceSchema = validateOpenCodeHistoryDatabase(source);
    const targetSchema = inspectOpenCodeImportTargetSchema(target);
    inspectTargetSchemas(sourceSchema, targetSchema);
    const rows = sourceRows(source, sourceSchema);
    const positions = new Map<NativeRow, OpenCodeRowPosition>();
    const insertedRows: OpenCodeInsertedRow[] = [];
    const conflicts: string[] = [];
    for (const row of rows) {
      const observed = position(target, row);
      positions.set(row, observed);
      if (observed === "absent") insertedRows.push(row.persistedKey);
      if (observed === "diverged") conflicts.push(`${row.table.name}:${JSON.stringify(row.persistedKey.key)}`);
    }
    const sourceSessionTable = openCodeTableSchema(sourceSchema, "session")!;
    const sessionRows = rows.filter((row) => row.table.name === "session");
    const sessions: OpenCodeSessionAssessment[] = [];
    for (const sessionRow of sessionRows) {
      const nativeId = openCodeStringColumn(sessionRow.values, sourceSessionTable.columns, "id")!;
      const sessionPosition = positions.get(sessionRow)!;
      const ownedRows = rows.filter((row) => row.owner === nativeId);
      let classification: OpenCodeImportClassification;
      let reason: string | undefined;
      if (sessionPosition === "diverged") {
        classification = "conflict";
        reason = "target session row differs";
      } else {
        const expectedPosition = sessionPosition === "absent" ? "absent" : "exact";
        const mismatched = ownedRows.find((row) => positions.get(row) !== expectedPosition);
        let countMismatch = false;
        for (const sourceTable of sourceSchema.tables) {
          if (OWNER_COLUMN[sourceTable.name] === undefined) continue;
          const sourceCount = ownedRows.filter((row) => row.table.name === sourceTable.name).length;
          const targetTable = openCodeTableSchema(targetSchema, sourceTable.name)!;
          if (ownedCount(target, targetTable, nativeId) !== (expectedPosition === "exact" ? sourceCount : 0)) {
            countMismatch = true;
            break;
          }
        }
        if (mismatched !== undefined || countMismatch) {
          classification = "conflict";
          reason = "target session history is partial or has later rows";
        } else {
          classification = sessionPosition === "absent" ? "new" : "already_present";
        }
      }
      if (classification === "conflict") conflicts.push(`session:${nativeId}`);
      sessions.push({ nativeId, classification, ...(reason === undefined ? {} : { reason }) });
    }
    const sharedMissing = rows.some((row) => row.owner === undefined && positions.get(row) === "absent");
    if (sharedMissing && sessions.every((session) => session.classification === "already_present")) {
      conflicts.push("shared-history-closure-incomplete");
    }
    return {
      sessions,
      insertedRows,
      conflicts: [...new Set(conflicts)].sort(),
    };
  } finally {
    target.close();
    source.close();
  }
}

export function normalizeOpenCodeInsertedRows(
  sourcePath: string,
  raw: readonly OpenCodeInsertedRow[],
): readonly OpenCodeInsertedRow[] {
  const source = new DatabaseSync(sourcePath, { readOnly: true, readBigInts: true });
  try {
    const schema = validateOpenCodeHistoryDatabase(source);
    const available = new Map(sourceRows(source, schema).map((row) => [rowToken(row.persistedKey), row.persistedKey]));
    const result: OpenCodeInsertedRow[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!INSERT_ORDER.includes(item.table) || !Array.isArray(item.key)) throw new Error("OpenCode transaction row key is invalid");
      const normalized: OpenCodeInsertedRow = { table: item.table, key: [...item.key] };
      const token = rowToken(normalized);
      const sourceKey = available.get(token);
      if (sourceKey === undefined || seen.has(token)) throw new Error("OpenCode transaction row key is invalid");
      seen.add(token);
      result.push(sourceKey);
    }
    return result.sort((left, right) => {
      const table = INSERT_ORDER.indexOf(left.table) - INSERT_ORDER.indexOf(right.table);
      return table || rowToken(left).localeCompare(rowToken(right));
    });
  } finally {
    source.close();
  }
}

export function observeOpenCodeInsertedRows(
  sourcePath: string,
  targetPath: string,
  inserted: readonly OpenCodeInsertedRow[],
): readonly OpenCodeRowPosition[] {
  const source = new DatabaseSync(sourcePath, { readOnly: true, readBigInts: true });
  const target = new DatabaseSync(targetPath, { readOnly: true, readBigInts: true, timeout: 5_000 });
  try {
    const schema = validateOpenCodeHistoryDatabase(source);
    inspectTargetSchemas(schema, inspectOpenCodeImportTargetSchema(target));
    const wanted = new Set(inserted.map(rowToken));
    return sourceRows(source, schema)
      .filter((row) => wanted.has(rowToken(row.persistedKey)))
      .map((row) => position(target, row));
  } finally {
    target.close();
    source.close();
  }
}

function insertRow(database: DatabaseSync, row: NativeRow): void {
  const columns = row.table.columns.map((column) => quoteSQLiteIdentifier(column.name));
  database.prepare(
    `INSERT INTO ${quoteSQLiteIdentifier(row.table.name)} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...row.values);
}

function deleteRow(database: DatabaseSync, row: NativeRow): void {
  const predicate = row.keyColumns.map((column) => `${quoteSQLiteIdentifier(column)} = ?`).join(" AND ");
  const result = database.prepare(
    `DELETE FROM ${quoteSQLiteIdentifier(row.table.name)} WHERE ${predicate}`,
  ).run(...row.keyValues);
  if (result.changes !== 1 && result.changes !== 1n) throw new Error(`OpenCode ${row.table.name} changed while deleting`);
}

export function applyOpenCodeInsertedRows(
  sourcePath: string,
  targetPath: string,
  inserted: readonly OpenCodeInsertedRow[],
  desired: "present" | "absent",
  recovery: boolean,
): void {
  const source = new DatabaseSync(sourcePath, { readOnly: true, readBigInts: true });
  const target = new DatabaseSync(targetPath, { readBigInts: true, timeout: 5_000 });
  try {
    const schema = validateOpenCodeHistoryDatabase(source);
    inspectTargetSchemas(schema, inspectOpenCodeImportTargetSchema(target));
    const wanted = new Set(inserted.map(rowToken));
    const selected = sourceRows(source, schema).filter((row) => wanted.has(rowToken(row.persistedKey)));
    if (selected.length !== wanted.size) throw new Error("OpenCode transaction row closure is incomplete");
    const before = selected.map((row) => position(target, row));
    const allowed = recovery
      ? before.every((item) => item !== "diverged")
      : before.every((item) => item === (desired === "present" ? "absent" : "exact"));
    if (!allowed) throw new Error("OpenCode target no longer matches transaction state");
    target.exec("BEGIN IMMEDIATE");
    try {
      const ordered = desired === "present" ? selected : [...selected].reverse();
      for (const row of ordered) {
        const current = position(target, row);
        if (desired === "present") {
          if (current === "exact") continue;
          if (current !== "absent") throw new Error(`OpenCode ${row.table.name} row diverged before insert`);
          insertRow(target, row);
        } else {
          if (current === "absent") continue;
          if (current !== "exact") throw new Error(`OpenCode ${row.table.name} row diverged before delete`);
          deleteRow(target, row);
        }
      }
      target.exec("COMMIT");
    } catch (error) {
      try { target.exec("ROLLBACK"); } catch { /* SQLite transaction may already be closed */ }
      throw error;
    }
    const expected = desired === "present" ? "exact" : "absent";
    if (!selected.every((row) => position(target, row) === expected)) {
      throw new Error("OpenCode transaction verification failed");
    }
  } finally {
    target.close();
    source.close();
  }
}

export function insertedOpenCodeSessionsUnchanged(
  sourcePath: string,
  targetPath: string,
  inserted: readonly OpenCodeInsertedRow[],
): boolean {
  const source = new DatabaseSync(sourcePath, { readOnly: true, readBigInts: true });
  const target = new DatabaseSync(targetPath, { readOnly: true, readBigInts: true, timeout: 5_000 });
  try {
    const sourceSchema = validateOpenCodeHistoryDatabase(source);
    const targetSchema = inspectOpenCodeImportTargetSchema(target);
    inspectTargetSchemas(sourceSchema, targetSchema);
    const insertedTokens = new Set(inserted.map(rowToken));
    const allRows = sourceRows(source, sourceSchema);
    const insertedSessions = new Set(
      allRows
        .filter((row) => row.table.name === "session" && insertedTokens.has(rowToken(row.persistedKey)))
        .map((row) => row.owner)
        .filter((owner): owner is string => owner !== undefined),
    );
    for (const nativeId of insertedSessions) {
      const owned = allRows.filter((row) => row.owner === nativeId);
      if (owned.some((row) => position(target, row) !== "exact")) return false;
      for (const sourceTable of sourceSchema.tables) {
        if (OWNER_COLUMN[sourceTable.name] === undefined) continue;
        const targetTable = openCodeTableSchema(targetSchema, sourceTable.name)!;
        if (ownedCount(target, targetTable, nativeId) !== owned.filter((row) => row.table.name === sourceTable.name).length) {
          return false;
        }
      }
      const sourceChildren = new Set(
        allRows.filter((row) => row.table.name === "session")
          .filter((row) => openCodeStringColumn(row.values, row.table.columns, "parent_id") === nativeId)
          .map((row) => row.owner),
      );
      const targetChildren = target.prepare("SELECT id FROM session WHERE parent_id = ?").all(nativeId) as Array<Record<string, unknown>>;
      if (targetChildren.some((row) => typeof row.id !== "string" || !sourceChildren.has(row.id))) return false;
    }
    const insertedProjects = allRows.filter((row) =>
      row.table.name === "project" && insertedTokens.has(rowToken(row.persistedKey))
    );
    const sourceSessionIds = new Set(allRows.filter((row) => row.table.name === "session").map((row) => row.owner));
    for (const project of insertedProjects) {
      const projectId = openCodeStringColumn(project.values, project.table.columns, "id");
      if (projectId === undefined) return false;
      const dependents = target.prepare("SELECT id FROM session WHERE project_id = ?").all(projectId) as Array<Record<string, unknown>>;
      if (dependents.some((row) => typeof row.id !== "string" || !sourceSessionIds.has(row.id))) return false;
    }
    return true;
  } finally {
    target.close();
    source.close();
  }
}
