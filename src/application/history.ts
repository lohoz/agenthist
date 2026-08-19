import { AGENTS, type Agent } from "../domain/agent.js";
import {
  libraryState,
  libraryMetadataEqual,
  readLibraryMetadata,
  sessionAgent,
  type AgentSnapshot,
  type ConversationItem,
  type LibraryMetadata,
  type LibraryState,
  type StoredSession,
} from "../domain/history.js";
import type { PortableContextBlock } from "../domain/portable-context.js";
import { loadSnapshot } from "../infrastructure/history-store.js";
import { loadLibraryOverlay, saveLibraryOverlay, type LibraryEntry } from "../infrastructure/library-store.js";
import { withStateReadLock, withStateWriteLock } from "../infrastructure/state.js";
import { assertNoPendingTransactions } from "../infrastructure/transaction-store.js";

export type HistoryView = LibraryState | "all";

export const DEFAULT_HISTORY_OFFSET = 0;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_OFFSET = 100_000;
export const MAX_HISTORY_LIMIT = 1000;

export interface ListHistoryOptions {
  readonly stateDirectory: string;
  readonly agents?: readonly Agent[];
  readonly view?: HistoryView;
  readonly offset?: number;
  readonly limit?: number;
}

export interface HistoryPage {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly returned: number;
  readonly remaining: number;
  readonly nextOffset?: number;
}

export interface HistorySessionSummary {
  readonly sessionRef: string;
  readonly agent: Agent;
  readonly title: string;
  readonly context: string;
  readonly model: string;
  readonly provider: string;
  readonly updatedAt: string;
  readonly nativeArchived: boolean;
  readonly libraryState: LibraryState;
  readonly tags: readonly string[];
}

export interface HistorySessionDetail extends HistorySessionSummary {
  readonly libraryName: string;
  readonly conversation: readonly ConversationItem[];
}

export interface ListHistoryResult extends HistoryPage {
  readonly sessions: readonly HistorySessionSummary[];
}

export interface SearchHit {
  readonly session: HistorySessionSummary;
  readonly field: "name" | "tag" | "title" | "context" | "model" | "session_ref" | "content";
  readonly snippet: string;
}

export interface SearchHistoryResult extends HistoryPage {
  readonly query: string;
  readonly hits: readonly SearchHit[];
}

function includeView(session: StoredSession, view: HistoryView): boolean {
  return view === "all" || libraryState(session.library) === view;
}

function resolveHistoryView(value: HistoryView | undefined): HistoryView {
  const view = value ?? "active";
  if (view !== "active" && view !== "archived" && view !== "deleted" && view !== "all") {
    throw new Error(`unsupported history view: ${view}`);
  }
  return view;
}

function validatePage(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_HISTORY_OFFSET) {
    throw new Error("history offset must be between 0 and 100000");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new Error("history limit must be between 1 and 1000");
  }
}

function pageMetadata(total: number, offset: number, limit: number, returned: number): HistoryPage {
  const remaining = Math.max(0, total - offset - returned);
  return {
    total,
    offset,
    limit,
    returned,
    remaining,
    ...(remaining === 0 ? {} : { nextOffset: offset + returned }),
  };
}

function sessionSummary(session: StoredSession): HistorySessionSummary {
  return {
    sessionRef: session.sessionRef,
    agent: session.agent,
    title: session.library.name || session.title,
    context: session.context,
    model: session.model,
    provider: session.provider,
    updatedAt: session.updatedAt,
    nativeArchived: session.nativeArchived,
    libraryState: libraryState(session.library),
    tags: session.library.tags,
  };
}

function compareSessions(left: StoredSession, right: StoredSession): number {
  const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  return Number.isNaN(byUpdated) || byUpdated === 0 ? left.sessionRef.localeCompare(right.sessionRef) : byUpdated;
}

function sortSessions(sessions: StoredSession[]): void {
  sessions.sort(compareSessions);
}

