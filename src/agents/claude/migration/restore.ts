import { lstat } from "node:fs/promises";
import path from "node:path";

import type { ImportEntry } from "../../../domain/import.js";
import type { StoredSession } from "../../../domain/history.js";
import { normalizeAbsolutePath, pathIdentity, samePath } from "../../../domain/host-path.js";
import { mapAbsolutePath, type PathMappings } from "../../../domain/path-mapping.js";
import { transactionReference } from "../../../domain/transaction.js";
import {
  exclusiveFileMatches,
  observeExclusiveFile,
  type ExclusiveFileImage,
} from "../../../infrastructure/exclusive-file.js";
import { copyStableFile, digestFile } from "../../../infrastructure/files.js";
import { loadSnapshot } from "../../../infrastructure/history-store.js";
import {
  newManagedResourceEffects,
  planManagedResources,
  type ManagedResourcePlan,
} from "../../../infrastructure/managed-resources.js";
import { readClaudeDescriptor } from "./archive.js";
import { discoverClaudeCarriers } from "../carrier.js";
import { validateClaudeCheckpoints, type ClaudeCheckpointFile } from "../sidecars/checkpoint.js";
import { claudeProjectCarrier } from "../project.js";
import { projectClaudeTranscript } from "./rewrite.js";
import { scanClaude } from "../scan.js";
import { claudeSessionSidecarIdentity } from "../sidecars/sidecar.js";
import { requireClaudeSource, resolveClaudeSource, type ClaudeSourceOptions } from "../source.js";
import { validateClaudeSubagentBundles, type ClaudeSubagentFile } from "../sidecars/subagent.js";
import { validateClaudeTaskList, type ClaudeTaskFile } from "../sidecars/task.js";
import { validateClaudeToolResults, type ClaudeToolResultFile } from "../sidecars/tool-result.js";
import {
  executePreparedClaudeTransaction,
  prepareClaudeTransaction,
  type ClaudeNativeFileRole,
  type ClaudeTransactionSession,
  type PreparedClaudeEffect,
} from "./transaction.js";
import { parseClaudeTranscript } from "../history/transcript.js";

export type ClaudeImportClassification = "new" | "already_present" | "conflict";

export interface ClaudeImportItem {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly classification: ClaudeImportClassification;
  readonly destination: string;
  readonly provider: string;
  readonly cwd: string;
  readonly reason?: string;
}

export interface RestoreClaudeResult {
  readonly targetConfigRoot: string;
  readonly items: readonly ClaudeImportItem[];
  readonly newSessions: number;
  readonly alreadyPresent: number;
  readonly resources: ManagedResourcePlan["items"];
  readonly transactionRef?: string;
}

export interface RestoreClaudeOptions extends ClaudeSourceOptions {
  readonly stateDirectory: string;
  readonly entries: readonly ImportEntry[];
  readonly objects: ReadonlyMap<string, string>;
  readonly pathMappings: PathMappings;
  readonly workspace: string;
}

interface ArchiveClaudeFile {
  readonly role: ClaudeNativeFileRole;
  readonly relativePath: string;
  readonly filePath: string;
  readonly mode: number;
}

interface PlannedClaudeFile extends ArchiveClaudeFile {
  readonly destination: string;
  readonly image: ExclusiveFileImage;
  readonly classification: ClaudeImportClassification;
  readonly reason?: string;
}

interface PlannedSession {
  readonly entry: ImportEntry;
  readonly files: readonly PlannedClaudeFile[];
  readonly destination: string;
  readonly cwd: string;
  readonly classification: ClaudeImportClassification;
  readonly reason?: string;
}

interface RestorePlan {
  readonly configRoot: string;
  readonly sessions: readonly PlannedSession[];
  readonly resources: ManagedResourcePlan;
}

export interface PreparedClaudeRestore {
  readonly result: RestoreClaudeResult;
  readonly apply: () => Promise<RestoreClaudeResult>;
}

