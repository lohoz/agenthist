import { lstat, open } from "node:fs/promises";

import type {
  ArchiveEntry,
  ArchiveManifest,
  ArchiveObjectBinding,
} from "../../../domain/archive.js";
import type { AgentSnapshot, JsonValue, StoredSession } from "../../../domain/history.js";
import { samePath, type PathFlavor } from "../../../domain/host-path.js";
import type { ArchiveObjectSource } from "../../../infrastructure/archive.js";
import { snapshotRawPath } from "../../../infrastructure/history-store.js";
import {
  threadSpawnComponents,
  validateThreadDynamicTools,
  validateThreadSpawnEdge,
  type ThreadDynamicToolRow,
  type ThreadSpawnEdgeRow,
} from "../storage/database.js";
import { validateThreadGoalRow, type ThreadGoalRow } from "../storage/goals.js";
import { canonicalCodexSessionId, codexSessionRef } from "../identity.js";
import { parseCodexRollout, type CodexHistoryBase } from "../history/rollout.js";
import {
  threadSectionRowsEqual,
  validateThreadSectionRow,
  type ThreadSectionRow,
} from "../storage/sections.js";

function objectValue(value: JsonValue | undefined): { readonly [key: string]: JsonValue } | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function readCodexDynamicTools(
  session: Pick<StoredSession, "agent" | "native" | "nativeId" | "sessionRef">,
): ThreadDynamicToolRow[] {
  if (session.agent !== "codex") throw new Error(`Codex native state belongs to another Agent: ${session.sessionRef}`);
  const native = objectValue(session.native);
  return validateThreadDynamicTools(native?.dynamicTools, session.nativeId);
}

export function readCodexGoal(
  session: Pick<StoredSession, "agent" | "native" | "nativeId" | "sessionRef">,
): ThreadGoalRow | null {
  if (session.agent !== "codex") throw new Error(`Codex goal state belongs to another Agent: ${session.sessionRef}`);
  const native = objectValue(session.native);
  if (native?.goal === null) return null;
  try {
    return validateThreadGoalRow(native?.goal, session.nativeId);
  } catch {
    throw new Error(`Codex goal state is invalid: ${session.sessionRef}`);
  }
}

export function readCodexSection(
  session: Pick<StoredSession, "agent" | "native" | "nativeId" | "sessionRef">,
): ThreadSectionRow | null {
  if (session.agent !== "codex") throw new Error(`Codex section state belongs to another Agent: ${session.sessionRef}`);
  const native = objectValue(session.native);
  const thread = objectValue(native?.thread);
  let section: ThreadSectionRow | null;
  try {
    section = native?.section === null ? null : validateThreadSectionRow(native?.section);
  } catch {
    throw new Error(`Codex section state is invalid: ${session.sessionRef}`);
  }
  const sectionId = thread?.thread_section_id;
  if (
    section === null
      ? sectionId !== undefined && sectionId !== null
      : sectionId !== section.id
  ) {
    throw new Error(`Codex section state is invalid: ${session.sessionRef}`);
  }
  return section;
}

export interface CodexLineageDescriptor {
  readonly historyMode: "legacy" | "paginated";
  readonly sessionId: string;
  readonly subagentHistoryStartOrdinal: number | null;
  readonly forkedFromId: string | null;
  readonly parentThreadId: string | null;
  readonly historyBase: CodexHistoryBase | null;
}

export interface CodexSpawnDescriptor {
  readonly incoming: ThreadSpawnEdgeRow | null;
  readonly componentNativeIds: readonly string[];
  readonly relationStatus: "valid" | "invalid" | "unknown";
}