async function historySnapshots(stateDirectory: string, selected?: readonly Agent[]): Promise<AgentSnapshot[]> {
  const agents = selected ?? AGENTS;
  const snapshots: AgentSnapshot[] = [];
  for (const agent of agents) {
    const snapshot = await loadSnapshot(stateDirectory, agent);
    if (snapshot === undefined) {
      if (selected !== undefined) throw new Error(`no scanned ${agent} history; run agenthist scan first`);
      continue;
    }
    snapshots.push(snapshot);
  }
  if (snapshots.length === 0) throw new Error("no scanned history; run agenthist scan first");
  return snapshots;
}

export async function listHistory(options: ListHistoryOptions): Promise<ListHistoryResult> {
  return withStateReadLock(options.stateDirectory, async () => {
    const view = resolveHistoryView(options.view);
    const offset = options.offset ?? DEFAULT_HISTORY_OFFSET;
    const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
    validatePage(offset, limit);
    const snapshots = await historySnapshots(options.stateDirectory, options.agents);
    const matching = snapshots.flatMap((snapshot) => snapshot.sessions).filter((session) => includeView(session, view));
    sortSessions(matching);
    const sessions = matching.slice(offset, offset + limit).map(sessionSummary);
    return { ...pageMetadata(matching.length, offset, limit, sessions.length), sessions };
  });
}

async function showHistoryUnlocked(stateDirectory: string, sessionRef: string): Promise<StoredSession> {
  const agent = sessionAgent(sessionRef);
  if (agent === undefined) throw new Error("invalid history session reference");
  const snapshot = await loadSnapshot(stateDirectory, agent);
  if (snapshot === undefined) throw new Error(`no scanned ${agent} history; run agenthist scan first`);
  const session = snapshot.sessions.find((candidate) => candidate.sessionRef === sessionRef);
  if (session === undefined) {
    throw new Error(`history session was not found: ${sessionRef}`);
  }
  return session;
}

export async function showHistory(stateDirectory: string, sessionRef: string): Promise<HistorySessionDetail> {
  return withStateReadLock(stateDirectory, async () => {
    const session = await showHistoryUnlocked(stateDirectory, sessionRef);
    return { ...sessionSummary(session), libraryName: session.library.name, conversation: session.conversation };
  });
}

function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function matchingSnippet(value: string, query: string, foldedQuery: string): string | undefined {
  const index = asciiFold(value).indexOf(foldedQuery);
  if (index < 0) {
    return undefined;
  }
  const start = Math.max(0, index - 120);
  const end = Math.min(value.length, index + query.length + 120);
  return `${start === 0 ? "" : "..."}${value.slice(start, end)}${end === value.length ? "" : "..."}`;
}

function portableBlockSearchText(block: PortableContextBlock): readonly string[] {
  if (block.kind === "text") return [block.text];
  if (block.kind === "historical_citations") return [JSON.stringify(block.citations)];
  if (block.kind === "historical_context") return [block.context.sourceRole, block.context.text];
  if (block.kind === "historical_event") return [block.event, block.reason];
  if (block.kind === "historical_work_state") {
    return [
      block.workState.sourceKind,
      ...block.workState.items.flatMap((item) => [
        item.id,
        item.title,
        item.description,
        item.activeLabel ?? "",
        item.assignee ?? "",
        item.priority ?? "",
        item.status,
        ...item.blocks,
        ...item.blockedBy,
      ]),
    ];
  }
  if (block.kind === "historical_reasoning") return block.summary;
  if (block.kind === "historical_reasoning_trace") return [block.text];
  if (block.kind === "historical_reference") {
    return [
      block.reference.type,
      block.reference.namespace,
      block.reference.locator,
      block.reference.title ?? "",
      block.reference.context ?? "",
      block.reference.citations === undefined ? "" : JSON.stringify(block.reference.citations),
    ];
  }
  if (block.kind === "historical_resource") {
    const resource = block.resource;
    return [
      resource.name,
      resource.mediaType,
      resource.sourceReference,
      resource.relativePath,
      resource.sha256,
    ];
  }
  const tool = block.tool;
  return [
    tool.callId,
    tool.name ?? "",
    tool.namespace ?? "",
    tool.status ?? "",
    ...(tool.input === undefined ? [] : [JSON.stringify(tool.input)]),
    ...(tool.output === undefined ? [] : [JSON.stringify(tool.output)]),
    ...(tool.error === undefined ? [] : [JSON.stringify(tool.error)]),
    ...(tool.resources ?? []).flatMap((resource) => [
      resource.name,
      resource.mediaType,
      resource.sourceReference,
      resource.relativePath,
      resource.sha256,
    ]),
    ...(tool.references ?? []).flatMap((reference) => [
      reference.type,
      reference.namespace,
      reference.locator,
      reference.title ?? "",
      reference.context ?? "",
      reference.citations === undefined ? "" : JSON.stringify(reference.citations),
    ]),
  ].filter((value) => value !== "");
}

