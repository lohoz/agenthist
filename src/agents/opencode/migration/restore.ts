import { backup, DatabaseSync } from "node:sqlite";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { ImportEntry } from "../../../domain/import.js";
import type { PathMappings } from "../../../domain/path-mapping.js";
import {
  exclusiveFileMatches,
  observeExclusiveFile,
  requireRealDirectory,
  requireSafeDirectoryParents,
  type ExclusiveFileImage,
} from "../../../infrastructure/exclusive-file.js";
import { digestFile } from "../../../infrastructure/files.js";
import {
  newManagedResourceEffects,
  planManagedResources,
  type ManagedResourcePlan,
} from "../../../infrastructure/managed-resources.js";
import type { StoredSession } from "../../../domain/history.js";
import { transactionReference } from "../../../domain/transaction.js";
import { loadSnapshot } from "../../../infrastructure/history-store.js";
import { readOpenCodeNativeDescriptor } from "./archive.js";
import {
  createOpenCodeFilteredDatabase,
  inspectOpenCodeImportTargetSchema,
  materializeOpenCodeConversionDatabase,
  mergeOpenCodeHistoryDatabases,
} from "../storage/database.js";
import {
  applyOpenCodeInsertedRows,
  assessOpenCodeTarget,
  type OpenCodeImportClassification,
  type OpenCodeTargetAssessment,
} from "../storage/native.js";
import { projectOpenCodeTargetProjects } from "./project-projection.js";
import { projectOpenCodeTargetLocation } from "./projection.js";
import { readOpenCodePlanLocations } from "../plan.js";
import { readOpenCodeHistory } from "../history/reader.js";
import { scanOpenCode } from "../scan.js";
import { requireOpenCodeSource, resolveOpenCodeSource, type OpenCodeSourceOptions } from "../source.js";
import {
  executePreparedOpenCodeTransaction,
  prepareOpenCodeTransaction,
  type OpenCodeNativeFileRole,
  type PreparedOpenCodeNativeFileEffect,
} from "./transaction.js";
import { projectOpenCodeToolOutputPaths, type OpenCodeToolOutputDescriptor } from "../tool-output.js";

export interface OpenCodeImportItem {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly classification: OpenCodeImportClassification;
  readonly destination: string;
  readonly provider: string;
  readonly cwd: string;
  readonly reason?: string;
}

export interface RestoreOpenCodeResult {
  readonly targetDataRoot: string;
  readonly targetDatabase: string;
  readonly items: readonly OpenCodeImportItem[];
  readonly newSessions: number;
  readonly alreadyPresent: number;
  readonly resources: ManagedResourcePlan["items"];
  readonly transactionRef?: string;
}

export interface RestoreOpenCodeOptions extends OpenCodeSourceOptions {
  readonly stateDirectory: string;
  readonly entries: readonly ImportEntry[];
  readonly objects: ReadonlyMap<string, string>;
  readonly pathMappings: PathMappings;
  readonly workspace: string;
}

interface RestorePlan {
  readonly target: ReturnType<typeof resolveOpenCodeSource>;
  readonly projectedArtifact: string;
  readonly assessment: OpenCodeTargetAssessment;
  readonly nativeFiles: readonly OpenCodeNativeFilePlan[];
  readonly items: readonly OpenCodeImportItem[];
  readonly resources: ManagedResourcePlan;
}

interface OpenCodeArchiveNativeFile {
  readonly role: OpenCodeNativeFileRole;
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly relativePath: string;
  readonly filePath: string;
}

interface OpenCodeArchiveObjects {
  readonly databases: readonly {
    readonly file: string;
    readonly projected: boolean;
    readonly nativeIds: ReadonlySet<string>;
  }[];
  readonly nativeFiles: readonly OpenCodeArchiveNativeFile[];
  readonly toolOutputs: ReadonlyMap<string, readonly OpenCodeToolOutputDescriptor[]>;
}

interface OpenCodeNativeFilePlan extends PreparedOpenCodeNativeFileEffect {
  readonly root: string;
  readonly image: ExclusiveFileImage;
  readonly classification: OpenCodeImportClassification;
  readonly reason?: string;
}

export interface PreparedOpenCodeRestore {
  readonly result: RestoreOpenCodeResult;
  readonly apply: () => Promise<RestoreOpenCodeResult>;
}

