import { lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { isAbsolutePath } from "../../../domain/host-path.js";
import { mapAbsolutePath, type PathMappings } from "../../../domain/path-mapping.js";
import { quoteSQLiteIdentifier } from "../../../infrastructure/sqlite.js";
import {
  inspectOpenCodeHistorySchema,
  openCodeStringColumn,
  openCodeTableSchema,
  readOpenCodeTableRows,
  validateOpenCodeHistoryDatabase,
} from "../storage/database.js";

function supportedInput(value: unknown): value is SQLInputValue {
  return value === null || typeof value === "number" || typeof value === "bigint" ||
    typeof value === "string" || value instanceof Uint8Array;
}

function valuesEqual(left: SQLInputValue, right: SQLInputValue): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) return Buffer.from(left).equals(Buffer.from(right));
  return Object.is(left, right);
}

async function requireMappedWorktree(directory: string): Promise<void> {
  let info;
  try { info = await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`mapped OpenCode project worktree does not exist: ${directory}`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`mapped OpenCode project worktree is not a real directory: ${directory}`);
  }
}

export async function projectOpenCodeTargetProjects(
  databasePath: string,
  targetPath: string,
  mappings: PathMappings,
): Promise<void> {
  const database = new DatabaseSync(databasePath, { readBigInts: true });
  const target = new DatabaseSync(targetPath, { readOnly: true, readBigInts: true, timeout: 5_000 });
  try {
    const schema = validateOpenCodeHistoryDatabase(database);
    const table = openCodeTableSchema(schema, "project")!;
    const targetTable = openCodeTableSchema(inspectOpenCodeHistorySchema(target), "project")!;
    const targetColumns = new Set(targetTable.columns.map((column) => column.name));
    const missing = table.columns.find((column) => !targetColumns.has(column.name));
    if (missing !== undefined) throw new Error(`target OpenCode project cannot preserve source column: ${missing.name}`);
    const idIndex = table.columns.findIndex((column) => column.name === "id");
    const worktreeIndex = table.columns.findIndex((column) => column.name === "worktree");
    const sandboxesIndex = table.columns.findIndex((column) => column.name === "sandboxes");
    if (idIndex < 0) throw new Error("OpenCode project identity capability is unavailable");
    const names = table.columns.map((column) => quoteSQLiteIdentifier(column.name));
    const targetRow = target.prepare(`SELECT ${names.join(", ")} FROM project WHERE id = ?`);
    targetRow.setReadBigInts(true);
    targetRow.setReturnArrays(true);
    const changes: Array<{ id: string; values: SQLInputValue[] }> = [];
    const checkedWorktrees = new Set<string>();
    for (const source of readOpenCodeTableRows(database, table)) {
      const id = openCodeStringColumn(source, table.columns, "id");
      if (id === undefined) throw new Error("OpenCode project identity is invalid");
      const matched = targetRow.all(id) as unknown[];
      if (matched.length > 1) throw new Error(`target OpenCode project identity is not unique: ${id}`);
      let projected: SQLInputValue[];
      if (matched.length === 1) {
        const value = matched[0];
        if (!Array.isArray(value) || value.length !== names.length || !value.every(supportedInput)) {
          throw new Error(`target OpenCode project row is invalid: ${id}`);
        }
        projected = [...value];
      } else {
        projected = [...source];
        if (worktreeIndex >= 0) {
          const before = source[worktreeIndex];
          if (typeof before !== "string") throw new Error(`OpenCode project worktree is invalid: ${id}`);
          const after = mapAbsolutePath(before, mappings, "OpenCode project worktree");
          if (after !== before && !checkedWorktrees.has(after)) {
            await requireMappedWorktree(after);
            checkedWorktrees.add(after);
          }
          projected[worktreeIndex] = after;
        }
        if (sandboxesIndex >= 0) {
          const value = source[sandboxesIndex];
          if (typeof value !== "string") throw new Error(`OpenCode project sandboxes are invalid: ${id}`);
          let parsed: unknown;
          try { parsed = JSON.parse(value); } catch { throw new Error(`OpenCode project sandboxes are invalid: ${id}`); }
          if (!Array.isArray(parsed) || !parsed.every((item) =>
            typeof item === "string" && isAbsolutePath(item, mappings.sourceFlavor))) {
            throw new Error(`OpenCode project sandboxes are invalid: ${id}`);
          }
          projected[sandboxesIndex] = "[]";
        }
      }
      if (!source.every((value, index) => valuesEqual(value, projected[index]!))) {
        changes.push({ id, values: projected });
      }
    }
    if (changes.length === 0) return;
    const mutable = table.columns
      .map((column, index) => ({ column, index }))
      .filter(({ column }) => column.name !== "id");
    if (mutable.length === 0) return;
    const update = database.prepare(
      `UPDATE project SET ${mutable.map(({ column }) => `${quoteSQLiteIdentifier(column.name)} = ?`).join(", ")} WHERE id = ?`,
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const change of changes) {
        const result = update.run(...mutable.map(({ index }) => change.values[index]!), change.id);
        if (result.changes !== 1 && result.changes !== 1n) {
          throw new Error(`OpenCode project changed during target projection: ${change.id}`);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* SQLite transaction may already be closed */ }
      throw error;
    }
    validateOpenCodeHistoryDatabase(database);
  } finally {
    target.close();
    database.close();
  }
}
