import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  exportHistory as coreExportHistory,
  importHistoryArchive as coreImportHistoryArchive,
  openImportCatalog as coreOpenImportCatalog,
  planExportHistory as corePlanExportHistory,
  type ExportHistoryOptions,
  type ExportHistoryPlan,
  type ExportHistoryResult,
  type ImportHistoryOptions,
  type ImportHistoryResult,
  type ImportCatalog,
  type ImportCatalogEntry,
  type ImportWorkspaceInspection,
} from "../application/index.js";
import { AGENTS, isAgent, type Agent } from "../domain/agent.js";
import { canonicalDigest } from "../domain/history-identity.js";
import { sessionAgent } from "../domain/history.js";
import { normalizeConversionFindings, type ConversionFinding } from "../domain/conversion.js";
import { copyStableFile, digestFile, sameFileStat } from "../infrastructure/files.js";
import type {
  ApplyImportRequest,
  ApplyImportResultDto,
  CancelImportRequest,
  CancelImportResultDto,
  ExportHistoryRequest,
  ExportHistoryResultDto,
  ImportPlanDto,
  ImportRouteDto,
  ImportWorkspaceDto,
  MapImportWorkspaceRequest,
  MapImportWorkspaceResultDto,
  OpenImportResultDto,
  ReplanImportRequest,
} from "./contracts.js";

export const MAX_DESKTOP_IMPORT_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
export const MAX_DESKTOP_TRANSFER_SESSIONS = 100_000;
export const MAX_DESKTOP_TRANSFER_OBJECTS = 100_000;
export const MAX_DESKTOP_IMPORT_HANDLES = 8;
export const DEFAULT_DESKTOP_IMPORT_HANDLE_TTL_MS = 30 * 60 * 1000;

const MAX_PATH_BYTES = 64 * 1024;
const MAX_PATH_MAPPINGS = 128;
const HANDLE = /^ahimport1_[0-9a-f]{64}$/;
const PLAN = /^ahimportplan1_[0-9a-f]{64}$/;

type ImportBaseOptions = Omit<
  ImportHistoryOptions,
  "file" | "stateDirectory" | "mode" | "targetAgent" | "pathMappings" | "sessions" | "agents" |
  "allowLossyConversion"
>;

interface FileObservation {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly device: number;
  readonly inode: number;
}

interface FrozenArchive {
  readonly file: string;
  readonly observation: FileObservation;
}

interface ImportChoices {
  readonly targetAgent?: Agent;
  readonly sessionRefs?: readonly string[];
  readonly allowLossyConversion: boolean;
  readonly pathMappings: readonly string[];
}

interface InternalImportPlan {
  readonly dto: ImportPlanDto;
  readonly observation: FileObservation;
  readonly choices: ImportChoices;
  readonly result?: ImportHistoryResult;
  readonly preflight: ImportWorkspacePreflight;
}

interface ImportWorkspacePreflight {
  readonly catalogEntries: readonly ImportCatalogEntry[];
  readonly entries: readonly ImportCatalogEntry[];
  readonly workspaces: readonly ImportWorkspaceInspection[];
}

interface ImportHandleEntry {
  readonly handle: string;
  readonly sourceFile: string;
  readonly fileName: string;
  readonly workspace: string;
  frozenFile: string;
  plan: InternalImportPlan;
  busy: boolean;
  expired: boolean;
  cleanupInFlight: Promise<void> | undefined;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

export interface DesktopTransferService {
  exportHistory(request: ExportHistoryRequest): Promise<ExportHistoryResultDto>;
  openImport(): Promise<OpenImportResultDto>;
  replanImport(request: ReplanImportRequest): Promise<ImportPlanDto>;
  mapImportWorkspace(
    request: MapImportWorkspaceRequest,
    targetDirectory: string,
  ): Promise<MapImportWorkspaceResultDto>;
  applyImport(request: ApplyImportRequest): Promise<ApplyImportResultDto>;
  cancelImport(request: CancelImportRequest): Promise<CancelImportResultDto>;
  dispose(): Promise<void>;
}

export interface DesktopTransferServiceOptions {
  readonly stateDirectory: string;
  readonly cwd?: string;
  readonly importOptions?: ImportBaseOptions;
  readonly chooseOpenFile: () => Promise<string | undefined>;
  readonly chooseSaveFile: (suggestedName: string) => Promise<string | undefined>;
  readonly planExportHistory?: (options: ExportHistoryOptions) => Promise<ExportHistoryPlan>;
  readonly exportHistory?: (options: ExportHistoryOptions) => Promise<ExportHistoryResult>;
  readonly importHistoryArchive?: (options: ImportHistoryOptions) => Promise<ImportHistoryResult>;
  readonly openImportCatalog?: (file: string, cwd?: string) => Promise<ImportCatalog>;
  readonly digestFile?: typeof digestFile;
  readonly lstat?: typeof lstat;
  readonly copyStableFile?: typeof copyStableFile;
  readonly makeTempDirectory?: () => Promise<string>;
  readonly removeDirectory?: (directory: string) => Promise<void>;
  readonly randomUUID?: () => string;
  readonly now?: () => number;
  readonly importHandleTtlMs?: number;
}

interface Dependencies {
  readonly planExportHistory: (options: ExportHistoryOptions) => Promise<ExportHistoryPlan>;
  readonly exportHistory: (options: ExportHistoryOptions) => Promise<ExportHistoryResult>;
  readonly importHistoryArchive: (options: ImportHistoryOptions) => Promise<ImportHistoryResult>;
  readonly openImportCatalog: (file: string, cwd?: string) => Promise<ImportCatalog>;
  readonly digestFile: typeof digestFile;
  readonly lstat: typeof lstat;
  readonly copyStableFile: typeof copyStableFile;
  readonly makeTempDirectory: () => Promise<string>;
  readonly removeDirectory: (directory: string) => Promise<void>;
  readonly randomUUID: () => string;
  readonly now: () => number;
}

function safeText(value: string, label: string, maximumBytes = MAX_PATH_BYTES): string {
  if (
    typeof value !== "string" || value === "" || /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  ) throw new Error(`${label} is invalid`);
  return value;
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown !== undefined) throw new Error(`${label} has an unknown field: ${unknown}`);
}