function archiveFiles(
  entry: ImportEntry,
  objects: ReadonlyMap<string, string>,
  descriptor: ReturnType<typeof readClaudeDescriptor>,
): ArchiveClaudeFile[] {
  if (entry.agent !== "claude" || entry.objects.length === 0 || entry.objects[0]?.role !== "main-transcript") {
    throw new Error(`Claude Code import entry is invalid: ${entry.sessionRef}`);
  }
  return entry.objects.map((binding) => {
    const role = binding.role;
    const filePath = objects.get(binding.id);
    if (
      filePath === undefined ||
      (role !== "main-transcript" && role !== "subagent-transcript" && role !== "subagent-metadata" &&
        role !== "tool-result" && role !== "session-sidecar" && role !== "checkpoint-backup" &&
        role !== "task-entry" && role !== "task-highwatermark")
    ) throw new Error(`Claude Code import object is invalid: ${entry.sessionRef}`);
    const related = descriptor.relatedFiles.find((file) => file.relativePath === binding.relativePath);
    const mode = role === "checkpoint-backup" ? related?.mode : 0o600;
    if (mode === undefined || (role === "checkpoint-backup" && related?.role !== role)) {
      throw new Error(`Claude Code import checkpoint mode is invalid: ${entry.sessionRef}`);
    }
    return { role, relativePath: binding.relativePath, filePath, mode };
  });
}

async function requireMappedDirectory(directory: string): Promise<void> {
  let info;
  try { info = await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`mapped Claude Code directory does not exist: ${directory}`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`mapped Claude Code directory is not a real directory: ${directory}`);
  }
}

async function classifyFile(
  filePath: string,
  destination: string,
  mode: number,
): Promise<{ readonly image: ExclusiveFileImage; readonly classification: ClaudeImportClassification; readonly reason?: string }> {
  const image: ExclusiveFileImage = { ...(await digestFile(filePath)), mode };
  try {
    const current = await observeExclusiveFile(destination, "Claude Code target carrier");
    if (current === null) return { image, classification: "new" };
    return exclusiveFileMatches(image, current)
      ? { image, classification: "already_present" }
      : { image, classification: "conflict", reason: "target carrier differs from the archive" };
  } catch (error) {
    return {
      image,
      classification: "conflict",
      reason: error instanceof Error ? error.message : "target carrier has an unsupported shape",
    };
  }
}

function aggregateClassification(
  files: readonly PlannedClaudeFile[],
  unexpected: boolean,
): { readonly classification: ClaudeImportClassification; readonly reason?: string } {
  if (unexpected) return { classification: "conflict", reason: "target has another carrier for this session ID" };
  const conflict = files.find((file) => file.classification === "conflict");
  if (conflict !== undefined) return {
    classification: "conflict",
    ...(conflict.reason === undefined ? {} : { reason: conflict.reason }),
  };
  return files.some((file) => file.classification === "new")
    ? { classification: "new" }
    : { classification: "already_present" };
}

