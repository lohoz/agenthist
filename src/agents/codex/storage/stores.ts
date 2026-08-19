import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { hasThreadTable, inspectThreadSchema } from "./database.js";

function validStoreName(value: string): boolean {
  return value !== ".sqlite" && value.endsWith(".sqlite") && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

export function isCodexSQLiteStorePath(sqliteHome: string, candidate: string): boolean {
  const root = path.resolve(sqliteHome);
  const resolved = path.resolve(candidate);
  return path.dirname(resolved) === root && validStoreName(path.basename(resolved));
}

export async function codexSQLiteStorePaths(sqliteHome: string): Promise<readonly string[]> {
  const root = path.resolve(sqliteHome);
  const entries = await readdir(root, { withFileTypes: true });
  const stores: string[] = [];
  for (const entry of entries) {
    if (!validStoreName(entry.name)) continue;
    const candidate = path.join(root, entry.name);
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Codex SQLite store is not a regular file: ${candidate}`);
    }
    stores.push(candidate);
  }
  return stores.sort((left, right) => left.localeCompare(right));
}

function compatibleStateStore(candidate: string): boolean {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(candidate, { readOnly: true });
  } catch {
    return false;
  }
  try {
    let hasThreads: boolean;
    try {
      hasThreads = hasThreadTable(database);
    } catch {
      return false;
    }
    if (!hasThreads) return false;
    inspectThreadSchema(database);
    return true;
  } finally {
    database.close();
  }
}

export async function resolveCodexStateStore(sqliteHome: string): Promise<string | undefined> {
  const matches: string[] = [];
  for (const candidate of await codexSQLiteStorePaths(sqliteHome)) {
    if (compatibleStateStore(candidate)) matches.push(candidate);
  }
  if (matches.length > 1) {
    throw new Error("Codex SQLite home contains multiple compatible thread stores");
  }
  return matches[0];
}

export async function requireCodexStateStore(sqliteHome: string): Promise<string> {
  const database = await resolveCodexStateStore(sqliteHome);
  if (database === undefined) {
    throw new Error(`Codex SQLite home has no database with a compatible threads schema: ${path.resolve(sqliteHome)}`);
  }
  return database;
}
