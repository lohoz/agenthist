import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { quoteSQLiteIdentifier } from "../../../infrastructure/sqlite.js";

export const OPENCODE_HISTORY_FORMAT = "agenthist.opencode.history-sqlite/v1";

export const OPENCODE_HISTORY_TABLES = [
  "event",
  "event_sequence",
  "message",
  "part",
  "project",
  "session",
  "session_context_epoch",
  "session_input",
  "session_message",
  "todo",
] as const;

export type OpenCodeHistoryTable = (typeof OPENCODE_HISTORY_TABLES)[number];
export type OpenCodePendingInputStatus = "empty" | "present" | "unknown";
export type OpenCodeRevertStatus = "empty" | "present" | "unknown";

const TABLE_KEYS: Readonly<Record<OpenCodeHistoryTable, readonly string[]>> = {
  event: ["aggregate_id", "seq", "id"],
  event_sequence: ["aggregate_id"],
  message: ["session_id", "time_created", "id"],
  part: ["message_id", "id"],
  project: ["id"],
  session: ["id"],
  session_context_epoch: ["session_id"],
  session_input: ["session_id", "admitted_seq", "id"],
  session_message: ["session_id", "seq", "id"],
  todo: ["session_id", "position"],
};

const REQUIRED_COLUMNS: Readonly<Partial<Record<OpenCodeHistoryTable, readonly string[]>>> = {
  project: ["id"],
  session: ["id", "project_id", "parent_id", "directory", "path", "title", "version", "model", "time_created", "time_updated", "time_archived"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
};

const REQUIRED_TABLES = new Set(Object.keys(REQUIRED_COLUMNS));
const EXCLUDED_RELATIONAL_TABLES = new Set([
  "account",
  "account_state",
  "control_account",
  "credential",
  "data_migration",
  "migration",
  "permission",
  "project_directory",
  "session_share",
  "workspace",
]);

export interface OpenCodeColumn {
  readonly name: string;
  readonly declaredType: string;
  readonly notNull: boolean;
  readonly defaultValue: unknown;
  readonly primaryKeyOrder: number;
}

export interface OpenCodeTableSchema {
  readonly name: OpenCodeHistoryTable;
  readonly columns: readonly OpenCodeColumn[];
  readonly keyColumns: readonly string[];
}

export interface OpenCodeHistorySchema {
  readonly tables: readonly OpenCodeTableSchema[];
}

function tableNames(database: DatabaseSync): Set<string> {
  const rows = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<Record<string, unknown>>;
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
}

function pragmaInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return undefined;
}

function inspectColumns(database: DatabaseSync, table: string): OpenCodeColumn[] {
  const rows = database.prepare(`PRAGMA table_xinfo(${quoteSQLiteIdentifier(table)})`).all() as Array<Record<string, unknown>>;
  const columns: OpenCodeColumn[] = [];
  for (const row of rows) {
    const notNull = pragmaInteger(row.notnull);
    const primaryKeyOrder = pragmaInteger(row.pk);
    const hidden = row.hidden === undefined ? 0 : pragmaInteger(row.hidden);
    if (
      typeof row.name !== "string" || typeof row.type !== "string" || notNull === undefined ||
      primaryKeyOrder === undefined || hidden !== 0 ||
      columns.some((column) => column.name === row.name)
    ) {
      throw new Error(`OpenCode table has an unsupported column shape: ${table}`);
    }
    quoteSQLiteIdentifier(row.name);
    columns.push({
      name: row.name,
      declaredType: row.type,
      notNull: notNull !== 0,
      defaultValue: row.dflt_value,
      primaryKeyOrder,
    });
  }
  if (columns.length === 0) throw new Error(`OpenCode history table has no columns: ${table}`);
  return columns;
}

