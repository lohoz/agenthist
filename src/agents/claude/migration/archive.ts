import path from "node:path";

import type { ArchiveEntry, ArchiveManifest, ArchiveObjectBinding } from "../../../domain/archive.js";
import type { AgentSnapshot, JsonValue, StoredSession } from "../../../domain/history.js";
import type { ArchiveObjectSource } from "../../../infrastructure/archive.js";
import { snapshotRawPath } from "../../../infrastructure/history-store.js";
import {
  claudeCheckpointPathName,
  validClaudeCheckpointMode,
  validateClaudeCheckpoints,
  type ClaudeCheckpointFile,
} from "../sidecars/checkpoint.js";
import { claudeSessionRef, canonicalClaudeUuid } from "../identity.js";
import { claudeSessionSidecarIdentity } from "../sidecars/sidecar.js";
import {
  claudeSubagentPathIdentity,
  validateClaudeSubagentBundles,
  type ClaudeSubagentFile,
  type ClaudeSubagentFileRole,
} from "../sidecars/subagent.js";
import {
  claudeTaskPathIdentity,
  validateClaudeTaskList,
  type ClaudeTaskFile,
} from "../sidecars/task.js";
import {
  claudeToolResultPathName,
  validateClaudeToolResults,
  type ClaudeToolResultFile,
} from "../sidecars/tool-result.js";
import { parseClaudeTranscript } from "../history/transcript.js";

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function strings(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? [...value] : undefined;
}

function claudeSessionMode(
  session: Pick<StoredSession, "native" | "sessionRef">,
): "" | "normal" | "coordinator" {
  const transcript = objectValue(objectValue(session.native)?.transcript);
  const mode = transcript?.sessionMode;
  if (mode !== "" && mode !== "normal" && mode !== "coordinator") {
    throw new Error(`Claude Code captured session mode is invalid: ${session.sessionRef}`);
  }
  return mode;
}

export interface ClaudeDescriptor {
  readonly mainRelativePath: string;
  readonly projectCarrier: string;
  readonly firstRootRecordUuid: string;
  readonly blockers: readonly string[];
  readonly relatedFiles: readonly ClaudeRelatedFileDescriptor[];
}

export interface ClaudeRelatedFileDescriptor {
  readonly relativePath: string;
  readonly role: string;
  readonly mode?: number;
}

function relatedFileDescriptors(value: JsonValue | undefined): ClaudeRelatedFileDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: ClaudeRelatedFileDescriptor[] = [];
  for (const raw of value) {
    const item = objectValue(raw);
    if (item === undefined || typeof item.relativePath !== "string" || typeof item.role !== "string") return undefined;
    if (item.mode !== undefined && !validClaudeCheckpointMode(item.mode)) return undefined;
    result.push({
      relativePath: item.relativePath,
      role: item.role,
      ...(item.mode === undefined ? {} : { mode: item.mode }),
    });
  }
  return result;
}

export function readClaudeDescriptor(
  session: Pick<StoredSession, "agent" | "native" | "sessionRef">,
): ClaudeDescriptor {
  const native = objectValue(session.native);
  const carrier = objectValue(native?.carrier);
  const identity = objectValue(native?.identity);
  const mainRelativePath = carrier?.mainRelativePath;
  const projectCarrier = carrier?.projectCarrier;
  const relatedFiles = relatedFileDescriptors(carrier?.relatedFiles);
  const firstRootRecordUuid = identity?.firstRootRecordUuid;
  const blockers = strings(native?.migrationBlockers);
  if (
    session.agent !== "claude" || typeof mainRelativePath !== "string" || typeof projectCarrier !== "string" ||
    relatedFiles === undefined || typeof firstRootRecordUuid !== "string" || blockers === undefined ||
    native?.relationStatus !== "verified"
  ) throw new Error(`Claude Code captured descriptor is invalid: ${session.sessionRef}`);
  canonicalClaudeUuid(firstRootRecordUuid);
  return { mainRelativePath, projectCarrier, firstRootRecordUuid, blockers, relatedFiles };
}

function validateMainPath(relativePath: string, projectCarrier: string, nativeId: string): void {
  const parts = relativePath.split("/");
  if (
    parts.length !== 4 || parts[0] !== "claude" || parts[1] !== "projects" ||
    parts[2] !== projectCarrier || projectCarrier === "" || parts[3] !== `${nativeId}.jsonl` ||
    parts.includes("") || parts.includes(".") || parts.includes("..")
  ) throw new Error("Claude Code main transcript path is invalid");
}

