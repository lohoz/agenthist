import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { AgentSnapshot, StoredSession } from "../../domain/history.js";
import { copyStableFile } from "../../infrastructure/files.js";
import { backupSQLiteDatabase } from "../../infrastructure/sqlite.js";
import {
  createSnapshotWorkspace,
  discardSnapshot,
  ensureStateDirectory,
  loadSnapshot,
  publishSnapshot,
  type SnapshotWorkspace,
} from "../../infrastructure/history-store.js";
import {
  incrementalSourceKey,
  reusableSessionMap,
  scanState,
} from "../incremental-scan.js";
import { createOpenCodeHistoryDatabase } from "./storage/database.js";
import { discoverOpenCodePlans, sameOpenCodePlans } from "./plan.js";
import { OPENCODE_HISTORY_DATABASE_RELATIVE_PATH, readOpenCodeHistory } from "./history/reader.js";
import { requireOpenCodeSource, resolveOpenCodeSource, type OpenCodeSourceOptions } from "./source.js";
import { captureOpenCodeToolOutputs, loadOpenCodeToolOutputResources } from "./tool-output.js";

export interface ScanOpenCodeOptions extends OpenCodeSourceOptions {
  readonly stateDirectory: string;
  readonly importedLibrary?: ReadonlyMap<string, StoredSession["library"]>;
}

export interface ScanOpenCodeResult {
  readonly stateDirectory: string;
  readonly snapshot: AgentSnapshot;
}

