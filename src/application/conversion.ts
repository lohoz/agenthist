import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentPortableProjection } from "../agents/contracts.js";
import { agentAdapter } from "../agents/registry.js";
import { AGENTS, type Agent } from "../domain/agent.js";
import type {
  ArchiveEntry,
  ArchiveManifest,
  ArchiveResourceBinding,
  ProjectedArchiveEntry,
} from "../domain/archive.js";
import {
  conversionStatus,
  deriveConversionKey,
  normalizeConversionFindings,
  type ConversionFinding,
  type ConversionStatus,
} from "../domain/conversion.js";
import type { ImportEntry, ImportProjection } from "../domain/import.js";
import type { StoredSession } from "../domain/history.js";
import { sourceRevision } from "../domain/history-identity.js";
import type { PathFlavor } from "../domain/host-path.js";
import type { PortableContextSession } from "../domain/portable-context.js";
import {
  managedResourceReference,
  type ManagedResourceObject,
  type ManagedResourceReference,
} from "../domain/resource.js";
import type { ArchiveObjectSource, PreparedArchiveEntries } from "../infrastructure/archive.js";
import { digestFile } from "../infrastructure/files.js";
import {
  MANAGED_RESOURCE_OBJECT_KIND,
  validateArchiveManagedResources,
} from "../infrastructure/managed-resources.js";
import { createArchiveSourceMaterializer } from "./archive-source.js";

export interface ImportConversionPlanItem {
  readonly sourceAgent: Agent;
  readonly targetAgent: Agent;
  readonly sourceSessionRef: string;
  readonly sourceRevision: string;
  readonly targetSessionRef: string;
  readonly status: ConversionStatus;
  readonly findings: readonly ConversionFinding[];
  readonly resources: readonly ManagedResourceReference[];
}

export interface ImportConversionStatusCounts {
  readonly exact: number;
  readonly degraded: number;
  readonly blocked: number;
}

export interface PreparedImportConversions {
  readonly statusCounts: ImportConversionStatusCounts;
  readonly items: readonly ImportConversionPlanItem[];
  readonly entries: readonly ImportEntry[];
  readonly sources: readonly ArchiveObjectSource[];
}

export interface PrepareImportConversionsOptions {
  readonly entries: readonly ArchiveEntry[];
  readonly objects: ReadonlyMap<string, string>;
  readonly destinations: ReadonlyMap<string, Agent>;
  readonly workspace: string;
  readonly allocateObjectId: () => string;
  readonly pathFlavor: PathFlavor;
}

interface PreparedItem extends ImportConversionPlanItem {
  readonly source: StoredSession;
  readonly sourceNativeId: string;
  readonly conversionKey: string;
  readonly portable?: PortableContextSession;
  readonly projection?: AgentPortableProjection;
  readonly resourceObjects: readonly ManagedResourceObject[];
}

function portableResources(session: PortableContextSession): ManagedResourceReference[] {
  return session.messages.flatMap((message) => message.blocks.flatMap((block) =>
    block.kind === "historical_tool"
      ? [...(block.tool.resources ?? [])]
      : block.kind === "historical_resource"
        ? [block.resource]
        : []));
}

function resourceStorageKey(resource: ManagedResourceReference): string {
  return JSON.stringify([
    resource.sha256,
    resource.sizeBytes,
    resource.mediaType,
    resource.name,
    resource.relativePath,
  ]);
}

function resourceStorageLabel(resource: ManagedResourceReference): string {
  return `${resource.name}:${resource.sha256.slice(0, 12)}`;
}

function requireResourceClosure(
  session: PortableContextSession | undefined,
  resources: readonly ManagedResourceObject[],
  sourceSessionRef: string,
): void {
  if (session === undefined) return;
  const referenced = new Map(portableResources(session)
    .map((resource) => [resourceStorageKey(resource), resource] as const));
  const extracted = new Map(resources.map((resource) => {
    const reference = managedResourceReference(resource);
    return [resourceStorageKey(reference), reference] as const;
  }));
  const missing = [...referenced].filter(([key]) => !extracted.has(key)).map(([, resource]) => resource);
  const extra = [...extracted].filter(([key]) => !referenced.has(key)).map(([, resource]) => resource);
  if (missing.length !== 0 || extra.length !== 0) {
    const details = [
      ...(missing.length === 0 ? [] : [`missing ${missing.map(resourceStorageLabel).join(", ")}`]),
      ...(extra.length === 0 ? [] : [`unreferenced ${extra.map(resourceStorageLabel).join(", ")}`]),
    ].join("; ");
    throw new Error(`managed resource closure changed while planning import: ${sourceSessionRef} (${details})`);
  }
}

function targetFor(options: PrepareImportConversionsOptions, entry: ArchiveEntry): Agent {
  const target = options.destinations.get(entry.sessionRef);
  if (target === undefined) throw new Error(`import destination is missing: ${entry.sessionRef}`);
  return target;
}