function unknownHistoryRelations(database: DatabaseSync, names: ReadonlySet<string>): string[] {
  const knownHistory = new Set<string>(OPENCODE_HISTORY_TABLES);
  const result: string[] = [];
  for (const table of [...names].sort()) {
    if (knownHistory.has(table) || EXCLUDED_RELATIONAL_TABLES.has(table)) continue;
    const columns = inspectColumns(database, table);
    const looksOwned = columns.some((column) =>
      column.name === "session_id" || column.name === "message_id" || column.name === "aggregate_id"
    );
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${quoteSQLiteIdentifier(table)})`).all() as Array<Record<string, unknown>>;
    const relatesToHistory = foreignKeys.some((row) => typeof row.table === "string" && knownHistory.has(row.table));
    if (looksOwned || relatesToHistory) result.push(table);
  }
  return result;
}

export function inspectOpenCodeHistorySchema(database: DatabaseSync): OpenCodeHistorySchema {
  const names = tableNames(database);
  for (const table of REQUIRED_TABLES) {
    if (!names.has(table)) throw new Error(`OpenCode database lacks required history capability: ${table}`);
  }
  const unknown = unknownHistoryRelations(database, names);
  if (unknown.length !== 0) {
    throw new Error(`OpenCode database has unclassified session relations: ${unknown.join(", ")}`);
  }
  const tables: OpenCodeTableSchema[] = [];
  for (const table of OPENCODE_HISTORY_TABLES) {
    if (!names.has(table)) continue;
    const columns = inspectColumns(database, table);
    const columnNames = new Set(columns.map((column) => column.name));
    for (const required of REQUIRED_COLUMNS[table] ?? []) {
      if (!columnNames.has(required)) {
        throw new Error(`OpenCode ${table} table lacks required history column: ${required}`);
      }
    }
    const keyColumns = TABLE_KEYS[table].filter((column) => columnNames.has(column));
    if (keyColumns.length === 0) throw new Error(`OpenCode ${table} table has no stable history key`);
    tables.push({ name: table, columns, keyColumns });
  }
  return { tables };
}

function journalHasEntries(
  database: DatabaseSync,
  table: string,
  idColumn: string,
  requiredColumns: readonly string[],
): boolean {
  const columns = new Set(inspectColumns(database, table).map((column) => column.name));
  for (const required of requiredColumns) {
    if (!columns.has(required)) {
      throw new Error(`target OpenCode migration journal is incompatible: ${table}.${required}`);
    }
  }
  return database.prepare(
    `SELECT 1 FROM ${quoteSQLiteIdentifier(table)} ` +
    `WHERE typeof(${quoteSQLiteIdentifier(idColumn)}) = 'text' ` +
    `AND trim(${quoteSQLiteIdentifier(idColumn)}) <> '' LIMIT 1`,
  ).get() !== undefined;
}

export function inspectOpenCodeImportTargetSchema(database: DatabaseSync): OpenCodeHistorySchema {
  const schema = inspectOpenCodeHistorySchema(database);
  const names = tableNames(database);
  const current = names.has("migration") && journalHasEntries(
    database,
    "migration",
    "id",
    ["id", "time_completed"],
  );
  if (current) return schema;
  const legacy = names.has("__drizzle_migrations") && journalHasEntries(
    database,
    "__drizzle_migrations",
    "name",
    ["name"],
  );
  if (!legacy) {
    throw new Error(
      "target OpenCode database is not initialized by OpenCode; initialize a clean OpenCode data directory before importing history",
    );
  }
  return schema;
}

function supportedInput(value: unknown): value is SQLInputValue {
  return value === null || typeof value === "number" || typeof value === "bigint" ||
    typeof value === "string" || value instanceof Uint8Array;
}

type RowFilter = (table: OpenCodeTableSchema, row: readonly SQLInputValue[]) => boolean;

function copyTable(
  source: DatabaseSync,
  destination: DatabaseSync,
  table: OpenCodeTableSchema,
  include: RowFilter,
): void {
  const names = table.columns.map((column) => quoteSQLiteIdentifier(column.name));
  destination.exec(`CREATE TABLE ${quoteSQLiteIdentifier(table.name)} (${names.join(", ")})`);
  const order = table.keyColumns.map((column) => quoteSQLiteIdentifier(column)).join(", ");
  const select = source.prepare(`SELECT ${names.join(", ")} FROM ${quoteSQLiteIdentifier(table.name)} ORDER BY ${order}`);
  select.setReadBigInts(true);
  select.setReturnArrays(true);
  const insert = destination.prepare(
    `INSERT INTO ${quoteSQLiteIdentifier(table.name)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  );
  for (const value of select.iterate() as Iterable<unknown>) {
    if (!Array.isArray(value) || value.length !== names.length || !value.every(supportedInput)) {
      throw new Error(`OpenCode ${table.name} returned an unsupported history row`);
    }
    if (include(table, value)) insert.run(...value);
  }
}