function archiveObjects(options: RestoreOpenCodeOptions): OpenCodeArchiveObjects {
  const databases = new Map<string, {
    readonly file: string;
    readonly projected: boolean;
    readonly nativeIds: Set<string>;
  }>();
  const nativeFiles: OpenCodeArchiveNativeFile[] = [];
  const toolOutputs = new Map<string, readonly OpenCodeToolOutputDescriptor[]>();
  for (const entry of options.entries) {
    const binding = entry.objects[0];
    const sidecar = entry.objects.find((item) => item.role === "session-diff");
    const plan = entry.objects.find((item) => item.role === "session-plan");
    if (
      entry.agent !== "opencode" || binding === undefined || binding.role !== "history-database" ||
      entry.objects.slice(1).some((item) =>
        item.role !== "session-diff" && item.role !== "session-plan" && item.role !== "tool-output"
      )
    ) {
      throw new Error(`OpenCode import entry is invalid: ${entry.sessionRef}`);
    }
    const databaseFile = options.objects.get(binding.id);
    if (databaseFile === undefined) throw new Error(`OpenCode import history database is missing: ${entry.sessionRef}`);
    const existingDatabase = databases.get(binding.id);
    if (existingDatabase !== undefined) {
      if (existingDatabase.file !== databaseFile || existingDatabase.projected !== (entry.projection !== undefined)) {
        throw new Error("OpenCode import history closure has inconsistent route metadata");
      }
      existingDatabase.nativeIds.add(entry.nativeId);
    } else {
      databases.set(binding.id, {
        file: databaseFile,
        projected: entry.projection !== undefined,
        nativeIds: new Set([entry.nativeId]),
      });
    }
    if (sidecar !== undefined) {
      const filePath = options.objects.get(sidecar.id);
      if (filePath === undefined) throw new Error(`OpenCode import session_diff is missing: ${entry.sessionRef}`);
      nativeFiles.push({
        role: "session-diff",
        sessionRef: entry.sessionRef,
        nativeId: entry.nativeId,
        relativePath: sidecar.relativePath,
        filePath,
      });
    }
    if (plan !== undefined) {
      const filePath = options.objects.get(plan.id);
      if (filePath === undefined) throw new Error(`OpenCode import session plan is missing: ${entry.sessionRef}`);
      nativeFiles.push({
        role: "session-plan",
        sessionRef: entry.sessionRef,
        nativeId: entry.nativeId,
        relativePath: plan.relativePath,
        filePath,
      });
    }
    const descriptor = readOpenCodeNativeDescriptor(entry);
    toolOutputs.set(entry.nativeId, descriptor.toolOutputs);
    const outputBindings = new Map(
      entry.objects.filter((item) => item.role === "tool-output").map((item) => [item.relativePath, item]),
    );
    for (const output of descriptor.toolOutputs) {
      if (!output.available) continue;
      const outputBinding = outputBindings.get(output.relativePath);
      const filePath = outputBinding === undefined ? undefined : options.objects.get(outputBinding.id);
      if (filePath === undefined) throw new Error(`OpenCode import tool-output is missing: ${entry.sessionRef}`);
      nativeFiles.push({
        role: "tool-output",
        sessionRef: entry.sessionRef,
        nativeId: entry.nativeId,
        relativePath: output.relativePath,
        filePath,
      });
    }
  }
  if (databases.size === 0) throw new Error("OpenCode import history database is missing");
  return { databases: [...databases.values()], nativeFiles, toolOutputs };
}

async function prepareOpenCodeImportDatabase(
  archive: OpenCodeArchiveObjects,
  targetDatabase: string,
  projectedArtifact: string,
  workspace: string,
): Promise<void> {
  const native: string[] = [];
  const converted: string[] = [];
  for (const [index, database] of archive.databases.entries()) {
    const selected = path.join(workspace, `opencode-selected-${index.toString().padStart(3, "0")}.sqlite`);
    await rm(selected, { force: true });
    createOpenCodeFilteredDatabase(database.file, selected, database.nativeIds);
    (database.projected ? converted : native).push(selected);
  }
  let nativeClosure: string | undefined;
  if (native.length === 1) {
    nativeClosure = native[0]!;
  } else if (native.length > 1) {
    nativeClosure = path.join(workspace, "opencode-native-merged.sqlite");
    await rm(nativeClosure, { force: true });
    mergeOpenCodeHistoryDatabases(native, nativeClosure);
  }
  const materialized: string[] = [];
  for (const [index, source] of converted.entries()) {
    const candidate = path.join(workspace, `opencode-converted-${index.toString().padStart(3, "0")}.sqlite`);
    await rm(candidate, { force: true });
    materializeOpenCodeConversionDatabase(source, nativeClosure ?? targetDatabase, candidate);
    materialized.push(candidate);
  }
  const closures = [...(nativeClosure === undefined ? [] : [nativeClosure]), ...materialized];
  if (closures.length === 1) {
    mergeOpenCodeHistoryDatabases(closures, projectedArtifact);
  } else {
    mergeOpenCodeHistoryDatabases(closures, projectedArtifact);
  }
}

