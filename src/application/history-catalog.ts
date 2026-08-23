import type { Agent } from "../domain/agent.js";
import { AGENTS } from "../domain/agent.js";
import { libraryState, type ConversationItem, type LibraryState, type StoredSession } from "../domain/history.js";
import { loadSnapshot } from "../infrastructure/history-store.js";
import { withStateReadLock } from "../infrastructure/state.js";

export interface HistoryCatalogEntry {
  readonly sessionRef: string;
  readonly agent: Agent;
  readonly nativeId: string;
  readonly title: string;
  readonly workspace: string;
  readonly model: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nativeArchived: boolean;
  readonly libraryState: LibraryState;
  readonly tags: readonly string[];
  readonly resourceCount: number;
}

export interface HistorySessionPreview extends HistoryCatalogEntry {
  readonly conversation: readonly ConversationItem[];
}

export interface HistorySelectionCatalog {
  readonly entries: readonly HistoryCatalogEntry[];
  closeSelection(sessionRefs: readonly string[]): readonly HistoryCatalogEntry[];
  preview(sessionRef: string): Promise<HistorySessionPreview>;
}

function catalogEntry(session: StoredSession): HistoryCatalogEntry {
  return {
    sessionRef: session.sessionRef,
    agent: session.agent,
    nativeId: session.nativeId,
    title: session.library.name || session.title,
    workspace: session.context,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    nativeArchived: session.nativeArchived,
    libraryState: libraryState(session.library),
    tags: session.library.tags,
    resourceCount: 0,
  };
}

function compareCatalogEntries(left: HistoryCatalogEntry, right: HistoryCatalogEntry): number {
  const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (!Number.isNaN(byUpdated) && byUpdated !== 0) return byUpdated;
  const byAgent = AGENTS.indexOf(left.agent) - AGENTS.indexOf(right.agent);
  return byAgent === 0 ? left.sessionRef.localeCompare(right.sessionRef) : byAgent;
}

export async function openHistoryCatalog(
  stateDirectory: string,
  agents?: readonly Agent[],
): Promise<HistorySelectionCatalog> {
  return withStateReadLock(stateDirectory, async () => {
    const selected = agents ?? AGENTS;
    const sessions: StoredSession[] = [];
    for (const agent of selected) {
      const snapshot = await loadSnapshot(stateDirectory, agent);
      if (snapshot === undefined) {
        if (agents !== undefined) throw new Error(`no scanned ${agent} history; run agenthist scan first`);
        continue;
      }
      sessions.push(...snapshot.sessions);
    }
    if (sessions.length === 0) throw new Error("no scanned history; run agenthist scan first");
    const byReference = new Map(sessions.map((session) => [session.sessionRef, session]));
    const entries = sessions.map(catalogEntry).toSorted(compareCatalogEntries);
    return {
      entries,
      closeSelection(sessionRefs) {
        const requested = new Set(sessionRefs);
        const missing = [...requested].find((sessionRef) => !byReference.has(sessionRef));
        if (missing !== undefined) throw new Error(`selected history session was not found: ${missing}`);
        return entries.filter((entry) => requested.has(entry.sessionRef));
      },
      async preview(sessionRef) {
        const session = byReference.get(sessionRef);
        if (session === undefined) throw new Error(`selected history session was not found: ${sessionRef}`);
        return { ...catalogEntry(session), conversation: session.conversation };
      },
    };
  });
}