function selectedSessions(request: ExportHistoryRequest): readonly string[] | undefined {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("desktop export request is invalid");
  }
  if (request.scope === "all") {
    exactKeys(request, ["scope"], "desktop export request");
    return undefined;
  }
  if (request.scope !== "sessions") throw new Error("desktop export scope is invalid");
  exactKeys(request, ["scope", "sessionRefs"], "desktop export request");
  if (
    !Array.isArray(request.sessionRefs) || request.sessionRefs.length === 0 ||
    request.sessionRefs.length > MAX_DESKTOP_TRANSFER_SESSIONS
  ) throw new Error("desktop export session selection is invalid");
  const references = request.sessionRefs.map((reference) => {
    safeText(reference, "desktop export session reference", 256);
    if (sessionAgent(reference) === undefined) throw new Error("desktop export session reference is invalid");
    return reference;
  });
  if (new Set(references).size !== references.length) {
    throw new Error("desktop export session selection contains duplicates");
  }
  return references;
}

async function requireExportDestination(file: string, deps: Dependencies): Promise<string> {
  safeText(file, "desktop export destination");
  if (!path.isAbsolute(file) || !file.toLowerCase().endsWith(".agenthist")) {
    throw new Error("desktop export destination must be an absolute .agenthist path from the system picker");
  }
  try {
    await deps.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await deps.lstat(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error("desktop export destination parent is not a real directory");
    }
    return path.normalize(file);
  }
  throw new Error("desktop export never overwrites an existing path");
}

function exportOptions(
  stateDirectory: string,
  cwd: string,
  output: string,
  sessions: readonly string[] | undefined,
): ExportHistoryOptions {
  return {
    stateDirectory,
    output,
    cwd,
    ...(sessions === undefined ? {} : { sessions, strictSessions: true }),
  };
}

function assertExportPlan(plan: ExportHistoryPlan, output: string): void {
  if (
    plan.file !== output || !Number.isSafeInteger(plan.entries) || plan.entries < 1 ||
    plan.entries > MAX_DESKTOP_TRANSFER_SESSIONS || !Number.isSafeInteger(plan.objects) ||
    plan.objects < 0 || plan.objects > MAX_DESKTOP_TRANSFER_OBJECTS ||
    !Number.isSafeInteger(plan.resources) || plan.resources < 0 || plan.resources > MAX_DESKTOP_TRANSFER_OBJECTS
  ) throw new Error("desktop export plan exceeds supported limits");
}

function exportDto(result: ExportHistoryResult, output: string): ExportHistoryResultDto {
  if (path.resolve(result.file) !== path.resolve(output)) {
    throw new Error("desktop export wrote an unexpected destination");
  }
  if (
    !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes <= 0 ||
    result.sizeBytes > MAX_DESKTOP_IMPORT_ARCHIVE_BYTES || !/^[0-9a-f]{64}$/.test(result.sha256) ||
    !Number.isSafeInteger(result.entries) || result.entries < 1 ||
    result.entries > MAX_DESKTOP_TRANSFER_SESSIONS || !Number.isSafeInteger(result.objects) ||
    result.objects < 0 || result.objects > MAX_DESKTOP_TRANSFER_OBJECTS ||
    !Number.isSafeInteger(result.resources) || result.resources < 0 ||
    result.resources > MAX_DESKTOP_TRANSFER_OBJECTS
  ) throw new Error("desktop export result exceeds supported limits");
  return {
    status: "completed",
    file: result.file,
    sizeBytes: result.sizeBytes,
    sha256: result.sha256,
    entries: result.entries,
    objects: result.objects,
    resources: result.resources,
    agents: result.agents.map((item) => ({ agent: item.agent, sessions: item.sessions })),
    skipped: result.skippedSessions.map((item) => ({
      agent: item.agent,
      sessionRef: item.sessionRef,
      title: item.title,
      reason: item.reason,
    })),
  };
}

async function observeArchive(file: string, deps: Dependencies): Promise<FileObservation> {
  const before = await deps.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("desktop import source is not a regular file");
  }
  if (before.size <= 0 || before.size > MAX_DESKTOP_IMPORT_ARCHIVE_BYTES) {
    throw new Error("desktop import source exceeds supported size limits");
  }
  const digest = await deps.digestFile(file);
  const after = await deps.lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || !sameFileStat(before, after) || digest.sizeBytes !== after.size) {
    throw new Error("desktop import source changed while being observed");
  }
  return {
    sizeBytes: digest.sizeBytes,
    sha256: digest.sha256,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
    device: after.dev,
    inode: after.ino,
  };
}

function sameObservation(left: FileObservation, right: FileObservation): boolean {
  return left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256 &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.device === right.device && left.inode === right.inode;
}

