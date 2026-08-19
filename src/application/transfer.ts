import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { agentAdapter } from "../agents/registry.js";
import { AGENTS, type Agent } from "../domain/agent.js";
import type { ArchiveEntry, ArchiveManifest, ArchiveObjectBinding } from "../domain/archive.js";
import { libraryState, type AgentSnapshot, type LibraryState, type StoredSession } from "../domain/history.js";
import { managedResourceReference, type ManagedResourceReference } from "../domain/resource.js";
import { pathFlavorForPlatform } from "../domain/host-path.js";
import {
  readArchive,
  writeArchive,
  type ArchiveObjectSource,
  type ArchiveWriteResult,
} from "../infrastructure/archive.js";
import { loadSnapshot, pathsOverlap } from "../infrastructure/history-store.js";
import { withStateReadLock } from "../infrastructure/state.js";
import { validateArchiveObjects, validateArchiveSemantics } from "./archive-validation.js";

export interface ExportHistoryOptions {
  readonly stateDirectory: string;
  readonly output?: string;
  readonly cwd?: string;
  readonly agents?: readonly Agent[];
  readonly sessions?: readonly string[];
}

export interface ArchiveArtifactResult {
  readonly file: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly entries: number;
  readonly objects: number;
  readonly resources: number;
}

export interface ExportHistoryResult extends ArchiveArtifactResult {
  readonly agents: readonly { readonly agent: Agent; readonly sessions: number }[];
}

export interface ExportHistoryPlanItem {
  readonly agent: Agent;
  readonly sessionRef: string;
  readonly title: string;
}

export interface ExportHistoryPlan {
  readonly file: string;
  readonly entries: number;
  readonly objects: number;
  readonly resources: number;
  readonly agents: readonly { readonly agent: Agent; readonly sessions: number }[];
  readonly items: readonly ExportHistoryPlanItem[];
}

export interface InspectedHistoryEntry {
  readonly sessionRef: string;
  readonly agent: Agent;
  readonly title: string;
  readonly context: string;
  readonly nativeArchived: boolean;
  readonly libraryState: LibraryState;
  readonly tags: readonly string[];
  readonly objects: number;
  readonly resources: readonly ManagedResourceReference[];
}

export interface InspectedArchiveWorkspace {
  readonly source: string;
  readonly agents: readonly Agent[];
  readonly sessions: number;
}

export interface InspectArchiveResult {
  readonly file: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly entries: readonly InspectedHistoryEntry[];
  readonly workspaces: readonly InspectedArchiveWorkspace[];
  readonly totalEntries: number;
  readonly returnedEntries: number;
  readonly remainingEntries: number;
  readonly totalResources: number;
  readonly nextCursor?: string;
}

