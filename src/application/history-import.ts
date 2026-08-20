import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentSourceOptions,
  NativeImportResult,
  PreparedNativeImport,
} from "../agents/contracts.js";
import { agentAdapter } from "../agents/registry.js";
import { AGENTS, isAgent, type Agent } from "../domain/agent.js";
import type { ArchiveEntry } from "../domain/archive.js";
import {
  normalizeConversionFindings,
  type ConversionFinding,
  type ConversionStatus,
} from "../domain/conversion.js";
import type { ImportEntry } from "../domain/import.js";
import type { PathFlavor } from "../domain/host-path.js";
import { managedResourceReference, type ManagedResourceReference } from "../domain/resource.js";
import { readArchive } from "../infrastructure/archive.js";
import { withStateReadLock, withStateWriteLock } from "../infrastructure/state.js";
import { assertNoPendingTransactions } from "../infrastructure/transaction-store.js";
import { validateArchiveObjects, validateArchiveSemantics } from "./archive-validation.js";
import { assertPathMappingsConsumed, parsePathMappings } from "../domain/path-mapping.js";
import {
  planImportWorkspaces,
  type ImportWorkspaceProjection,
  type ImportWorkspaceStatus,
} from "./workspace-projection.js";
import {
  prepareImportConversions,
  type ImportConversionPlanItem,
} from "./conversion.js";
import { selectImportEntries } from "./import-selection.js";

export type { ImportWorkspaceStatus } from "./workspace-projection.js";

export interface ImportHistoryOptions {
  readonly file: string;
  readonly stateDirectory: string;
  readonly codexHome?: string;
  readonly sqliteHome?: string;
  readonly profile?: string;
  readonly opencodeDataRoot?: string;
  readonly opencodeDatabase?: string;
  readonly claudeConfigRoot?: string;
  readonly piSessionRoot?: string;
  readonly providerPolicy?: string;
  readonly pathMappings?: readonly string[];
  readonly sessions?: readonly string[];
  readonly agents?: readonly Agent[];
  readonly targetAgent?: Agent;
  readonly sessionTargets?: Readonly<Record<string, Agent>>;
  readonly mode: "dry_run" | "apply";
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly home?: string;
}

interface PreparedImportAgentResult {
  readonly agent: Agent;
  readonly result: NativeImportResult;
}

export type ImportClassification = "new" | "already_present" | "conflict";
export type ImportHistoryStatus = "ready" | "completed" | "blocked";
export type ImportRouteQuality = "native" | ConversionStatus;

export interface ImportRouteSummary {
  readonly sourceAgent: Agent;
  readonly targetAgent: Agent;
  readonly quality: ImportRouteQuality;
  readonly sessions: number;
  readonly findings: readonly ConversionFinding[];
}

export interface ImportAgentTarget {
  readonly root: string;
  readonly databaseRoot?: string;
  readonly database?: string;
}

export interface ImportAgentSummary {
  readonly agent: Agent;
  readonly target: ImportAgentTarget;
  readonly newSessions: number;
  readonly written: number;
  readonly alreadyPresent: number;
  readonly transactionRef?: string;
}

export interface ImportHistoryItem {
  readonly sourceAgent: Agent;
  readonly targetAgent: Agent;
  readonly sourceSessionRef: string;
  readonly targetSessionRef: string;
  readonly quality: ImportRouteQuality;
  readonly findings: readonly ConversionFinding[];
  readonly classification: ImportClassification;
  readonly destination: string;
  readonly provider: string;
  readonly sourceCwd: string;
  readonly cwd: string;
  readonly workspaceStatus: ImportWorkspaceStatus;
  readonly reason?: string;
}

export interface ImportHistoryWorkspace {
  readonly source: string;
  readonly target: string;
  readonly status: ImportWorkspaceStatus;
  readonly agents: readonly Agent[];
  readonly sessions: number;
}

export interface ImportHistoryResource extends ManagedResourceReference {
  readonly agent: Agent;
  readonly sessionRefs: readonly string[];
  readonly materializedPath: string;
  readonly classification: ImportClassification;
  readonly reason?: string;
}

export interface ImportBlockedSession {
  readonly sourceAgent: Agent;
  readonly targetAgent: Agent;
  readonly sourceSessionRef: string;
  readonly findings: readonly ConversionFinding[];
}

