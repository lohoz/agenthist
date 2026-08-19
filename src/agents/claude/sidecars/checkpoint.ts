import path from "node:path";

import { pathFlavorForPlatform, pathIdentity, samePath } from "../../../domain/host-path.js";
import { canonicalClaudeUuid } from "../identity.js";
import { forEachClaudeJsonlRecord } from "../jsonl.js";

const BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@v([1-9][0-9]*)$/;
const EDIT_TOOLS: ReadonlyMap<string, string> = new Map([
  ["Write", "file_path"],
  ["Edit", "file_path"],
  ["NotebookEdit", "notebook_path"],
] as const);

export interface ClaudeCheckpointFile {
  readonly relativePath: string;
  readonly role: "checkpoint-backup";
  readonly filePath: string;
  readonly mode: number;
}

export interface ClaudeCheckpointBinding {
  readonly trackingPath: string;
  readonly backupFileName: string;
  readonly version: number;
  readonly file: ClaudeCheckpointFile;
}

export interface ClaudeCheckpointEditPath {
  readonly trackingPath: string;
  readonly referencePath: string;
  readonly sourceCwd: string;
}

export interface ClaudeCheckpointClosure {
  readonly backups: readonly ClaudeCheckpointBinding[];
  readonly editPaths: readonly ClaudeCheckpointEditPath[];
  readonly realParentDirectories: readonly string[];
}

interface BackupReference {
  readonly backupFileName: string | null;
  readonly version: number;
  readonly realParentDir?: string;
}

interface EditRecord {
  readonly cwd: string;
  readonly paths: ReadonlySet<string>;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathParts(relativePath: string): string[] {
  const parts = relativePath.split("/");
  return parts[0] === "claude" ? parts.slice(1) : parts;
}

export function validClaudeCheckpointMode(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0o777 &&
    (value & 0o400) !== 0;
}

export function claudeCheckpointPathName(relativePath: string, sessionId: string): string | undefined {
  const parts = pathParts(relativePath);
  if (parts.length !== 3 || parts[0] !== "file-history" || parts[1] !== sessionId ||
    BACKUP_NAME.exec(parts[2]!) === null) return undefined;
  return parts[2];
}

function uuid(value: unknown, description: string): string {
  if (typeof value !== "string") throw new Error(`Claude checkpoint ${description} is missing`);
  try { return canonicalClaudeUuid(value); }
  catch { throw new Error(`Claude checkpoint ${description} is invalid`); }
}

function timestamp(value: unknown): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("Claude checkpoint timestamp is invalid");
  }
}

function trackingPath(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.includes("\0") || path.isAbsolute(value) ||
    path.normalize(value) !== value || value === "." || value === ".." || value.startsWith(`..${path.sep}`)) {
    throw new Error("Claude checkpoint tracking path is outside the session workspace");
  }
  return value;
}

function backupReference(value: unknown): BackupReference {
  const backup = objectValue(value);
  if (backup === undefined || !Number.isSafeInteger(backup.version) || (backup.version as number) < 1) {
    throw new Error("Claude checkpoint backup reference is incomplete");
  }
  timestamp(backup.backupTime);
  const version = backup.version as number;
  let realParentDir: string | undefined;
  if (backup.realParentDir !== undefined) {
    if (typeof backup.realParentDir !== "string" || backup.realParentDir.includes("\0") ||
      !path.isAbsolute(backup.realParentDir) || path.normalize(backup.realParentDir) !== backup.realParentDir) {
      throw new Error("Claude checkpoint real parent directory is invalid");
    }
    realParentDir = backup.realParentDir;
  }
  if (backup.backupFileName === null) {
    return { backupFileName: null, version, ...(realParentDir === undefined ? {} : { realParentDir }) };
  }
  if (typeof backup.backupFileName !== "string") {
    throw new Error("Claude checkpoint backup filename is invalid");
  }
  const matched = BACKUP_NAME.exec(backup.backupFileName);
  if (matched === null || Number(matched[1]) !== version) {
    throw new Error("Claude checkpoint backup version is inconsistent");
  }
  return {
    backupFileName: backup.backupFileName,
    version,
    ...(realParentDir === undefined ? {} : { realParentDir }),
  };
}