async function freezeArchive(
  sourceFile: string,
  workspace: string,
  deps: Dependencies,
): Promise<FrozenArchive> {
  const suffix = deps.randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(suffix)) throw new Error("desktop import copy identity is invalid");
  const frozenFile = path.join(workspace, `archive-${suffix}.agenthist`);
  try {
    await deps.copyStableFile(sourceFile, frozenFile);
    const [source, frozen] = await Promise.all([
      observeArchive(sourceFile, deps),
      deps.digestFile(frozenFile),
    ]);
    if (frozen.sizeBytes !== source.sizeBytes || frozen.sha256 !== source.sha256) {
      throw new Error("desktop import private copy differs from the selected archive");
    }
    return { file: frozenFile, observation: source };
  } catch (error) {
    try { await rm(frozenFile, { force: true }); } catch { /* preserve the capture error */ }
    throw error;
  }
}

function validatePickedImport(file: string): string {
  safeText(file, "desktop import source");
  if (!path.isAbsolute(file) || !file.toLowerCase().endsWith(".agenthist")) {
    throw new Error("desktop import source must be an absolute .agenthist path from the system picker");
  }
  return path.normalize(file);
}

function choices(request: ReplanImportRequest): ImportChoices {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("desktop import replan request is invalid");
  }
  exactKeys(
    request,
    ["handle", "targetAgent", "sessionRefs", "allowLossyConversion", "pathMappings"],
    "desktop import replan request",
  );
  if (request.targetAgent !== undefined && !isAgent(request.targetAgent)) {
    throw new Error("desktop import target Agent is invalid");
  }
  if (
    request.pathMappings !== undefined && (!Array.isArray(request.pathMappings) ||
      request.pathMappings.length > MAX_PATH_MAPPINGS)
  ) throw new Error("desktop import path mappings are invalid");
  const pathMappings = (request.pathMappings ?? []).map((mapping) =>
    safeText(mapping, "desktop import path mapping"));
  if (new Set(pathMappings).size !== pathMappings.length) {
    throw new Error("desktop import path mappings contain duplicates");
  }
  if (request.allowLossyConversion !== undefined && typeof request.allowLossyConversion !== "boolean") {
    throw new Error("desktop import lossy option is invalid");
  }
  let sessionRefs: string[] | undefined;
  if (request.sessionRefs !== undefined) {
    if (!Array.isArray(request.sessionRefs) || request.sessionRefs.length === 0 ||
      request.sessionRefs.length > MAX_DESKTOP_TRANSFER_SESSIONS) {
      throw new Error("desktop import session selection is invalid");
    }
    sessionRefs = request.sessionRefs.map((reference) => {
      safeText(reference, "desktop import session reference", 256);
      if (sessionAgent(reference) === undefined) throw new Error("desktop import session reference is invalid");
      return reference;
    });
    if (new Set(sessionRefs).size !== sessionRefs.length) {
      throw new Error("desktop import session selection contains duplicates");
    }
  }
  return {
    ...(request.targetAgent === undefined ? {} : { targetAgent: request.targetAgent }),
    ...(sessionRefs === undefined ? {} : { sessionRefs }),
    allowLossyConversion: request.allowLossyConversion ?? false,
    pathMappings,
  };
}

function validateHandle(value: string): string {
  if (typeof value !== "string" || !HANDLE.test(value)) {
    throw new Error("desktop import handle is invalid or expired");
  }
  return value;
}

function validatePlanReference(value: string): string {
  if (typeof value !== "string" || !PLAN.test(value)) throw new Error("desktop import plan reference is invalid");
  return value;
}

function validateWorkspaceMappingRequest(request: MapImportWorkspaceRequest): {
  readonly handle: string;
  readonly source: string;
} {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("desktop import workspace mapping request is invalid");
  }
  exactKeys(request, ["handle", "source"], "desktop import workspace mapping request");
  return {
    handle: validateHandle(request.handle),
    source: safeText(request.source, "desktop import workspace mapping source"),
  };
}

async function validateMappingTarget(targetDirectory: string, deps: Dependencies): Promise<string> {
  const target = safeText(targetDirectory, "desktop import workspace mapping target");
  if (!path.isAbsolute(target)) {
    throw new Error("desktop import workspace mapping target must be an absolute system-picker path");
  }
  const normalized = path.normalize(target);
  const info = await deps.lstat(normalized);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("desktop import workspace mapping target is not a real directory");
  }
  return normalized;
}

function replaceWorkspaceMapping(
  selected: ImportChoices,
  source: string,
  target: string,
): ImportChoices {
  if (source.includes("=") || target.includes("=")) {
    throw new Error("desktop import workspace paths containing '=' cannot be represented safely");
  }
  const retained = selected.pathMappings.filter((mapping) => mapping.slice(0, mapping.indexOf("=")) !== source);
  return {
    ...(selected.targetAgent === undefined ? {} : { targetAgent: selected.targetAgent }),
    ...(selected.sessionRefs === undefined ? {} : { sessionRefs: [...selected.sessionRefs] }),
    allowLossyConversion: selected.allowLossyConversion,
    pathMappings: [...retained, `${source}=${target}`],
  };
}

function safeCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DESKTOP_TRANSFER_SESSIONS) {
    throw new Error(`${label} exceeds supported limits`);
  }
  return value;
}

function findings(values: readonly ConversionFinding[]): readonly ConversionFinding[] {
  return normalizeConversionFindings(values).map((finding) => ({ ...finding }));
}

function importRoutes(result: ImportHistoryResult): readonly ImportRouteDto[] {
  return result.routes.map((route) => {
    if (!isAgent(route.sourceAgent) || !isAgent(route.targetAgent)) {
      throw new Error("desktop import route contains an invalid Agent");
    }
    if (
      route.quality !== "native" && route.quality !== "exact" &&
      route.quality !== "degraded" && route.quality !== "blocked"
    ) throw new Error("desktop import route contains an invalid quality");
    return {
      sourceAgent: route.sourceAgent,
      targetAgent: route.targetAgent,
      quality: route.quality,
      sessions: safeCount(route.sessions, "desktop import route session count"),
      findings: findings(route.findings),
    };
  });
}

