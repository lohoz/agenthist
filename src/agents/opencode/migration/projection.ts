import { lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  isAbsolutePath,
  joinPathSegments,
  relativePathSegments,
} from "../../../domain/host-path.js";
import {
  mapAbsolutePath,
  type PathMappings,
} from "../../../domain/path-mapping.js";
import { quoteSQLiteIdentifier } from "../../../infrastructure/sqlite.js";
import {
  inspectOpenCodeHistorySchema,
  openCodeStringColumn,
  openCodeTableSchema,
  readOpenCodeTableRows,
  validateOpenCodeHistoryDatabase,
} from "../storage/database.js";

const SESSION_INFO_FIELDS = new Set([
  "id",
  "slug",
  "projectID",
  "workspaceID",
  "directory",
  "path",
  "parentID",
  "summary",
  "cost",
  "tokens",
  "share",
  "title",
  "agent",
  "model",
  "version",
  "metadata",
  "time",
  "permission",
  "revert",
]);
const SESSION_EVENT_FIELDS = new Set(["sessionID", "info"]);
const MOVED_EVENT_FIELDS = new Set(["timestamp", "sessionID", "location", "subdirectory"]);
const LOCATION_FIELDS = new Set(["directory", "workspaceID"]);
const SESSION_INFO_EVENT_TYPES = new Set(["session.created.1", "session.updated.1", "session.deleted.1"]);
const MOVED_EVENT_TYPE = "session.next.moved.1";
const LOCATION_EVENT_TYPE = /^(session\.next\.moved|session\.(created|updated|deleted))(?:\.|$)/;

interface SessionLocationProjection {
  readonly id: string;
  readonly beforeDirectory: string;
  readonly afterDirectory: string;
  readonly beforePath: string | null;
  readonly afterPath: string | null;
  readonly beforeWorkspace: string | null;
  readonly afterWorkspace: string | null;
  readonly preserveEventWorkspace: boolean;
}

interface EventDataProjection {
  readonly id: string;
  readonly sessionId: string;
  readonly data: string;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") throw new Error(`${label} is not JSON text`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} is not valid JSON`); }
  return objectValue(parsed, label);
}

function requireOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown !== undefined) throw new Error(`${label} has an unsupported field: ${unknown}`);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} is not a string`);
  return value;
}

async function requireMappedDirectory(directory: string): Promise<void> {
  let info;
  try { info = await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`mapped OpenCode directory does not exist: ${directory}`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`mapped OpenCode directory is not a real directory: ${directory}`);
  }
}

function projectedSessionPath(
  beforeDirectory: string,
  afterDirectory: string,
  value: string | undefined,
  mappings: PathMappings,
): string | undefined {
  if (value === undefined || beforeDirectory === afterDirectory || value === ".") return value;
  if (value === beforeDirectory) return afterDirectory;
  if (value === beforeDirectory.slice(1)) return afterDirectory.slice(1);
  if (isAbsolutePath(value, mappings.sourceFlavor)) {
    const segments = relativePathSegments(beforeDirectory, value, mappings.sourceFlavor);
    if (segments !== undefined) return joinPathSegments(afterDirectory, segments, mappings.targetFlavor);
  }
  return value;
}

function projectEventDirectory(
  projection: SessionLocationProjection,
  value: string,
  mappings: PathMappings,
  label: string,
): string {
  return projection.beforeDirectory === projection.afterDirectory
    ? value
    : mapAbsolutePath(value, mappings, label);
}

function projectSessionInfoEvent(
  raw: unknown,
  projection: SessionLocationProjection,
  mappings: PathMappings,
  label: string,
): Record<string, unknown> | undefined {
  const data = parseObject(raw, label);
  requireOnlyFields(data, SESSION_EVENT_FIELDS, label);
  if (data.sessionID !== projection.id) throw new Error(`${label} has a different session ID`);
  const info = objectValue(data.info, `${label} info`);
  requireOnlyFields(info, SESSION_INFO_FIELDS, `${label} info`);
  if (info.id !== projection.id || typeof info.directory !== "string") {
    throw new Error(`${label} info has an invalid session location`);
  }
  const beforePath = optionalString(info.path, `${label} info path`);
  const beforeWorkspace = optionalString(info.workspaceID, `${label} info workspace`);
  const afterDirectory = projectEventDirectory(projection, info.directory, mappings, `${label} directory`);
  const afterPath = projectedSessionPath(info.directory, afterDirectory, beforePath, mappings);
  const detachWorkspace = !projection.preserveEventWorkspace && beforeWorkspace !== undefined;
  if (afterDirectory === info.directory && afterPath === beforePath && !detachWorkspace) return undefined;
  const projectedInfo: Record<string, unknown> = { ...info, directory: afterDirectory };
  if (afterPath === undefined) delete projectedInfo.path;
  else projectedInfo.path = afterPath;
  if (detachWorkspace) delete projectedInfo.workspaceID;
  return { ...data, info: projectedInfo };
}

function projectMovedEvent(
  raw: unknown,
  projection: SessionLocationProjection,
  mappings: PathMappings,
  label: string,
): Record<string, unknown> | undefined {
  const data = parseObject(raw, label);
  requireOnlyFields(data, MOVED_EVENT_FIELDS, label);
  if (data.sessionID !== projection.id || typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp)) {
    throw new Error(`${label} has invalid base fields`);
  }
  const location = objectValue(data.location, `${label} location`);
  requireOnlyFields(location, LOCATION_FIELDS, `${label} location`);
  if (typeof location.directory !== "string") throw new Error(`${label} has an invalid directory`);
  const beforeSubdirectory = optionalString(data.subdirectory, `${label} subdirectory`);
  const beforeWorkspace = optionalString(location.workspaceID, `${label} workspace`);
  const afterDirectory = projectEventDirectory(projection, location.directory, mappings, `${label} directory`);
  const afterSubdirectory = projectedSessionPath(location.directory, afterDirectory, beforeSubdirectory, mappings);
  const detachWorkspace = !projection.preserveEventWorkspace && beforeWorkspace !== undefined;
  if (
    afterDirectory === location.directory && afterSubdirectory === beforeSubdirectory && !detachWorkspace
  ) return undefined;
  const projectedLocation: Record<string, unknown> = { ...location, directory: afterDirectory };
  if (detachWorkspace) delete projectedLocation.workspaceID;
  const result: Record<string, unknown> = { ...data, location: projectedLocation };
  if (afterSubdirectory === undefined) delete result.subdirectory;
  else result.subdirectory = afterSubdirectory;
  return result;
}

function projectEventData(
  type: string,
  raw: unknown,
  projection: SessionLocationProjection,
  mappings: PathMappings,
  label: string,
): string | undefined {
  let projected: Record<string, unknown> | undefined;
  if (type === MOVED_EVENT_TYPE) {
    projected = projectMovedEvent(raw, projection, mappings, label);
  } else if (SESSION_INFO_EVENT_TYPES.has(type)) {
    projected = projectSessionInfoEvent(raw, projection, mappings, label);
  } else {
    if (LOCATION_EVENT_TYPE.test(type)) {
      throw new Error(`${label} uses an unsupported location event version: ${type}`);
    }
    return undefined;
  }
  return projected === undefined ? undefined : JSON.stringify(projected);
}

export async function projectOpenCodeTargetLocation(
  databasePath: string,
  targetPath: string,
  mappings: PathMappings,
): Promise<void> {
  const database = new DatabaseSync(databasePath, { readBigInts: true });
  const target = new DatabaseSync(targetPath, { readOnly: true, readBigInts: true, timeout: 5_000 });
  try {
    const schema = validateOpenCodeHistoryDatabase(database);
    const sessionTable = openCodeTableSchema(schema, "session")!;
    const targetTable = openCodeTableSchema(inspectOpenCodeHistorySchema(target), "session")!;
    const directoryIndex = sessionTable.columns.findIndex((column) => column.name === "directory");
    const pathIndex = sessionTable.columns.findIndex((column) => column.name === "path");
    const workspaceIndex = sessionTable.columns.findIndex((column) => column.name === "workspace_id");
    const targetWorkspaceIndex = targetTable.columns.findIndex((column) => column.name === "workspace_id");
    if (directoryIndex < 0 || pathIndex < 0) throw new Error("OpenCode session location capability is unavailable");
    const targetColumns = targetWorkspaceIndex < 0
      ? quoteSQLiteIdentifier("id")
      : `${quoteSQLiteIdentifier("id")}, ${quoteSQLiteIdentifier("workspace_id")}`;
    const targetSession = target.prepare(`SELECT ${targetColumns} FROM session WHERE id = ?`);
    const projections = new Map<string, SessionLocationProjection>();
    const checkedDirectories = new Set<string>();
    for (const row of readOpenCodeTableRows(database, sessionTable)) {
      const id = openCodeStringColumn(row, sessionTable.columns, "id");
      const beforeDirectory = openCodeStringColumn(row, sessionTable.columns, "directory");
      const beforePathValue = row[pathIndex];
      const beforeWorkspaceValue = workspaceIndex < 0 ? null : row[workspaceIndex];
      if (
        id === undefined || beforeDirectory === undefined ||
        (beforePathValue !== null && typeof beforePathValue !== "string") ||
        (beforeWorkspaceValue !== null && typeof beforeWorkspaceValue !== "string")
      ) throw new Error("OpenCode session location is invalid");
      const afterDirectory = mapAbsolutePath(beforeDirectory, mappings, "OpenCode session directory");
      if (afterDirectory !== beforeDirectory) {
        if (!checkedDirectories.has(afterDirectory)) {
          await requireMappedDirectory(afterDirectory);
          checkedDirectories.add(afterDirectory);
        }
      }
      const targetRow = targetSession.get(id) as Record<string, unknown> | undefined;
      const targetWorkspace = targetWorkspaceIndex < 0 ? null : targetRow?.workspace_id;
      if (
        targetRow !== undefined && targetWorkspaceIndex >= 0 &&
        targetWorkspace !== null && typeof targetWorkspace !== "string"
      ) throw new Error(`target OpenCode workspace binding is invalid: ${id}`);
      const beforeWorkspace = beforeWorkspaceValue as string | null;
      const preserveEventWorkspace = targetRow !== undefined && targetWorkspace === beforeWorkspace;
      const afterWorkspace = workspaceIndex < 0 || preserveEventWorkspace ? beforeWorkspace : null;
      const beforePath = beforePathValue as string | null;
      projections.set(id, {
        id,
        beforeDirectory,
        afterDirectory,
        beforePath,
        afterPath: projectedSessionPath(beforeDirectory, afterDirectory, beforePath ?? undefined, mappings) ?? null,
        beforeWorkspace,
        afterWorkspace,
        preserveEventWorkspace,
      });
    }

    const eventChanges: EventDataProjection[] = [];
    const transformedSessions = new Set<string>();
    const eventTable = openCodeTableSchema(schema, "event");
    if (eventTable !== undefined) {
      const idIndex = eventTable.columns.findIndex((column) => column.name === "id");
      const typeIndex = eventTable.columns.findIndex((column) => column.name === "type");
      const dataIndex = eventTable.columns.findIndex((column) => column.name === "data");
      if (idIndex < 0 || typeIndex < 0 || dataIndex < 0) {
        throw new Error("OpenCode durable event location capability is unavailable");
      }
      for (const row of readOpenCodeTableRows(database, eventTable)) {
        const id = row[idIndex];
        const sessionId = openCodeStringColumn(row, eventTable.columns, "aggregate_id");
        const type = row[typeIndex];
        if (typeof id !== "string" || sessionId === undefined || typeof type !== "string") {
          throw new Error("OpenCode durable event identity is invalid");
        }
        const projection = projections.get(sessionId);
        if (projection === undefined) throw new Error(`OpenCode durable event has no session: ${id}`);
        const data = projectEventData(type, row[dataIndex], projection, mappings, `OpenCode event ${id}`);
        if (data !== undefined) {
          eventChanges.push({ id, sessionId, data });
          transformedSessions.add(sessionId);
        }
      }
    }

    const sessionChanges = [...projections.values()].filter((projection) =>
      projection.beforeDirectory !== projection.afterDirectory ||
      projection.beforePath !== projection.afterPath ||
      projection.beforeWorkspace !== projection.afterWorkspace
    );
    for (const projection of sessionChanges) transformedSessions.add(projection.id);
    if (sessionChanges.length === 0 && eventChanges.length === 0) return;

    database.exec("BEGIN IMMEDIATE");
    try {
      const updateSession = workspaceIndex < 0
        ? database.prepare(
            `UPDATE session SET ${quoteSQLiteIdentifier("directory")} = ?, ${quoteSQLiteIdentifier("path")} = ? WHERE id = ?`,
          )
        : database.prepare(
            `UPDATE session SET ${quoteSQLiteIdentifier("directory")} = ?, ${quoteSQLiteIdentifier("path")} = ?, ` +
            `${quoteSQLiteIdentifier("workspace_id")} = ? WHERE id = ?`,
          );
      for (const projection of sessionChanges) {
        const result = workspaceIndex < 0
          ? updateSession.run(projection.afterDirectory, projection.afterPath, projection.id)
          : updateSession.run(projection.afterDirectory, projection.afterPath, projection.afterWorkspace, projection.id);
        if (result.changes !== 1 && result.changes !== 1n) {
          throw new Error(`OpenCode session changed during location projection: ${projection.id}`);
        }
      }
      if (eventChanges.length !== 0) {
        const updateEvent = database.prepare("UPDATE event SET data = ? WHERE id = ? AND aggregate_id = ?");
        for (const change of eventChanges) {
          const result = updateEvent.run(change.data, change.id, change.sessionId);
          if (result.changes !== 1 && result.changes !== 1n) {
            throw new Error(`OpenCode event changed during location projection: ${change.id}`);
          }
        }
      }
      if (transformedSessions.size !== 0 && openCodeTableSchema(schema, "session_context_epoch") !== undefined) {
        const removeContext = database.prepare("DELETE FROM session_context_epoch WHERE session_id = ?");
        for (const sessionId of transformedSessions) removeContext.run(sessionId);
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
