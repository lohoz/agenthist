import { lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  requireRealDirectory,
  requireSafeDirectoryParents,
} from "../../infrastructure/exclusive-file.js";
import {
  inspectOpenCodeHistorySchema,
  openCodeStringColumn,
  openCodeTableSchema,
  readOpenCodeTableRows,
  validateOpenCodeHistoryDatabase,
} from "./storage/database.js";

export interface OpenCodePlanLocation {
  readonly nativeId: string;
  readonly root: string;
  readonly nativePath: string;
  readonly relativePath: string;
}

export interface OpenCodePlanCandidate extends OpenCodePlanLocation {
  readonly fingerprint: string;
}

export interface OpenCodePlanLocations {
  readonly supported: boolean;
  readonly bySession: ReadonlyMap<string, OpenCodePlanLocation>;
}

function integer(value: SQLInputValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return undefined;
}

function validSlug(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." && path.basename(value) === value &&
    !value.includes("/") && !value.includes("\\") && !/[\u0000-\u001f\u007f]/.test(value) &&
    Buffer.byteLength(value, "utf8") <= 256;
}

export function readOpenCodePlanLocations(
  databasePath: string,
  dataRoot: string,
  format: "history" | "native",
): OpenCodePlanLocations {
  const database = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true, timeout: 5_000 });
  try {
    const schema = format === "history"
      ? validateOpenCodeHistoryDatabase(database)
      : inspectOpenCodeHistorySchema(database);
    const sessionTable = openCodeTableSchema(schema, "session")!;
    const projectTable = openCodeTableSchema(schema, "project")!;
    const slugIndex = sessionTable.columns.findIndex((column) => column.name === "slug");
    const createdIndex = sessionTable.columns.findIndex((column) => column.name === "time_created");
    const worktreeIndex = projectTable.columns.findIndex((column) => column.name === "worktree");
    const vcsIndex = projectTable.columns.findIndex((column) => column.name === "vcs");
    if (slugIndex < 0 || createdIndex < 0 || worktreeIndex < 0 || vcsIndex < 0) {
      return { supported: false, bySession: new Map() };
    }

    const projects = new Map<string, { readonly root: string; readonly projectPlans: boolean }>();
    for (const row of readOpenCodeTableRows(database, projectTable)) {
      const id = openCodeStringColumn(row, projectTable.columns, "id");
      const worktree = row[worktreeIndex];
      const vcs = row[vcsIndex];
      if (
        id === undefined || typeof worktree !== "string" || !path.isAbsolute(worktree) || path.resolve(worktree) !== worktree ||
        (vcs !== null && typeof vcs !== "string")
      ) throw new Error("OpenCode project plan location is invalid");
      projects.set(id, vcs === null || vcs === ""
        ? { root: path.resolve(dataRoot), projectPlans: false }
        : { root: worktree, projectPlans: true });
    }

    const bySession = new Map<string, OpenCodePlanLocation>();
    const destinations = new Set<string>();
    for (const row of readOpenCodeTableRows(database, sessionTable)) {
      const nativeId = openCodeStringColumn(row, sessionTable.columns, "id");
      const projectId = openCodeStringColumn(row, sessionTable.columns, "project_id");
      const slug = row[slugIndex];
      const created = integer(row[createdIndex]);
      const project = projectId === undefined ? undefined : projects.get(projectId);
      if (nativeId === undefined || project === undefined || typeof slug !== "string" || !validSlug(slug) || created === undefined) {
        throw new Error("OpenCode session plan identity is invalid");
      }
      const name = `${created}-${slug}.md`;
      const nativePath = project.projectPlans
        ? path.join(project.root, ".opencode", "plans", name)
        : path.join(project.root, "plans", name);
      if (destinations.has(nativePath)) throw new Error(`OpenCode session plan ownership is ambiguous: ${nativePath}`);
      destinations.add(nativePath);
      bySession.set(nativeId, {
        nativeId,
        root: project.root,
        nativePath,
        relativePath: `opencode/plan/${nativeId}.md`,
      });
    }
    return { supported: true, bySession };
  } finally {
    database.close();
  }
}

export async function discoverOpenCodePlans(
  databasePath: string,
  dataRoot: string,
): Promise<{ readonly supported: boolean; readonly files: readonly OpenCodePlanCandidate[] }> {
  const locations = readOpenCodePlanLocations(databasePath, dataRoot, "history");
  const files: OpenCodePlanCandidate[] = [];
  for (const location of locations.bySession.values()) {
    let info;
    try { info = await lstat(location.nativePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await requireRealDirectory(location.root, "OpenCode plan root");
    await requireSafeDirectoryParents(location.root, location.nativePath, "OpenCode session plan");
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`OpenCode session plan is not a regular file: ${location.nativePath}`);
    }
    files.push({
      ...location,
      fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
    });
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { supported: locations.supported, files };
}

export function sameOpenCodePlans(
  left: readonly OpenCodePlanCandidate[],
  right: readonly OpenCodePlanCandidate[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined && item.nativeId === other.nativeId && item.nativePath === other.nativePath &&
      item.relativePath === other.relativePath && item.fingerprint === other.fingerprint;
  });
}