function conversationSearchText(item: StoredSession["conversation"][number]): readonly string[] {
  return item.kind === "gap"
    ? [item.label]
    : [item.text, ...(item.portableBlocks ?? []).flatMap(portableBlockSearchText)];
}

type SearchMatch = Pick<SearchHit, "field" | "snippet">;

function findHit(session: StoredSession, query: string, foldedQuery: string): SearchMatch | undefined {
  const metadata: Array<[SearchHit["field"], string]> = [
    ["name", session.library.name],
    ...session.library.tags.map((tag): ["tag", string] => ["tag", tag]),
    ["title", session.title],
    ["context", session.context],
    ["model", session.model],
    ["session_ref", session.sessionRef],
  ];
  for (const [field, value] of metadata) {
    const snippet = matchingSnippet(value, query, foldedQuery);
    if (snippet !== undefined) {
      return { field, snippet };
    }
  }
  for (const item of session.conversation) {
    for (const value of conversationSearchText(item)) {
      const snippet = matchingSnippet(value, query, foldedQuery);
      if (snippet !== undefined) return { field: "content", snippet };
    }
  }
  for (const value of session.searchText) {
    const snippet = matchingSnippet(value, query, foldedQuery);
    if (snippet !== undefined) return { field: "content", snippet };
  }
  return undefined;
}

export async function searchHistory(
  options: ListHistoryOptions,
  query: string,
): Promise<SearchHistoryResult> {
  if (query === "" || query.includes("\0") || Buffer.byteLength(query, "utf8") > 512) {
    throw new Error("search query must be non-empty UTF-8 without NUL and at most 512 bytes");
  }
  return withStateReadLock(options.stateDirectory, async () => {
    const view = resolveHistoryView(options.view);
    const offset = options.offset ?? DEFAULT_HISTORY_OFFSET;
    const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
    validatePage(offset, limit);
    const snapshots = await historySnapshots(options.stateDirectory, options.agents);
    const foldedQuery = asciiFold(query);
    const hits: Array<{ readonly session: StoredSession; readonly match: SearchMatch }> = [];
    for (const snapshot of snapshots) {
      for (const session of snapshot.sessions) {
        if (!includeView(session, view)) continue;
        const match = findHit(session, query, foldedQuery);
        if (match !== undefined) hits.push({ session, match });
      }
    }
    hits.sort((left, right) => compareSessions(left.session, right.session));
    const page = hits.slice(offset, offset + limit).map((hit): SearchHit => ({
      session: sessionSummary(hit.session),
      ...hit.match,
    }));
    return { query, ...pageMetadata(hits.length, offset, limit, page.length), hits: page };
  });
}

export type HistoryMutationOperation = "rename" | "tag" | "archive" | "unarchive" | "delete" | "undelete";

export interface MutateHistoryOptions {
  readonly stateDirectory: string;
  readonly sessionRef: string;
  readonly operation: HistoryMutationOperation;
  readonly name?: string;
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
}

export type HistoryLibraryView = {
  readonly name: string;
  readonly tags: readonly string[];
} & (
  | { readonly state: "active" | "archived" }
  | { readonly state: "deleted"; readonly restoreState: "active" | "archived" }
);

export interface MutateHistoryResult {
  readonly sessionRef: string;
  readonly agent: Agent;
  readonly operation: HistoryMutationOperation;
  readonly changed: boolean;
  readonly before: HistoryLibraryView;
  readonly after: HistoryLibraryView;
}