async function prepareItems(options: PrepareImportConversionsOptions): Promise<PreparedItem[]> {
  const prepared: PreparedItem[] = [];
  for (const sourceAgent of AGENTS) {
    const sourceEntries = options.entries.filter((entry) => entry.agent === sourceAgent);
    const convertedEntries = sourceEntries.filter((entry) => targetFor(options, entry) !== sourceAgent);
    if (convertedEntries.length === 0) continue;
    const materializer = await createArchiveSourceMaterializer(
      sourceAgent,
      sourceEntries,
      options.objects,
      options.workspace,
    );
    for (const entry of convertedEntries.toSorted((left, right) => left.sessionRef.localeCompare(right.sessionRef))) {
      const targetAgent = targetFor(options, entry);
      const portableSource = await materializer.prepare(entry.sessionRef);
      const source = portableSource.source;
      const revision = sourceRevision(source);
      const conversionKey = deriveConversionKey(sourceAgent, targetAgent, entry.sessionRef, revision);
      const normalization = portableSource.normalization;
      requireResourceClosure(normalization.session, portableSource.resources, entry.sessionRef);
      const projection = normalization.session === undefined
        ? undefined
        : agentAdapter(targetAgent).portableTarget.project(normalization.session, conversionKey);
      const findings = normalizeConversionFindings([
        ...normalization.findings,
        ...(projection?.findings ?? []),
      ]);
      prepared.push({
        sourceAgent,
        targetAgent,
        source,
        sourceNativeId: entry.nativeId,
        sourceSessionRef: entry.sessionRef,
        sourceRevision: revision,
        conversionKey,
        targetSessionRef: projection?.sessionRef ?? "",
        status: conversionStatus(findings),
        findings,
        ...(normalization.session === undefined ? {} : { portable: normalization.session }),
        ...(projection === undefined ? {} : { projection }),
        resourceObjects: portableSource.resources,
        resources: portableSource.resources.map(managedResourceReference),
      });
    }
  }
  return prepared;
}

async function prepareManagedResourceObjects(
  items: readonly PreparedItem[],
  workspace: string,
  allocateObjectId: () => string,
): Promise<{
  readonly sources: readonly ArchiveObjectSource[];
  readonly bindings: ReadonlyMap<string, readonly ArchiveResourceBinding[]>;
}> {
  const sources: ArchiveObjectSource[] = [];
  const byDigest = new Map<string, { readonly id: string; readonly filePath: string }>();
  const bindings = new Map<string, ArchiveResourceBinding[]>();
  for (const item of items) {
    const sessionBindings: ArchiveResourceBinding[] = [];
    const boundPaths = new Map<string, ArchiveResourceBinding>();
    for (const resource of [...item.resourceObjects].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath))) {
      let object = byDigest.get(resource.sha256);
      if (object === undefined) {
        const id = allocateObjectId();
        const filePath = path.join(workspace, `${id}.resource`);
        await writeFile(filePath, resource.bytes, { flag: "wx", mode: 0o600 });
        object = { id, filePath };
        byDigest.set(resource.sha256, object);
        sources.push({ id, kind: MANAGED_RESOURCE_OBJECT_KIND, filePath });
      }
      const binding: ArchiveResourceBinding = { id: object.id, ...managedResourceReference(resource) };
      const existing = boundPaths.get(binding.relativePath);
      if (existing !== undefined) {
        if (
          existing.id !== binding.id || existing.sha256 !== binding.sha256 ||
          existing.sizeBytes !== binding.sizeBytes || existing.mediaType !== binding.mediaType ||
          existing.name !== binding.name
        ) throw new Error(`managed resource receiver path collides: ${binding.relativePath}`);
        continue;
      }
      boundPaths.set(binding.relativePath, binding);
      sessionBindings.push(binding);
    }
    bindings.set(item.sourceSessionRef, sessionBindings);
  }
  return { sources, bindings };
}

async function writeProjectedEntries(
  items: readonly PreparedItem[],
  workspace: string,
  allocateObjectId: () => string,
): Promise<PreparedArchiveEntries> {
  const sources: ArchiveObjectSource[] = [];
  const entries: ProjectedArchiveEntry[] = [];
  const write = async (targetAgent: Agent, selected: readonly PreparedItem[]): Promise<void> => {
    const projections = selected.map((item) => {
      if (
        item.projection?.targetAgent !== targetAgent || item.portable === undefined ||
        item.status === "blocked"
      ) throw new Error(`import conversion lost its ${targetAgent} projection`);
      return { projection: item.projection, sourceUpdatedAt: item.source.updatedAt };
    });
    const written = await agentAdapter(targetAgent).portableTarget.write({
      projections,
      workspace,
      allocateObjectId,
    });
    sources.push(...written.sources);
    entries.push(...written.entries);
  };
  for (const targetAgent of AGENTS) {
    const target = agentAdapter(targetAgent).portableTarget;
    if (target.writeMode !== "shared") continue;
    const selected = items.filter((item) => item.targetAgent === targetAgent);
    if (selected.length !== 0) await write(targetAgent, selected);
  }
  for (const item of items) {
    if (agentAdapter(item.targetAgent).portableTarget.writeMode !== "independent") continue;
    if (item.projection === undefined || item.portable === undefined || item.status === "blocked") {
      throw new Error("import conversion lost its target projection");
    }
    await write(item.targetAgent, [item]);
  }
  return { sources, entries };
}