function importWorkspaces(result: ImportHistoryResult): readonly ImportWorkspaceDto[] {
  return result.workspaces.map((workspace) => {
    if (workspace.status !== "unchanged" && workspace.status !== "mapped") {
      throw new Error("desktop import workspace contains an invalid status");
    }
    return {
      source: safeText(workspace.source, "desktop import source workspace"),
      target: safeText(workspace.target, "desktop import target workspace"),
      status: workspace.status,
      agents: workspace.agents.map((agent) => {
        if (!isAgent(agent)) throw new Error("desktop import workspace contains an invalid Agent");
        return agent;
      }),
      sessions: safeCount(workspace.sessions, "desktop import workspace session count"),
    };
  });
}

function conflictCount(result: ImportHistoryResult): number {
  return result.items.filter((item) => item.classification === "conflict").length +
    result.resources.filter((resource) => resource.classification === "conflict").length;
}

function validateDryRun(result: ImportHistoryResult): void {
  if (result.mode !== "dry_run" || result.status !== "ready" && result.status !== "blocked") {
    throw new Error("desktop import planning did not return a dry-run result");
  }
  for (const value of [
    result.selectedSessions,
    result.newSessions,
    result.alreadyPresent,
    result.blocked,
    result.items.length,
    result.resources.length,
  ]) safeCount(value, "desktop import result count");
  if (result.selectedSessions < 1) throw new Error("desktop import archive contains no selected sessions");
}

function validateImportTargets(result: ImportHistoryResult, selected: ImportChoices): void {
  const validTarget = (source: Agent, target: Agent): boolean =>
    target === (selected.targetAgent ?? source);
  if (
    result.routes.some((route) => !validTarget(route.sourceAgent, route.targetAgent)) ||
    result.items.some((item) => !validTarget(item.sourceAgent, item.targetAgent)) ||
    result.blockedSessions.some((item) => !validTarget(item.sourceAgent, item.targetAgent))
  ) throw new Error("desktop import result does not match its requested target");
}

function importCoreOptions(
  options: DesktopTransferServiceOptions,
  frozenFile: string,
  selected: ImportChoices,
  mode: "dry_run" | "apply",
): ImportHistoryOptions {
  return {
    ...(options.importOptions ?? {}),
    file: frozenFile,
    stateDirectory: options.stateDirectory,
    mode,
    ...(selected.targetAgent === undefined ? {} : { targetAgent: selected.targetAgent }),
    ...(selected.sessionRefs === undefined ? {} : { sessions: [...selected.sessionRefs] }),
    ...(selected.allowLossyConversion ? { allowLossyConversion: true } : {}),
    pathMappings: selected.pathMappings,
  };
}

function preflightIdentity(preflight: ImportWorkspacePreflight): unknown {
  return {
    catalogEntries: preflight.catalogEntries.map((entry) => ({
      sessionRef: entry.sessionRef,
      sourceAgent: entry.agent,
      sourceWorkspace: entry.workspace,
    })),
    entries: preflight.entries.map((entry) => ({
      sessionRef: entry.sessionRef,
      sourceAgent: entry.agent,
      sourceWorkspace: entry.workspace,
    })),
    workspaces: preflight.workspaces.map((workspace) => ({
      source: workspace.source,
      target: workspace.target,
      status: workspace.status,
      availability: workspace.availability,
      agents: workspace.agents,
      sessionRefs: workspace.sessionRefs,
    })),
  };
}

async function inspectFrozenImport(
  frozen: FrozenArchive,
  selected: ImportChoices,
  deps: Dependencies,
): Promise<ImportWorkspacePreflight> {
  const catalog = await deps.openImportCatalog(frozen.file, path.dirname(frozen.file));
  try {
    if (catalog.sizeBytes !== frozen.observation.sizeBytes || catalog.sha256 !== frozen.observation.sha256) {
      throw new Error("desktop import catalog differs from its private archive copy");
    }
    if (!Array.isArray(catalog.entries) || catalog.entries.length < 1 ||
      catalog.entries.length > MAX_DESKTOP_TRANSFER_SESSIONS) {
      throw new Error("desktop import catalog exceeds supported session limits");
    }
    const references = new Set<string>();
    const catalogEntries = catalog.entries.map((entry): ImportCatalogEntry => {
      if (!isAgent(entry.agent) || sessionAgent(entry.sessionRef) !== entry.agent || references.has(entry.sessionRef)) {
        throw new Error("desktop import catalog contains an invalid or duplicate session");
      }
      references.add(entry.sessionRef);
      return { ...entry, tags: [...entry.tags] };
    });
    const selectedReferences = selected.sessionRefs ?? catalogEntries.map((entry) => entry.sessionRef);
    if (selectedReferences.some((reference) => !references.has(reference))) {
      throw new Error("desktop import selection contains a session outside the archive");
    }
    const entries = selected.sessionRefs === undefined
      ? catalogEntries
      : catalog.closeSelection(selectedReferences);
    if (entries.length !== selectedReferences.length || entries.length === 0) {
      throw new Error("desktop import selection is empty or incomplete");
    }
    const destinations: Record<string, Agent> = {};
    for (const entry of entries) destinations[entry.sessionRef] = selected.targetAgent ?? entry.agent;
    const workspaces = await catalog.inspectWorkspaces(
      entries.map((entry) => entry.sessionRef),
      destinations,
      selected.pathMappings,
    );
    const observedReferences: string[] = [];
    for (const workspace of workspaces) {
      if (
        workspace.status !== "unchanged" && workspace.status !== "mapped" ||
        workspace.availability !== "available" && workspace.availability !== "missing" &&
          workspace.availability !== "unsafe" ||
        workspace.sessionRefs.length === 0 || workspace.agents.some((agent) => !isAgent(agent))
      ) throw new Error("desktop import workspace preflight is invalid");
      for (const reference of workspace.sessionRefs) {
        if (!references.has(reference)) throw new Error("desktop import workspace preflight has an unknown session");
        observedReferences.push(reference);
      }
    }
    if (
      observedReferences.length !== entries.length ||
      new Set(observedReferences).size !== observedReferences.length
    ) throw new Error("desktop import workspace preflight does not cover every session exactly once");
    return {
      catalogEntries,
      entries,
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        agents: [...workspace.agents],
        sessionRefs: [...workspace.sessionRefs],
      })),
    };
  } finally {
    await catalog.close();
  }
}