async function buildRestorePlan(options: RestoreClaudeOptions): Promise<RestorePlan> {
  if (options.entries.length === 0) throw new Error("Claude Code import selection is empty");
  const target = resolveClaudeSource(options);
  await requireClaudeSource(target);
  const carriers = await discoverClaudeCarriers(target.configRoot);
  const sessions: PlannedSession[] = [];
  const allDestinations = new Set<string>();
  const workingDirectories = new Map<string, string>();
  for (const [sessionIndex, entry] of options.entries.entries()) {
    const descriptor = readClaudeDescriptor(entry);
    const sourceFiles = archiveFiles(entry, options.objects, descriptor);
    const mainSource = sourceFiles[0]!.filePath;
    const parsed = await parseClaudeTranscript(mainSource, entry.nativeId, entry.updatedAt);
    if (parsed.observedCwds.length === 0) throw new Error(`Claude Code session has no restorable cwd: ${entry.sessionRef}`);
    const cwdMap = new Map<string, string>();
    for (const sourceCwd of [...parsed.observedCwds, ...parsed.observedRelocatedCwds]) {
      const targetCwd = mapAbsolutePath(sourceCwd, options.pathMappings, "Claude Code history cwd");
      cwdMap.set(pathIdentity(sourceCwd, options.pathMappings.sourceFlavor), targetCwd);
    }
    const cwd = cwdMap.get(pathIdentity(parsed.context, options.pathMappings.sourceFlavor));
    if (cwd === undefined) throw new Error(`Claude Code current session cwd was not assessed: ${entry.sessionRef}`);
    await requireMappedDirectory(cwd);
    const targetObservedCwds = [...new Set(parsed.observedCwds.map((value) =>
      cwdMap.get(pathIdentity(value, options.pathMappings.sourceFlavor))!))].sort();
    const allowedTargetCwds = [...new Set([...targetObservedCwds, cwd])].sort();
    const projectCarrier = claudeProjectCarrier(cwd);
    workingDirectories.set(entry.sessionRef, cwd);

    const locatedFiles: Array<ArchiveClaudeFile & { readonly destination: string; readonly projected: string }> = [];
    for (const [fileIndex, source] of sourceFiles.entries()) {
      const basename = path.posix.basename(source.relativePath);
      const sidecar = source.role === "session-sidecar"
        ? claudeSessionSidecarIdentity(source.relativePath, descriptor.projectCarrier, entry.nativeId)
        : undefined;
      if (source.role === "session-sidecar" && sidecar === undefined) {
        throw new Error(`Claude Code session sidecar path is invalid: ${entry.sessionRef}`);
      }
      const destination = source.role === "main-transcript"
        ? path.join(target.configRoot, "projects", projectCarrier, `${entry.nativeId}.jsonl`)
        : source.role === "checkpoint-backup"
          ? path.join(target.configRoot, "file-history", entry.nativeId, basename)
          : source.role === "task-entry" || source.role === "task-highwatermark"
            ? path.join(target.configRoot, "tasks", entry.nativeId, basename)
            : source.role === "session-sidecar"
              ? path.join(target.configRoot, "projects", projectCarrier, entry.nativeId, ...sidecar!.subpath)
        : path.join(
            target.configRoot,
            "projects",
            projectCarrier,
            entry.nativeId,
            source.role === "tool-result" ? "tool-results" : "subagents",
            basename,
          );
      if (allDestinations.has(destination)) throw new Error(`Claude Code import destination is duplicated: ${destination}`);
      allDestinations.add(destination);
      const extension = source.role === "tool-result"
        ? path.extname(basename)
        : source.role === "session-sidecar" ? ".sidecar"
        : source.role === "subagent-metadata" ? ".json"
          : source.role === "checkpoint-backup" ? ".backup"
            : source.role === "task-entry" ? ".json"
              : source.role === "task-highwatermark" ? ".state" : ".jsonl";
      const projected = path.join(
        options.workspace,
        `claude-projected-${sessionIndex.toString().padStart(6, "0")}-${fileIndex.toString().padStart(4, "0")}${extension}`,
      );
      locatedFiles.push({ ...source, destination, projected });
    }

    const sourceSubagents: ClaudeSubagentFile[] = locatedFiles.flatMap((file) =>
      file.role === "subagent-transcript" || file.role === "subagent-metadata"
        ? [{ relativePath: file.relativePath, role: file.role, filePath: file.filePath }]
        : []);
    const sourceToolResults: ClaudeToolResultFile[] = locatedFiles.flatMap((file) => file.role === "tool-result"
      ? [{ relativePath: file.relativePath, role: file.role, filePath: file.filePath }]
      : []);
    const sourceCheckpoints: ClaudeCheckpointFile[] = locatedFiles.flatMap((file) => file.role === "checkpoint-backup"
      ? [{
          relativePath: file.relativePath,
          role: file.role,
          filePath: file.filePath,
          mode: file.mode,
        }]
      : []);
    const sourceTasks: ClaudeTaskFile[] = locatedFiles.flatMap((file) =>
      file.role === "task-entry" || file.role === "task-highwatermark"
        ? [{ relativePath: file.relativePath, role: file.role, filePath: file.filePath }]
        : []);
    await validateClaudeTaskList({ sessionId: entry.nativeId, files: sourceTasks });
    const checkpointClosure = await validateClaudeCheckpoints({
      transcriptPath: mainSource,
      files: sourceCheckpoints,
      sessionId: entry.nativeId,
    });
    const checkpointParentReplacements = new Map<string, string>();
    for (const sourceParent of checkpointClosure.realParentDirectories) {
      const targetParent = mapAbsolutePath(
        sourceParent,
        options.pathMappings,
        "Claude Code checkpoint real parent directory",
      );
      await requireMappedDirectory(targetParent);
      checkpointParentReplacements.set(sourceParent, targetParent);
    }
    const toolBindings = await validateClaudeToolResults({
      transcripts: [
        mainSource,
        ...sourceSubagents.filter((file) => file.role === "subagent-transcript").map((file) => file.filePath),
      ],
      files: sourceToolResults,
      sessionId: entry.nativeId,
      projectCarrier: descriptor.projectCarrier,
    });
    const referenceReplacements = new Map(toolBindings.map((binding) => {
      const located = locatedFiles.find((file) => file.relativePath === binding.file.relativePath);
      if (located === undefined) throw new Error(`Claude Code tool-result destination is missing: ${entry.sessionRef}`);
      return [binding.referencePath, located.destination] as const;
    }));
    for (const binding of checkpointClosure.editPaths) {
      const mapped = mapAbsolutePath(binding.referencePath, options.pathMappings, "Claude Code checkpoint edit path");
      const mappedSourceCwd = cwdMap.get(pathIdentity(binding.sourceCwd, options.pathMappings.sourceFlavor));
      if (mappedSourceCwd === undefined) {
        throw new Error(`Claude Code checkpoint cwd was not assessed: ${entry.sessionRef}`);
      }
      await requireMappedDirectory(mappedSourceCwd);
      const expected = path.resolve(mappedSourceCwd, binding.trackingPath);
      if (mapped !== expected) throw new Error(`Claude Code checkpoint path projection is invalid: ${entry.sessionRef}`);
      const previous = referenceReplacements.get(binding.referencePath);
      if (previous !== undefined && previous !== mapped) {
        throw new Error(`Claude Code transcript path projection is ambiguous: ${entry.sessionRef}`);
      }
      referenceReplacements.set(binding.referencePath, mapped);
    }

    const projectedFiles: Array<ArchiveClaudeFile & { readonly destination: string }> = [];
    for (const source of locatedFiles) {
      if (source.role === "main-transcript" || source.role === "subagent-transcript") {
        await projectClaudeTranscript(source.filePath, source.projected, (value) => {
          normalizeAbsolutePath(value, options.pathMappings.sourceFlavor, "Claude Code transcript cwd");
          const mapped = cwdMap.get(pathIdentity(value, options.pathMappings.sourceFlavor));
          if (mapped === undefined) throw new Error(`Claude Code transcript cwd was not assessed: ${entry.sessionRef}`);
          return mapped;
        }, {
          referenceReplacements,
          checkpointParentReplacements: source.role === "main-transcript" ? checkpointParentReplacements : new Map(),
          ...(source.role === "main-transcript" ? {
            clearWorktreeStateForSession: entry.nativeId,
            clearBridgeSessionForSession: entry.nativeId,
            rewriteRelocatedCwdForSession: entry.nativeId,
          } : {}),
        });
      } else {
        await copyStableFile(source.filePath, source.projected);
      }
      projectedFiles.push({
        role: source.role,
        relativePath: source.relativePath,
        filePath: source.projected,
        destination: source.destination,
        mode: source.mode,
      });
    }

    const projectedMain = projectedFiles[0]!;
    const projected = await parseClaudeTranscript(projectedMain.filePath, entry.nativeId, entry.updatedAt);
    if (
      projected.firstRootRecordUuid !== descriptor.firstRootRecordUuid ||
      projected.context !== cwd ||
      projected.observedCwds.length !== targetObservedCwds.length ||
      projected.observedCwds.some((value, index) => value !== targetObservedCwds[index])
    ) throw new Error(`Claude Code path projection changed native identity: ${entry.sessionRef}`);
    const projectedSubagents: ClaudeSubagentFile[] = projectedFiles.flatMap((file) =>
      file.role === "subagent-transcript" || file.role === "subagent-metadata"
        ? [{
            relativePath: `claude/projects/${projectCarrier}/${entry.nativeId}/subagents/${path.basename(file.destination)}`,
            role: file.role,
            filePath: file.filePath,
          }]
        : []);
    await validateClaudeSubagentBundles({
      mainTranscriptPath: projectedMain.filePath,
      sessionId: entry.nativeId,
      projectCarrier,
      allowedCwds: allowedTargetCwds,
      files: projectedSubagents,
    });
    const projectedToolResults: ClaudeToolResultFile[] = projectedFiles.flatMap((file) => file.role === "tool-result"
      ? [{
          relativePath: `claude/projects/${projectCarrier}/${entry.nativeId}/tool-results/${path.basename(file.destination)}`,
          role: file.role,
          filePath: file.filePath,
        }]
      : []);
    await validateClaudeToolResults({
      transcripts: [
        projectedMain.filePath,
        ...projectedSubagents.filter((file) => file.role === "subagent-transcript").map((file) => file.filePath),
      ],
      files: projectedToolResults,
      sessionId: entry.nativeId,
      projectCarrier,
      expectedConfigRoot: target.configRoot,
    });
    const projectedCheckpoints: ClaudeCheckpointFile[] = projectedFiles.flatMap((file) =>
      file.role === "checkpoint-backup"
        ? [{
            relativePath: `claude/file-history/${entry.nativeId}/${path.basename(file.destination)}`,
            role: file.role,
            filePath: file.filePath,
            mode: file.mode,
          }]
        : []);
    const projectedCheckpointClosure = await validateClaudeCheckpoints({
      transcriptPath: projectedMain.filePath,
      files: projectedCheckpoints,
      sessionId: entry.nativeId,
    });
    const expectedParentDirectories = [...new Set(checkpointParentReplacements.values())].sort();
    if (projectedCheckpointClosure.realParentDirectories.length !== expectedParentDirectories.length ||
      projectedCheckpointClosure.realParentDirectories.some((value, index) => value !== expectedParentDirectories[index])) {
      throw new Error(`Claude Code checkpoint real parent projection is invalid: ${entry.sessionRef}`);
    }
    const projectedTasks: ClaudeTaskFile[] = projectedFiles.flatMap((file) =>
      file.role === "task-entry" || file.role === "task-highwatermark"
        ? [{
            relativePath: `claude/tasks/${entry.nativeId}/${path.basename(file.destination)}`,
            role: file.role,
            filePath: file.filePath,
          }]
        : []);
    await validateClaudeTaskList({ sessionId: entry.nativeId, files: projectedTasks });

    const files: PlannedClaudeFile[] = [];
    for (const file of projectedFiles) {
      files.push({ ...file, ...(await classifyFile(file.filePath, file.destination, file.mode)) });
    }
    const expected = new Set(files.map((file) => file.destination));
    const unexpected = carriers.some((carrier) =>
      carrier.sessionCandidate === entry.nativeId && !expected.has(path.resolve(carrier.sourcePath)));
    const classification = aggregateClassification(files, unexpected);
    sessions.push({
      entry,
      files,
      destination: projectedMain.destination,
      cwd,
      ...classification,
    });
  }
  const resources = await planManagedResources(options.entries, options.objects, workingDirectories);
  return { configRoot: target.configRoot, sessions, resources };
}