function supportedRelatedFiles(native: ClaudeDescriptor, nativeId: string): ClaudeRelatedFileDescriptor[] {
  const files = [...native.relatedFiles].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const groups = new Map<string, Set<ClaudeSubagentFileRole>>();
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.relativePath)) throw new Error("Claude Code related carrier is duplicated");
    paths.add(file.relativePath);
    if (file.role === "checkpoint-backup") {
      if (claudeCheckpointPathName(file.relativePath, nativeId) === undefined ||
        !validClaudeCheckpointMode(file.mode)) {
        throw new Error("Claude Code checkpoint backup carrier is invalid");
      }
      continue;
    }
    if (file.mode !== undefined) throw new Error("Claude Code related carrier mode is unexpected");
    if (file.role === "task-entry" || file.role === "task-highwatermark") {
      const identity = claudeTaskPathIdentity(file.relativePath);
      if (identity === undefined || identity.sessionId !== nativeId || identity.role !== file.role) {
        throw new Error("Claude Code task carrier path is invalid");
      }
      continue;
    }
    if (file.role === "tool-result") {
      if (claudeToolResultPathName(file.relativePath, native.projectCarrier, nativeId) === undefined) {
        throw new Error("Claude Code tool-result carrier path is invalid");
      }
      continue;
    }
    if (file.role === "session-sidecar") {
      if (
        claudeSessionSidecarIdentity(file.relativePath, native.projectCarrier, nativeId) === undefined ||
        claudeSubagentPathIdentity(file.relativePath, native.projectCarrier, nativeId) !== undefined ||
        claudeToolResultPathName(file.relativePath, native.projectCarrier, nativeId) !== undefined
      ) throw new Error("Claude Code session sidecar path is invalid");
      continue;
    }
    if (file.role !== "subagent-transcript" && file.role !== "subagent-metadata") {
      throw new Error("Claude Code session has an unsupported related carrier");
    }
    const identity = claudeSubagentPathIdentity(file.relativePath, native.projectCarrier, nativeId);
    if (identity === undefined || identity.role !== file.role) {
      throw new Error("Claude Code subagent carrier path is invalid");
    }
    const roles = groups.get(identity.agentId) ?? new Set<ClaudeSubagentFileRole>();
    if (roles.has(identity.role)) throw new Error("Claude Code subagent carrier is duplicated");
    roles.add(identity.role);
    groups.set(identity.agentId, roles);
  }
  if ([...groups.values()].some((roles) => roles.size !== 2)) {
    throw new Error("Claude Code subagent carrier pair is incomplete");
  }
  return files;
}

function objectKind(role: string): string | undefined {
  if (role === "main-transcript") return "claude.main-transcript";
  if (role === "subagent-transcript") return "claude.subagent-transcript";
  if (role === "subagent-metadata") return "claude.subagent-metadata";
  if (role === "tool-result") return "claude.tool-result";
  if (role === "session-sidecar") return "claude.session-sidecar";
  if (role === "checkpoint-backup") return "claude.checkpoint-backup";
  if (role === "task-entry") return "claude.task-entry";
  if (role === "task-highwatermark") return "claude.task-highwatermark";
  return undefined;
}

export interface PreparedClaudeArchive {
  readonly sources: readonly ArchiveObjectSource[];
  readonly bindings: readonly ArchiveObjectBinding[];
}

function requireExportableClaudeSession(
  snapshot: AgentSnapshot,
  session: StoredSession,
): { readonly native: ClaudeDescriptor; readonly related: readonly ClaudeRelatedFileDescriptor[] } {
  if (snapshot.agent !== "claude" || session.agent !== "claude") {
    throw new Error("Claude archive received another Agent");
  }
  const native = readClaudeDescriptor(session);
  validateMainPath(native.mainRelativePath, native.projectCarrier, session.nativeId);
  if (native.blockers.length !== 0) {
    throw new Error(`Claude Code session cannot be exported without losing native history: ${session.sessionRef}`);
  }
  if (claudeSessionMode(session) === "coordinator") {
    throw new Error(`Claude Code coordinator session cannot be exported without team runtime state: ${session.sessionRef}`);
  }
  const related = supportedRelatedFiles(native, session.nativeId);
  const expectedRawFiles = [native.mainRelativePath, ...related.map((file) => file.relativePath)].sort();
  if (JSON.stringify([...session.rawFiles].sort()) !== JSON.stringify(expectedRawFiles)) {
    throw new Error(`Claude Code session cannot be exported without losing native history: ${session.sessionRef}`);
  }
  return { native, related };
}

export function closeClaudeSelection(
  snapshot: AgentSnapshot,
  selected: readonly StoredSession[],
): StoredSession[] {
  for (const session of selected) requireExportableClaudeSession(snapshot, session);
  return [...selected].sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
}

export function prepareClaudeArchive(
  stateDirectory: string,
  snapshot: AgentSnapshot,
  session: StoredSession,
  allocateObjectId: () => string,
): PreparedClaudeArchive {
  const { native, related } = requireExportableClaudeSession(snapshot, session);
  const sources: ArchiveObjectSource[] = [];
  const bindings: ArchiveObjectBinding[] = [];
  for (const file of [
    { relativePath: native.mainRelativePath, role: "main-transcript" },
    ...related,
  ]) {
    const id = allocateObjectId();
    sources.push({ id, kind: objectKind(file.role)!, filePath: snapshotRawPath(stateDirectory, snapshot, file.relativePath) });
    bindings.push({ id, role: file.role, relativePath: file.relativePath });
  }
  return { sources, bindings };
}