export interface InspectArchiveOptions {
  readonly agents?: readonly Agent[];
  readonly sessions?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

function archiveEntry(session: StoredSession, objects: readonly ArchiveObjectBinding[]): ArchiveEntry {
  return {
    kind: "history",
    agent: session.agent,
    sessionRef: session.sessionRef,
    nativeId: session.nativeId,
    title: session.title,
    context: session.context,
    model: session.model,
    provider: session.provider,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    nativeArchived: session.nativeArchived,
    library: session.library,
    objects,
    resources: [],
    native: session.native,
  };
}

function selectSessions(all: readonly StoredSession[], selected: readonly string[]): StoredSession[] {
  if (selected.length === 0) {
    return [...all];
  }
  const requested = new Set(selected);
  const matches = all.filter((session) => requested.has(session.sessionRef));
  if (matches.length !== requested.size) {
    const found = new Set(matches.map((session) => session.sessionRef));
    const missing = [...requested].find((reference) => !found.has(reference));
    throw new Error(`selected history session was not found: ${missing ?? "unknown"}`);
  }
  return matches;
}

async function selectedSnapshots(stateDirectory: string, selected?: readonly Agent[]): Promise<AgentSnapshot[]> {
  const agents = selected ?? AGENTS;
  const snapshots: AgentSnapshot[] = [];
  for (const agent of agents) {
    const snapshot = await loadSnapshot(stateDirectory, agent);
    if (snapshot === undefined) {
      if (selected !== undefined) throw new Error(`no scanned ${agent} history is available to export`);
      continue;
    }
    snapshots.push(snapshot);
  }
  if (snapshots.length === 0) throw new Error("no scanned history is available to export");
  return snapshots;
}

function defaultArchiveName(cwd: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.join(cwd, `agenthist-${timestamp}-${randomUUID().slice(0, 8)}.agenthist`);
}

export function archiveArtifactResult(result: ArchiveWriteResult): ArchiveArtifactResult {
  return {
    file: result.file,
    sizeBytes: result.sizeBytes,
    sha256: result.sha256,
    entries: result.manifest.entries.length,
    objects: result.manifest.objects.length,
    resources: new Set(result.manifest.entries.flatMap((entry) =>
      entry.resources.map((resource) => resource.id))).size,
  };
}

function exportResult(result: ArchiveWriteResult): ExportHistoryResult {
  return {
    ...archiveArtifactResult(result),
    agents: AGENTS.flatMap((agent) => {
      const sessions = result.manifest.entries.filter((entry) => entry.agent === agent).length;
      return sessions === 0 ? [] : [{ agent, sessions }];
    }),
  };
}

interface PreparedExport {
  readonly output: string;
  readonly sources: readonly ArchiveObjectSource[];
  readonly entries: readonly ArchiveEntry[];
}

function exportAgentCounts(entries: readonly ArchiveEntry[]): ExportHistoryPlan["agents"] {
  return AGENTS.flatMap((agent) => {
    const sessions = entries.filter((entry) => entry.agent === agent).length;
    return sessions === 0 ? [] : [{ agent, sessions }];
  });
}

async function prepareExport(
  options: ExportHistoryOptions,
  workspace: string,
): Promise<PreparedExport> {
  const snapshots = await selectedSnapshots(options.stateDirectory, options.agents);
  const all = snapshots.flatMap((snapshot) => snapshot.sessions);
  const selected = selectSessions(all, options.sessions ?? []);
  if (selected.length === 0) {
    throw new Error("no history sessions are available to export");
  }
  const output = path.resolve(options.cwd ?? process.cwd(), options.output ?? defaultArchiveName(options.cwd ?? process.cwd()));
  if (pathsOverlap(options.stateDirectory, output)) {
    throw new Error("archive output cannot be inside AgentHist state");
  }
  const sources: ArchiveObjectSource[] = [];
  const entries: ArchiveEntry[] = [];
  let objectNumber = 0;
  for (const agent of AGENTS) {
    const snapshot = snapshots.find((candidate) => candidate.agent === agent);
    const sessions = selected.filter((session) => session.agent === agent);
    if (snapshot === undefined || sessions.length === 0) continue;
    const prepared = await agentAdapter(agent).archive.prepare({
      stateDirectory: options.stateDirectory,
      snapshot,
      sessions,
      workspace,
      allocateObjectId: () => {
        objectNumber++;
        return `o${objectNumber.toString().padStart(6, "0")}`;
      },
    });
    sources.push(...prepared.sources);
    entries.push(...prepared.sessions.map((session) => {
      const bindings = prepared.bindings.get(session.sessionRef);
      if (bindings === undefined) throw new Error(`${agent} export bindings are missing: ${session.sessionRef}`);
      return archiveEntry(session, bindings);
    }));
  }
  entries.sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
  if (entries.length === 0) throw new Error("no history sessions are available to export");
  return { output, sources, entries };
}

async function exportHistoryUnlocked(options: ExportHistoryOptions): Promise<ExportHistoryResult> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-export-"));
  try {
    const prepared = await prepareExport(options, workspace);
    const written = await writeArchive(prepared.output, prepared.sources, (objects): ArchiveManifest => {
      const manifest: ArchiveManifest = {
        schemaVersion: "agenthist.archive/v1",
        createdAt: new Date().toISOString(),
        pathFlavor: pathFlavorForPlatform(),
        entries: prepared.entries,
        objects,
      };
      validateArchiveSemantics(manifest);
      return manifest;
    });
    return exportResult(written);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function planExportHistoryUnlocked(options: ExportHistoryOptions): Promise<ExportHistoryPlan> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-export-plan-"));
  try {
    const prepared = await prepareExport(options, workspace);
    return {
      file: prepared.output,
      entries: prepared.entries.length,
      objects: prepared.sources.length,
      resources: 0,
      agents: exportAgentCounts(prepared.entries),
      items: prepared.entries.map((entry) => ({
        agent: entry.agent,
        sessionRef: entry.sessionRef,
        title: entry.library.name || entry.title,
      })),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export function exportHistory(options: ExportHistoryOptions): Promise<ExportHistoryResult> {
  return withStateReadLock(options.stateDirectory, () => exportHistoryUnlocked(options));
}

export function planExportHistory(options: ExportHistoryOptions): Promise<ExportHistoryPlan> {
  return withStateReadLock(options.stateDirectory, () => planExportHistoryUnlocked(options));
}

export const DEFAULT_INSPECT_LIMIT = 50;
export const MAX_INSPECT_LIMIT = 200;
const INSPECT_CURSOR_PREFIX = "ahcursor1_";

function inspectCursor(sessionRef: string): string {
  return `${INSPECT_CURSOR_PREFIX}${Buffer.from(sessionRef, "utf8").toString("base64url")}`;
}

function parseInspectCursor(value: string): string {
  if (!value.startsWith(INSPECT_CURSOR_PREFIX)) throw new Error("inspect cursor is invalid");
  const encoded = value.slice(INSPECT_CURSOR_PREFIX.length);
  if (encoded === "") throw new Error("inspect cursor is invalid");
  const sessionRef = Buffer.from(encoded, "base64url").toString("utf8");
  if (sessionRef === "" || Buffer.from(sessionRef, "utf8").toString("base64url") !== encoded) {
    throw new Error("inspect cursor is invalid");
  }
  return sessionRef;
}

function inspectSelection(
  manifest: ArchiveManifest,
  options: InspectArchiveOptions,
): readonly ArchiveEntry[] {
  const selectedAgents = options.agents === undefined ? undefined : new Set(options.agents);
  let entries = manifest.entries.filter((entry) => selectedAgents?.has(entry.agent) ?? true);
  if (selectedAgents !== undefined && entries.length === 0) {
    throw new Error("archive has no history for the selected Agent");
  }
  const requestedSessions = new Set(options.sessions ?? []);
  if (requestedSessions.size !== 0) {
    const available = new Set(entries.map((entry) => entry.sessionRef));
    const missing = [...requestedSessions].find((sessionRef) => !available.has(sessionRef));
    if (missing !== undefined) throw new Error(`selected history session was not found: ${missing}`);
    entries = entries.filter((entry) => requestedSessions.has(entry.sessionRef));
  }
  if (entries.length === 0) throw new Error("archive has no history entries");
  return entries.toSorted((left, right) => left.sessionRef.localeCompare(right.sessionRef));
}

function inspectedEntry(entry: ArchiveEntry): InspectedHistoryEntry {
  return {
    sessionRef: entry.sessionRef,
    agent: entry.agent,
    title: entry.library.name || entry.title,
    context: entry.context,
    nativeArchived: entry.nativeArchived,
    libraryState: libraryState(entry.library),
    tags: entry.library.tags,
    objects: entry.objects.length,
    resources: entry.resources.map(managedResourceReference),
  };
}

function inspectedWorkspaces(entries: readonly ArchiveEntry[]): readonly InspectedArchiveWorkspace[] {
  const groups = new Map<string, { readonly agents: Set<Agent>; sessions: number }>();
  for (const entry of entries) {
    let group = groups.get(entry.context);
    if (group === undefined) {
      group = { agents: new Set(), sessions: 0 };
      groups.set(entry.context, group);
    }
    group.agents.add(entry.agent);
    group.sessions++;
  }
  return [...groups.entries()]
    .map(([source, group]): InspectedArchiveWorkspace => ({
      source,
      agents: AGENTS.filter((agent) => group.agents.has(agent)),
      sessions: group.sessions,
    }))
    .toSorted((left, right) => left.source.localeCompare(right.source));
}

export async function inspectHistoryArchive(
  filePath: string,
  options: InspectArchiveOptions = {},
): Promise<InspectArchiveResult> {
  const limit = options.limit ?? DEFAULT_INSPECT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INSPECT_LIMIT) {
    throw new Error(`inspect limit must be between 1 and ${MAX_INSPECT_LIMIT}`);
  }
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-inspect-"));
  try {
    const result = await readArchive(path.resolve(filePath), workspace);
    validateArchiveSemantics(result.manifest, result.extractedObjects);
    await validateArchiveObjects(result.manifest, result.extractedObjects);
    const selected = inspectSelection(result.manifest, options);
    let offset = 0;
    if (options.cursor !== undefined) {
      const after = parseInspectCursor(options.cursor);
      const index = selected.findIndex((entry) => entry.sessionRef === after);
      if (index < 0) throw new Error("inspect cursor does not belong to the current selection");
      offset = index + 1;
    }
    const page = selected.slice(offset, offset + limit);
    const remainingEntries = Math.max(0, selected.length - offset - page.length);
    const last = page.at(-1);
    return {
      file: result.file,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
      entries: page.map(inspectedEntry),
      workspaces: inspectedWorkspaces(selected),
      totalEntries: selected.length,
      returnedEntries: page.length,
      remainingEntries,
      totalResources: new Set(selected.flatMap((entry) => entry.resources.map((resource) => resource.id))).size,
      ...(remainingEntries === 0 || last === undefined ? {} : { nextCursor: inspectCursor(last.sessionRef) }),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