function resultFromPlan(plan: RestorePlan, reference?: string): RestoreClaudeResult {
  const items = plan.sessions.map((session): ClaudeImportItem => ({
    sessionRef: session.entry.sessionRef,
    nativeId: session.entry.nativeId,
    classification: session.classification,
    destination: session.destination,
    provider: "",
    cwd: session.cwd,
    ...(session.reason === undefined ? {} : { reason: session.reason }),
  }));
  return {
    targetConfigRoot: plan.configRoot,
    items,
    newSessions: items.filter((item) => item.classification === "new").length,
    alreadyPresent: items.filter((item) => item.classification === "already_present").length,
    resources: plan.resources.items,
    ...(reference === undefined ? {} : { transactionRef: reference }),
  };
}

function importedLibrary(entries: readonly ImportEntry[]): Map<string, StoredSession["library"]> {
  return new Map(entries.map((entry) => [entry.sessionRef, entry.library]));
}

async function reconcileWithoutNativeWrite(options: RestoreClaudeOptions, plan: RestorePlan): Promise<void> {
  const snapshot = await loadSnapshot(options.stateDirectory, "claude");
  if (snapshot !== undefined && options.entries.every((entry) =>
    snapshot.sessions.some((session) => session.sessionRef === entry.sessionRef)
  )) return;
  await scanClaude({
    stateDirectory: options.stateDirectory,
    configRoot: plan.configRoot,
    importedLibrary: importedLibrary(options.entries),
  });
}