interface SidecarCandidate {
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly fingerprint: string;
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function discoverSessionDiff(dataRoot: string): Promise<SidecarCandidate[]> {
  const root = path.join(dataRoot, "storage", "session_diff");
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`OpenCode session_diff carrier is not a real directory: ${root}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: SidecarCandidate[] = [];
  const pending = [root];
  while (pending.length !== 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`OpenCode session_diff contains a symbolic link: ${sourcePath}`);
      if (entry.isDirectory()) {
        pending.push(sourcePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`OpenCode session_diff contains an unsupported entry: ${sourcePath}`);
      const info = await lstat(sourcePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`OpenCode session_diff file changed shape: ${sourcePath}`);
      result.push({
        sourcePath,
        relativePath: portablePath(path.join("opencode", "session_diff", path.relative(root, sourcePath))),
        fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
      });
    }
  }
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function sameSidecars(left: readonly SidecarCandidate[], right: readonly SidecarCandidate[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined && item.relativePath === other.relativePath && item.fingerprint === other.fingerprint;
  });
}

async function captureOpenCode(
  options: ScanOpenCodeOptions,
  workspace: SnapshotWorkspace,
  previous: AgentSnapshot | undefined,
  sourceKey: string,
): Promise<{
  sessions: readonly StoredSession[];
  auxiliaryFiles: readonly string[];
  warnings: readonly string[];
  reusedSessions: number;
}> {
  const source = resolveOpenCodeSource(options);
  const before = await discoverSessionDiff(source.dataRoot);
  const acquisition = path.join(workspace.root, ".acquisition.sqlite");
  const historyDatabase = path.join(workspace.rawRoot, ...OPENCODE_HISTORY_DATABASE_RELATIVE_PATH.split("/"));
  await backupSQLiteDatabase(source.databasePath, acquisition);
  try {
    await mkdir(path.dirname(historyDatabase), { recursive: true, mode: 0o700 });
    createOpenCodeHistoryDatabase(acquisition, historyDatabase);
  } finally {
    await rm(acquisition, { force: true });
  }
  for (const sidecar of before) {
    await copyStableFile(sidecar.sourcePath, path.join(workspace.rawRoot, ...sidecar.relativePath.split("/")));
  }
  const plansBefore = await discoverOpenCodePlans(historyDatabase, source.dataRoot);
  for (const plan of plansBefore.files) {
    await copyStableFile(plan.nativePath, path.join(workspace.rawRoot, ...plan.relativePath.split("/")));
  }
  const after = await discoverSessionDiff(source.dataRoot);
  if (!sameSidecars(before, after)) throw new Error("OpenCode session_diff changed while scanning");
  const plansAfter = await discoverOpenCodePlans(historyDatabase, source.dataRoot);
  if (!sameOpenCodePlans(plansBefore.files, plansAfter.files)) {
    throw new Error("OpenCode session plan changed while scanning");
  }
  const sidecarFiles = before.map((item) => item.relativePath);
  const planFiles = new Map(plansBefore.files.map((item) => [item.nativeId, item.relativePath]));
  const toolOutputs = await captureOpenCodeToolOutputs(historyDatabase, source.dataRoot, workspace.rawRoot);
  const toolOutputResources = await loadOpenCodeToolOutputResources(
    toolOutputs.bySession,
    (relativePath) => path.join(workspace.rawRoot, ...relativePath.split("/")),
  );
  const previousSessions = reusableSessionMap(previous, sourceKey);
  const previousLibrary = new Map(previous?.sessions.map((session) => [session.sessionRef, session.library]));
  const read = readOpenCodeHistory({
    databasePath: historyDatabase,
    databaseRelativePath: OPENCODE_HISTORY_DATABASE_RELATIVE_PATH,
    sidecarFiles,
    planFiles,
    toolOutputs: toolOutputs.bySession,
    toolOutputResources: toolOutputResources.byNativePath,
    previousLibrary,
    previousSessions,
    nonReusableSessions: new Set(toolOutputs.bySession.keys()),
    ...(options.importedLibrary === undefined ? {} : { importedLibrary: options.importedLibrary }),
  });
  const warnings = [...read.warnings, ...toolOutputs.warnings, ...toolOutputResources.warnings];
  const assignedSidecars = sidecarFiles.length - read.unassignedSidecars.length;
  if (assignedSidecars !== 0) {
    warnings.push(
      `captured ${assignedSidecars} OpenCode session_diff file(s) with canonical session ownership`,
    );
  }
  if (read.unassignedSidecars.length !== 0) warnings.push(
    `captured ${read.unassignedSidecars.length} OpenCode session_diff file(s) with unknown ownership; all sessions remain blocked`,
  );
  if (!plansBefore.supported) {
    warnings.push("OpenCode session plan ownership capability is unavailable; plan files were not captured");
  } else if (plansBefore.files.length !== 0) {
    warnings.push(`captured ${plansBefore.files.length} OpenCode session plan file(s)`);
  }
  return {
    sessions: read.sessions,
    auxiliaryFiles: [
      OPENCODE_HISTORY_DATABASE_RELATIVE_PATH,
      ...sidecarFiles,
      ...plansBefore.files.map((item) => item.relativePath),
      ...toolOutputs.capturedFiles,
    ],
    warnings,
    reusedSessions: read.reusedSessions,
  };
}

export async function scanOpenCode(options: ScanOpenCodeOptions): Promise<ScanOpenCodeResult> {
  const source = resolveOpenCodeSource(options);
  await requireOpenCodeSource(source);
  await ensureStateDirectory(options.stateDirectory, [source.dataRoot, source.databasePath]);
  const previous = await loadSnapshot(options.stateDirectory, "opencode");
  const sourceKey = incrementalSourceKey("opencode", [source.dataRoot, source.databasePath]);
  const workspace = await createSnapshotWorkspace(options.stateDirectory, "opencode");
  try {
    const captured = await captureOpenCode(options, workspace, previous, sourceKey);
    const warnings = [...captured.warnings];
    const snapshot: AgentSnapshot = {
      schemaVersion: "agenthist.history-snapshot/v2",
      snapshotId: workspace.id,
      agent: "opencode",
      scannedAt: new Date().toISOString(),
      sessions: captured.sessions,
      auxiliaryFiles: captured.auxiliaryFiles,
      warnings,
      scan: scanState(
        sourceKey,
        previous,
        captured.sessions,
        captured.reusedSessions,
      ),
    };
    warnings.push(...await publishSnapshot(options.stateDirectory, workspace, snapshot));
    return { stateDirectory: options.stateDirectory, snapshot };
  } catch (error) {
    await discardSnapshot(workspace);
    throw error;
  }
}