function preliminaryRoutes(
  preflight: ImportWorkspacePreflight,
  selected: ImportChoices,
): readonly ImportRouteDto[] {
  const groups = new Map<string, { readonly sourceAgent: Agent; readonly targetAgent: Agent; sessions: number }>();
  for (const entry of preflight.entries) {
    const targetAgent = selected.targetAgent ?? entry.agent;
    const key = `${entry.agent}\0${targetAgent}`;
    const group = groups.get(key) ?? { sourceAgent: entry.agent, targetAgent, sessions: 0 };
    group.sessions++;
    groups.set(key, group);
  }
  return [...groups.values()].map((group): ImportRouteDto => ({
    sourceAgent: group.sourceAgent,
    targetAgent: group.targetAgent,
    quality: group.sourceAgent === group.targetAgent ? "native" : "blocked",
    sessions: group.sessions,
    findings: [],
  })).toSorted((left, right) =>
    AGENTS.indexOf(left.sourceAgent) - AGENTS.indexOf(right.sourceAgent) ||
    AGENTS.indexOf(left.targetAgent) - AGENTS.indexOf(right.targetAgent));
}

function preflightWorkspaces(preflight: ImportWorkspacePreflight): readonly ImportWorkspaceDto[] {
  return preflight.workspaces.map((workspace) => ({
    source: workspace.source,
    target: workspace.target,
    status: workspace.availability === "missing"
      ? "missing"
      : workspace.availability === "unsafe"
        ? "unmapped"
        : workspace.status,
    agents: [...workspace.agents],
    sessions: workspace.sessionRefs.length,
  }));
}

function importSessions(
  preflight: ImportWorkspacePreflight,
  selected: ImportChoices,
): ImportPlanDto["sessions"] {
  const selectedReferences = new Set(selected.sessionRefs ?? preflight.catalogEntries.map((entry) => entry.sessionRef));
  const groups = new Map<string, typeof preflight.catalogEntries[number][]>();
  for (const entry of preflight.catalogEntries) {
    const key = `${entry.agent}\u0000${entry.nativeId}`;
    const members = groups.get(key) ?? [];
    members.push(entry);
    groups.set(key, members);
  }
  return [...groups.values()].map((members) => {
    const ordered = members.toSorted((left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.sessionRef.localeCompare(right.sessionRef));
    const entry = ordered[0]!;
    const memberSessionRefs = ordered.map((member) => safeText(
      member.sessionRef,
      "desktop import session reference",
      256,
    ));
    const updatedAt = safeText(entry.updatedAt, "desktop import session timestamp", 128);
    if (Number.isNaN(Date.parse(updatedAt)) || ordered.some((member) => Number.isNaN(Date.parse(member.updatedAt)))) {
      throw new Error("desktop import session timestamp is invalid");
    }
    return {
      sessionRef: safeText(entry.sessionRef, "desktop import session reference", 256),
      memberSessionRefs,
      sourceAgent: entry.agent,
      title: safeText(entry.title, "desktop import session title"),
      workspace: safeText(entry.workspace, "desktop import session workspace"),
      updatedAt,
      selected: memberSessionRefs.every((reference) => selectedReferences.has(reference)),
    };
  }).toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.sessionRef.localeCompare(right.sessionRef));
}

function preliminaryPlanDto(
  handle: string,
  fileName: string,
  observation: FileObservation,
  selected: ImportChoices,
  preflight: ImportWorkspacePreflight,
): ImportPlanDto {
  const routes = preliminaryRoutes(preflight, selected);
  const workspaces = preflightWorkspaces(preflight);
  const blockedSessions = new Set(preflight.workspaces
    .filter((workspace) => workspace.availability !== "available")
    .flatMap((workspace) => workspace.sessionRefs)).size;
  if (blockedSessions === 0) throw new Error("desktop import preliminary plan is not blocked");
  const identity = {
    handle,
    file: {
      sizeBytes: observation.sizeBytes,
      sha256: observation.sha256,
      mtimeMs: observation.mtimeMs,
    },
    options: {
      targetAgent: selected.targetAgent ?? null,
      sessionRefs: selected.sessionRefs ?? null,
      allowLossyConversion: selected.allowLossyConversion,
      pathMappings: selected.pathMappings,
    },
    preflight: preflightIdentity(preflight),
    result: {
      status: "blocked",
      selectedSessions: preflight.entries.length,
      newSessions: 0,
      alreadyPresent: 0,
      blocked: blockedSessions,
      conflicts: 0,
      routes,
      workspaces,
    },
  };
  return {
    handle,
    planRef: `ahimportplan1_${canonicalDigest(identity)}`,
    fileName,
    status: "blocked",
    selectedSessions: preflight.entries.length,
    newSessions: 0,
    alreadyPresent: 0,
    blocked: blockedSessions,
    conflicts: 0,
    routes,
    workspaces,
    sessions: importSessions(preflight, selected),
    transactionRequired: false,
  };
}