export async function prepareClaudeRestore(options: RestoreClaudeOptions): Promise<PreparedClaudeRestore> {
  const plan = await buildRestorePlan(options);
  return {
    result: resultFromPlan(plan),
    apply: async () => {
      const conflict = plan.sessions.find((session) => session.classification === "conflict");
      if (conflict !== undefined) {
        throw new Error(`Claude Code import conflict for ${conflict.entry.sessionRef}: ${conflict.reason ?? "target differs"}`);
      }
      const resources = newManagedResourceEffects(plan.resources);
      const pending = plan.sessions.filter((session) => session.classification === "new");
      const affectedRefs = new Set([
        ...pending.map((session) => session.entry.sessionRef),
        ...resources.flatMap((resource) => resource.sessionRefs),
      ]);
      if (affectedRefs.size === 0) {
        await reconcileWithoutNativeWrite(options, plan);
        return resultFromPlan(plan);
      }
      const effects: PreparedClaudeEffect[] = pending.flatMap((session) => session.files
        .filter((file) => file.classification === "new")
        .map((file) => ({
          role: file.role,
          sessionRef: session.entry.sessionRef,
          nativeId: session.entry.nativeId,
          destination: file.destination,
          filePath: file.filePath,
          mode: file.mode,
        })));
      const transactionSessions: ClaudeTransactionSession[] = plan.sessions
        .filter((session) => affectedRefs.has(session.entry.sessionRef))
        .map((session) => ({
          sessionRef: session.entry.sessionRef,
          nativeId: session.entry.nativeId,
          firstRootRecordUuid: readClaudeDescriptor(session.entry).firstRootRecordUuid,
          files: session.files.map((file) => ({
            role: file.role,
            destination: file.destination,
            image: file.image,
          })).sort((left, right) => left.destination.localeCompare(right.destination)),
        }));
      const transactionLibrary = importedLibrary(options.entries.filter((entry) => affectedRefs.has(entry.sessionRef)));
      const journal = await prepareClaudeTransaction({
        stateDirectory: options.stateDirectory,
        configRoot: plan.configRoot,
        effects,
        resources,
        sessions: transactionSessions,
        importedLibrary: transactionLibrary,
      });
      const committed = await executePreparedClaudeTransaction(options.stateDirectory, journal);
      return resultFromPlan(plan, transactionReference(committed.id));
    },
  };
}