function importProjection(item: PreparedItem): ImportProjection {
  if (item.status === "blocked") throw new Error("blocked import conversion cannot form a target entry");
  return {
    sourceAgent: item.sourceAgent,
    sourceSessionRef: item.sourceSessionRef,
    sourceNativeId: item.sourceNativeId,
    sourceRevision: item.sourceRevision,
    targetAgent: item.targetAgent,
    conversionKey: item.conversionKey,
    status: item.status,
    findings: item.findings,
  };
}

function completeProjectedEntries(
  items: readonly PreparedItem[],
  projected: readonly ProjectedArchiveEntry[],
  resources: ReadonlyMap<string, readonly ArchiveResourceBinding[]>,
): ImportEntry[] {
  const byTarget = new Map<string, PreparedItem>();
  for (const item of items) {
    if (item.targetSessionRef === "" || byTarget.has(item.targetSessionRef)) {
      throw new Error(`import conversion target identity is ambiguous: ${item.targetSessionRef || "missing"}`);
    }
    byTarget.set(item.targetSessionRef, item);
  }
  const entries = projected.map((entry): ImportEntry => {
    const item = byTarget.get(entry.sessionRef);
    if (
      item === undefined || entry.agent !== item.targetAgent ||
      entry.nativeId !== item.projection?.nativeId
    ) throw new Error(`projected import entry does not match its route: ${entry.sessionRef}`);
    byTarget.delete(entry.sessionRef);
    return {
      ...entry,
      library: item.source.library,
      resources: resources.get(item.sourceSessionRef) ?? [],
      projection: importProjection(item),
    };
  });
  if (byTarget.size !== 0) throw new Error("projected import entries do not cover the route plan");
  return entries;
}

async function validateProjectedEntries(
  entries: readonly ImportEntry[],
  sources: readonly ArchiveObjectSource[],
  pathFlavor: PathFlavor,
): Promise<void> {
  const extracted = new Map(sources.map((source) => [source.id, source.filePath]));
  const descriptors = new Map<string, ArchiveManifest["objects"][number]>();
  for (const source of sources) {
    const digest = await digestFile(source.filePath);
    descriptors.set(source.id, {
      id: source.id,
      kind: source.kind,
      sizeBytes: digest.sizeBytes,
      sha256: digest.sha256,
    });
  }
  for (const agent of AGENTS) {
    agentAdapter(agent).archive.validateEntries(
      entries.filter((entry) => entry.agent === agent),
      descriptors,
      extracted,
    );
  }
  validateArchiveManagedResources(entries, descriptors);
  for (const agent of AGENTS) {
    await agentAdapter(agent).archive.validateObjects(
      entries.filter((entry) => entry.agent === agent),
      extracted,
      pathFlavor,
    );
  }
}

function statusCounts(items: readonly PreparedItem[]): ImportConversionStatusCounts {
  return {
    exact: items.filter((item) => item.status === "exact").length,
    degraded: items.filter((item) => item.status === "degraded").length,
    blocked: items.filter((item) => item.status === "blocked").length,
  };
}

function publicItems(items: readonly PreparedItem[]): ImportConversionPlanItem[] {
  const order = { blocked: 0, degraded: 1, exact: 2 } as const;
  return items.map((item) => ({
    sourceAgent: item.sourceAgent,
    targetAgent: item.targetAgent,
    sourceSessionRef: item.sourceSessionRef,
    sourceRevision: item.sourceRevision,
    targetSessionRef: item.targetSessionRef,
    status: item.status,
    findings: item.findings,
    resources: item.resources,
  })).toSorted((left, right) =>
    order[left.status] - order[right.status] || left.sourceSessionRef.localeCompare(right.sourceSessionRef));
}

export async function prepareImportConversions(
  options: PrepareImportConversionsOptions,
): Promise<PreparedImportConversions> {
  const prepared = await prepareItems(options);
  const items = publicItems(prepared);
  const counts = statusCounts(prepared);
  if (counts.blocked !== 0 || prepared.length === 0) {
    return { statusCounts: counts, items, entries: [], sources: [] };
  }
  const projected = await writeProjectedEntries(prepared, options.workspace, options.allocateObjectId);
  const managed = await prepareManagedResourceObjects(
    prepared,
    options.workspace,
    options.allocateObjectId,
  );
  const entries = completeProjectedEntries(prepared, projected.entries, managed.bindings);
  const sources = [...projected.sources, ...managed.sources];
  await validateProjectedEntries(entries, sources, options.pathFlavor);
  return { statusCounts: counts, items, entries, sources };
}