export function readCodexSpawn(
  session: Pick<StoredSession, "agent" | "native" | "nativeId" | "sessionRef">,
): CodexSpawnDescriptor {
  if (session.agent !== "codex") throw new Error(`Codex spawn state belongs to another Agent: ${session.sessionRef}`);
  const native = objectValue(session.native);
  const spawn = objectValue(native?.spawn);
  const component = Array.isArray(spawn?.componentNativeIds) ? spawn.componentNativeIds : undefined;
  let incoming: ThreadSpawnEdgeRow | null;
  try {
    incoming = spawn?.incoming === null
      ? null
      : validateThreadSpawnEdge(spawn?.incoming, session.nativeId);
  } catch {
    throw new Error(`Codex spawn descriptor is invalid: ${session.sessionRef}`);
  }
  if (
    spawn === undefined ||
    Object.keys(spawn).sort().join("\0") !== "componentNativeIds\0incoming\0relationStatus" ||
    (spawn.relationStatus !== "valid" && spawn.relationStatus !== "invalid" && spawn.relationStatus !== "unknown") ||
    component === undefined || component.length === 0 ||
    component.some((id) => typeof id !== "string")
  ) throw new Error(`Codex spawn descriptor is invalid: ${session.sessionRef}`);
  const canonical = (component as string[]).map((id) => {
    try {
      return canonicalCodexSessionId(id);
    } catch {
      throw new Error(`Codex spawn descriptor is invalid: ${session.sessionRef}`);
    }
  });
  if (
    canonical.some((id, index) => id !== component[index]) ||
    canonical.some((id, index) => index !== 0 && canonical[index - 1]! >= id) ||
    !canonical.includes(session.nativeId)
  ) throw new Error(`Codex spawn descriptor is invalid: ${session.sessionRef}`);
  return { incoming, componentNativeIds: canonical, relationStatus: spawn.relationStatus };
}

export function readCodexUnsupportedRelationStatus(
  session: Pick<StoredSession, "agent" | "native" | "sessionRef">,
): "empty" | "present" | "unknown" {
  if (session.agent !== "codex") throw new Error(`Codex relation state belongs to another Agent: ${session.sessionRef}`);
  const native = objectValue(session.native);
  const status = native?.unsupportedRelationStatus;
  if (status !== "empty" && status !== "present" && status !== "unknown") {
    throw new Error(`Codex unsupported relation state is invalid: ${session.sessionRef}`);
  }
  return status;
}

function lineageId(value: JsonValue | undefined): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  try {
    return canonicalCodexSessionId(value);
  } catch {
    return undefined;
  }
}

function historyBaseValue(value: JsonValue | undefined): CodexHistoryBase | null | undefined {
  if (value === null) return null;
  const base = objectValue(value);
  if (
    base === undefined || Object.keys(base).sort().join("\0") !== "endByteOffset\0endOrdinalExclusive\0threadId" ||
    typeof base.threadId !== "string" ||
    typeof base.endOrdinalExclusive !== "number" || !Number.isSafeInteger(base.endOrdinalExclusive) ||
    base.endOrdinalExclusive <= 0 ||
    typeof base.endByteOffset !== "number" || !Number.isSafeInteger(base.endByteOffset) || base.endByteOffset <= 0
  ) return undefined;
  try {
    return {
      threadId: canonicalCodexSessionId(base.threadId),
      endOrdinalExclusive: base.endOrdinalExclusive,
      endByteOffset: base.endByteOffset,
    };
  } catch {
    return undefined;
  }
}