function planDto(
  handle: string,
  fileName: string,
  observation: FileObservation,
  selected: ImportChoices,
  result: ImportHistoryResult,
  preflight: ImportWorkspacePreflight,
): ImportPlanDto {
  validateDryRun(result);
  const routes = importRoutes(result);
  const workspaces = importWorkspaces(result);
  const conflicts = safeCount(conflictCount(result), "desktop import conflict count");
  const status = result.status === "blocked" || conflicts !== 0 ? "blocked" : "ready";
  const identity = {
    handle,
    file: {
      sizeBytes: observation.sizeBytes,
      sha256: observation.sha256,
      mtimeMs: observation.mtimeMs,
    },
    options: {
      targetAgent: selected.targetAgent ?? null,
      sessionRefs: selected.sessionRefs ?? null,
      allowLossyConversion: selected.allowLossyConversion,
      pathMappings: selected.pathMappings,
    },
    preflight: preflightIdentity(preflight),
    result: {
      status,
      selectedSessions: result.selectedSessions,
      newSessions: result.newSessions,
      alreadyPresent: result.alreadyPresent,
      blocked: result.blocked,
      conflicts,
      routes,
      workspaces,
      items: result.items.map((item) => ({
        sourceAgent: item.sourceAgent,
        targetAgent: item.targetAgent,
        sourceSessionRef: item.sourceSessionRef,
        targetSessionRef: item.targetSessionRef,
        targetNativeId: item.targetNativeId,
        quality: item.quality,
        findings: findings(item.findings),
        classification: item.classification,
        destination: item.destination,
        provider: item.provider,
        sourceCwd: item.sourceCwd,
        cwd: item.cwd,
        workspaceStatus: item.workspaceStatus,
        reason: item.reason ?? null,
      })),
      resources: result.resources.map((resource) => ({
        agent: resource.agent,
        sessionRefs: resource.sessionRefs,
        sha256: resource.sha256,
        sizeBytes: resource.sizeBytes,
        relativePath: resource.relativePath,
        materializedPath: resource.materializedPath,
        classification: resource.classification,
        reason: resource.reason ?? null,
      })),
    },
  };
  return {
    handle,
    planRef: `ahimportplan1_${canonicalDigest(identity)}`,
    fileName,
    status,
    selectedSessions: safeCount(result.selectedSessions, "desktop import selected session count"),
    newSessions: safeCount(result.newSessions, "desktop import new session count"),
    alreadyPresent: safeCount(result.alreadyPresent, "desktop import existing session count"),
    blocked: safeCount(result.blocked, "desktop import blocked session count"),
    conflicts,
    routes,
    workspaces,
    sessions: importSessions(preflight, selected),
    transactionRequired: status === "ready" && result.newSessions > 0,
  };
}

function makeHandle(deps: Dependencies, existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 4; attempt++) {
    const first = deps.randomUUID().replaceAll("-", "").toLowerCase();
    const second = deps.randomUUID().replaceAll("-", "").toLowerCase();
    const handle = `ahimport1_${first}${second}`;
    if (!HANDLE.test(handle)) throw new Error("desktop import handle generation failed");
    if (!existing.has(handle)) return handle;
  }
  throw new Error("desktop import handle generation collided repeatedly");
}