export function validateClaudeArchiveEntries(
  entries: readonly ArchiveEntry[],
  objects: ReadonlyMap<string, ArchiveManifest["objects"][number]>,
): void {
  for (const entry of entries) {
    const native = readClaudeDescriptor(entry);
    const related = supportedRelatedFiles(native, entry.nativeId);
    const expected = [
      { relativePath: native.mainRelativePath, role: "main-transcript" },
      ...related,
    ];
    validateMainPath(native.mainRelativePath, native.projectCarrier, entry.nativeId);
    if (
      entry.agent !== "claude" || entry.nativeArchived || entry.provider !== "" ||
      claudeSessionRef(entry.nativeId, native.firstRootRecordUuid) !== entry.sessionRef ||
      native.blockers.length !== 0 || entry.objects.length !== expected.length ||
      new Set(entry.objects.map((binding) => binding.id)).size !== entry.objects.length ||
      expected.some((file, index) => {
        const binding = entry.objects[index];
        return binding === undefined || binding.role !== file.role || binding.relativePath !== file.relativePath ||
          objects.get(binding.id)?.kind !== objectKind(file.role);
      })
    ) throw new Error(`Claude Code archive entry is invalid: ${entry.sessionRef}`);
  }
}

export async function validateClaudeArchiveObjects(
  entries: readonly ArchiveEntry[],
  extracted: ReadonlyMap<string, string>,
): Promise<void> {
  for (const entry of entries) {
    const mainBinding = entry.objects[0]!;
    const file = extracted.get(mainBinding.id);
    if (file === undefined) throw new Error(`Claude Code archive transcript is missing: ${entry.sessionRef}`);
    const native = readClaudeDescriptor(entry);
    const parsed = await parseClaudeTranscript(file, entry.nativeId, entry.updatedAt);
    if (
      parsed.firstRootRecordUuid !== native.firstRootRecordUuid ||
      parsed.sessionMode === "coordinator" ||
      claudeSessionRef(parsed.nativeId, parsed.firstRootRecordUuid) !== entry.sessionRef ||
      parsed.context !== entry.context || parsed.model !== entry.model || parsed.title !== entry.title ||
      parsed.createdAt !== entry.createdAt || parsed.updatedAt !== entry.updatedAt
    ) throw new Error(`Claude Code archive metadata disagrees with its transcript: ${entry.sessionRef}`);
    const bindings = new Map(entry.objects.map((binding) => [binding.relativePath, binding]));
    const related = supportedRelatedFiles(native, entry.nativeId);
    const relatedObjects = new Map(related.map((item) => {
      const binding = bindings.get(item.relativePath);
      const object = binding === undefined ? undefined : extracted.get(binding.id);
      if (object === undefined) throw new Error(`Claude Code archive related object is missing: ${entry.sessionRef}`);
      return [item.relativePath, object] as const;
    }));
    const subagentFiles: ClaudeSubagentFile[] = related.flatMap((item) => {
      const object = relatedObjects.get(item.relativePath)!;
      if (item.role !== "subagent-transcript" && item.role !== "subagent-metadata") return [];
      return [{ relativePath: item.relativePath, role: item.role, filePath: object }];
    });
    try {
      await validateClaudeSubagentBundles({
        mainTranscriptPath: file,
        sessionId: entry.nativeId,
        projectCarrier: native.projectCarrier,
        allowedCwds: [...new Set([...parsed.observedCwds, parsed.context])],
        files: subagentFiles,
      });
      const toolResultFiles: ClaudeToolResultFile[] = related.flatMap((item) => item.role === "tool-result"
        ? [{ relativePath: item.relativePath, role: item.role, filePath: relatedObjects.get(item.relativePath)! }]
        : []);
      await validateClaudeToolResults({
        transcripts: [
          file,
          ...subagentFiles.filter((item) => item.role === "subagent-transcript").map((item) => item.filePath),
        ],
        files: toolResultFiles,
        sessionId: entry.nativeId,
        projectCarrier: native.projectCarrier,
      });
      const checkpointFiles: ClaudeCheckpointFile[] = related.flatMap((item) => item.role === "checkpoint-backup"
        ? [{
            relativePath: item.relativePath,
            role: item.role,
            filePath: relatedObjects.get(item.relativePath)!,
            mode: item.mode!,
          }]
        : []);
      await validateClaudeCheckpoints({
        transcriptPath: file,
        files: checkpointFiles,
        sessionId: entry.nativeId,
      });
      const taskFiles: ClaudeTaskFile[] = related.flatMap((item) =>
        item.role === "task-entry" || item.role === "task-highwatermark"
          ? [{
              relativePath: item.relativePath,
              role: item.role,
              filePath: relatedObjects.get(item.relativePath)!,
            }]
          : []);
      await validateClaudeTaskList({ sessionId: entry.nativeId, files: taskFiles });
    } catch {
      throw new Error(`Claude Code archive related carrier closure is invalid: ${entry.sessionRef}`);
    }
  }
}
