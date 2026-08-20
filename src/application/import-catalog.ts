import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AGENTS, type Agent } from "../domain/agent.js";
import type { ArchiveEntry } from "../domain/archive.js";
import { libraryState } from "../domain/history.js";
import { readArchive } from "../infrastructure/archive.js";
import { parsePathMappings } from "../domain/path-mapping.js";
import { createArchiveSourceMaterializer, type ArchiveSourceMaterializer } from "./archive-source.js";
import { validateArchiveObjects, validateArchiveSemantics } from "./archive-validation.js";
import { selectImportEntries } from "./import-selection.js";
import {
  inspectImportWorkspaces,
  type ImportWorkspaceInspection,
} from "./workspace-projection.js";
import type {
  HistoryCatalogEntry,
  HistorySelectionCatalog,
  HistorySessionPreview,
} from "./history-catalog.js";

export type ImportCatalogEntry = HistoryCatalogEntry;
export type ImportSessionPreview = HistorySessionPreview;

export interface ImportCatalog extends HistorySelectionCatalog {
  readonly file: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly entries: readonly ImportCatalogEntry[];
  closeSelection(sessionRefs: readonly string[]): readonly ImportCatalogEntry[];
  inspectWorkspaces(
    sessionRefs: readonly string[],
    destinations: Readonly<Record<string, Agent>>,
    pathMappings: readonly string[],
  ): Promise<readonly ImportWorkspaceInspection[]>;
  preview(sessionRef: string): Promise<ImportSessionPreview>;
  close(): Promise<void>;
}

function publicEntry(entry: ArchiveEntry): HistoryCatalogEntry {
  return {
    sessionRef: entry.sessionRef,
    agent: entry.agent,
    nativeId: entry.nativeId,
    title: entry.library.name || entry.title,
    workspace: entry.context,
    model: entry.model,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    nativeArchived: entry.nativeArchived,
    libraryState: libraryState(entry.library),
    tags: entry.library.tags,
    resourceCount: entry.resources.length,
  };
}

export async function openImportCatalog(file: string, cwd = process.cwd()): Promise<ImportCatalog> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agenthist-catalog-"));
  let closed = false;
  try {
    const read = await readArchive(path.resolve(cwd, file), workspace);
    validateArchiveSemantics(read.manifest, read.extractedObjects);
    await validateArchiveObjects(read.manifest, read.extractedObjects);
    const entries = read.manifest.entries;
    const publicEntries = entries.map(publicEntry);
    const materializers = new Map<Agent, Promise<ArchiveSourceMaterializer>>();

    const assertOpen = (): void => {
      if (closed) throw new Error("import catalog is closed");
    };
    const materializer = (agent: Agent): Promise<ArchiveSourceMaterializer> => {
      assertOpen();
      let pending = materializers.get(agent);
      if (pending === undefined) {
        const agentEntries = entries.filter((entry) => entry.agent === agent);
        pending = createArchiveSourceMaterializer(
          agent,
          agentEntries,
          read.extractedObjects,
          path.join(workspace, "preview"),
        );
        materializers.set(agent, pending);
      }
      return pending;
    };

    return {
      file: read.file,
      sizeBytes: read.sizeBytes,
      sha256: read.sha256,
      entries: publicEntries,
      closeSelection(sessionRefs) {
        assertOpen();
        if (sessionRefs.length === 0) return [];
        return selectImportEntries(entries, undefined, sessionRefs).map(publicEntry);
      },
      async inspectWorkspaces(sessionRefs, destinations, pathMappings) {
        assertOpen();
        if (sessionRefs.length === 0) return [];
        const selected = selectImportEntries(entries, undefined, sessionRefs);
        const mappings = parsePathMappings(pathMappings, { sourceFlavor: read.manifest.pathFlavor });
        const inspected = await inspectImportWorkspaces(selected.map((entry) => ({
          agent: destinations[entry.sessionRef] ?? entry.agent,
          sessionRef: entry.sessionRef,
          context: entry.context,
        })), mappings);
        return inspected;
      },
      async preview(sessionRef) {
        assertOpen();
        const entryIndex = entries.findIndex((entry) => entry.sessionRef === sessionRef);
        const entry = entries[entryIndex];
        if (entry === undefined) throw new Error(`archive session was not found: ${sessionRef}`);
        const prepared = await (await materializer(entry.agent)).prepare(sessionRef);
        return { ...publicEntries[entryIndex]!, conversation: prepared.source.conversation };
      },
      async close() {
        if (closed) return;
        closed = true;
        await rm(workspace, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

export function previewImportSession(
  catalog: ImportCatalog,
  sessionRef: string,
): Promise<ImportSessionPreview> {
  return catalog.preview(sessionRef);
}

export function inspectImportCatalogWorkspaces(
  catalog: ImportCatalog,
  sessionRefs: readonly string[],
  destinations: Readonly<Record<string, Agent>>,
  pathMappings: readonly string[],
): Promise<readonly ImportWorkspaceInspection[]> {
  return catalog.inspectWorkspaces(sessionRefs, destinations, pathMappings);
}
