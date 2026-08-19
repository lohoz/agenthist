import path from "node:path";

import type {
  ArchiveEntry,
  ArchiveManifest,
  ArchiveObjectBinding,
} from "../../../domain/archive.js";
import type { AgentSnapshot, JsonValue, StoredSession } from "../../../domain/history.js";
import type { ArchiveObjectSource } from "../../../infrastructure/archive.js";
import { snapshotRawPath } from "../../../infrastructure/history-store.js";
import { canonicalPiSessionId, piSessionRef } from "../identity.js";
import { parsePiSession } from "../history/session.js";

export interface PiNativeDescriptor {
  readonly relativePath: string;
  readonly fileName: string;
  readonly mode: number;
  readonly parentSession: string | null;
  readonly parentSessionRef: string | null;
  readonly relationStatus: "verified" | "external_parent";
  readonly migrationBlockers: readonly string[];
  readonly leafId: string | null;
  readonly roots: number;
  readonly branchPoints: number;
  readonly entries: number;
  readonly messages: number;
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function integer(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function readPiNativeDescriptor(value: Pick<StoredSession, "native"> | Pick<ArchiveEntry, "native">): PiNativeDescriptor {
  const native = objectValue(value.native);
  const carrier = objectValue(native?.carrier);
  const header = objectValue(native?.header);
  const tree = objectValue(native?.tree);
  const blockers = native?.migrationBlockers;
  const relativePath = carrier?.relativePath;
  const fileName = carrier?.fileName;
  const mode = integer(carrier?.mode);
  const parentSession = header?.parentSession;
  const parentSessionRef = native?.parentSessionRef;
  const relationStatus = native?.relationStatus;
  const leafId = tree?.leafId;
  const roots = integer(tree?.roots);
  const branchPoints = integer(tree?.branchPoints);
  const entries = integer(tree?.entries);
  const messages = integer(tree?.messages);
  if (
    typeof relativePath !== "string" || !relativePath.startsWith("pi/") || path.posix.normalize(relativePath) !== relativePath ||
    relativePath.split("/").includes("..") || typeof fileName !== "string" || fileName !== path.posix.basename(relativePath) ||
    mode === undefined || mode > 0o777 || header?.version !== 3 ||
    !(parentSession === null || typeof parentSession === "string") ||
    !(parentSessionRef === null || typeof parentSessionRef === "string") ||
    (relationStatus !== "verified" && relationStatus !== "external_parent") ||
    !Array.isArray(blockers) || blockers.some((item) => typeof item !== "string") ||
    !(leafId === null || typeof leafId === "string") || roots === undefined || branchPoints === undefined ||
    entries === undefined || messages === undefined
  ) throw new Error("Pi native history descriptor is invalid");
  return {
    relativePath,
    fileName,
    mode,
    parentSession,
    parentSessionRef,
    relationStatus,
    migrationBlockers: blockers as string[],
    leafId,
    roots,
    branchPoints,
    entries,
    messages,
  };
}

function closePiSessions(all: readonly StoredSession[], selected: readonly StoredSession[]): StoredSession[] {
  const byReference = new Map(all.filter((session) => session.agent === "pi").map((session) => [session.sessionRef, session]));
  const included = new Set(selected.map((session) => session.sessionRef));
  const visiting = new Set<string>();
  const close = (sessionRef: string): void => {
    if (visiting.has(sessionRef)) throw new Error(`Pi parent session graph contains a cycle: ${sessionRef}`);
    visiting.add(sessionRef);
    const session = byReference.get(sessionRef);
    if (session === undefined) throw new Error(`Pi parent session closure is incomplete: ${sessionRef}`);
    const descriptor = readPiNativeDescriptor(session);
    if (descriptor.migrationBlockers.length !== 0) {
      throw new Error(`Pi session cannot be exported without losing native history: ${sessionRef}`);
    }
    if (descriptor.parentSessionRef !== null && !included.has(descriptor.parentSessionRef)) {
      included.add(descriptor.parentSessionRef);
      close(descriptor.parentSessionRef);
    }
    visiting.delete(sessionRef);
  };
  for (const sessionRef of [...included]) close(sessionRef);
  return all.filter((session) => session.agent === "pi" && included.has(session.sessionRef))
    .sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
}

export function closePiEntrySelection(
  all: readonly ArchiveEntry[],
  selected: ReadonlySet<string>,
): ReadonlySet<string> {
  const byReference = new Map(all.filter((entry) => entry.agent === "pi").map((entry) => [entry.sessionRef, entry]));
  const result = new Set(selected);
  const visiting = new Set<string>();
  const close = (sessionRef: string): void => {
    if (visiting.has(sessionRef)) throw new Error(`Pi parent session graph contains a cycle: ${sessionRef}`);
    const entry = byReference.get(sessionRef);
    if (entry === undefined) return;
    visiting.add(sessionRef);
    const descriptor = readPiNativeDescriptor(entry);
    if (descriptor.parentSessionRef !== null) {
      if (!byReference.has(descriptor.parentSessionRef)) {
        throw new Error(`Pi parent session closure is incomplete: ${sessionRef}`);
      }
      if (!result.has(descriptor.parentSessionRef)) result.add(descriptor.parentSessionRef);
      close(descriptor.parentSessionRef);
    }
    visiting.delete(sessionRef);
  };
  for (const sessionRef of [...selected]) close(sessionRef);
  return result;
}

export interface PreparedPiArchive {
  readonly sessions: readonly StoredSession[];
  readonly sources: readonly ArchiveObjectSource[];
  readonly bindings: ReadonlyMap<string, readonly ArchiveObjectBinding[]>;
}

export function preparePiArchive(
  stateDirectory: string,
  snapshot: AgentSnapshot,
  selected: readonly StoredSession[],
  allocateObjectId: () => string,
): PreparedPiArchive {
  if (snapshot.agent !== "pi" || selected.some((session) => session.agent !== "pi")) {
    throw new Error("Pi archive received another Agent");
  }
  const sessions = closePiSessions(snapshot.sessions, selected);
  const sources: ArchiveObjectSource[] = [];
  const bindings = new Map<string, readonly ArchiveObjectBinding[]>();
  for (const session of sessions) {
    const descriptor = readPiNativeDescriptor(session);
    if (session.rawFiles.length !== 1 || session.rawFiles[0] !== descriptor.relativePath) {
      throw new Error(`Pi session cannot be exported without losing native history: ${session.sessionRef}`);
    }
    const id = allocateObjectId();
    sources.push({
      id,
      kind: "pi.session-jsonl",
      filePath: snapshotRawPath(stateDirectory, snapshot, descriptor.relativePath),
    });
    bindings.set(session.sessionRef, [{ id, role: "session", relativePath: descriptor.relativePath }]);
  }
  return { sessions, sources, bindings };
}

export function validatePiArchiveEntries(
  entries: readonly ArchiveEntry[],
  objects: ReadonlyMap<string, ArchiveManifest["objects"][number]>,
): void {
  const references = new Set(entries.map((entry) => entry.sessionRef));
  for (const entry of entries) {
    const descriptor = readPiNativeDescriptor(entry);
    const binding = entry.objects[0];
    if (
      entry.agent !== "pi" || piSessionRef(canonicalPiSessionId(entry.nativeId)) !== entry.sessionRef ||
      entry.nativeArchived || entry.objects.length !== 1 || binding?.role !== "session" ||
      binding.relativePath !== descriptor.relativePath || objects.get(binding.id)?.kind !== "pi.session-jsonl" ||
      descriptor.migrationBlockers.length !== 0 ||
      (descriptor.parentSessionRef !== null && !references.has(descriptor.parentSessionRef))
    ) throw new Error(`Pi archive entry is invalid: ${entry.sessionRef}`);
  }
}

export async function validatePiArchiveObjects(
  entries: readonly ArchiveEntry[],
  extracted: ReadonlyMap<string, string>,
): Promise<void> {
  for (const entry of entries) {
    const binding = entry.objects[0]!;
    const file = extracted.get(binding.id);
    if (file === undefined) throw new Error(`Pi archive session is missing: ${entry.sessionRef}`);
    const parsed = await parsePiSession(file, entry.updatedAt);
    const descriptor = readPiNativeDescriptor(entry);
    if (
      parsed.header.id !== entry.nativeId || piSessionRef(parsed.header.id) !== entry.sessionRef ||
      parsed.header.cwd !== entry.context || parsed.header.parentSession !== (descriptor.parentSession ?? undefined) ||
      parsed.title !== entry.title || parsed.model !== entry.model || parsed.provider !== entry.provider ||
      parsed.createdAt !== entry.createdAt || parsed.updatedAt !== entry.updatedAt ||
      parsed.leafId !== descriptor.leafId || parsed.roots !== descriptor.roots ||
      parsed.branchPoints !== descriptor.branchPoints || parsed.entries.length !== descriptor.entries ||
      parsed.messageCount !== descriptor.messages
    ) throw new Error(`Pi archive metadata disagrees with its session: ${entry.sessionRef}`);
  }
}