function writeOpenCodeHistoryDatabase(
  source: DatabaseSync,
  destinationPath: string,
  schema: OpenCodeHistorySchema,
  include: RowFilter,
): void {
  let destination: DatabaseSync | undefined;
  try {
    destination = new DatabaseSync(destinationPath, { enableForeignKeyConstraints: false });
    destination.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE _agenthist_format (schema_version TEXT NOT NULL);
      CREATE TABLE _agenthist_schema (
        table_name TEXT PRIMARY KEY,
        columns_json TEXT NOT NULL,
        key_columns_json TEXT NOT NULL
      );
      BEGIN IMMEDIATE;
    `);
    const metadata = destination.prepare(
      "INSERT INTO _agenthist_schema (table_name, columns_json, key_columns_json) VALUES (?, ?, ?)",
    );
    destination.prepare("INSERT INTO _agenthist_format (schema_version) VALUES (?)").run(OPENCODE_HISTORY_FORMAT);
    for (const table of schema.tables) {
      copyTable(source, destination, table, include);
      metadata.run(table.name, JSON.stringify(table.columns), JSON.stringify(table.keyColumns));
    }
    destination.exec("COMMIT");
  } catch (error) {
    if (destination?.isTransaction) destination.exec("ROLLBACK");
    throw error;
  } finally {
    destination?.close();
  }
}

function writeOpenCodeHistoryRows(
  destinationPath: string,
  schema: OpenCodeHistorySchema,
  rows: ReadonlyMap<OpenCodeHistoryTable, readonly (readonly SQLInputValue[])[]>,
): void {
  let destination: DatabaseSync | undefined;
  try {
    destination = new DatabaseSync(destinationPath, { enableForeignKeyConstraints: false });
    destination.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE _agenthist_format (schema_version TEXT NOT NULL);
      CREATE TABLE _agenthist_schema (
        table_name TEXT PRIMARY KEY,
        columns_json TEXT NOT NULL,
        key_columns_json TEXT NOT NULL
      );
      BEGIN IMMEDIATE;
    `);
    destination.prepare("INSERT INTO _agenthist_format (schema_version) VALUES (?)").run(OPENCODE_HISTORY_FORMAT);
    const metadata = destination.prepare(
      "INSERT INTO _agenthist_schema (table_name, columns_json, key_columns_json) VALUES (?, ?, ?)",
    );
    for (const table of schema.tables) {
      const names = table.columns.map((column) => quoteSQLiteIdentifier(column.name));
      const definitions = table.columns.map((column, index) => {
        const declared = column.declaredType.toUpperCase();
        const affinity = declared.includes("INT")
          ? "INTEGER"
          : declared.includes("CHAR") || declared.includes("CLOB") || declared.includes("TEXT")
            ? "TEXT"
            : declared.includes("REAL") || declared.includes("FLOA") || declared.includes("DOUB")
              ? "REAL"
              : declared === "" || declared.includes("BLOB")
                ? "BLOB"
                : "NUMERIC";
        return `${names[index]!} ${affinity}`;
      });
      destination.exec(`CREATE TABLE ${quoteSQLiteIdentifier(table.name)} (${definitions.join(", ")})`);
      metadata.run(table.name, JSON.stringify(table.columns), JSON.stringify(table.keyColumns));
      const insert = destination.prepare(
        `INSERT INTO ${quoteSQLiteIdentifier(table.name)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      );
      for (const row of rows.get(table.name) ?? []) {
        if (row.length !== names.length || !row.every(supportedInput)) {
          throw new Error(`OpenCode ${table.name} projected row is invalid`);
        }
        insert.run(...row);
      }
    }
    destination.exec("COMMIT");
  } catch (error) {
    if (destination?.isTransaction) destination.exec("ROLLBACK");
    throw error;
  } finally {
    destination?.close();
  }
}

export function createOpenCodeHistoryDatabase(sourcePath: string, destinationPath: string): OpenCodeHistorySchema {
  const source = new DatabaseSync(sourcePath, { readOnly: true, readBigInts: true, timeout: 5_000 });
  try {
    const schema = inspectOpenCodeHistorySchema(source);
    writeOpenCodeHistoryDatabase(source, destinationPath, schema, () => true);
    return schema;
  } finally {
    source.close();
  }
}

function parsePersistedColumns(value: unknown, table: string): OpenCodeColumn[] {
  if (typeof value !== "string") throw new Error(`OpenCode history schema is invalid: ${table}`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`OpenCode history schema is invalid: ${table}`); }
  if (!Array.isArray(parsed)) throw new Error(`OpenCode history schema is invalid: ${table}`);
  const result: OpenCodeColumn[] = [];
  for (const item of parsed) {
    if (
      item === null || typeof item !== "object" || Array.isArray(item) ||
      typeof (item as Record<string, unknown>).name !== "string" ||
      typeof (item as Record<string, unknown>).declaredType !== "string" ||
      typeof (item as Record<string, unknown>).notNull !== "boolean" ||
      typeof (item as Record<string, unknown>).primaryKeyOrder !== "number"
    ) {
      throw new Error(`OpenCode history schema is invalid: ${table}`);
    }
    const record = item as Record<string, unknown>;
    quoteSQLiteIdentifier(record.name as string);
    result.push({
      name: record.name as string,
      declaredType: record.declaredType as string,
      notNull: record.notNull as boolean,
      defaultValue: record.defaultValue,
      primaryKeyOrder: record.primaryKeyOrder as number,
    });
  }
  return result;
}

export function readOpenCodeHistorySchema(database: DatabaseSync): OpenCodeHistorySchema {
  const format = database.prepare("SELECT schema_version FROM _agenthist_format").all() as Array<Record<string, unknown>>;
  if (format.length !== 1 || format[0]?.schema_version !== OPENCODE_HISTORY_FORMAT) {
    throw new Error("OpenCode history database format is unsupported");
  }
  const rows = database.prepare(
    "SELECT table_name, columns_json, key_columns_json FROM _agenthist_schema ORDER BY table_name",
  ).all() as Array<Record<string, unknown>>;
  const tables: OpenCodeTableSchema[] = [];
  for (const row of rows) {
    if (typeof row.table_name !== "string" || !OPENCODE_HISTORY_TABLES.includes(row.table_name as OpenCodeHistoryTable)) {
      throw new Error("OpenCode history database declares an unsupported table");
    }
    const columns = parsePersistedColumns(row.columns_json, row.table_name);
    let keys: unknown;
    try { keys = JSON.parse(String(row.key_columns_json)); } catch { throw new Error(`OpenCode history schema is invalid: ${row.table_name}`); }
    if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string" && columns.some((column) => column.name === key))) {
      throw new Error(`OpenCode history schema is invalid: ${row.table_name}`);
    }
    const actual = inspectColumns(database, row.table_name);
    if (actual.map((column) => column.name).join("\0") !== columns.map((column) => column.name).join("\0")) {
      throw new Error(`OpenCode history table columns disagree: ${row.table_name}`);
    }
    tables.push({ name: row.table_name as OpenCodeHistoryTable, columns, keyColumns: keys });
  }
  const names = tableNames(database);
  const declared = new Set(tables.map((table) => table.name));
  if (
    names.size !== declared.size + 2 || !names.has("_agenthist_format") || !names.has("_agenthist_schema") ||
    [...declared].some((table) => !names.has(table))
  ) {
    throw new Error("OpenCode history database contains an undeclared table");
  }
  for (const required of REQUIRED_TABLES) {
    if (!declared.has(required as OpenCodeHistoryTable)) {
      throw new Error(`OpenCode history database lacks required table: ${required}`);
    }
  }
  return { tables };
}

export function openCodeStringColumn(
  row: readonly SQLInputValue[],
  columns: readonly OpenCodeColumn[],
  name: string,
): string | undefined {
  const index = columns.findIndex((column) => column.name === name);
  const value = index < 0 ? undefined : row[index];
  return typeof value === "string" ? value : undefined;
}

export function readOpenCodeTableRows(database: DatabaseSync, table: OpenCodeTableSchema): SQLInputValue[][] {
  const columns = table.columns.map((column) => quoteSQLiteIdentifier(column.name));
  const order = table.keyColumns.map((column) => quoteSQLiteIdentifier(column)).join(", ");
  const statement = database.prepare(
    `SELECT ${columns.join(", ")} FROM ${quoteSQLiteIdentifier(table.name)} ORDER BY ${order}`,
  );
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  const result: SQLInputValue[][] = [];
  for (const value of statement.iterate() as Iterable<unknown>) {
    if (!Array.isArray(value) || value.length !== columns.length || !value.every(supportedInput)) {
      throw new Error(`OpenCode ${table.name} contains an unsupported history row`);
    }
    result.push(value);
  }
  return result;
}

export function openCodeTableSchema(
  schema: OpenCodeHistorySchema,
  name: OpenCodeHistoryTable,
): OpenCodeTableSchema | undefined {
  return schema.tables.find((table) => table.name === name);
}

export function openCodePendingInputStatuses(
  database: DatabaseSync,
  schema: OpenCodeHistorySchema,
): ReadonlyMap<string, OpenCodePendingInputStatus> {
  const table = openCodeTableSchema(schema, "session_input");
  if (table === undefined) return new Map();
  const promotedIndex = table.columns.findIndex((column) => column.name === "promoted_seq");
  const statuses = new Map<string, OpenCodePendingInputStatus>();
  for (const row of readOpenCodeTableRows(database, table)) {
    const sessionId = openCodeStringColumn(row, table.columns, "session_id");
    if (sessionId === undefined) continue;
    const promoted = promotedIndex < 0 ? undefined : row[promotedIndex];
    const observed: OpenCodePendingInputStatus = promoted === null
      ? "present"
      : (typeof promoted === "bigint" && promoted >= 0n) ||
          (typeof promoted === "number" && Number.isSafeInteger(promoted) && promoted >= 0)
        ? "empty"
        : "unknown";
    const current = statuses.get(sessionId) ?? "empty";
    statuses.set(
      sessionId,
      current === "present" || observed === "present"
        ? "present"
        : current === "unknown" || observed === "unknown"
          ? "unknown"
          : "empty",
    );
  }
  return statuses;
}

export function openCodeRevertStatuses(
  database: DatabaseSync,
  schema: OpenCodeHistorySchema,
): ReadonlyMap<string, OpenCodeRevertStatus> {
  const table = openCodeTableSchema(schema, "session")!;
  const revertIndex = table.columns.findIndex((column) => column.name === "revert");
  if (revertIndex < 0) return new Map();
  const statuses = new Map<string, OpenCodeRevertStatus>();
  for (const row of readOpenCodeTableRows(database, table)) {
    const sessionId = openCodeStringColumn(row, table.columns, "id");
    if (sessionId === undefined) continue;
    const value = row[revertIndex];
    if (value === null) {
      statuses.set(sessionId, "empty");
      continue;
    }
    if (typeof value !== "string") {
      statuses.set(sessionId, "unknown");
      continue;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch {
      statuses.set(sessionId, "unknown");
      continue;
    }
    if (parsed === null) {
      statuses.set(sessionId, "empty");
      continue;
    }
    const record = typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
    statuses.set(sessionId, typeof record?.messageID === "string" && record.messageID !== "" ? "present" : "unknown");
  }
  return statuses;
}

export function validateOpenCodeHistoryDatabase(database: DatabaseSync): OpenCodeHistorySchema {
  const integrity = database.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
  if (integrity?.integrity_check !== "ok") throw new Error("OpenCode history database failed integrity check");
  const schema = readOpenCodeHistorySchema(database);
  const sessionTable = openCodeTableSchema(schema, "session")!;
  const projectTable = openCodeTableSchema(schema, "project")!;
  const messageTable = openCodeTableSchema(schema, "message")!;
  const partTable = openCodeTableSchema(schema, "part")!;
  const sessionRows = readOpenCodeTableRows(database, sessionTable);
  const sessionIds = new Set<string>();
  const parents = new Map<string, string>();
  const projectIds = new Set<string>();
  for (const row of readOpenCodeTableRows(database, projectTable)) {
    const id = openCodeStringColumn(row, projectTable.columns, "id");
    if (id === undefined || projectIds.has(id)) throw new Error("OpenCode history contains an invalid or duplicate project ID");
    projectIds.add(id);
  }
  for (const row of sessionRows) {
    const id = openCodeStringColumn(row, sessionTable.columns, "id");
    const projectId = openCodeStringColumn(row, sessionTable.columns, "project_id");
    const parentId = openCodeStringColumn(row, sessionTable.columns, "parent_id");
    if (id === undefined || sessionIds.has(id)) throw new Error("OpenCode history contains an invalid or duplicate session ID");
    if (projectId === undefined || !projectIds.has(projectId)) throw new Error(`OpenCode history session has no project: ${id}`);
    sessionIds.add(id);
    if (parentId !== undefined) parents.set(id, parentId);
  }
  for (const [id, parent] of parents) {
    if (parent === id || !sessionIds.has(parent)) throw new Error(`OpenCode history session parent is invalid: ${id}`);
    const visited = new Set([id]);
    let current: string | undefined = parent;
    while (current !== undefined) {
      if (visited.has(current)) throw new Error(`OpenCode history session parent cycle includes: ${id}`);
      visited.add(current);
      current = parents.get(current);
    }
  }
  const messageIds = new Map<string, string>();
  for (const row of readOpenCodeTableRows(database, messageTable)) {
    const id = openCodeStringColumn(row, messageTable.columns, "id");
    const sessionId = openCodeStringColumn(row, messageTable.columns, "session_id");
    if (id === undefined || sessionId === undefined || messageIds.has(id) || !sessionIds.has(sessionId)) {
      throw new Error("OpenCode history contains an unreachable message");
    }
    messageIds.set(id, sessionId);
  }
  const partIds = new Set<string>();
  for (const row of readOpenCodeTableRows(database, partTable)) {
    const id = openCodeStringColumn(row, partTable.columns, "id");
    const messageId = openCodeStringColumn(row, partTable.columns, "message_id");
    const sessionId = openCodeStringColumn(row, partTable.columns, "session_id");
    if (
      id === undefined || messageId === undefined || sessionId === undefined || partIds.has(id) ||
      messageIds.get(messageId) !== sessionId
    ) {
      throw new Error("OpenCode history contains an unreachable part");
    }
    partIds.add(id);
  }
  const ownedTables: Array<[OpenCodeHistoryTable, string]> = [
    ["todo", "session_id"],
    ["session_context_epoch", "session_id"],
    ["session_input", "session_id"],
    ["session_message", "session_id"],
    ["event_sequence", "aggregate_id"],
  ];
  for (const [name, ownerColumn] of ownedTables) {
    const table = openCodeTableSchema(schema, name);
    if (table === undefined) continue;
    for (const row of readOpenCodeTableRows(database, table)) {
      const owner = openCodeStringColumn(row, table.columns, ownerColumn);
      if (owner === undefined || !sessionIds.has(owner)) throw new Error(`OpenCode history ${name} row is unreachable`);
    }
  }
  const eventTable = openCodeTableSchema(schema, "event");
  const sequenceTable = openCodeTableSchema(schema, "event_sequence");
  if (eventTable !== undefined) {
    if (sequenceTable === undefined) throw new Error("OpenCode history events have no sequence table");
    const aggregates = new Set(
      readOpenCodeTableRows(database, sequenceTable).map((row) => openCodeStringColumn(row, sequenceTable.columns, "aggregate_id")),
    );
    for (const row of readOpenCodeTableRows(database, eventTable)) {
      const aggregate = openCodeStringColumn(row, eventTable.columns, "aggregate_id");
      if (aggregate === undefined || !aggregates.has(aggregate)) throw new Error("OpenCode history event is unreachable");
    }
  }
  return schema;
}

export function createOpenCodeFilteredDatabase(
  sourcePath: string,
  destinationPath: string,
  selectedSessionIds: ReadonlySet<string>,
): OpenCodeHistorySchema {
  if (selectedSessionIds.size === 0) throw new Error("OpenCode export selection is empty");
  const source = new DatabaseSync(sourcePath, { readOnly: true, readBigInts: true });
  try {
    const schema = validateOpenCodeHistoryDatabase(source);
    const pendingInputs = openCodePendingInputStatuses(source, schema);
    const reverts = openCodeRevertStatuses(source, schema);
    for (const sessionId of selectedSessionIds) {
      const status = pendingInputs.get(sessionId) ?? "empty";
      if (status === "present") throw new Error(`OpenCode session has pending input: ${sessionId}`);
      if (status === "unknown") throw new Error(`OpenCode session input state cannot be classified: ${sessionId}`);
      const revert = reverts.get(sessionId) ?? "empty";
      if (revert === "present") throw new Error(`OpenCode session has an active revert: ${sessionId}`);
      if (revert === "unknown") throw new Error(`OpenCode session revert state cannot be classified: ${sessionId}`);
    }
    const sessionTable = openCodeTableSchema(schema, "session")!;
    const messageTable = openCodeTableSchema(schema, "message")!;
    const selectedProjects = new Set<string>();
    const observedSessions = new Set<string>();
    for (const row of readOpenCodeTableRows(source, sessionTable)) {
      const id = openCodeStringColumn(row, sessionTable.columns, "id");
      if (id === undefined || !selectedSessionIds.has(id)) continue;
      observedSessions.add(id);
      const project = openCodeStringColumn(row, sessionTable.columns, "project_id");
      if (project !== undefined) selectedProjects.add(project);
    }
    if (observedSessions.size !== selectedSessionIds.size) throw new Error("OpenCode export selection is not present in captured history");
    const selectedMessages = new Set<string>();
    for (const row of readOpenCodeTableRows(source, messageTable)) {
      const session = openCodeStringColumn(row, messageTable.columns, "session_id");
      const id = openCodeStringColumn(row, messageTable.columns, "id");
      if (session !== undefined && selectedSessionIds.has(session) && id !== undefined) selectedMessages.add(id);
    }
    const include: RowFilter = (table, row) => {
      switch (table.name) {
        case "session":
        case "event_sequence":
        case "session_context_epoch":
        case "todo":
          return selectedSessionIds.has(openCodeStringColumn(row, table.columns, table.name === "event_sequence" ? "aggregate_id" : "session_id") ??
            openCodeStringColumn(row, table.columns, "id") ?? "");
        case "message":
        case "session_input":
        case "session_message":
          return selectedSessionIds.has(openCodeStringColumn(row, table.columns, "session_id") ?? "");
        case "event":
          return selectedSessionIds.has(openCodeStringColumn(row, table.columns, "aggregate_id") ?? "");
        case "part":
          return selectedSessionIds.has(openCodeStringColumn(row, table.columns, "session_id") ?? "") ||
            selectedMessages.has(openCodeStringColumn(row, table.columns, "message_id") ?? "");
        case "project":
          return selectedProjects.has(openCodeStringColumn(row, table.columns, "id") ?? "");
      }
      return false;
    };
    writeOpenCodeHistoryDatabase(source, destinationPath, schema, include);
    const destination = new DatabaseSync(destinationPath, { readOnly: true, readBigInts: true });
    try { validateOpenCodeHistoryDatabase(destination); } finally { destination.close(); }
    return schema;
  } finally {
    source.close();
  }
}

function primaryColumns(table: OpenCodeTableSchema): string[] {
  return table.columns
    .filter((column) => column.primaryKeyOrder > 0)
    .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder)
    .map((column) => column.name);
}

function convertedRequiredValue(
  table: OpenCodeHistoryTable,
  column: string,
  source: ReadonlyMap<string, SQLInputValue>,
): SQLInputValue {
  if (table === "project") {
    const values: Readonly<Record<string, SQLInputValue>> = {
      worktree: "/",
      vcs: "",
      name: "AgentHist converted",
      icon_url: "",
      icon_url_override: "",
      icon_color: "",
      time_created: 0,
      time_updated: 0,
      time_initialized: 0,
      sandboxes: "[]",
      commands: "[]",
    };
    if (Object.hasOwn(values, column)) return values[column]!;
  }
  if (table === "session") {
    const id = source.get("id");
    const values: Readonly<Record<string, SQLInputValue>> = {
      slug: typeof id === "string" ? `agenthist-${id.slice("ses_agenthist_".length)}` : "agenthist-converted",
      summary_additions: 0,
      summary_deletions: 0,
      summary_files: 0,
      summary_diffs: "[]",
      metadata: "{}",
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      revert: "null",
      permission: "[]",
      agent: "build",
    };
    if (Object.hasOwn(values, column)) return values[column]!;
  }
  throw new Error(`target OpenCode ${table} requires unavailable converted column: ${column}`);
}

function conversionTarget(
  database: DatabaseSync,
): { readonly schema: OpenCodeHistorySchema; readonly internal: boolean } {
  const names = tableNames(database);
  const internal = names.has("_agenthist_format") || names.has("_agenthist_schema");
  // Filtered archive databases persist native constraints as metadata; their physical tables are transport-only.
  return {
    schema: internal ? validateOpenCodeHistoryDatabase(database) : inspectOpenCodeHistorySchema(database),
    internal,
  };
}

function convertedMissingValue(
  table: OpenCodeHistoryTable,
  column: OpenCodeColumn,
  source: ReadonlyMap<string, SQLInputValue>,
): SQLInputValue {
  try {
    return convertedRequiredValue(table, column.name, source);
  } catch (error) {
    if (!column.notNull) return null;
    throw error;
  }
}

export function materializeOpenCodeConversionDatabase(
  sourcePath: string,
  targetPath: string,
  destinationPath: string,
): void {
  const source = new DatabaseSync(sourcePath, { readOnly: true, readBigInts: true });
  const target = new DatabaseSync(targetPath, { readOnly: true, readBigInts: true, timeout: 5_000 });
  try {
    const sourceSchema = validateOpenCodeHistoryDatabase(source);
    const targetDescription = conversionTarget(target);
    const targetSchema = targetDescription.schema;
    const expected = new Set<OpenCodeHistoryTable>(["project", "session", "message", "part"]);
    if (
      sourceSchema.tables.length !== expected.size ||
      sourceSchema.tables.some((table) => !expected.has(table.name))
    ) throw new Error("converted OpenCode archive has an unsupported table closure");

    const projectedTables: OpenCodeTableSchema[] = [];
    const projectedRows = new Map<OpenCodeHistoryTable, readonly (readonly SQLInputValue[])[]>();
    for (const sourceTable of sourceSchema.tables) {
      const targetTable = openCodeTableSchema(targetSchema, sourceTable.name);
      if (targetTable === undefined) throw new Error(`target OpenCode database lacks history table: ${sourceTable.name}`);
      const targetByName = new Map(targetTable.columns.map((column) => [column.name, column]));
      if (sourceTable.columns.some((column) => !targetByName.has(column.name))) {
        throw new Error(`target OpenCode ${sourceTable.name} lacks a converted history column`);
      }
      if (primaryColumns(sourceTable).join("\0") !== primaryColumns(targetTable).join("\0")) {
        throw new Error(`target OpenCode ${sourceTable.name} primary key capability differs`);
      }
      const sourceNames = new Set(sourceTable.columns.map((column) => column.name));
      const additions = targetTable.columns.filter((column) =>
        !sourceNames.has(column.name) && column.notNull && column.defaultValue === null && column.primaryKeyOrder === 0
      );
      const columns = targetDescription.internal ? targetTable.columns : [...sourceTable.columns, ...additions];
      const sourceIndexes = new Map(sourceTable.columns.map((column, index) => [column.name, index]));
      const rows = readOpenCodeTableRows(source, sourceTable).map((row) => {
        const fields = new Map(sourceTable.columns.map((column, index) => [column.name, row[index]!]));
        let sharedProject: Record<string, unknown> | undefined;
        if (sourceTable.name === "project") {
          const id = fields.get("id");
          if (typeof id === "string") {
            sharedProject = target.prepare("SELECT * FROM project WHERE id = ?").get(id) as Record<string, unknown> | undefined;
          }
        }
        return columns.map((column) => {
          if (sourceTable.name === "project" && sharedProject !== undefined &&
            Object.hasOwn(sharedProject, column.name)) {
            const shared = sharedProject[column.name];
            if (!supportedInput(shared)) {
              throw new Error(`target OpenCode project has an unsupported column value: ${column.name}`);
            }
            return shared;
          }
          const index = sourceIndexes.get(column.name);
          return index === undefined
            ? convertedMissingValue(sourceTable.name, column, fields)
            : row[index]!;
        });
      });
      projectedTables.push(targetDescription.internal ? targetTable : { ...sourceTable, columns });
      projectedRows.set(sourceTable.name, rows);
    }
    if (targetDescription.internal) {
      for (const targetTable of targetSchema.tables) {
        if (projectedRows.has(targetTable.name)) continue;
        projectedTables.push(targetTable);
        projectedRows.set(targetTable.name, []);
      }
    }
    writeOpenCodeHistoryRows(destinationPath, { tables: projectedTables }, projectedRows);
    const projected = new DatabaseSync(destinationPath, { readOnly: true, readBigInts: true });
    try { validateOpenCodeHistoryDatabase(projected); } finally { projected.close(); }
  } finally {
    target.close();
    source.close();
  }
}

function sqliteIdentity(value: SQLInputValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "bigint") return `i:${value.toString()}`;
  if (typeof value === "number") return `n:${String(value)}`;
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return `b:${Buffer.from(bytes).toString("hex")}`;
}

export function mergeOpenCodeHistoryDatabases(
  sourcePaths: readonly string[],
  destinationPath: string,
): void {
  if (sourcePaths.length === 0) throw new Error("OpenCode import has no history database to merge");
  const databases = sourcePaths.map((sourcePath) =>
    new DatabaseSync(sourcePath, { readOnly: true, readBigInts: true }));
  try {
    const schemas = databases.map((database) => validateOpenCodeHistoryDatabase(database));
    const schema = schemas[0]!;
    if (schemas.some((candidate) => !isDeepStrictEqual(candidate, schema))) {
      throw new Error("OpenCode import history closures have different schemas");
    }
    const rows = new Map<OpenCodeHistoryTable, readonly (readonly SQLInputValue[])[]>();
    for (const table of schema.tables) {
      const keyIndexes = table.keyColumns.map((name) => {
        const index = table.columns.findIndex((column) => column.name === name);
        if (index < 0) throw new Error(`OpenCode ${table.name} key column is unavailable: ${name}`);
        return index;
      });
      const merged = new Map<string, readonly SQLInputValue[]>();
      for (const database of databases) {
        for (const row of readOpenCodeTableRows(database, table)) {
          const key = keyIndexes.map((index) => sqliteIdentity(row[index]!)).join("\0");
          const existing = merged.get(key);
          if (existing !== undefined && !isDeepStrictEqual(existing, row)) {
            throw new Error(`OpenCode ${table.name} identity collides across import routes`);
          }
          merged.set(key, row);
        }
      }
      rows.set(table.name, [...merged.values()]);
    }
    writeOpenCodeHistoryRows(destinationPath, schema, rows);
    const destination = new DatabaseSync(destinationPath, { readOnly: true, readBigInts: true });
    try { validateOpenCodeHistoryDatabase(destination); } finally { destination.close(); }
  } finally {
    for (const database of databases) database.close();
  }
}