async function simulatePlan(plan: RestorePlan, workspace: string): Promise<void> {
  if (plan.assessment.insertedRows.length === 0) return;
  const candidate = path.join(workspace, `opencode-target-candidate-${crypto.randomUUID()}.sqlite`);
  const target = new DatabaseSync(plan.target.databasePath, { readOnly: true, timeout: 5_000 });
  try {
    await backup(target, candidate);
  } finally {
    target.close();
  }
  try {
    applyOpenCodeInsertedRows(
      plan.projectedArtifact,
      candidate,
      plan.assessment.insertedRows,
      "present",
      false,
    );
  } finally {
    await rm(candidate, { force: true });
  }
}

async function buildRestorePlan(options: RestoreOpenCodeOptions): Promise<RestorePlan> {
  if (options.entries.length === 0) throw new Error("OpenCode import selection is empty");
  const target = resolveOpenCodeSource(options);
  await requireOpenCodeSource(target);
  const targetDatabase = new DatabaseSync(target.databasePath, { readOnly: true, readBigInts: true, timeout: 5_000 });
  try {
    inspectOpenCodeImportTargetSchema(targetDatabase);
  } finally {
    targetDatabase.close();
  }
  const archive = archiveObjects(options);
  const projectedArtifact = path.join(options.workspace, "opencode-projected.sqlite");
  await rm(projectedArtifact, { force: true });
  await prepareOpenCodeImportDatabase(archive, target.databasePath, projectedArtifact, options.workspace);
  await projectOpenCodeTargetProjects(projectedArtifact, target.databasePath, options.pathMappings);
  await projectOpenCodeTargetLocation(projectedArtifact, target.databasePath, options.pathMappings);
  const toolOutputMappings = new Map<string, string>();
  for (const descriptors of archive.toolOutputs.values()) {
    for (const descriptor of descriptors) {
      toolOutputMappings.set(
        descriptor.nativePath,
        path.join(target.dataRoot, "tool-output", path.basename(descriptor.relativePath)),
      );
    }
  }
  projectOpenCodeToolOutputPaths(projectedArtifact, toolOutputMappings);
  const assessment = assessOpenCodeTarget(projectedArtifact, target.databasePath);
  const byNativeId = new Map(assessment.sessions.map((session) => [session.nativeId, session]));
  const projected = readOpenCodeHistory({
    databasePath: projectedArtifact,
    databaseRelativePath: "opencode/history.sqlite",
    sidecarFiles: [],
  });
  const projectedById = new Map(projected.sessions.map((session) => [session.nativeId, session]));
  const planLocations = readOpenCodePlanLocations(projectedArtifact, target.dataRoot, "history");
  const nativeFiles: OpenCodeNativeFilePlan[] = [];
  for (const nativeFile of archive.nativeFiles) {
    let root = target.dataRoot;
    let destination: string;
    if (nativeFile.role === "session-diff") {
      destination = path.join(target.dataRoot, "storage", "session_diff", `${nativeFile.nativeId}.json`);
    } else if (nativeFile.role === "tool-output") {
      destination = path.join(target.dataRoot, "tool-output", path.basename(nativeFile.relativePath));
    } else {
      const location = planLocations.bySession.get(nativeFile.nativeId);
      if (
        !planLocations.supported || location === undefined ||
        nativeFile.relativePath !== `opencode/plan/${nativeFile.nativeId}.md`
      ) throw new Error(`target OpenCode session plan location is unavailable: ${nativeFile.sessionRef}`);
      root = location.root;
      destination = location.nativePath;
    }
    const image: ExclusiveFileImage = { ...(await digestFile(nativeFile.filePath)), mode: 0o600 };
    let classification: OpenCodeImportClassification;
    let reason: string | undefined;
    try {
      if (nativeFile.role === "session-plan") await requireRealDirectory(root, "OpenCode plan root");
      await requireSafeDirectoryParents(root, destination, `OpenCode ${nativeFile.role}`);
      const current = await observeExclusiveFile(destination, `OpenCode ${nativeFile.role} ${nativeFile.sessionRef}`);
      classification = current === null
        ? "new"
        : exclusiveFileMatches(image, current)
          ? "already_present"
          : "conflict";
      if (classification === "conflict") reason = `target ${nativeFile.role} differs from the archive`;
    } catch (error) {
      classification = "conflict";
      reason = error instanceof Error ? error.message : `target ${nativeFile.role} is unsafe`;
    }
    nativeFiles.push({ ...nativeFile, root, destination, image, classification, ...(reason === undefined ? {} : { reason }) });
  }
  const nativeFilesBySession = new Map<string, OpenCodeNativeFilePlan[]>();
  for (const nativeFile of nativeFiles) {
    const owned = nativeFilesBySession.get(nativeFile.sessionRef) ?? [];
    owned.push(nativeFile);
    nativeFilesBySession.set(nativeFile.sessionRef, owned);
  }
  const items = options.entries.map((entry): OpenCodeImportItem => {
    const result = byNativeId.get(entry.nativeId);
    const session = projectedById.get(entry.nativeId);
    if (result === undefined || session === undefined) throw new Error(`OpenCode restore plan omitted a session: ${entry.sessionRef}`);
    const ownedFiles = nativeFilesBySession.get(entry.sessionRef) ?? [];
    const classification: OpenCodeImportClassification = result.classification === "conflict" ||
      ownedFiles.some((item) => item.classification === "conflict")
      ? "conflict"
      : result.classification === "new" || ownedFiles.some((item) => item.classification === "new")
        ? "new"
        : "already_present";
    const reason = result.reason ?? ownedFiles.find((item) => item.reason !== undefined)?.reason;
    return {
      sessionRef: entry.sessionRef,
      nativeId: entry.nativeId,
      classification,
      destination: target.databasePath,
      provider: session.provider,
      cwd: session.context,
      ...(reason === undefined ? {} : { reason }),
    };
  });
  const resources = await planManagedResources(
    options.entries,
    options.objects,
    new Map(items.map((item) => [item.sessionRef, item.cwd])),
  );
  const plan = { target, projectedArtifact, assessment, nativeFiles, items, resources };
  if (!items.some((item) => item.classification === "conflict")) await simulatePlan(plan, options.workspace);
  return plan;
}