export interface ImportHistoryResult {
  readonly mode: "dry_run" | "apply";
  readonly status: ImportHistoryStatus;
  readonly selectedSessions: number;
  readonly newSessions: number;
  readonly written: number;
  readonly alreadyPresent: number;
  readonly blocked: number;
  readonly blockedSessions: readonly ImportBlockedSession[];
  readonly routes: readonly ImportRouteSummary[];
  readonly agents: readonly ImportAgentSummary[];
  readonly workspaces: readonly ImportHistoryWorkspace[];
  readonly items: readonly ImportHistoryItem[];
  readonly resources: readonly ImportHistoryResource[];
}

interface PreparedAgentRestore {
  readonly agent: Agent;
  readonly prepared: PreparedNativeImport;
}

interface PreparedImportBatch {
  readonly restores: readonly PreparedAgentRestore[];
  readonly workspaces: readonly ImportWorkspaceProjection[];
}

async function restoreWorkspace(root: string, agent: Agent): Promise<string> {
  const directory = path.join(root, `restore-${agent}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

function restoreSourceOptions(options: ImportHistoryOptions, agent: Agent): AgentSourceOptions {
  const common = {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
  };
  const byAgent: Readonly<Record<Agent, AgentSourceOptions>> = {
    codex: {
      ...common,
      ...(options.codexHome === undefined ? {} : { historyRoot: options.codexHome }),
      ...(options.sqliteHome === undefined ? {} : { nativeStateRoot: options.sqliteHome }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
    },
    opencode: {
      ...common,
      ...(options.opencodeDataRoot === undefined ? {} : { historyRoot: options.opencodeDataRoot }),
      ...(options.opencodeDatabase === undefined ? {} : { databasePath: options.opencodeDatabase }),
    },
    claude: {
      ...common,
      ...(options.claudeConfigRoot === undefined ? {} : { historyRoot: options.claudeConfigRoot }),
    },
    pi: {
      ...common,
      ...(options.piSessionRoot === undefined ? {} : { historyRoot: options.piSessionRoot }),
    },
  };
  return byAgent[agent];
}

async function prepareRestores(
  options: ImportHistoryOptions,
  entries: readonly ImportEntry[],
  objects: ReadonlyMap<string, string>,
  workspace: string,
  sourcePathFlavor: PathFlavor,
): Promise<PreparedImportBatch> {
  const mappings = parsePathMappings(options.pathMappings ?? [], { sourceFlavor: sourcePathFlavor });
  const workspaces = await planImportWorkspaces(entries, mappings);
  const prepared: PreparedAgentRestore[] = [];
  for (const agent of AGENTS) {
    const agentEntries = entries.filter((entry) => entry.agent === agent);
    if (agentEntries.length === 0) continue;
    const agentWorkspace = await restoreWorkspace(workspace, agent);
    prepared.push({
      agent,
      prepared: await agentAdapter(agent).nativeImport.prepare({
        stateDirectory: options.stateDirectory,
        entries: agentEntries,
        objects,
        providerPolicy: options.providerPolicy ?? "current",
        pathMappings: mappings,
        workspace: agentWorkspace,
        source: restoreSourceOptions(options, agent),
      }),
    });
  }
  assertPathMappingsConsumed(mappings);
  assertRestoreBatchReady(prepared);
  return { restores: prepared, workspaces };
}

function restoreResult(item: PreparedAgentRestore): PreparedImportAgentResult {
  return { agent: item.agent, result: item.prepared.result };
}

function assertRestoreBatchReady(prepared: readonly PreparedAgentRestore[]): void {
  const resources = new Map<string, { readonly sha256: string; readonly sizeBytes: number }>();
  for (const item of prepared) {
    const conflict = item.prepared.result.items.find((candidate) => candidate.classification === "conflict");
    if (conflict !== undefined) {
      throw new Error(`${item.agent} import conflict for ${conflict.sessionRef}: ${conflict.reason ?? "target differs"}`);
    }
    for (const resource of item.prepared.result.resources) {
      if (resource.classification === "conflict") {
        throw new Error(`managed resource import conflict at ${resource.destination}: ${resource.reason ?? "target differs"}`);
      }
      const existing = resources.get(resource.destination);
      if (
        existing !== undefined &&
        (existing.sha256 !== resource.binding.sha256 || existing.sizeBytes !== resource.binding.sizeBytes)
      ) throw new Error(`managed resource destination collides: ${resource.destination}`);
      resources.set(resource.destination, {
        sha256: resource.binding.sha256,
        sizeBytes: resource.binding.sizeBytes,
      });
    }
  }
}

async function applyRestore(item: PreparedAgentRestore): Promise<PreparedImportAgentResult> {
  return { agent: item.agent, result: await item.prepared.apply() };
}

function partialImportError(error: unknown, completed: readonly PreparedImportAgentResult[]): Error {
  const message = error instanceof Error ? error.message : "unknown import error";
  if (completed.length === 0) return error instanceof Error ? error : new Error(message);
  const agents = completed.map((item) => item.agent).join(", ");
  const transactions = completed
    .flatMap((item) => item.result.transactionRef === undefined ? [] : [item.result.transactionRef])
    .join(", ");
  return new Error(
    `multi-Agent import stopped after completing ${agents}; rerun the same import to continue idempotently` +
    `${transactions === "" ? "" : ` (committed transactions: ${transactions})`}: ${message}`,
  );
}

function routeSummaries(
  entries: readonly ArchiveEntry[],
  destinations: ReadonlyMap<string, Agent>,
  conversions: readonly ImportConversionPlanItem[],
): ImportRouteSummary[] {
  const converted = new Map(conversions.map((item) => [item.sourceSessionRef, item]));
  const grouped = new Map<string, {
    sourceAgent: Agent;
    targetAgent: Agent;
    qualities: ImportRouteQuality[];
    findings: ConversionFinding[];
  }>();
  for (const entry of entries) {
    const targetAgent = destinations.get(entry.sessionRef);
    if (targetAgent === undefined) throw new Error(`import destination is missing: ${entry.sessionRef}`);
    const key = `${entry.agent}\0${targetAgent}`;
    const group = grouped.get(key) ?? {
      sourceAgent: entry.agent,
      targetAgent,
      qualities: [],
      findings: [],
    };
    if (entry.agent === targetAgent) {
      group.qualities.push("native");
    } else {
      const conversion = converted.get(entry.sessionRef);
      if (conversion === undefined || conversion.targetAgent !== targetAgent) {
        throw new Error(`import conversion result is missing: ${entry.sessionRef}`);
      }
      group.qualities.push(conversion.status);
      group.findings.push(...conversion.findings);
    }
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group): ImportRouteSummary => {
    const quality: ImportRouteQuality = group.qualities.includes("blocked")
      ? "blocked"
      : group.qualities.includes("degraded")
        ? "degraded"
        : group.qualities.includes("exact")
          ? "exact"
          : "native";
    return {
      sourceAgent: group.sourceAgent,
      targetAgent: group.targetAgent,
      quality,
      sessions: group.qualities.length,
      findings: normalizeConversionFindings(group.findings),
    };
  }).toSorted((left, right) =>
    AGENTS.indexOf(left.sourceAgent) - AGENTS.indexOf(right.sourceAgent) ||
    AGENTS.indexOf(left.targetAgent) - AGENTS.indexOf(right.targetAgent));
}

function publicImportResult(
  mode: "dry_run" | "apply",
  status: "ready" | "completed",
  sourceEntries: readonly ArchiveEntry[],
  targetEntries: readonly ImportEntry[],
  routes: readonly ImportRouteSummary[],
  completed: readonly PreparedImportAgentResult[],
  workspaces: readonly ImportWorkspaceProjection[],
): ImportHistoryResult {
  const dryRun = mode === "dry_run";
  const agents = completed.map((item): ImportAgentSummary => {
    return {
      agent: item.agent,
      target: item.result.target,
      newSessions: item.result.newSessions,
      written: dryRun ? 0 : item.result.newSessions,
      alreadyPresent: item.result.alreadyPresent,
      ...(item.result.transactionRef === undefined ? {} : { transactionRef: item.result.transactionRef }),
    };
  });
  const newSessions = agents.reduce((total, item) => total + item.newSessions, 0);
  const workspaceBySession = new Map(
    workspaces.flatMap((workspace) => workspace.sessionRefs.map((sessionRef) => [sessionRef, workspace] as const)),
  );
  const entryByTargetSession = new Map(targetEntries.map((entry) => [entry.sessionRef, entry]));
  return {
    mode,
    status,
    selectedSessions: sourceEntries.length,
    newSessions,
    written: dryRun ? 0 : newSessions,
    alreadyPresent: agents.reduce((total, item) => total + item.alreadyPresent, 0),
    blocked: 0,
    blockedSessions: [],
    routes,
    agents,
    workspaces: workspaces.map((workspace) => ({
      source: workspace.source,
      target: workspace.target,
      status: workspace.status,
      agents: workspace.agents,
      sessions: workspace.sessionRefs.length,
    })),
    items: completed.flatMap((agentResult) => agentResult.result.items.map((item) => {
      const workspace = workspaceBySession.get(item.sessionRef);
      const entry = entryByTargetSession.get(item.sessionRef);
      if (workspace === undefined) throw new Error(`import result has no workspace projection: ${item.sessionRef}`);
      if (entry === undefined) throw new Error(`import result has no target entry: ${item.sessionRef}`);
      return {
        sourceAgent: entry.projection?.sourceAgent ?? agentResult.agent,
        targetAgent: agentResult.agent,
        sourceSessionRef: entry.projection?.sourceSessionRef ?? item.sessionRef,
        targetSessionRef: item.sessionRef,
        quality: entry.projection?.status ?? "native",
        findings: entry.projection?.findings ?? [],
        classification: item.classification,
        destination: item.destination,
        provider: item.provider,
        sourceCwd: workspace.source,
        cwd: item.cwd,
        workspaceStatus: workspace.status,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
      };
    })),
    resources: completed.flatMap((agentResult) => agentResult.result.resources.map((resource) => ({
      agent: agentResult.agent,
      sessionRefs: resource.sessionRefs,
      ...managedResourceReference(resource.binding),
      materializedPath: resource.destination,
      classification: resource.classification,
      ...(resource.reason === undefined ? {} : { reason: resource.reason }),
    }))),
  };
}

function blockedImportResult(
  mode: "dry_run" | "apply",
  sourceEntries: readonly ArchiveEntry[],
  routes: readonly ImportRouteSummary[],
  workspaces: readonly ImportWorkspaceProjection[],
  conversions: readonly ImportConversionPlanItem[],
): ImportHistoryResult {
  const blockedSessions = conversions
    .filter((item) => item.status === "blocked")
    .map((item): ImportBlockedSession => ({
      sourceAgent: item.sourceAgent,
      targetAgent: item.targetAgent,
      sourceSessionRef: item.sourceSessionRef,
      findings: item.findings,
    }));
  return {
    mode,
    status: "blocked",
    selectedSessions: sourceEntries.length,
    newSessions: 0,
    written: 0,
    alreadyPresent: 0,
    blocked: blockedSessions.length,
    blockedSessions,
    routes,
    agents: [],
    workspaces: workspaces.map((workspace) => ({
      source: workspace.source,
      target: workspace.target,
      status: workspace.status,
      agents: workspace.agents,
      sessions: workspace.sessionRefs.length,
    })),
    items: [],
    resources: [],
  };
}

function targetEntries(
  sourceEntries: readonly ArchiveEntry[],
  destinations: ReadonlyMap<string, Agent>,
  converted: readonly ImportEntry[],
): ImportEntry[] {
  const bySource = new Map(converted.map((entry) => [entry.projection?.sourceSessionRef, entry]));
  return sourceEntries.map((entry): ImportEntry => {
    const target = destinations.get(entry.sessionRef);
    if (target === undefined) throw new Error(`import destination is missing: ${entry.sessionRef}`);
    if (target === entry.agent) return entry;
    const projected = bySource.get(entry.sessionRef);
    if (projected === undefined || projected.agent !== target) {
      throw new Error(`projected import entry is missing: ${entry.sessionRef}`);
    }
    return projected;
  }).toSorted((left, right) => {
    const agentOrder = AGENTS.indexOf(left.agent) - AGENTS.indexOf(right.agent);
    return agentOrder === 0 ? left.sessionRef.localeCompare(right.sessionRef) : agentOrder;
  });
}

async function prepareImportPlan(
  options: ImportHistoryOptions,
  sourceEntries: readonly ArchiveEntry[],
  extractedObjects: ReadonlyMap<string, string>,
  workspace: string,
  sourcePathFlavor: PathFlavor,
): Promise<{
  readonly targetEntries: readonly ImportEntry[];
  readonly objects: ReadonlyMap<string, string>;
  readonly routes: readonly ImportRouteSummary[];
  readonly conversions: Awaited<ReturnType<typeof prepareImportConversions>>;
  readonly restores?: PreparedImportBatch;
  readonly blockedWorkspaces?: readonly ImportWorkspaceProjection[];
}> {
  if (options.targetAgent !== undefined && options.sessionTargets !== undefined) {
    throw new Error("import cannot combine one target Agent with per-session targets");
  }
  const selectedReferences = new Set(sourceEntries.map((entry) => entry.sessionRef));
  for (const [sessionRef, agent] of Object.entries(options.sessionTargets ?? {})) {
    if (!selectedReferences.has(sessionRef)) throw new Error(`import target refers to an unselected session: ${sessionRef}`);
    if (!isAgent(agent)) throw new Error(`import target Agent is invalid: ${String(agent)}`);
  }
  const destinations = new Map(sourceEntries.map((entry) => [
    entry.sessionRef,
    options.sessionTargets?.[entry.sessionRef] ?? options.targetAgent ?? entry.agent,
  ]));
  if (options.providerPolicy !== undefined && ![...destinations.values()].includes("codex")) {
    throw new Error("--codex-provider cannot be used without a Codex import target");
  }
  let objectNumber = [...extractedObjects.keys()].reduce((maximum, id) => {
    const parsed = /^o([0-9]{6})$/.exec(id);
    return parsed === null ? maximum : Math.max(maximum, Number(parsed[1]));
  }, 0);
  const conversions = await prepareImportConversions({
    entries: sourceEntries,
    objects: extractedObjects,
    destinations,
    workspace,
    pathFlavor: sourcePathFlavor,
    allocateObjectId: () => {
      objectNumber++;
      if (objectNumber > 999_999) throw new Error("import plan exceeds the object identity limit");
      return `o${objectNumber.toString().padStart(6, "0")}`;
    },
  });
  const routes = routeSummaries(sourceEntries, destinations, conversions.items);
  if (conversions.statusCounts.blocked !== 0) {
    const mappings = parsePathMappings(options.pathMappings ?? [], { sourceFlavor: sourcePathFlavor });
    const routeEntries = sourceEntries.map((entry) => ({
      agent: destinations.get(entry.sessionRef)!,
      sessionRef: entry.sessionRef,
      context: entry.context,
    }));
    const blockedWorkspaces = await planImportWorkspaces(routeEntries, mappings);
    assertPathMappingsConsumed(mappings);
    return {
      targetEntries: [],
      objects: extractedObjects,
      routes,
      conversions,
      blockedWorkspaces,
    };
  }
  const projectedEntries = targetEntries(sourceEntries, destinations, conversions.entries);
  const objects = new Map(extractedObjects);
  for (const source of conversions.sources) {
    if (objects.has(source.id)) throw new Error(`projected import object collides: ${source.id}`);
    objects.set(source.id, source.filePath);
  }
  return {
    targetEntries: projectedEntries,
    objects,
    routes,
    conversions,
    restores: await prepareRestores(options, projectedEntries, objects, workspace, sourcePathFlavor),
  };
}

export async function importHistoryArchive(options: ImportHistoryOptions): Promise<ImportHistoryResult> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-import-"));
  try {
    const read = await readArchive(path.resolve(options.cwd ?? process.cwd(), options.file), workspace);
    validateArchiveSemantics(read.manifest, read.extractedObjects);
    await validateArchiveObjects(read.manifest, read.extractedObjects);
    const entries = selectImportEntries(read.manifest.entries, options.agents, options.sessions ?? []);
    if (options.mode === "dry_run") {
      return await withStateReadLock(options.stateDirectory, async () => {
        await assertNoPendingTransactions(options.stateDirectory);
        const prepared = await prepareImportPlan(
          options,
          entries,
          read.extractedObjects,
          workspace,
          read.manifest.pathFlavor,
        );
        if (prepared.restores === undefined) {
          return blockedImportResult(
            options.mode,
            entries,
            prepared.routes,
            prepared.blockedWorkspaces ?? [],
            prepared.conversions.items,
          );
        }
        return publicImportResult(
          options.mode,
          "ready",
          entries,
          prepared.targetEntries,
          prepared.routes,
          prepared.restores.restores.map(restoreResult),
          prepared.restores.workspaces,
        );
      });
    }
    return await withStateWriteLock(options.stateDirectory, async () => {
      await assertNoPendingTransactions(options.stateDirectory);
      const prepared = await prepareImportPlan(
        options,
        entries,
        read.extractedObjects,
        workspace,
        read.manifest.pathFlavor,
      );
      if (prepared.restores === undefined) {
        return blockedImportResult(
          options.mode,
          entries,
          prepared.routes,
          prepared.blockedWorkspaces ?? [],
          prepared.conversions.items,
        );
      }
      const completed: PreparedImportAgentResult[] = [];
      try {
        for (const item of prepared.restores.restores) completed.push(await applyRestore(item));
      } catch (error) {
        throw partialImportError(error, completed);
      }
      return publicImportResult(
        options.mode,
        "completed",
        entries,
        prepared.targetEntries,
        prepared.routes,
        completed,
        prepared.restores.workspaces,
      );
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