export function readCodexLineage(
  session: Pick<StoredSession, "agent" | "native" | "nativeId" | "sessionRef">,
): CodexLineageDescriptor {
  if (session.agent !== "codex") throw new Error(`Codex lineage belongs to another Agent: ${session.sessionRef}`);
  const native = objectValue(session.native);
  const lineage = objectValue(native?.lineage);
  const forkedFromId = lineageId(lineage?.forkedFromId);
  const parentThreadId = lineageId(lineage?.parentThreadId);
  const sessionId = lineageId(lineage?.sessionId);
  const subagentHistoryStartOrdinal = lineage?.subagentHistoryStartOrdinal;
  const historyBase = historyBaseValue(lineage?.historyBase);
  if (
    lineage === undefined ||
    Object.keys(lineage).sort().join("\0") !==
      "forkedFromId\0historyBase\0historyMode\0parentThreadId\0sessionId\0subagentHistoryStartOrdinal" ||
    (lineage.historyMode !== "legacy" && lineage.historyMode !== "paginated") ||
    sessionId === undefined || sessionId === null ||
    forkedFromId === undefined || parentThreadId === undefined || historyBase === undefined ||
    (subagentHistoryStartOrdinal !== null && (
      typeof subagentHistoryStartOrdinal !== "number" ||
      !Number.isSafeInteger(subagentHistoryStartOrdinal) || subagentHistoryStartOrdinal < 1 ||
      parentThreadId === null || sessionId === session.nativeId
    )) ||
    (sessionId !== session.nativeId && parentThreadId === null) ||
    forkedFromId === session.nativeId || parentThreadId === session.nativeId || historyBase?.threadId === session.nativeId ||
    (lineage.historyMode === "legacy" && (historyBase !== null || subagentHistoryStartOrdinal !== null)) ||
    (historyBase !== null && subagentHistoryStartOrdinal !== null)
  ) throw new Error(`Codex lineage descriptor is invalid: ${session.sessionRef}`);
  return {
    historyMode: lineage.historyMode,
    sessionId,
    subagentHistoryStartOrdinal,
    forkedFromId,
    parentThreadId,
    historyBase,
  };
}

function lineageDependencies(lineage: CodexLineageDescriptor): string[] {
  return lineage.historyBase === null ? [] : [lineage.historyBase.threadId];
}

function closureDependencies(
  session: Pick<StoredSession, "agent" | "native" | "nativeId" | "sessionRef">,
): string[] {
  const lineage = readCodexLineage(session);
  const spawn = readCodexSpawn(session);
  if (spawn.relationStatus !== "valid") throw new Error(`Codex spawn relation closure is invalid: ${session.sessionRef}`);
  return [...new Set([
    ...lineageDependencies(lineage),
    ...(lineage.parentThreadId === null ? [] : [lineage.parentThreadId]),
    ...spawn.componentNativeIds,
  ])];
}

function closeCodexNativeIds<T extends Pick<StoredSession, "agent" | "native" | "nativeId" | "sessionRef">>(
  all: readonly T[],
  selected: readonly T[],
): Set<string> {
  const byNativeId = new Map(all.filter((item) => item.agent === "codex").map((item) => [item.nativeId, item]));
  const included = new Set(selected.map((item) => item.nativeId));
  const queue = [...selected];
  while (queue.length !== 0) {
    const item = queue.shift()!;
    for (const nativeId of closureDependencies(item)) {
      const dependency = byNativeId.get(nativeId);
      if (dependency === undefined) throw new Error(`Codex migration closure is incomplete: ${item.sessionRef}`);
      if (included.has(nativeId)) continue;
      included.add(nativeId);
      queue.push(dependency);
    }
  }
  return included;
}

export function orderCodexLineage<
  T extends Pick<StoredSession, "agent" | "native" | "nativeId" | "sessionRef">,