export function createDesktopTransferService(options: DesktopTransferServiceOptions): DesktopTransferService {
  safeText(options.stateDirectory, "desktop transfer state directory");
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const ttl = options.importHandleTtlMs ?? DEFAULT_DESKTOP_IMPORT_HANDLE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 24 * 60 * 60 * 1000) {
    throw new Error("desktop import handle TTL is invalid");
  }
  const deps: Dependencies = {
    planExportHistory: options.planExportHistory ?? corePlanExportHistory,
    exportHistory: options.exportHistory ?? coreExportHistory,
    importHistoryArchive: options.importHistoryArchive ?? coreImportHistoryArchive,
    openImportCatalog: options.openImportCatalog ?? coreOpenImportCatalog,
    digestFile: options.digestFile ?? digestFile,
    lstat: options.lstat ?? lstat,
    copyStableFile: options.copyStableFile ?? copyStableFile,
    makeTempDirectory: options.makeTempDirectory ?? (() => mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-import-"))),
    removeDirectory: options.removeDirectory ?? ((directory) => rm(directory, { recursive: true, force: true })),
    randomUUID: options.randomUUID ?? randomUUID,
    now: options.now ?? Date.now,
  };
  const handles = new Map<string, ImportHandleEntry>();
  const reservedHandles = new Set<string>();
  const pendingWorkspaces = new Set<string>();
  const activeOperations = new Set<Promise<unknown>>();
  let openingHandles = 0;
  let acceptingOperations = true;
  let disposed = false;
  let disposeInFlight: Promise<void> | undefined;

  const withOperation = <T>(action: () => Promise<T>): Promise<T> => {
    if (!acceptingOperations) return Promise.reject(new Error("desktop transfer service is closing"));
    const operation = Promise.resolve().then(action);
    activeOperations.add(operation);
    void operation.then(
      () => { activeOperations.delete(operation); },
      () => { activeOperations.delete(operation); },
    );
    return operation;
  };

  const disposeEntry = async (entry: ImportHandleEntry): Promise<void> => {
    clearTimeout(entry.timer);
    entry.expired = true;
    if (entry.cleanupInFlight === undefined) {
      const cleanup = deps.removeDirectory(entry.workspace).then(() => {
        if (handles.get(entry.handle) === entry) handles.delete(entry.handle);
      });
      entry.cleanupInFlight = cleanup;
    }
    const cleanup = entry.cleanupInFlight;
    try {
      await cleanup;
    } finally {
      if (entry.cleanupInFlight === cleanup) entry.cleanupInFlight = undefined;
    }
  };

  const expireEntry = async (handle: string): Promise<void> => {
    const entry = handles.get(handle);
    if (entry === undefined) return;
    if (entry.busy) {
      entry.expired = true;
      return;
    }
    await disposeEntry(entry);
  };

  const purgeExpired = async (): Promise<void> => {
    const now = deps.now();
    for (const entry of [...handles.values()]) {
      if (entry.expired || now >= entry.expiresAt) await expireEntry(entry.handle);
    }
  };

  const acquireEntry = async (rawHandle: string): Promise<ImportHandleEntry> => {
    const handle = validateHandle(rawHandle);
    await purgeExpired();
    const entry = handles.get(handle);
    if (entry === undefined || entry.expired || deps.now() >= entry.expiresAt) {
      if (entry !== undefined) await expireEntry(handle);
      throw new Error("desktop import handle is invalid or expired");
    }
    if (entry.busy) throw new Error("desktop import handle already has an operation in progress");
    entry.busy = true;
    return entry;
  };

  const withEntry = async <T>(rawHandle: string, action: (entry: ImportHandleEntry) => Promise<T>): Promise<T> => {
    const entry = await acquireEntry(rawHandle);
    try {
      return await action(entry);
    } finally {
      entry.busy = false;
      if (entry.expired && handles.has(entry.handle)) await disposeEntry(entry);
    }
  };

  const planFrozen = async (
    handle: string,
    fileName: string,
    frozen: FrozenArchive,
    selected: ImportChoices,
  ): Promise<InternalImportPlan> => {
    const preflight = await inspectFrozenImport(frozen, selected, deps);
    if (preflight.workspaces.some((workspace) => workspace.availability !== "available")) {
      return {
        dto: preliminaryPlanDto(handle, fileName, frozen.observation, selected, preflight),
        observation: frozen.observation,
        choices: selected,
        preflight,
      };
    }
    const result = await deps.importHistoryArchive(importCoreOptions(options, frozen.file, selected, "dry_run"));
    validateImportTargets(result, selected);
    if (result.selectedSessions !== preflight.entries.length) {
      throw new Error("desktop import dry-run does not match the preflight session count");
    }
    const dto = planDto(handle, fileName, frozen.observation, selected, result, preflight);
    return { dto, observation: frozen.observation, choices: selected, result, preflight };
  };

  const replacePlan = async (
    entry: ImportHandleEntry,
    selected: ImportChoices,
  ): Promise<InternalImportPlan> => {
    const frozen = await freezeArchive(entry.sourceFile, entry.workspace, deps);
    try {
      const planned = await planFrozen(entry.handle, entry.fileName, frozen, selected);
      const previous = entry.frozenFile;
      entry.frozenFile = frozen.file;
      entry.plan = planned;
      if (previous !== frozen.file) {
        try { await rm(previous, { force: true }); } catch { /* workspace disposal removes stale copies */ }
      }
      return planned;
    } catch (error) {
      try { await rm(frozen.file, { force: true }); } catch { /* preserve the planning error */ }
      throw error;
    }
  };

  return {
    async exportHistory(request) {
      return withOperation(async () => {
        const sessions = selectedSessions(request);
        const selected = await options.chooseSaveFile("agenthist-export.agenthist");
        if (selected === undefined) return { status: "cancelled" };
        const output = await requireExportDestination(selected, deps);
        const coreOptions = exportOptions(options.stateDirectory, cwd, output, sessions);
        const plan = await deps.planExportHistory(coreOptions);
        assertExportPlan(plan, output);
        const result = await deps.exportHistory(coreOptions);
        const observed = await observeArchive(output, deps);
        if (result.sizeBytes !== observed.sizeBytes || result.sha256 !== observed.sha256) {
          throw new Error("desktop export result does not match the published archive");
        }
        return exportDto(result, output);
      });
    },

    async openImport() {
      return withOperation(async () => {
        await purgeExpired();
        if (handles.size + openingHandles >= MAX_DESKTOP_IMPORT_HANDLES) {
          throw new Error("too many desktop import handles are open");
        }
        openingHandles++;
        try {
          const selected = await options.chooseOpenFile();
          if (selected === undefined) return { status: "cancelled" };
          const sourceFile = validatePickedImport(selected);
          const sourceInfo = await deps.lstat(sourceFile);
          if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size <= 0 ||
            sourceInfo.size > MAX_DESKTOP_IMPORT_ARCHIVE_BYTES) {
            throw new Error("desktop import source is not a supported regular file");
          }
          const handle = makeHandle(deps, new Set([...handles.keys(), ...reservedHandles]));
          reservedHandles.add(handle);
          let workspace: string | undefined;
          try {
            workspace = await deps.makeTempDirectory();
            pendingWorkspaces.add(workspace);
            const frozen = await freezeArchive(sourceFile, workspace, deps);
            const selectedChoices: ImportChoices = { allowLossyConversion: false, pathMappings: [] };
            const plan = await planFrozen(handle, path.basename(sourceFile), frozen, selectedChoices);
            const expiresAt = deps.now() + ttl;
            const timer = setTimeout(() => { void expireEntry(handle).catch(() => undefined); }, ttl);
            timer.unref();
            handles.set(handle, {
              handle,
              sourceFile,
              fileName: path.basename(sourceFile),
              workspace,
              frozenFile: frozen.file,
              plan,
              busy: false,
              expired: false,
              cleanupInFlight: undefined,
              expiresAt,
              timer,
            });
            pendingWorkspaces.delete(workspace);
            return { status: "planned", plan: plan.dto };
          } catch (error) {
            if (workspace !== undefined) {
              try {
                await deps.removeDirectory(workspace);
                pendingWorkspaces.delete(workspace);
              } catch { /* retain the workspace for a disposal retry */ }
            }
            throw error;
          } finally {
            reservedHandles.delete(handle);
          }
        } finally {
          openingHandles--;
        }
      });
    },

    async replanImport(request) {
      return withOperation(async () => {
        const selected = choices(request);
        return withEntry(request.handle, async (entry) => (await replacePlan(entry, selected)).dto);
      });
    },

    async mapImportWorkspace(request, targetDirectory) {
      return withOperation(async () => {
        const validated = validateWorkspaceMappingRequest(request);
        return withEntry(validated.handle, async (entry): Promise<MapImportWorkspaceResultDto> => {
          const authoritative = entry.plan.preflight.workspaces.find((workspace) =>
            workspace.source === validated.source);
          if (authoritative === undefined) {
            throw new Error("desktop import workspace mapping source is not in the current plan");
          }
          const target = await validateMappingTarget(targetDirectory, deps);
          const selected = replaceWorkspaceMapping(entry.plan.choices, authoritative.source, target);
          const planned = await replacePlan(entry, selected);
          return { status: "planned", plan: planned.dto };
        });
      });
    },

    async applyImport(request) {
      return withOperation(async () => {
        if (request === null || typeof request !== "object" || Array.isArray(request)) {
          throw new Error("desktop import apply request is invalid");
        }
        exactKeys(request, ["handle", "expectedPlanRef"], "desktop import apply request");
        const expectedPlanRef = validatePlanReference(request.expectedPlanRef);
        let completedEntry: ImportHandleEntry | undefined;
        const outcome = await withEntry(request.handle, async (entry): Promise<ApplyImportResultDto> => {
          const observed = await observeArchive(entry.sourceFile, deps);
          let refreshed: InternalImportPlan;
          if (!sameObservation(observed, entry.plan.observation)) {
            refreshed = await replacePlan(entry, entry.plan.choices);
          } else {
            const privateDigest = await deps.digestFile(entry.frozenFile);
            if (
              privateDigest.sizeBytes !== entry.plan.observation.sizeBytes ||
              privateDigest.sha256 !== entry.plan.observation.sha256
            ) throw new Error("desktop import private copy changed unexpectedly");
            refreshed = await planFrozen(entry.handle, entry.fileName, {
              file: entry.frozenFile,
              observation: observed,
            }, entry.plan.choices);
            entry.plan = refreshed;
          }
          if (refreshed.dto.planRef !== expectedPlanRef) {
            return { status: "replan_required", plan: refreshed.dto };
          }
          if (refreshed.dto.status === "blocked") return { status: "blocked", plan: refreshed.dto };

          const result = await deps.importHistoryArchive(
            importCoreOptions(options, entry.frozenFile, refreshed.choices, "apply"),
          );
          validateImportTargets(result, refreshed.choices);
          if (result.mode !== "apply") throw new Error("desktop import apply returned an invalid mode");
          if (result.status === "blocked") {
            const blocked = planDto(entry.handle, entry.fileName, refreshed.observation, refreshed.choices, {
              ...result,
              mode: "dry_run",
            }, refreshed.preflight);
            entry.plan = { ...refreshed, dto: blocked, result: { ...result, mode: "dry_run" } };
            return { status: "blocked", plan: blocked };
          }
          if (result.status !== "completed") throw new Error("desktop import apply returned an invalid status");
          const transactionRefs = result.agents.flatMap((agent) =>
            agent.transactionRef === undefined ? [] : [agent.transactionRef]);
          completedEntry = entry;
          return {
            status: "completed",
            fileName: entry.fileName,
            written: safeCount(result.written, "desktop import written session count"),
            alreadyPresent: safeCount(result.alreadyPresent, "desktop import existing session count"),
            transactionRefs,
          };
        });
        if (completedEntry !== undefined && handles.has(completedEntry.handle)) {
          try {
            await disposeEntry(completedEntry);
          } catch {
            // The native apply is already authoritative. Keep the expired
            // handle registered so service disposal can retry private cleanup.
          }
        }
        return outcome;
      });
    },

    async cancelImport(request) {
      return withOperation(async () => {
        if (request === null || typeof request !== "object" || Array.isArray(request)) {
          throw new Error("desktop import cancel request is invalid");
        }
        exactKeys(request, ["handle"], "desktop import cancel request");
        const entry = await acquireEntry(request.handle);
        try {
          await disposeEntry(entry);
          return { closed: true };
        } finally {
          entry.busy = false;
        }
      });
    },

    async dispose() {
      if (disposed) return;
      if (disposeInFlight === undefined) {
        acceptingOperations = false;
        disposeInFlight = (async () => {
          await Promise.allSettled([...activeOperations]);
          const entries = [...handles.values()];
          const workspaces = [...pendingWorkspaces];
          const settled = await Promise.allSettled([
            ...entries.map((entry) => disposeEntry(entry)),
            ...workspaces.map(async (workspace) => {
              await deps.removeDirectory(workspace);
              pendingWorkspaces.delete(workspace);
            }),
          ]);
          const failures = settled.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []);
          if (failures.length !== 0) {
            throw new AggregateError(failures, "desktop transfer disposal failed");
          }
          disposed = true;
        })();
      }
      try {
        await disposeInFlight;
      } finally {
        if (!disposed) disposeInFlight = undefined;
      }
    },
  };
}
