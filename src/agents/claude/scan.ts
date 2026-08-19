import path from "node:path";

import type { AgentSnapshot, StoredSession } from "../../domain/history.js";
import { copyStableFile } from "../../infrastructure/files.js";
import {
  createSnapshotWorkspace,
  discardSnapshot,
  ensureStateDirectory,
  loadSnapshot,
  publishSnapshot,
  reuseSnapshotFile,
} from "../../infrastructure/history-store.js";
import {
  incrementalSourceKey,
  metadataFingerprint,
  reusableNativeSessionMap,
  scanState,
} from "../incremental-scan.js";
import { discoverClaudeCarriers, sameClaudeInventory, type ClaudeCarrier } from "./carrier.js";
import { validateClaudeCheckpoints, type ClaudeCheckpointFile } from "./sidecars/checkpoint.js";
import { claudeSessionRef } from "./identity.js";
import { requireClaudeSource, resolveClaudeSource, type ClaudeSourceOptions } from "./source.js";
import { validateClaudeSubagentBundles, type ClaudeSubagentFile } from "./sidecars/subagent.js";
import { validateClaudeTaskList, type ClaudeTaskFile } from "./sidecars/task.js";
import { validateClaudeToolResults, type ClaudeToolResultFile } from "./sidecars/tool-result.js";
import { parseClaudeTranscript } from "./history/transcript.js";

export interface ScanClaudeOptions extends ClaudeSourceOptions {
  readonly stateDirectory: string;
  readonly importedLibrary?: ReadonlyMap<string, StoredSession["library"]>;
}

export interface ScanClaudeResult {
  readonly stateDirectory: string;
  readonly snapshot: AgentSnapshot;
}

function rawRelative(carrier: ClaudeCarrier): string {
  return `claude/${carrier.relativePath}`;
}

function relatedTo(main: ClaudeCarrier, candidate: ClaudeCarrier): boolean {
  if (candidate.sessionCandidate !== main.sessionCandidate) return false;
  return candidate.role === "checkpoint" || candidate.role === "checkpoint-backup" ||
    candidate.role === "task-entry" || candidate.role === "task-highwatermark" ||
    candidate.projectCarrier === main.projectCarrier && (
      candidate.role === "session-sidecar" || candidate.role === "subagent-transcript" ||
      candidate.role === "subagent-metadata" || candidate.role === "tool-result"
    );
}

function blockers(related: readonly ClaudeCarrier[]): string[] {
  const result = new Set<string>();
  for (const carrier of related) {
    if (carrier.role === "checkpoint") result.add("claude.native.checkpoint_rewind_unfrozen");
  }
  return [...result].sort();
}

interface ReusableClaudeSession {
  readonly session: StoredSession;
  readonly rawFiles: readonly string[];
  readonly fingerprint: string;
}

function claudeSessionFingerprint(main: ClaudeCarrier, related: readonly ClaudeCarrier[]): string {
  return metadataFingerprint("claude-session/v1", [main, ...related].map((carrier) => [
    rawRelative(carrier),
    carrier.role,
    carrier.projectCarrier ?? "",
    carrier.sessionCandidate ?? "",
    carrier.fingerprint,
  ]));
}