function historyLibraryView(value: LibraryMetadata): HistoryLibraryView {
  const state = libraryState(value);
  const view = {
    name: value.name,
    tags: [...value.tags],
  };
  if (state === "deleted") {
    return { ...view, state, restoreState: value.archived ? "archived" : "active" };
  }
  return { ...view, state };
}

function canonicalLibrary(value: LibraryMetadata): LibraryMetadata {
  const canonical = readLibraryMetadata(value);
  if (canonical === undefined) throw new Error("history library metadata is invalid");
  return canonical;
}

function normalizeMutation(options: MutateHistoryOptions): {
  readonly name?: string;
  readonly addTags: readonly string[];
  readonly removeTags: readonly string[];
} {
  if (!(["rename", "tag", "archive", "unarchive", "delete", "undelete"] as const).includes(options.operation)) {
    throw new Error("history mutation operation is invalid");
  }
  const addTags = [...new Set(options.addTags ?? [])].sort();
  const removeTags = [...new Set(options.removeTags ?? [])].sort();
  if (options.operation === "rename") {
    if (options.name === undefined || addTags.length !== 0 || removeTags.length !== 0) {
      throw new Error("history rename arguments are invalid");
    }
    canonicalLibrary({ name: options.name, tags: [], archived: false, deleted: false });
    return { name: options.name, addTags, removeTags };
  }
  if (options.operation === "tag") {
    if (options.name !== undefined || addTags.length + removeTags.length === 0 ||
      addTags.some((tag) => removeTags.includes(tag))) {
      throw new Error("history tag arguments are invalid");
    }
    canonicalLibrary({
      name: "",
      tags: [...new Set([...addTags, ...removeTags])].sort(),
      archived: false,
      deleted: false,
    });
    return { addTags, removeTags };
  }
  if (options.name !== undefined || addTags.length !== 0 || removeTags.length !== 0) {
    throw new Error(`history ${options.operation} arguments are invalid`);
  }
  return { addTags, removeTags };
}

function applyMutation(
  current: LibraryMetadata,
  operation: HistoryMutationOperation,
  mutation: ReturnType<typeof normalizeMutation>,
): LibraryMetadata {
  if ((operation === "archive" || operation === "unarchive") && current.deleted) {
    throw new Error(`history ${operation} conflicts with a deleted session; undelete it first`);
  }
  if (operation === "rename") return canonicalLibrary({ ...current, name: mutation.name! });
  if (operation === "tag") {
    const tags = new Set(current.tags);
    for (const tag of mutation.addTags) tags.add(tag);
    for (const tag of mutation.removeTags) tags.delete(tag);
    return canonicalLibrary({ ...current, tags: [...tags].sort() });
  }
  if (operation === "archive") return canonicalLibrary({ ...current, archived: true });
  if (operation === "unarchive") return canonicalLibrary({ ...current, archived: false });
  if (operation === "delete") return canonicalLibrary({ ...current, deleted: true });
  return canonicalLibrary({ ...current, deleted: false });
}

export async function mutateHistory(options: MutateHistoryOptions): Promise<MutateHistoryResult> {
  const agent = sessionAgent(options.sessionRef);
  if (agent === undefined) throw new Error("invalid history session reference");
  const mutation = normalizeMutation(options);

  // Validate existence before opening the write lock so an invalid request cannot create state.
  await showHistory(options.stateDirectory, options.sessionRef);
  return withStateWriteLock(options.stateDirectory, async () => {
    await assertNoPendingTransactions(options.stateDirectory);
    const session = await showHistoryUnlocked(options.stateDirectory, options.sessionRef);
    const before = canonicalLibrary(session.library);
    const after = applyMutation(before, options.operation, mutation);
    const changed = !libraryMetadataEqual(before, after);
    if (changed) {
      const overlay = await loadLibraryOverlay(options.stateDirectory);
      const entries: LibraryEntry[] = overlay.entries.filter((entry) => entry.sessionRef !== options.sessionRef);
      entries.push({ sessionRef: options.sessionRef, ...after });
      await saveLibraryOverlay(options.stateDirectory, entries);
    }
    return {
      sessionRef: options.sessionRef,
      agent,
      operation: options.operation,
      changed,
      before: historyLibraryView(before),
      after: historyLibraryView(after),
    };
  });
}