function editRecord(record: Record<string, unknown>): EditRecord | undefined {
  if (record.type !== "assistant" || record.isSidechain === true) return undefined;
  const message = objectValue(record.message);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const paths = new Set<string>();
  for (const raw of message.content) {
    const block = objectValue(raw);
    if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
    const field = EDIT_TOOLS.get(block.name);
    if (field === undefined) continue;
    const input = objectValue(block.input);
    const filePath = input?.[field];
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
      throw new Error("Claude checkpoint edit tool path is invalid");
    }
    paths.add(filePath);
  }
  if (paths.size === 0) return undefined;
  if (typeof record.cwd !== "string" || !path.isAbsolute(record.cwd) || path.normalize(record.cwd) !== record.cwd) {
    throw new Error("Claude checkpoint edit record cwd is invalid");
  }
  return { cwd: record.cwd, paths };
}

export async function validateClaudeCheckpoints(options: {
  readonly transcriptPath: string;
  readonly files: readonly ClaudeCheckpointFile[];
  readonly sessionId: string;
}): Promise<ClaudeCheckpointClosure> {
  const files = new Map<string, ClaudeCheckpointFile>();
  for (const file of options.files) {
    const name = claudeCheckpointPathName(file.relativePath, options.sessionId);
    if (name === undefined || !validClaudeCheckpointMode(file.mode) || files.has(name)) {
      throw new Error("Claude checkpoint backup carrier is invalid");
    }
    files.set(name, file);
  }

  const users = new Set<string>();
  const edits = new Map<string, EditRecord>();
  const snapshots = new Set<string>();
  const snapshotReferences = new Map<string, readonly (readonly [string, unknown])[]>();
  const deltas: Array<{
    readonly messageId: string;
    readonly snapshotMessageId: string;
    readonly trackingPath: string;
  }> = [];
  const references = new Map<string, {
    readonly trackingPath: string;
    readonly version: number;
    readonly realParentDir?: string;
  }>();
  const realParentDirectories = new Set<string>();
  const pathFlavor = pathFlavorForPlatform();

  const claim = (rawPath: unknown, rawBackup: unknown): void => {
    const ownedPath = trackingPath(rawPath);
    const backup = backupReference(rawBackup);
    if (backup.realParentDir !== undefined) realParentDirectories.add(backup.realParentDir);
    if (backup.backupFileName === null) return;
    const previous = references.get(backup.backupFileName);
    if (previous !== undefined &&
      (previous.trackingPath !== ownedPath || previous.version !== backup.version ||
        (previous.realParentDir !== undefined && backup.realParentDir !== undefined &&
          !samePath(previous.realParentDir, backup.realParentDir, pathFlavor)))) {
      throw new Error("Claude checkpoint backup has conflicting transcript references");
    }
    const realParentDir = previous?.realParentDir ?? backup.realParentDir;
    references.set(backup.backupFileName, {
      trackingPath: ownedPath,
      version: backup.version,
      ...(realParentDir === undefined ? {} : { realParentDir }),
    });
  };

  await forEachClaudeJsonlRecord(options.transcriptPath, (record) => {
    if (record.sessionId !== undefined && record.sessionId !== options.sessionId) {
      throw new Error("Claude checkpoint record belongs to another session");
    }
    if (record.type === "user" && record.isSidechain !== true) {
      users.add(uuid(record.uuid, "user message ID"));
    }
    if (record.type === "assistant") {
      const edit = editRecord(record);
      if (edit !== undefined) {
        const messageId = uuid(record.uuid, "edit message ID");
        if (edits.has(messageId)) throw new Error("Claude checkpoint edit message is duplicated");
        edits.set(messageId, edit);
      }
      return;
    }
    if (record.type === "file-history-snapshot") {
      if (record.agentId !== undefined) throw new Error("Claude subagent checkpoint is unsupported");
      const messageId = uuid(record.messageId, "snapshot message ID");
      const snapshot = objectValue(record.snapshot);
      const backups = objectValue(snapshot?.trackedFileBackups);
      if (snapshot === undefined || snapshot.messageId !== messageId || backups === undefined ||
        (record.isSnapshotUpdate !== undefined && typeof record.isSnapshotUpdate !== "boolean")) {
        throw new Error("Claude checkpoint snapshot is incomplete");
      }
      timestamp(snapshot.timestamp);
      snapshots.add(messageId);
      // Claude resolves repeated snapshot updates by message ID with the last
      // record winning. Stale references from an earlier update are not part of
      // the rewind state and their backup may already have been evicted.
      snapshotReferences.set(messageId, Object.entries(backups));
      return;
    }
    if (record.type === "file-history-delta") {
      if (record.agentId !== undefined) throw new Error("Claude subagent checkpoint is unsupported");
      const messageId = uuid(record.messageId, "delta edit message ID");
      const snapshotMessageId = uuid(record.snapshotMessageId, "delta snapshot message ID");
      const ownedPath = trackingPath(record.trackingPath);
      timestamp(record.timestamp);
      claim(ownedPath, record.backup);
      deltas.push({ messageId, snapshotMessageId, trackingPath: ownedPath });
    }
  });

  if ([...snapshots].some((messageId) => !users.has(messageId))) {
    throw new Error("Claude checkpoint snapshot is not linked to a user message");
  }
  for (const entries of snapshotReferences.values()) {
    for (const [ownedPath, backup] of entries) claim(ownedPath, backup);
  }
  const editPaths = new Map<string, {
    readonly trackingPath: string;
    readonly referencePath: string;
    readonly sourceCwd: string;
  }>();
  for (const delta of deltas) {
    const edit = edits.get(delta.messageId);
    const referencePath = edit === undefined ? "" : path.resolve(edit.cwd, delta.trackingPath);
    if (
      edit === undefined || !snapshots.has(delta.snapshotMessageId) ||
      ![...edit.paths].some((candidate) => samePath(candidate, referencePath, pathFlavor))
    ) {
      throw new Error("Claude checkpoint delta is not linked to its edit and snapshot");
    }
    const identity = pathIdentity(referencePath, pathFlavor);
    const previous = editPaths.get(identity);
    if (previous !== undefined &&
      (previous.trackingPath !== delta.trackingPath || !samePath(previous.sourceCwd, edit.cwd, pathFlavor))) {
      throw new Error("Claude checkpoint edit path has conflicting tracking paths");
    }
    editPaths.set(identity, {
      trackingPath: delta.trackingPath,
      referencePath,
      sourceCwd: edit.cwd,
    });
  }

  const bindings: ClaudeCheckpointBinding[] = [];
  for (const [name, reference] of references) {
    const file = files.get(name);
    if (file === undefined) throw new Error("Claude checkpoint backup carrier closure is incomplete");
    bindings.push({
      trackingPath: reference.trackingPath,
      backupFileName: name,
      version: reference.version,
      file,
    });
  }
  if (bindings.length !== files.size) throw new Error("Claude checkpoint backup carrier is unreferenced");
  return {
    backups: bindings.sort((left, right) => left.file.relativePath.localeCompare(right.file.relativePath)),
    editPaths: [...editPaths.values()].map((edit) => ({
      trackingPath: edit.trackingPath,
      referencePath: edit.referencePath,
      sourceCwd: edit.sourceCwd,
    })).sort((left, right) => left.referencePath.localeCompare(right.referencePath)),
    realParentDirectories: [...realParentDirectories].sort(),
  };
}