export async function scanClaude(options: ScanClaudeOptions): Promise<ScanClaudeResult> {
  const source = resolveClaudeSource(options);
  await requireClaudeSource(source);
  await ensureStateDirectory(options.stateDirectory, [source.configRoot]);
  const before = await discoverClaudeCarriers(source.configRoot);
  const mains = before.filter((carrier) => carrier.role === "main");
  if (mains.length === 0) throw new Error("Claude Code has no supported persisted sessions");
  const previous = await loadSnapshot(options.stateDirectory, "claude");
  const sourceKey = incrementalSourceKey("claude", [source.configRoot]);
  const previousByNativeId = reusableNativeSessionMap(previous, sourceKey);
  const previousLibrary = new Map(previous?.sessions.map((session) => [session.sessionRef, session.library]));
  const reusable = new Map<string, ReusableClaudeSession>();
  const reusableFiles = new Set<string>();
  for (const main of mains) {
    const related = before.filter((carrier) => relatedTo(main, carrier));
    const rawFiles = [main, ...related].map(rawRelative).sort();
    const fingerprint = claudeSessionFingerprint(main, related);
    const cached = previousByNativeId.get(main.sessionCandidate!);
    if (
      cached?.scan?.fingerprint !== fingerprint || cached.rawFiles.length !== rawFiles.length ||
      !cached.rawFiles.every((file, index) => file === rawFiles[index])
    ) continue;
    reusable.set(main.relativePath, { session: cached, rawFiles, fingerprint });
    rawFiles.forEach((file) => reusableFiles.add(file));
  }
  const workspace = await createSnapshotWorkspace(options.stateDirectory, "claude");
  try {
    for (const carrier of before) {
      const relativePath = rawRelative(carrier);
      if (reusableFiles.has(relativePath)) {
        await reuseSnapshotFile(options.stateDirectory, previous!, relativePath, workspace);
      } else {
        await copyStableFile(carrier.sourcePath, path.join(workspace.rawRoot, ...relativePath.split("/")));
      }
    }
    const after = await discoverClaudeCarriers(source.configRoot);
    if (!sameClaudeInventory(before, after)) throw new Error("Claude Code history changed while scanning");

    const sessions: StoredSession[] = [];
    const assigned = new Set<string>();
    const seenReferences = new Set<string>();
    const warnings: string[] = [];
    let reusedSessions = 0;
    for (const main of mains) {
      const cached = reusable.get(main.relativePath);
      if (cached !== undefined) {
        cached.rawFiles.forEach((relative) => assigned.add(relative));
        if (seenReferences.has(cached.session.sessionRef)) {
          throw new Error(`Claude Code logical session appears in multiple carriers: ${cached.session.nativeId}`);
        }
        seenReferences.add(cached.session.sessionRef);
        warnings.push(...(previous?.warnings.filter((warning) => warning.includes(cached.session.nativeId)) ?? []));
        sessions.push({
          ...cached.session,
          library: previousLibrary.get(cached.session.sessionRef) ??
            options.importedLibrary?.get(cached.session.sessionRef) ?? {
              name: "", tags: [], archived: false, deleted: false,
            },
          scan: { fingerprint: cached.fingerprint },
        });
        reusedSessions++;
        continue;
      }
      const mainRelative = rawRelative(main);
      const parsed = await parseClaudeTranscript(
        path.join(workspace.rawRoot, ...mainRelative.split("/")),
        main.sessionCandidate!,
        main.modifiedAt,
      );
      const related = before.filter((carrier) => relatedTo(main, carrier));
      const fingerprint = claudeSessionFingerprint(main, related);
      const sessionBlockers = blockers(related);
      const validationDetails: string[] = [];
      const subagentFiles: ClaudeSubagentFile[] = related.flatMap((carrier) =>
        carrier.role === "subagent-transcript" || carrier.role === "subagent-metadata"
          ? [{
              relativePath: rawRelative(carrier),
              role: carrier.role,
              filePath: path.join(workspace.rawRoot, ...rawRelative(carrier).split("/")),
            }]
          : []);
      let subagentSearchText: readonly string[] = [];
      try {
        const bundles = await validateClaudeSubagentBundles({
          mainTranscriptPath: path.join(workspace.rawRoot, ...mainRelative.split("/")),
          sessionId: parsed.nativeId,
          projectCarrier: main.projectCarrier!,
          allowedCwds: [...new Set([...parsed.observedCwds, parsed.context])],
          files: subagentFiles,
        });
        subagentSearchText = [...new Set(bundles.flatMap((bundle) => bundle.searchText))];
      } catch {
        sessionBlockers.push("claude.native.subagent_bundle_unverified");
        sessionBlockers.sort();
      }
      const taskFiles: ClaudeTaskFile[] = related.flatMap((carrier) =>
        carrier.role === "task-entry" || carrier.role === "task-highwatermark"
          ? [{
              relativePath: rawRelative(carrier),
              role: carrier.role,
              filePath: path.join(workspace.rawRoot, ...rawRelative(carrier).split("/")),
            }]
          : []);
      let taskSearchText: readonly string[] = [];
      try {
        taskSearchText = (await validateClaudeTaskList({ sessionId: parsed.nativeId, files: taskFiles })).searchText;
      } catch {
        sessionBlockers.push("claude.native.task_list_unverified");
        sessionBlockers.sort();
      }
      const toolResultFiles: ClaudeToolResultFile[] = related.flatMap((carrier) =>
        carrier.role === "tool-result"
          ? [{ relativePath: rawRelative(carrier), role: carrier.role, filePath: path.join(
              workspace.rawRoot,
              ...rawRelative(carrier).split("/"),
            ) }]
          : []);
      try {
        await validateClaudeToolResults({
          transcripts: [
            path.join(workspace.rawRoot, ...mainRelative.split("/")),
            ...subagentFiles.filter((file) => file.role === "subagent-transcript").map((file) => file.filePath),
          ],
          files: toolResultFiles,
          sessionId: parsed.nativeId,
          projectCarrier: main.projectCarrier!,
          expectedConfigRoot: source.configRoot,
        });
      } catch {
        sessionBlockers.push("claude.native.tool_result_closure_unverified");
        sessionBlockers.sort();
      }
      const checkpointFiles: ClaudeCheckpointFile[] = related.flatMap((carrier) =>
        carrier.role === "checkpoint-backup"
          ? [{
              relativePath: rawRelative(carrier),
              role: carrier.role,
              filePath: path.join(workspace.rawRoot, ...rawRelative(carrier).split("/")),
              mode: carrier.mode,
            }]
          : []);
      try {
        await validateClaudeCheckpoints({
          transcriptPath: path.join(workspace.rawRoot, ...mainRelative.split("/")),
          files: checkpointFiles,
          sessionId: parsed.nativeId,
        });
      } catch (error) {
        sessionBlockers.push("claude.native.checkpoint_closure_unverified");
        sessionBlockers.sort();
        validationDetails.push(
          `checkpoint closure: ${error instanceof Error ? error.message : "validation failed"}`,
        );
      }
      const rawFiles = [main, ...related].map(rawRelative).sort();
      rawFiles.forEach((relative) => assigned.add(relative));
      const sessionRef = claudeSessionRef(parsed.nativeId, parsed.firstRootRecordUuid);
      if (seenReferences.has(sessionRef)) {
        throw new Error(`Claude Code logical session appears in multiple carriers: ${parsed.nativeId}`);
      }
      seenReferences.add(sessionRef);
      if (sessionBlockers.length !== 0) {
        warnings.push(
          `Claude Code session ${parsed.nativeId} has native migration blockers: ${sessionBlockers.join(", ")}` +
          (validationDetails.length === 0 ? "" : ` (${validationDetails.join("; ")})`),
        );
      }
      sessions.push({
        sessionRef,
        agent: "claude",
        nativeId: parsed.nativeId,
        title: parsed.title,
        context: parsed.context,
        model: parsed.model,
        provider: "",
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        nativeArchived: false,
        library: previousLibrary.get(sessionRef) ?? options.importedLibrary?.get(sessionRef) ?? {
          name: "", tags: [], archived: false, deleted: false,
        },
        conversation: parsed.conversation,
        searchText: [...new Set([...subagentSearchText, ...taskSearchText])],
        rawFiles,
        native: {
          carrier: {
            mainRelativePath: mainRelative,
            projectCarrier: main.projectCarrier!,
            relatedFiles: related.map((carrier) => ({
              relativePath: rawRelative(carrier),
              role: carrier.role,
              ...(carrier.role === "checkpoint-backup" ? { mode: carrier.mode } : {}),
            })),
          },
          identity: { firstRootRecordUuid: parsed.firstRootRecordUuid },
          transcript: parsed.nativeSummary,
          relationStatus: "verified",
          migrationBlockers: sessionBlockers,
        },
        scan: { fingerprint },
      });
    }
    sessions.sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
    const auxiliaryFiles = before.map(rawRelative).filter((relative) => !assigned.has(relative)).sort();
    if (auxiliaryFiles.length !== 0) {
      warnings.push(`captured ${auxiliaryFiles.length} unassigned Claude Code history carrier(s)`);
    }
    const snapshot: AgentSnapshot = {
      schemaVersion: "agenthist.history-snapshot/v2",
      snapshotId: workspace.id,
      agent: "claude",
      scannedAt: new Date().toISOString(),
      sessions,
      auxiliaryFiles,
      warnings,
      scan: scanState(sourceKey, previous, sessions, reusedSessions),
    };
    warnings.push(...await publishSnapshot(options.stateDirectory, workspace, snapshot));
    return { stateDirectory: options.stateDirectory, snapshot };
  } catch (error) {
    await discardSnapshot(workspace);
    throw error;
  }
}