function resultFromPlan(plan: RestorePlan, reference?: string): RestoreOpenCodeResult {
  return {
    targetDataRoot: plan.target.dataRoot,
    targetDatabase: plan.target.databasePath,
    items: plan.items,
    newSessions: plan.items.filter((item) => item.classification === "new").length,
    alreadyPresent: plan.items.filter((item) => item.classification === "already_present").length,
    resources: plan.resources.items,
    ...(reference === undefined ? {} : { transactionRef: reference }),
  };
}

function importedLibrary(entries: readonly ImportEntry[]): Map<string, StoredSession["library"]> {
  return new Map(entries.map((entry) => [entry.sessionRef, entry.library]));
}

async function reconcileWithoutNativeWrite(options: RestoreOpenCodeOptions, plan: RestorePlan): Promise<void> {
  const snapshot = await loadSnapshot(options.stateDirectory, "opencode");
  if (snapshot !== undefined && options.entries.every((entry) =>
    snapshot.sessions.some((session) => session.sessionRef === entry.sessionRef)
  )) return;
  await scanOpenCode({
    stateDirectory: options.stateDirectory,
    dataRoot: plan.target.dataRoot,
    databasePath: plan.target.databasePath,
    importedLibrary: importedLibrary(options.entries),
  });
}

export async function prepareOpenCodeRestore(options: RestoreOpenCodeOptions): Promise<PreparedOpenCodeRestore> {
  const plan = await buildRestorePlan(options);
  return {
    result: resultFromPlan(plan),
    apply: async () => {
      if (plan.items.some((item) => item.classification === "conflict")) {
        const conflict = plan.items.find((item) => item.classification === "conflict");
        throw new Error(`OpenCode import conflict${conflict === undefined ? "" : ` for ${conflict.sessionRef}`}: ${
          conflict?.reason ?? plan.assessment.conflicts[0] ?? "target differs"
        }`);
      }
      const resources = newManagedResourceEffects(plan.resources);
      const nativeFiles = plan.nativeFiles.filter((item) => item.classification === "new");
      const affectedRefs = new Set([
        ...plan.items.filter((item) => item.classification === "new").map((item) => item.sessionRef),
        ...nativeFiles.map((file) => file.sessionRef),
        ...resources.flatMap((resource) => resource.sessionRefs),
      ]);
      if (affectedRefs.size === 0) {
        await reconcileWithoutNativeWrite(options, plan);
        return resultFromPlan(plan);
      }
      const transactionEntries = options.entries.filter((entry) => affectedRefs.has(entry.sessionRef));
      const journal = await prepareOpenCodeTransaction({
        stateDirectory: options.stateDirectory,
        dataRoot: plan.target.dataRoot,
        database: plan.target.databasePath,
        artifactPath: plan.projectedArtifact,
        insertedRows: plan.assessment.insertedRows,
        files: nativeFiles,
        resources,
        sessions: transactionEntries.map((entry) => ({ sessionRef: entry.sessionRef, nativeId: entry.nativeId })),
        importedLibrary: importedLibrary(transactionEntries),
      });
      const committed = await executePreparedOpenCodeTransaction(options.stateDirectory, journal);
      return resultFromPlan(plan, transactionReference(committed.id));
    },
  };
}