>(items: readonly T[]): T[] {
  const byNativeId = new Map(items.map((item) => [item.nativeId, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: T[] = [];
  const visit = (item: T): void => {
    if (visiting.has(item.nativeId)) throw new Error(`Codex history lineage contains a cycle: ${item.sessionRef}`);
    if (visited.has(item.nativeId)) return;
    visiting.add(item.nativeId);
    for (const dependencyId of lineageDependencies(readCodexLineage(item))) {
      const dependency = byNativeId.get(dependencyId);
      if (dependency === undefined) throw new Error(`Codex history lineage is incomplete: ${item.sessionRef}`);
      visit(dependency);
    }
    visiting.delete(item.nativeId);
    visited.add(item.nativeId);
    ordered.push(item);
  };
  for (const item of items) visit(item);
  return ordered;
}

type CodexMigratableSession = Pick<
  StoredSession,
  "agent" | "native" | "nativeArchived" | "nativeId" | "sessionRef"
>;

interface ValidatedCodexSession {
  readonly lineage: CodexLineageDescriptor;
  readonly section: ThreadSectionRow | null;
  readonly spawn: CodexSpawnDescriptor;
}

function validateCodexRolloutPath(
  session: CodexMigratableSession,
  relativePath: string,
): ValidatedCodexSession {
  if (session.agent !== "codex" || codexSessionRef(session.nativeId) !== session.sessionRef) {
    throw new Error(`Codex session identity is invalid: ${session.sessionRef}`);
  }
  const components = relativePath.split("/");
  if (
    relativePath.startsWith("/") || components.includes("") || components.includes(".") || components.includes("..") ||
    !relativePath.endsWith(".jsonl") ||
    (components[0] !== "sessions" && components[0] !== "archived_sessions") ||
    (components[0] === "archived_sessions") !== session.nativeArchived
  ) throw new Error(`Codex rollout carrier is invalid: ${session.sessionRef}`);
  const native = objectValue(session.native);
  const rollout = objectValue(native?.rollout);
  const thread = objectValue(native?.thread);
  readCodexDynamicTools(session);
  readCodexGoal(session);
  const section = readCodexSection(session);
  const lineage = readCodexLineage(session);
  const spawn = readCodexSpawn(session);
  if (thread === undefined) throw new Error(`Codex session has no restorable thread row: ${session.sessionRef}`);
  if (readCodexUnsupportedRelationStatus(session) !== "empty") {
    throw new Error(`Codex session has unsupported native relations: ${session.sessionRef}`);
  }
  if (spawn.relationStatus !== "valid") {
    throw new Error(`Codex spawn relation closure is invalid: ${session.sessionRef}`);
  }
  if (rollout?.relativePath !== relativePath || rollout.archived !== session.nativeArchived) {
    throw new Error(`Codex native descriptor is invalid: ${session.sessionRef}`);
  }
  return { lineage, section, spawn };
}

function validateCodexSelection<T extends CodexMigratableSession>(
  sessions: readonly T[],
  rolloutPath: (session: T) => string,
): void {
  const byNativeId = new Map(sessions.map((session) => [session.nativeId, session]));
  const validated = new Map<string, ValidatedCodexSession>();
  const spawnEdges = new Map<string, ThreadSpawnEdgeRow>();
  const sections = new Map<string, ThreadSectionRow>();
  for (const session of sessions) {
    const state = validateCodexRolloutPath(session, rolloutPath(session));
    validated.set(session.nativeId, state);
    for (const dependency of lineageDependencies(state.lineage)) {
      if (!byNativeId.has(dependency)) throw new Error(`Codex archive lineage is incomplete: ${session.sessionRef}`);
    }
    if (state.lineage.parentThreadId !== null && !byNativeId.has(state.lineage.parentThreadId)) {
      throw new Error(`Codex archive parent thread is incomplete: ${session.sessionRef}`);
    }
    if (state.lineage.parentThreadId !== null && state.lineage.sessionId !== session.nativeId) {
      const parent = byNativeId.get(state.lineage.parentThreadId)!;
      if (state.lineage.sessionId !== readCodexLineage(parent).sessionId) {
        throw new Error(`Codex archive session tree identity is invalid: ${session.sessionRef}`);
      }
    }
    for (const member of state.spawn.componentNativeIds) {
      if (!byNativeId.has(member)) throw new Error(`Codex archive spawn component is incomplete: ${session.sessionRef}`);
    }
    if (state.spawn.incoming !== null) spawnEdges.set(session.nativeId, state.spawn.incoming);
    if (state.section !== null) {
      const existing = sections.get(state.section.id as string);
      if (
        existing !== undefined &&
        (!threadSectionRowsEqual(existing, state.section) || !threadSectionRowsEqual(state.section, existing))
      ) {
        throw new Error(`Codex section definition disagrees (${String(state.section.id)}): ${session.sessionRef}`);
      }
      sections.set(state.section.id as string, state.section);
    }
    if (
      state.lineage.historyBase !== null &&
      readCodexLineage(byNativeId.get(state.lineage.historyBase.threadId)!).historyMode !== "paginated"
    ) throw new Error(`Codex paginated history base is invalid: ${session.sessionRef}`);
  }
  orderCodexLineage(sessions);
  const graph = threadSpawnComponents(new Set(byNativeId.keys()), spawnEdges);
  const invalidThreadId = [...graph.invalidThreadIds].sort()[0];
  if (invalidThreadId !== undefined) {
    throw new Error(`Codex spawn graph is incomplete: ${byNativeId.get(invalidThreadId)!.sessionRef}`);
  }
  for (const session of sessions) {
    const expected = graph.components.get(session.nativeId) ?? [session.nativeId];
    if (JSON.stringify(validated.get(session.nativeId)!.spawn.componentNativeIds) !== JSON.stringify(expected)) {
      throw new Error(`Codex archive spawn component is invalid: ${session.sessionRef}`);
    }
  }
}

function storedCodexRolloutPath(session: StoredSession): string {
  if (session.rawFiles.length !== 1) {
    throw new Error(`Codex session does not have one portable rollout: ${session.sessionRef}`);
  }
  return session.rawFiles[0]!;
}

export function closeCodexSelection(snapshot: AgentSnapshot, selected: readonly StoredSession[]): StoredSession[] {
  if (snapshot.agent !== "codex") throw new Error("Codex selection received another Agent snapshot");
  for (const session of selected) validateCodexRolloutPath(session, storedCodexRolloutPath(session));
  const included = closeCodexNativeIds(snapshot.sessions, selected);
  const sessions = snapshot.sessions
    .filter((session) => included.has(session.nativeId))
    .sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
  validateCodexSelection(sessions, storedCodexRolloutPath);
  return sessions;
}

export interface PreparedCodexArchive {
  readonly sessions: readonly StoredSession[];
  readonly sources: readonly ArchiveObjectSource[];
  readonly bindings: ReadonlyMap<string, readonly ArchiveObjectBinding[]>;
}

export function prepareCodexArchive(
  stateDirectory: string,
  snapshot: AgentSnapshot,
  selected: readonly StoredSession[],
  allocateObjectId: () => string,
): PreparedCodexArchive {
  const sessions = closeCodexSelection(snapshot, selected);
  const sources: ArchiveObjectSource[] = [];
  const bindings = new Map<string, readonly ArchiveObjectBinding[]>();
  for (const session of sessions) {
    const sessionBindings = session.rawFiles.map((relativePath): ArchiveObjectBinding => {
      const id = allocateObjectId();
      sources.push({
        id,
        kind: "codex.rollout",
        filePath: snapshotRawPath(stateDirectory, snapshot, relativePath),
      });
      return { id, role: "rollout", relativePath };
    });
    bindings.set(session.sessionRef, sessionBindings);
  }
  return { sessions, sources, bindings };
}

export function closeCodexEntrySelection(
  all: readonly ArchiveEntry[],
  selected: ReadonlySet<string>,
): ReadonlySet<string> {
  const selectedEntries = all.filter((entry) => entry.agent === "codex" && selected.has(entry.sessionRef));
  const includedNativeIds = closeCodexNativeIds(all, selectedEntries);
  const result = new Set(selected);
  for (const entry of all) {
    if (entry.agent === "codex" && includedNativeIds.has(entry.nativeId)) result.add(entry.sessionRef);
  }
  return result;
}

export function validateCodexArchiveEntries(
  entries: readonly ArchiveEntry[],
  objects: ReadonlyMap<string, ArchiveManifest["objects"][number]>,
): void {
  for (const entry of entries) {
    const binding = entry.objects[0];
    if (
      entry.agent !== "codex" || codexSessionRef(entry.nativeId) !== entry.sessionRef ||
      entry.objects.length !== 1 || binding === undefined || binding.role !== "rollout" ||
      objects.get(binding.id)?.kind !== "codex.rollout"
    ) throw new Error(`Codex archive entry is invalid: ${entry.sessionRef}`);
  }
  validateCodexSelection(entries, (entry) => entry.objects[0]!.relativePath);
}

function parsedLineage(parsed: Awaited<ReturnType<typeof parseCodexRollout>>): CodexLineageDescriptor {
  return {
    historyMode: parsed.historyMode,
    sessionId: parsed.sessionId,
    subagentHistoryStartOrdinal: parsed.subagentHistoryStartOrdinal ?? null,
    forkedFromId: parsed.forkedFromId ?? null,
    parentThreadId: parsed.parentThreadId ?? null,
    historyBase: parsed.historyBase ?? null,
  };
}

function lineageEqual(left: CodexLineageDescriptor, right: CodexLineageDescriptor): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function validateCodexHistoryBaseBoundary(
  file: string,
  historyBase: CodexHistoryBase,
  metadataEndByteOffset: number,
  sessionRef: string,
): Promise<void> {
  const info = await lstat(file);
  if (
    !info.isFile() || info.isSymbolicLink() || historyBase.endByteOffset > info.size ||
    historyBase.endByteOffset < metadataEndByteOffset
  ) {
    throw new Error(`Codex paginated history base is outside its rollout: ${sessionRef}`);
  }
  const handle = await open(file, "r");
  try {
    const byte = Buffer.allocUnsafe(1);
    const read = await handle.read(byte, 0, 1, historyBase.endByteOffset - 1);
    if (read.bytesRead !== 1 || byte[0] !== 0x0a) {
      throw new Error(`Codex paginated history base is not a complete JSONL prefix: ${sessionRef}`);
    }
  } finally {
    await handle.close();
  }
}

export async function validateCodexArchiveObjects(
  entries: readonly ArchiveEntry[],
  extracted: ReadonlyMap<string, string>,
  pathFlavor: PathFlavor,
): Promise<void> {
  const byNativeId = new Map(entries.map((entry) => [entry.nativeId, entry]));
  const parsedByNativeId = new Map<string, Awaited<ReturnType<typeof parseCodexRollout>>>();
  for (const entry of entries) {
    const binding = entry.objects[0]!;
    const file = extracted.get(binding.id);
    if (file === undefined) throw new Error(`Codex rollout object is missing: ${entry.sessionRef}`);
    const parsed = await parseCodexRollout(file);
    if (
      parsed.nativeId !== entry.nativeId || !samePath(parsed.cwd, entry.context, pathFlavor) ||
      parsed.provider !== entry.provider ||
      (entry.model !== "" && parsed.model !== entry.model) || !lineageEqual(readCodexLineage(entry), parsedLineage(parsed))
    ) throw new Error(`Codex archive metadata disagrees with its rollout: ${entry.sessionRef}`);
    parsedByNativeId.set(entry.nativeId, parsed);
  }
  for (const entry of entries) {
    const parsed = parsedByNativeId.get(entry.nativeId)!;
    const historyBase = parsed.historyBase;
    if (historyBase !== undefined) {
      const baseEntry = byNativeId.get(historyBase.threadId)!;
      const baseBinding = baseEntry.objects[0]!;
      const baseFile = extracted.get(baseBinding.id);
      if (baseFile === undefined) throw new Error(`Codex paginated history base is missing: ${entry.sessionRef}`);
      const baseMetadata = parsedByNativeId.get(historyBase.threadId)!;
      await validateCodexHistoryBaseBoundary(baseFile, historyBase, baseMetadata.metadataEndByteOffset, entry.sessionRef);
    }
  }
}
