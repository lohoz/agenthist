import { lstat } from "node:fs/promises";

import { AGENTS, type Agent } from "../domain/agent.js";
import type { ArchiveEntry } from "../domain/archive.js";
import { normalizeAbsolutePath, samePath } from "../domain/host-path.js";
import { mapAbsolutePath, type PathMappings } from "../domain/path-mapping.js";

export type ImportWorkspaceStatus = "mapped" | "unchanged";

export interface ImportWorkspaceProjection {
  readonly source: string;
  readonly target: string;
  readonly status: ImportWorkspaceStatus;
  readonly agents: readonly Agent[];
  readonly sessionRefs: readonly string[];
}

type WorkspaceEntry = Pick<ArchiveEntry, "agent" | "sessionRef" | "context">;
export type ImportWorkspaceAvailability = "available" | "missing" | "unsafe";

export interface ImportWorkspaceInspection {
  readonly source: string;
  readonly target: string;
  readonly status: ImportWorkspaceStatus;
  readonly availability: ImportWorkspaceAvailability;
  readonly agents: readonly Agent[];
  readonly sessionRefs: readonly string[];
}

interface MutableProjection {
  readonly source: string;
  readonly target: string;
  readonly status: ImportWorkspaceStatus;
  readonly agents: Set<Agent>;
  readonly sessionRefs: Set<string>;
}

interface WorkspaceFailure {
  readonly agent: Agent;
  readonly source: string;
  readonly target: string;
  readonly observation: Exclude<ImportWorkspaceAvailability, "available">;
}

async function observeDirectory(directory: string): Promise<ImportWorkspaceAvailability> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return "unsafe";
  return "available";
}

function failureMessage(failures: readonly WorkspaceFailure[]): string {
  const unique = new Map<string, WorkspaceFailure>();
  for (const failure of failures) {
    unique.set(`${failure.agent}\0${failure.source}\0${failure.target}\0${failure.observation}`, failure);
  }
  const details = [...unique.values()]
    .toSorted((left, right) => left.source.localeCompare(right.source) || left.agent.localeCompare(right.agent))
    .map((failure) => {
      const route = failure.source === failure.target ? failure.source : `${failure.source} -> ${failure.target}`;
      const reason = failure.observation === "missing" ? "target directory does not exist" : "target is not a real directory";
      const hint = failure.source === failure.target
        ? `; use --map-path ${failure.source}=/absolute/target if the workspace moved`
        : "";
      return `  ${failure.agent}  ${route}: ${reason}${hint}`;
    });
  return `workspace path resolution failed before import:\n${details.join("\n")}`;
}

export async function inspectImportWorkspaces(
  entries: readonly WorkspaceEntry[],
  mappings: PathMappings,
): Promise<readonly ImportWorkspaceInspection[]> {
  const observations = new Map<string, Promise<ImportWorkspaceAvailability>>();
  const projected: Array<{
    readonly entry: WorkspaceEntry;
    readonly source: string;
    readonly target: string;
    readonly status: ImportWorkspaceStatus;
    readonly observation: ImportWorkspaceAvailability;
  }> = [];

  for (const entry of entries) {
    const source = normalizeAbsolutePath(entry.context, mappings.sourceFlavor, `${entry.agent} history workspace`);
    const target = mapAbsolutePath(source, mappings, `${entry.agent} history workspace`);
    let pending = observations.get(target);
    if (pending === undefined) {
      pending = observeDirectory(target);
      observations.set(target, pending);
    }
    const observation = await pending;
    projected.push({
      entry,
      source,
      target,
      status: mappings.sourceFlavor === mappings.targetFlavor && samePath(source, target, mappings.sourceFlavor)
        ? "unchanged"
        : "mapped",
      observation,
    });
  }

  const groups = new Map<string, MutableProjection & { availability: ImportWorkspaceAvailability }>();
  for (const item of projected) {
    const key = `${item.source}\0${item.target}\0${item.status}\0${item.observation}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        source: item.source,
        target: item.target,
        status: item.status,
        availability: item.observation,
        agents: new Set(),
        sessionRefs: new Set(),
      };
      groups.set(key, group);
    }
    group.agents.add(item.entry.agent);
    group.sessionRefs.add(item.entry.sessionRef);
  }

  return [...groups.values()]
    .map((group): ImportWorkspaceInspection => ({
      source: group.source,
      target: group.target,
      status: group.status,
      availability: group.availability,
      agents: AGENTS.filter((agent) => group.agents.has(agent)),
      sessionRefs: [...group.sessionRefs].sort(),
    }))
    .toSorted((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target));
}

export async function planImportWorkspaces(
  entries: readonly WorkspaceEntry[],
  mappings: PathMappings,
): Promise<readonly ImportWorkspaceProjection[]> {
  const inspected = await inspectImportWorkspaces(entries, mappings);
  const failures: WorkspaceFailure[] = [];
  for (const item of inspected) {
    if (item.availability === "available") continue;
    for (const agent of item.agents) {
      failures.push({
        agent,
        source: item.source,
        target: item.target,
        observation: item.availability,
      });
    }
  }
  if (failures.length !== 0) throw new Error(failureMessage(failures));
  return inspected.map((item) => ({
    source: item.source,
    target: item.target,
    status: item.status,
    agents: item.agents,
    sessionRefs: item.sessionRefs,
  }));
}
