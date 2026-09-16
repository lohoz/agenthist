import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { AGENTS, isAgent, type Agent } from "../domain/agent.js";
import {
  isHistorySnapshotId,
  libraryState,
  readLibraryMetadata,
  sessionAgent,
  type AgentSnapshot,
  type ConversationItem,
  type ConversationMessage,
  type LibraryMetadata,
  type LibraryState,
} from "../domain/history.js";
import { canonicalDigest } from "../domain/history-identity.js";
import { workspacePath } from "../domain/workspace-path.js";
import { codexParentThreadId } from "../agents/codex/history/session-family.js";
import { applyPosixMode, readStableSmallFile } from "../infrastructure/files.js";
import { loadLibraryOverlay } from "../infrastructure/library-store.js";
import { ensurePrivateStateDirectory } from "../infrastructure/state.js";

export const DESKTOP_HISTORY_INDEX_SCHEMA = "agenthist.desktop-history-index/v3" as const;

export const DEFAULT_DESKTOP_HISTORY_LIMIT = 50;
export const MAX_DESKTOP_HISTORY_LIMIT = 500;
export const MAX_DESKTOP_HISTORY_OFFSET = 100_000;
export const DEFAULT_DESKTOP_CONVERSATION_LIMIT = 100;
export const MAX_DESKTOP_CONVERSATION_LIMIT = 1_000;
export const MAX_DESKTOP_CONVERSATION_OFFSET = 1_000_000;
export const DEFAULT_DESKTOP_CONVERSATION_MATCH_LIMIT = 100;
export const MAX_DESKTOP_CONVERSATION_MATCH_LIMIT = 1_000;

const HEAD_BYTES_LIMIT = 64 * 1024;
const SNAPSHOT_BYTES_LIMIT = 512 * 1024 * 1024;
const MAX_SESSIONS_PER_AGENT = 250_000;
const MAX_CONVERSATION_ITEMS = 250_000;
const MAX_ITEM_JSON_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_SEARCH_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_QUERY_BYTES = 512;
const MAX_QUERY_TERMS = 32;
const CJK_CHARACTER = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu;

const INDEX_DIRECTORY = "desktop";
const INDEX_FILE = "history-index.sqlite";
const INDEX_OPERATION_TAILS = new Map<string, Promise<void>>();
const ACTIVE_REBUILDS = new Map<string, Promise<RebuildDesktopHistoryIndexResult>>();

function indexOperationKey(stateDirectory: string): string {
  const resolved = path.resolve(stateDirectory);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function withIndexOperation<T>(stateDirectory: string, action: () => Promise<T>): Promise<T> {
  const key = indexOperationKey(stateDirectory);
  const previous = INDEX_OPERATION_TAILS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  INDEX_OPERATION_TAILS.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    void tail.then(() => {
      if (INDEX_OPERATION_TAILS.get(key) === tail) INDEX_OPERATION_TAILS.delete(key);
    });
  }
}

export type DesktopHistoryIndexIssueCode =
  | "head_invalid"
  | "head_unavailable"
  | "snapshot_invalid"
  | "snapshot_unavailable"
  | "library_invalid"
  | "index_rebuilt"
  | "index_update_failed";

export interface DesktopHistoryIndexIssue {
  readonly scope: "agent" | "library" | "index";
  readonly code: DesktopHistoryIndexIssueCode;
  readonly message: string;
  readonly agent?: Agent;
  readonly snapshotId?: string;
}

export interface DesktopHistoryIndexSyncResult {
  readonly file: string;
  readonly rebuilt: boolean;
  readonly sessions: number;
  readonly updatedAgents: readonly Agent[];
  readonly reusedAgents: readonly Agent[];
  readonly removedAgents: readonly Agent[];
  readonly issues: readonly DesktopHistoryIndexIssue[];
}

export interface RebuildDesktopHistoryIndexResult extends DesktopHistoryIndexSyncResult {
  readonly removed: boolean;
}

export interface DesktopIndexedHistorySummary {
  readonly sessionRef: string;
  readonly memberSessionRefs: readonly string[];
  readonly agent: Agent;
  readonly nativeId: string;
  readonly title: string;
  readonly workspace: string;
  readonly workspaceName: string;
  readonly model: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nativeArchived: boolean;
  readonly libraryName: string;
  readonly libraryState: LibraryState;
  readonly tags: readonly string[];
  readonly preview: string;
  readonly conversationItems: number;
}

export interface ListDesktopHistoryIndexOptions {
  readonly stateDirectory: string;
  readonly query?: string;
  readonly agents?: readonly Agent[];
  readonly workspace?: string;
  readonly workspaceDescendants?: boolean;
  readonly libraryStates?: readonly LibraryState[];
  readonly offset?: number;
  readonly limit?: number;
}

export interface DesktopHistoryIndexPage {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly returned: number;
  readonly remaining: number;
  readonly nextOffset?: number;
  readonly indexRebuilt: boolean;
  readonly sessions: readonly DesktopIndexedHistorySummary[];
}

export interface GetDesktopConversationChunkOptions {
  readonly stateDirectory: string;
  readonly sessionRef: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface DesktopIndexedConversationItem {
  readonly ordinal: number;
  readonly item: ConversationItem;
}

export interface DesktopConversationChunk {
  readonly session: DesktopIndexedHistorySummary;
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly returned: number;
  readonly remaining: number;
  readonly nextOffset?: number;
  readonly items: readonly DesktopIndexedConversationItem[];
}

export interface FindInDesktopConversationOptions {
  readonly stateDirectory: string;
  readonly sessionRef: string;
  readonly query: string;
  readonly limit?: number;
}

export interface DesktopConversationMatch {
  readonly ordinal: number;
  readonly snippet: string;
}

export interface DesktopConversationSearchResult {
  readonly query: string;
  readonly total: number;
  readonly returned: number;
  readonly matches: readonly DesktopConversationMatch[];
}

interface DatabaseOpenResult {
  readonly database: DatabaseSync;
  readonly rebuilt: boolean;
}

interface IndexedConversationItem {
  readonly ordinal: number;
  readonly json: string;
  readonly searchText: string;
}

interface PreparedIndexedSession {
  readonly parentNativeId: string | undefined;
  readonly sessionRef: string;
  readonly memberSessionRefs: readonly string[];
  readonly agent: Agent;
  readonly nativeId: string;
  readonly nativeTitle: string;
  readonly workspace: string;
  readonly workspaceKey: string;
  readonly workspaceName: string;
  readonly model: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nativeArchived: boolean;
  readonly capturedLibrary: LibraryMetadata;
  readonly effectiveLibrary: LibraryMetadata;
  readonly preview: string;
  readonly extraSearchText: string;
  readonly items: readonly IndexedConversationItem[];
}

interface PreparedAgentSnapshot {
  readonly agent: Agent;
  readonly snapshotId: string;
  readonly sessions: readonly PreparedIndexedSession[];
}

class DesktopHistoryIndexRebuildRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopHistoryIndexRebuildRequired";
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown desktop history index error";
  return Buffer.byteLength(message, "utf8") <= 4096 ? message : `${message.slice(0, 4093)}...`;
}

export function desktopHistoryIndexPath(stateDirectory: string): string {
  return path.join(stateDirectory, INDEX_DIRECTORY, INDEX_FILE);
}

async function ensureIndexDirectory(stateDirectory: string): Promise<string> {
  await ensurePrivateStateDirectory(stateDirectory);
  const directory = path.join(stateDirectory, INDEX_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await applyPosixMode(directory, 0o700);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("desktop history index directory is not a private real directory");
  }
  return directory;
}

async function existingRegularIndex(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("desktop history index is not a regular file");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    PRAGMA trusted_schema = OFF;
  `);
}

function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);
  const version = database.prepare("SELECT value FROM metadata WHERE key = ?").get("schema_version") as
    { readonly value?: unknown } | undefined;
  if (version === undefined) {
    database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      .run("schema_version", DESKTOP_HISTORY_INDEX_SCHEMA);
  } else if (version.value !== DESKTOP_HISTORY_INDEX_SCHEMA) {
    throw new DesktopHistoryIndexRebuildRequired("desktop history index schema is unsupported");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_head (
      agent TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      synced_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS session (
      session_ref TEXT PRIMARY KEY,
      member_refs_json TEXT NOT NULL,
      agent TEXT NOT NULL,
      native_id TEXT NOT NULL,
      native_title TEXT NOT NULL,
      workspace TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      native_archived INTEGER NOT NULL CHECK (native_archived IN (0, 1)),
      captured_library_name TEXT NOT NULL,
      captured_tags_json TEXT NOT NULL,
      captured_archived INTEGER NOT NULL CHECK (captured_archived IN (0, 1)),
      captured_deleted INTEGER NOT NULL CHECK (captured_deleted IN (0, 1)),
      library_name TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      library_state TEXT NOT NULL CHECK (library_state IN ('active', 'archived', 'deleted')),
      preview TEXT NOT NULL,
      extra_search_text TEXT NOT NULL,
      conversation_items INTEGER NOT NULL CHECK (conversation_items >= 0)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS session_recent ON session(updated_at DESC, session_ref);
    CREATE INDEX IF NOT EXISTS session_agent_recent ON session(agent, updated_at DESC, session_ref);
    CREATE INDEX IF NOT EXISTS session_workspace_recent ON session(workspace_key, updated_at DESC, session_ref);
    CREATE INDEX IF NOT EXISTS session_library_recent ON session(library_state, updated_at DESC, session_ref);

    CREATE TABLE IF NOT EXISTS session_member (
      member_ref TEXT PRIMARY KEY,
      session_ref TEXT NOT NULL REFERENCES session(session_ref) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS session_member_session ON session_member(session_ref);

    CREATE TABLE IF NOT EXISTS conversation_item (
      session_ref TEXT NOT NULL REFERENCES session(session_ref) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      item_json TEXT NOT NULL,
      PRIMARY KEY (session_ref, ordinal)
    ) STRICT;

    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      agent UNINDEXED,
      session_ref,
      title,
      workspace,
      model,
      provider,
      tags,
      extra,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
      agent UNINDEXED,
      session_ref UNINDEXED,
      item_ordinal UNINDEXED,
      text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}

function verifyDatabase(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA quick_check(1)").get();
  if (row === undefined || Object.values(row).length !== 1 || Object.values(row)[0] !== "ok") {
    throw new DesktopHistoryIndexRebuildRequired("desktop history index integrity check failed");
  }
}

function openConfiguredDatabase(file: string): DatabaseSync {
  const database = new DatabaseSync(file);
  try {
    configureDatabase(database);
    initializeDatabase(database);
    verifyDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function rebuildableDatabaseError(error: unknown): boolean {
  if (error instanceof DesktopHistoryIndexRebuildRequired) return true;
  const candidate = error as { readonly errcode?: unknown; readonly message?: unknown };
  if (candidate.errcode === 11 || candidate.errcode === 26) return true;
  return typeof candidate.message === "string" &&
    /database disk image is malformed|file is not a database|malformed database schema/i.test(candidate.message);
}

async function quarantineIndexFiles(file: string): Promise<readonly string[]> {
  const nonce = randomUUID();
  const candidates: Array<{ readonly source: string; readonly destination: string }> = [];
  for (const suffix of ["", "-journal", "-wal", "-shm"] as const) {
    const source = `${file}${suffix}`;
    let info;
    try {
      info = await lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`unsafe desktop history index sidecar: ${source}`);
    }
    candidates.push({ source, destination: `${file}.corrupt-${nonce}${suffix}` });
  }
  const moved: Array<{ readonly source: string; readonly destination: string }> = [];
  try {
    for (const candidate of candidates) {
      await rename(candidate.source, candidate.destination);
      moved.push(candidate);
    }
    return moved.map((item) => item.destination);
  } catch (error) {
    for (const item of [...moved].reverse()) {
      try { await rename(item.destination, item.source); } catch { /* preserve the quarantine failure */ }
    }
    throw error;
  }
}

async function openPreparedIndex(file: string): Promise<DatabaseSync> {
  const database = openConfiguredDatabase(file);
  try {
    await applyPosixMode(file, 0o600);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function openIndexDatabase(stateDirectory: string): Promise<DatabaseOpenResult> {
  await ensureIndexDirectory(stateDirectory);
  const file = desktopHistoryIndexPath(stateDirectory);
  const existed = await existingRegularIndex(file);
  try {
    const database = await openPreparedIndex(file);
    return { database, rebuilt: false };
  } catch (error) {
    if (!existed) {
      try { await rm(file, { force: true }); } catch { /* preserve the database error */ }
      throw error;
    }
    if (!rebuildableDatabaseError(error)) {
      throw error;
    }
    const quarantined = await quarantineIndexFiles(file);
    let database: DatabaseSync | undefined;
    try {
      database = await openPreparedIndex(file);
      for (const item of quarantined) {
        try { await rm(item, { force: true }); } catch { /* a stale derived quarantine is harmless */ }
      }
      return { database, rebuilt: true };
    } catch (rebuildError) {
      try { database?.close(); } catch { /* preserve the rebuild error */ }
      throw new Error("desktop history index could not be rebuilt", {
        cause: new AggregateError([error, rebuildError]),
      });
    }
  }
}

function metadataText(value: unknown, label: string, maximumBytes = MAX_METADATA_BYTES): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validConversationItem(value: unknown, label: string): ConversationItem {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const item = value as Record<string, unknown>;
  if (item.kind === "gap") {
    metadataText(item.label, `${label} label`, MAX_ITEM_JSON_BYTES);
    metadataText(item.timestamp, `${label} timestamp`);
    if (item.code !== undefined) metadataText(item.code, `${label} code`);
    return value as ConversationItem;
  }
  if (
    item.kind !== "message" ||
    item.role !== "user" && item.role !== "assistant" && item.role !== "system" && item.role !== "developer"
  ) throw new Error(`${label} is invalid`);
  metadataText(item.text, `${label} text`, MAX_ITEM_JSON_BYTES);
  metadataText(item.timestamp, `${label} timestamp`);
  if (item.model !== undefined) metadataText(item.model, `${label} model`);
  if (item.contentKinds !== undefined && (
    !Array.isArray(item.contentKinds) || item.contentKinds.some((entry) => typeof entry !== "string")
  )) throw new Error(`${label} content kinds are invalid`);
  if (item.portableNotes !== undefined && (
    !Array.isArray(item.portableNotes) || item.portableNotes.some((entry) => typeof entry !== "string")
  )) throw new Error(`${label} portable notes are invalid`);
  if (item.portableBlocks !== undefined && !Array.isArray(item.portableBlocks)) {
    throw new Error(`${label} portable blocks are invalid`);
  }
  return value as ConversationItem;
}

function visibleMessageText(message: ConversationMessage): string {
  const blocks = message.portableBlocks?.flatMap((block) => block.kind === "text" ? [block.text] : []);
  return blocks !== undefined && blocks.length !== 0 ? blocks.join("\n\n") : message.text;
}

function boundedPreview(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = [...normalized];
  return characters.length <= 240 ? normalized : `${characters.slice(0, 239).join("")}…`;
}

function conversationItemSearchText(item: ConversationItem): string {
  if (item.kind === "gap") return [item.label, item.code ?? ""].filter(Boolean).join("\n");
  const technical = [
    ...(item.portableNotes ?? []),
    ...(item.portableBlocks === undefined ? [] : [JSON.stringify(item.portableBlocks)]),
    ...(item.contentKinds ?? []),
  ];
  return [item.text, ...technical].filter((value) => value !== "").join("\n");
}

function cjkSegmentedText(value: string): string {
  return value.replace(CJK_CHARACTER, " $1 ").replace(/\s+/gu, " ").trim();
}

function ftsIndexedText(value: string): string {
  return cjkSegmentedText(value);
}

function workspaceIdentity(value: string): string {
  return workspacePath(value).key;
}

function workspaceBasename(value: string): string {
  const parsed = workspacePath(value);
  return parsed.segments.at(-1) ?? parsed.root;
}

function effectiveLibrary(
  captured: LibraryMetadata,
  sessionRef: string,
  overlay: ReadonlyMap<string, LibraryMetadata>,
): LibraryMetadata {
  return overlay.get(sessionRef) ?? captured;
}

function prepareSession(
  value: unknown,
  agent: Agent,
  overlay: ReadonlyMap<string, LibraryMetadata>,
  index: number,
): PreparedIndexedSession {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${agent} session ${index} is invalid`);
  }
  const session = value as Record<string, unknown>;
  const sessionRef = metadataText(session.sessionRef, `${agent} session reference`, 256);
  if (session.agent !== agent || sessionAgent(sessionRef) !== agent) {
    throw new Error(`${agent} session reference is invalid: ${sessionRef}`);
  }
  const nativeId = metadataText(session.nativeId, `${agent} native ID`);
  const nativeTitle = metadataText(session.title, `${agent} title`);
  const workspace = workspacePath(metadataText(session.context, `${agent} workspace`)).path;
  const model = metadataText(session.model, `${agent} model`);
  const provider = metadataText(session.provider, `${agent} provider`);
  const createdAt = metadataText(session.createdAt, `${agent} created timestamp`);
  const updatedAt = metadataText(session.updatedAt, `${agent} updated timestamp`);
  if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) {
    throw new Error(`${agent} session timestamps are invalid: ${sessionRef}`);
  }
  if (typeof session.nativeArchived !== "boolean") {
    throw new Error(`${agent} archive state is invalid: ${sessionRef}`);
  }
  const capturedLibrary = readLibraryMetadata(session.library);
  if (capturedLibrary === undefined) throw new Error(`${agent} library metadata is invalid: ${sessionRef}`);
  if (!Array.isArray(session.conversation) || session.conversation.length > MAX_CONVERSATION_ITEMS) {
    throw new Error(`${agent} conversation exceeds item limits: ${sessionRef}`);
  }
  if (!Array.isArray(session.searchText) || session.searchText.some((entry) => typeof entry !== "string")) {
    throw new Error(`${agent} search text is invalid: ${sessionRef}`);
  }
  const extraSearchText = session.searchText.join("\n");
  if (Buffer.byteLength(extraSearchText, "utf8") > MAX_SESSION_SEARCH_BYTES) {
    throw new Error(`${agent} search text exceeds byte limits: ${sessionRef}`);
  }
  const items = session.conversation.map((item, ordinal): IndexedConversationItem => {
    const validated = validConversationItem(item, `${agent} ${sessionRef} conversation item ${ordinal}`);
    const json = JSON.stringify(validated);
    if (Buffer.byteLength(json, "utf8") > MAX_ITEM_JSON_BYTES) {
      throw new Error(`${agent} conversation item exceeds byte limits: ${sessionRef}`);
    }
    return { ordinal, json, searchText: conversationItemSearchText(validated) };
  });
  const firstUser = session.conversation.find((item): item is ConversationMessage =>
    item !== null && typeof item === "object" && (item as { readonly kind?: unknown }).kind === "message" &&
    (item as { readonly role?: unknown }).role === "user") as ConversationMessage | undefined;
  const firstMessage = session.conversation.find((item): item is ConversationMessage =>
    item !== null && typeof item === "object" && (item as { readonly kind?: unknown }).kind === "message") as
    ConversationMessage | undefined;
  const selectedPreview = firstUser ?? firstMessage;
  return {
    parentNativeId: agent === "codex" ? codexParentThreadId(session.native, nativeId) : undefined,
    sessionRef,
    memberSessionRefs: [sessionRef],
    agent,
    nativeId,
    nativeTitle,
    workspace,
    workspaceKey: workspaceIdentity(workspace),
    workspaceName: workspaceBasename(workspace),
    model,
    provider,
    createdAt,
    updatedAt,
    nativeArchived: session.nativeArchived,
    capturedLibrary,
    effectiveLibrary: effectiveLibrary(capturedLibrary, sessionRef, overlay),
    preview: selectedPreview === undefined ? "" : boundedPreview(visibleMessageText(selectedPreview)),
    extraSearchText,
    items,
  };
}

function mergeSessionSegments(sessions: readonly PreparedIndexedSession[]): PreparedIndexedSession[] {
  const byId = new Map(sessions.map((session) => [session.nativeId, session]));
  const roots = new Map<string, string>();
  const familyRoot = (session: PreparedIndexedSession): string => {
    const visited = new Set<string>();
    let current = session;
    while (current.parentNativeId !== undefined && byId.has(current.parentNativeId)) {
      if (visited.has(current.nativeId)) return session.nativeId;
      if (roots.has(current.nativeId)) return roots.get(current.nativeId)!;
      visited.add(current.nativeId);
      current = byId.get(current.parentNativeId)!;
    }
    for (const id of visited) roots.set(id, current.nativeId);
    return current.nativeId;
  };
  const groups = new Map<string, PreparedIndexedSession[]>();
  for (const session of sessions) {
    const key = familyRoot(session);
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }
  return [...groups].map(([rootId, group]) => {
    if (group.length === 1) return group[0]!;
    const byCompleteness = [...group].toSorted((left, right) =>
      right.items.length - left.items.length ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.sessionRef.localeCompare(right.sessionRef));
    const primary = byCompleteness.find((session) => session.nativeId === rootId) ?? byCompleteness[0]!;
    const newest = [...group].toSorted((left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      right.items.length - left.items.length ||
      left.sessionRef.localeCompare(right.sessionRef))[0]!;
    const uniqueItems = new Map<string, IndexedConversationItem & { readonly sequence: number; readonly time: number }>();
    let sequence = 0;
    for (const session of [...group].toSorted((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.sessionRef.localeCompare(right.sessionRef))) {
      for (const item of session.items) {
        if (uniqueItems.has(item.json)) continue;
        const parsed = JSON.parse(item.json) as { readonly timestamp?: unknown };
        const time = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
        uniqueItems.set(item.json, { ...item, sequence: sequence++, time });
      }
    }
    const items = [...uniqueItems.values()]
      .toSorted((left, right) =>
        (Number.isFinite(left.time) ? left.time : Number.MAX_SAFE_INTEGER) -
          (Number.isFinite(right.time) ? right.time : Number.MAX_SAFE_INTEGER) ||
        left.sequence - right.sequence)
      .map((item, ordinal): IndexedConversationItem => ({
        ordinal,
        json: item.json,
        searchText: item.searchText,
      }));
    const searchLines = new Set(group.flatMap((session) => session.extraSearchText.split("\n")).filter(Boolean));
    const extraSearchText = [...searchLines].join("\n");
    if (Buffer.byteLength(extraSearchText, "utf8") > MAX_SESSION_SEARCH_BYTES) {
      throw new Error(`${primary.agent} merged session search text exceeds byte limits: ${primary.nativeId}`);
    }
    return {
      ...primary,
      memberSessionRefs: group.map((session) => session.sessionRef).toSorted(),
      nativeTitle: primary.nativeTitle || newest.nativeTitle,
      createdAt: group.map((session) => session.createdAt).toSorted()[0]!,
      updatedAt: newest.updatedAt,
      nativeArchived: primary.nativeArchived,
      preview: [...group].toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
        .find((session) => session.preview !== "")?.preview ?? "",
      extraSearchText,
      items,
    };
  });
}

async function readPreparedSnapshot(
  stateDirectory: string,
  agent: Agent,
  snapshotId: string,
  overlay: ReadonlyMap<string, LibraryMetadata>,
): Promise<PreparedAgentSnapshot> {
  const file = path.join(stateDirectory, "history", agent, "snapshots", snapshotId, "index.json");
  const bytes = await readStableSmallFile(file, SNAPSHOT_BYTES_LIMIT);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${agent} history snapshot is invalid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${agent} history snapshot is invalid`);
  }
  const snapshot = parsed as Partial<AgentSnapshot>;
  if (
    snapshot.schemaVersion !== "agenthist.history-snapshot/v2" || snapshot.snapshotId !== snapshotId ||
    snapshot.agent !== agent || !Array.isArray(snapshot.sessions) || snapshot.sessions.length > MAX_SESSIONS_PER_AGENT
  ) throw new Error(`${agent} history snapshot is invalid`);
  const prepared = snapshot.sessions.map((session, index) => prepareSession(session, agent, overlay, index));
  const sessions = mergeSessionSegments(prepared);
  if (new Set(sessions.map((session) => session.sessionRef)).size !== sessions.length) {
    throw new Error(`${agent} history snapshot contains duplicate sessions`);
  }
  return { agent, snapshotId, sessions };
}

type HeadObservation =
  | { readonly status: "missing" }
  | { readonly status: "ready"; readonly snapshotId: string }
  | { readonly status: "issue"; readonly issue: DesktopHistoryIndexIssue };

async function observeHead(stateDirectory: string, agent: Agent): Promise<HeadObservation> {
  const file = path.join(stateDirectory, "history", agent, "head.json");
  let bytes: Buffer;
  try {
    bytes = await readStableSmallFile(file, HEAD_BYTES_LIMIT);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return {
      status: "issue",
      issue: { scope: "agent", agent, code: "head_unavailable", message: safeErrorMessage(error) },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    value = undefined;
  }
  const head = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (
    head?.schemaVersion !== "agenthist.history-head/v1" || typeof head.snapshotId !== "string" ||
    !isHistorySnapshotId(head.snapshotId)
  ) {
    return {
      status: "issue",
      issue: { scope: "agent", agent, code: "head_invalid", message: `${agent} history head is invalid` },
    };
  }
  return { status: "ready", snapshotId: head.snapshotId };
}

function overlayMap(entries: Awaited<ReturnType<typeof loadLibraryOverlay>>["entries"]): ReadonlyMap<string, LibraryMetadata> {
  return new Map(entries.map((entry) => [entry.sessionRef, {
    name: entry.name,
    tags: [...entry.tags],
    archived: entry.archived,
    deleted: entry.deleted,
  }]));
}

function storedHeads(database: DatabaseSync): ReadonlyMap<Agent, string> {
  const rows = database.prepare("SELECT agent, snapshot_id FROM agent_head ORDER BY agent").all() as
    Array<{ readonly agent: unknown; readonly snapshot_id: unknown }>;
  const result = new Map<Agent, string>();
  for (const row of rows) {
    if (typeof row.agent !== "string" || !isAgent(row.agent) || typeof row.snapshot_id !== "string" ||
      !isHistorySnapshotId(row.snapshot_id)) {
      throw new DesktopHistoryIndexRebuildRequired("desktop history index head metadata is invalid");
    }
    result.set(row.agent, row.snapshot_id);
  }
  return result;
}

function begin(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
}

function rollback(database: DatabaseSync): void {
  try { database.exec("ROLLBACK"); } catch { /* preserve the transaction failure */ }
}

function removeAgent(database: DatabaseSync, agent: Agent): void {
  database.prepare("DELETE FROM conversation_fts WHERE agent = ?").run(agent);
  database.prepare("DELETE FROM session_fts WHERE agent = ?").run(agent);
  database.prepare("DELETE FROM session WHERE agent = ?").run(agent);
  database.prepare("DELETE FROM agent_head WHERE agent = ?").run(agent);
}

function insertSession(database: DatabaseSync, session: PreparedIndexedSession): void {
  const captured = session.capturedLibrary;
  const effective = session.effectiveLibrary;
  database.prepare(`
    INSERT INTO session (
      session_ref, member_refs_json, agent, native_id, native_title, workspace, workspace_key, workspace_name,
      model, provider, created_at, updated_at, native_archived,
      captured_library_name, captured_tags_json, captured_archived, captured_deleted,
      library_name, tags_json, library_state, preview, extra_search_text, conversation_items
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.sessionRef,
    JSON.stringify(session.memberSessionRefs),
    session.agent,
    session.nativeId,
    session.nativeTitle,
    session.workspace,
    session.workspaceKey,
    session.workspaceName,
    session.model,
    session.provider,
    session.createdAt,
    session.updatedAt,
    session.nativeArchived ? 1 : 0,
    captured.name,
    JSON.stringify(captured.tags),
    captured.archived ? 1 : 0,
    captured.deleted ? 1 : 0,
    effective.name,
    JSON.stringify(effective.tags),
    libraryState(effective),
    session.preview,
    session.extraSearchText,
    session.items.length,
  );
  const title = effective.name || session.nativeTitle;
  const insertMember = database.prepare("INSERT INTO session_member (member_ref, session_ref) VALUES (?, ?)");
  for (const reference of session.memberSessionRefs) insertMember.run(reference, session.sessionRef);
  database.prepare(`
    INSERT INTO session_fts (agent, session_ref, title, workspace, model, provider, tags, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.agent,
    session.sessionRef,
    ftsIndexedText(title),
    ftsIndexedText(session.workspace),
    ftsIndexedText(session.model),
    ftsIndexedText(session.provider),
    ftsIndexedText(effective.tags.join("\n")),
    ftsIndexedText(session.extraSearchText),
  );
  const insertItem = database.prepare(
    "INSERT INTO conversation_item (session_ref, ordinal, item_json) VALUES (?, ?, ?)",
  );
  const insertSearch = database.prepare(`
    INSERT INTO conversation_fts (agent, session_ref, item_ordinal, text)
    VALUES (?, ?, ?, ?)
  `);
  for (const item of session.items) {
    insertItem.run(session.sessionRef, item.ordinal, item.json);
    if (item.searchText !== "") {
      insertSearch.run(session.agent, session.sessionRef, item.ordinal, ftsIndexedText(item.searchText));
    }
  }
}

function replaceAgentSnapshot(database: DatabaseSync, snapshot: PreparedAgentSnapshot): void {
  begin(database);
  try {
    removeAgent(database, snapshot.agent);
    for (const session of snapshot.sessions) insertSession(database, session);
    database.prepare(`
      INSERT INTO agent_head (agent, snapshot_id, synced_at) VALUES (?, ?, ?)
    `).run(snapshot.agent, snapshot.snapshotId, new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function readTags(value: unknown, label: string): readonly string[] {
  if (typeof value !== "string") throw new DesktopHistoryIndexRebuildRequired(`${label} is invalid`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new DesktopHistoryIndexRebuildRequired(`${label} is invalid`); }
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string")) {
    throw new DesktopHistoryIndexRebuildRequired(`${label} is invalid`);
  }
  return parsed;
}

function updateOverlay(
  database: DatabaseSync,
  overlay: ReadonlyMap<string, LibraryMetadata>,
  digest: string,
): void {
  const rows = database.prepare(`
    SELECT session_ref, agent, native_title, workspace, model, provider, extra_search_text,
           captured_library_name, captured_tags_json, captured_archived, captured_deleted
    FROM session
    ORDER BY session_ref
  `).all() as Array<Record<string, unknown>>;
  const update = database.prepare(`
    UPDATE session SET library_name = ?, tags_json = ?, library_state = ? WHERE session_ref = ?
  `);
  const insertSearch = database.prepare(`
    INSERT INTO session_fts (agent, session_ref, title, workspace, model, provider, tags, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  begin(database);
  try {
    database.prepare("DELETE FROM session_fts").run();
    for (const row of rows) {
      const sessionRef = metadataText(row.session_ref, "indexed session reference", 256);
      const captured = readLibraryMetadata({
        name: row.captured_library_name,
        tags: readTags(row.captured_tags_json, "indexed captured tags"),
        archived: row.captured_archived === 1,
        deleted: row.captured_deleted === 1,
      });
      if (captured === undefined) {
        throw new DesktopHistoryIndexRebuildRequired("indexed captured library metadata is invalid");
      }
      const effective = effectiveLibrary(captured, sessionRef, overlay);
      update.run(effective.name, JSON.stringify(effective.tags), libraryState(effective), sessionRef);
      const nativeTitle = metadataText(row.native_title, "indexed native title");
      insertSearch.run(
        metadataText(row.agent, "indexed Agent", 32),
        sessionRef,
        ftsIndexedText(effective.name || nativeTitle),
        ftsIndexedText(metadataText(row.workspace, "indexed workspace")),
        ftsIndexedText(metadataText(row.model, "indexed model")),
        ftsIndexedText(metadataText(row.provider, "indexed provider")),
        ftsIndexedText(effective.tags.join("\n")),
        ftsIndexedText(metadataText(row.extra_search_text, "indexed extra search text", MAX_SESSION_SEARCH_BYTES)),
      );
    }
    database.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run("overlay_digest", digest);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function overlayDigest(entries: Awaited<ReturnType<typeof loadLibraryOverlay>>["entries"]): string {
  return `ahdesktopoverlay1_${canonicalDigest(entries)}`;
}

async function syncDesktopHistoryIndexUnlocked(stateDirectory: string): Promise<DesktopHistoryIndexSyncResult> {
  const opened = await openIndexDatabase(stateDirectory);
  const database = opened.database;
  const file = desktopHistoryIndexPath(stateDirectory);
  const issues: DesktopHistoryIndexIssue[] = opened.rebuilt
    ? [{ scope: "index", code: "index_rebuilt", message: "desktop history index was rebuilt safely" }]
    : [];
  const updatedAgents: Agent[] = [];
  const reusedAgents: Agent[] = [];
  const removedAgents: Agent[] = [];
  try {
    let library;
    try {
      library = await loadLibraryOverlay(stateDirectory);
    } catch (error) {
      issues.push({ scope: "library", code: "library_invalid", message: safeErrorMessage(error) });
      const sessions = (database.prepare("SELECT count(*) AS count FROM session").get() as { count: number }).count;
      return { file, rebuilt: opened.rebuilt, sessions, updatedAgents, reusedAgents, removedAgents, issues };
    }
    const effectiveOverlay = overlayMap(library.entries);
    const currentHeads = storedHeads(database);
    for (const agent of AGENTS) {
      const observed = await observeHead(stateDirectory, agent);
      if (observed.status === "issue") {
        issues.push(observed.issue);
        continue;
      }
      if (observed.status === "missing") {
        if (!currentHeads.has(agent)) continue;
        try {
          begin(database);
          removeAgent(database, agent);
          database.exec("COMMIT");
          removedAgents.push(agent);
        } catch (error) {
          rollback(database);
          issues.push({
            scope: "agent",
            agent,
            code: "index_update_failed",
            message: safeErrorMessage(error),
          });
        }
        continue;
      }
      if (currentHeads.get(agent) === observed.snapshotId) {
        reusedAgents.push(agent);
        continue;
      }
      let snapshot: PreparedAgentSnapshot;
      try {
        snapshot = await readPreparedSnapshot(stateDirectory, agent, observed.snapshotId, effectiveOverlay);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code === undefined
          ? "snapshot_invalid"
          : "snapshot_unavailable";
        issues.push({
          scope: "agent",
          agent,
          snapshotId: observed.snapshotId,
          code,
          message: safeErrorMessage(error),
        });
        continue;
      }
      try {
        replaceAgentSnapshot(database, snapshot);
        updatedAgents.push(agent);
      } catch (error) {
        issues.push({
          scope: "agent",
          agent,
          snapshotId: observed.snapshotId,
          code: "index_update_failed",
          message: safeErrorMessage(error),
        });
      }
    }
    const digest = overlayDigest(library.entries);
    const storedDigest = database.prepare("SELECT value FROM metadata WHERE key = ?").get("overlay_digest") as
      { readonly value?: unknown } | undefined;
    if (storedDigest?.value !== digest) {
      try {
        updateOverlay(database, effectiveOverlay, digest);
      } catch (error) {
        issues.push({ scope: "library", code: "index_update_failed", message: safeErrorMessage(error) });
      }
    }
    const sessions = (database.prepare("SELECT count(*) AS count FROM session").get() as { count: number }).count;
    return { file, rebuilt: opened.rebuilt, sessions, updatedAgents, reusedAgents, removedAgents, issues };
  } finally {
    database.close();
    await applyPosixMode(file, 0o600);
  }
}

function pageValue(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
  allowZero: boolean,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < (allowZero ? 0 : 1) || resolved > maximum) {
    throw new Error(`${label} is outside the supported range`);
  }
  return resolved;
}

function normalizedAgents(values: readonly Agent[] | undefined): readonly Agent[] {
  if (values === undefined || values.length === 0) return AGENTS;
  if (values.length > AGENTS.length || values.some((agent) => !isAgent(agent))) {
    throw new Error("desktop history Agent filter is invalid");
  }
  return AGENTS.filter((agent) => new Set(values).has(agent));
}

function normalizedStates(values: readonly LibraryState[] | undefined): readonly LibraryState[] {
  const selected = values ?? ["active"];
  if (
    selected.length === 0 || selected.length > 3 ||
    selected.some((state) => state !== "active" && state !== "archived" && state !== "deleted")
  ) throw new Error("desktop history library-state filter is invalid");
  return ["active", "archived", "deleted"].filter((state): state is LibraryState => selected.includes(state as LibraryState));
}

function normalizedQuery(value: string): { readonly query: string; readonly expression: string } {
  const query = value.normalize("NFKC").trim();
  if (query === "" || query.includes("\0") || Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
    throw new Error("desktop history query must be non-empty UTF-8 without NUL and at most 512 bytes");
  }
  const terms = query.split(/\s+/u);
  if (terms.length > MAX_QUERY_TERMS) throw new Error("desktop history query contains too many terms");
  const expression = terms.map((term) => {
    const searchable = cjkSegmentedText(term);
    return `"${searchable.replaceAll('"', '""')}"*`;
  }).join(" AND ");
  return { query, expression };
}

function readMemberSessionRefs(
  value: unknown,
  agent: Agent,
  primaryValue: unknown,
): readonly string[] {
  const primary = metadataText(primaryValue, "indexed session reference", 256);
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256 * 1024) {
    throw new DesktopHistoryIndexRebuildRequired("indexed session members are invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new DesktopHistoryIndexRebuildRequired("indexed session members are invalid");
  }
  if (
    !Array.isArray(parsed) || parsed.length === 0 || parsed.length > 10_000 ||
    parsed.some((reference) => typeof reference !== "string" || sessionAgent(reference) !== agent) ||
    new Set(parsed).size !== parsed.length || !parsed.includes(primary)
  ) throw new DesktopHistoryIndexRebuildRequired("indexed session members are invalid");
  return [...parsed].toSorted();
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function parseSummary(row: Record<string, unknown>): DesktopIndexedHistorySummary {
  const agent = metadataText(row.agent, "indexed Agent", 32);
  if (!isAgent(agent)) throw new DesktopHistoryIndexRebuildRequired("indexed Agent is invalid");
  const state = metadataText(row.library_state, "indexed library state", 16);
  if (state !== "active" && state !== "archived" && state !== "deleted") {
    throw new DesktopHistoryIndexRebuildRequired("indexed library state is invalid");
  }
  const tags = readTags(row.tags_json, "indexed tags");
  const conversationItems = row.conversation_items;
  if (typeof conversationItems !== "number" || !Number.isSafeInteger(conversationItems) || conversationItems < 0) {
    throw new DesktopHistoryIndexRebuildRequired("indexed conversation count is invalid");
  }
  return {
    sessionRef: metadataText(row.session_ref, "indexed session reference", 256),
    memberSessionRefs: readMemberSessionRefs(row.member_refs_json, agent, row.session_ref),
    agent,
    nativeId: metadataText(row.native_id, "indexed native ID"),
    title: metadataText(row.title, "indexed title"),
    workspace: metadataText(row.workspace, "indexed workspace"),
    workspaceName: metadataText(row.workspace_name, "indexed workspace name"),
    model: metadataText(row.model, "indexed model"),
    provider: metadataText(row.provider, "indexed provider"),
    createdAt: metadataText(row.created_at, "indexed created timestamp"),
    updatedAt: metadataText(row.updated_at, "indexed updated timestamp"),
    nativeArchived: row.native_archived === 1,
    libraryName: metadataText(row.library_name, "indexed library name"),
    libraryState: state,
    tags,
    preview: metadataText(row.preview, "indexed preview"),
    conversationItems,
  };
}

const SUMMARY_COLUMNS = `
  s.session_ref, s.member_refs_json, s.agent, s.native_id,
  CASE WHEN s.library_name <> '' THEN s.library_name ELSE s.native_title END AS title,
  s.workspace, s.workspace_name, s.model, s.provider, s.created_at, s.updated_at,
  s.native_archived, s.library_name, s.library_state, s.tags_json, s.preview, s.conversation_items
`;

async function listDesktopHistoryIndexUnlocked(
  options: ListDesktopHistoryIndexOptions,
): Promise<DesktopHistoryIndexPage> {
  const offset = pageValue(options.offset, 0, MAX_DESKTOP_HISTORY_OFFSET, "desktop history offset", true);
  const limit = pageValue(options.limit, DEFAULT_DESKTOP_HISTORY_LIMIT, MAX_DESKTOP_HISTORY_LIMIT, "desktop history limit", false);
  const agents = normalizedAgents(options.agents);
  const states = normalizedStates(options.libraryStates);
  const workspace = options.workspace === undefined
    ? undefined
    : workspaceIdentity(metadataText(options.workspace, "desktop history workspace", 32 * 1024));
  const search = options.query === undefined ? undefined : normalizedQuery(options.query);
  const opened = await openIndexDatabase(options.stateDirectory);
  const database = opened.database;
  try {
    const conditions = [
      `s.agent IN (${placeholders(agents.length)})`,
      `s.library_state IN (${placeholders(states.length)})`,
    ];
    const parameters: SQLInputValue[] = [...agents, ...states];
    if (workspace !== undefined) {
      if (options.workspaceDescendants === true) {
        const separator = workspacePath(options.workspace!).separator;
        const prefix = workspace.endsWith(separator) ? workspace : `${workspace}${separator}`;
        conditions.push("(s.workspace_key = ? OR substr(s.workspace_key, 1, length(?)) = ?)");
        parameters.push(workspace, prefix, prefix);
      } else {
        conditions.push("s.workspace_key = ?");
        parameters.push(workspace);
      }
    }
    if (search !== undefined) {
      conditions.push(`s.session_ref IN (
        SELECT session_ref FROM session_fts WHERE session_fts MATCH ?
        UNION
        SELECT session_ref FROM conversation_fts WHERE conversation_fts MATCH ?
      )`);
      parameters.push(search.expression, search.expression);
    }
    const where = conditions.join(" AND ");
    const count = database.prepare(`SELECT count(*) AS count FROM session s WHERE ${where}`)
      .get(...parameters) as { readonly count: number };
    const rows = database.prepare(`
      SELECT ${SUMMARY_COLUMNS}
      FROM session s
      WHERE ${where}
      ORDER BY s.updated_at DESC, s.session_ref ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset) as Array<Record<string, unknown>>;
    const sessions = rows.map(parseSummary);
    const remaining = Math.max(0, count.count - offset - sessions.length);
    return {
      total: count.count,
      offset,
      limit,
      returned: sessions.length,
      remaining,
      ...(remaining === 0 ? {} : { nextOffset: offset + sessions.length }),
      indexRebuilt: opened.rebuilt,
      sessions,
    };
  } finally {
    database.close();
  }
}

function validatedSessionReference(value: string): string {
  if (Buffer.byteLength(value, "utf8") > 256 || sessionAgent(value) === undefined) {
    throw new Error("desktop history session reference is invalid");
  }
  return value;
}

function summaryForSession(database: DatabaseSync, sessionRef: string): DesktopIndexedHistorySummary {
  const row = database.prepare(`
    SELECT ${SUMMARY_COLUMNS}
    FROM session s
    WHERE s.session_ref = ? OR s.session_ref = (
      SELECT session_ref FROM session_member WHERE member_ref = ?
    )
  `).get(sessionRef, sessionRef) as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error(`desktop history session was not found: ${sessionRef}`);
  return parseSummary(row);
}

function parsedConversationItem(json: unknown): ConversationItem {
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_ITEM_JSON_BYTES) {
    throw new DesktopHistoryIndexRebuildRequired("indexed conversation item is invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch {
    throw new DesktopHistoryIndexRebuildRequired("indexed conversation item is invalid JSON");
  }
  return validConversationItem(parsed, "indexed conversation item");
}

async function getDesktopConversationChunkUnlocked(
  options: GetDesktopConversationChunkOptions,
): Promise<DesktopConversationChunk> {
  const sessionRef = validatedSessionReference(options.sessionRef);
  const offset = pageValue(
    options.offset,
    0,
    MAX_DESKTOP_CONVERSATION_OFFSET,
    "desktop conversation offset",
    true,
  );
  const limit = pageValue(
    options.limit,
    DEFAULT_DESKTOP_CONVERSATION_LIMIT,
    MAX_DESKTOP_CONVERSATION_LIMIT,
    "desktop conversation limit",
    false,
  );
  const opened = await openIndexDatabase(options.stateDirectory);
  const database = opened.database;
  try {
    const session = summaryForSession(database, sessionRef);
    const rows = database.prepare(`
      SELECT ordinal, item_json
      FROM conversation_item
      WHERE session_ref = ?
      ORDER BY ordinal
      LIMIT ? OFFSET ?
    `).all(session.sessionRef, limit, offset) as Array<{ readonly ordinal: unknown; readonly item_json: unknown }>;
    const items = rows.map((row): DesktopIndexedConversationItem => {
      if (typeof row.ordinal !== "number" || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0) {
        throw new DesktopHistoryIndexRebuildRequired("indexed conversation ordinal is invalid");
      }
      return { ordinal: row.ordinal, item: parsedConversationItem(row.item_json) };
    });
    const remaining = Math.max(0, session.conversationItems - offset - items.length);
    return {
      session,
      total: session.conversationItems,
      offset,
      limit,
      returned: items.length,
      remaining,
      ...(remaining === 0 ? {} : { nextOffset: offset + items.length }),
      items,
    };
  } finally {
    database.close();
  }
}

async function findInDesktopConversationUnlocked(
  options: FindInDesktopConversationOptions,
): Promise<DesktopConversationSearchResult> {
  const sessionRef = validatedSessionReference(options.sessionRef);
  const search = normalizedQuery(options.query);
  const limit = pageValue(
    options.limit,
    DEFAULT_DESKTOP_CONVERSATION_MATCH_LIMIT,
    MAX_DESKTOP_CONVERSATION_MATCH_LIMIT,
    "desktop conversation match limit",
    false,
  );
  const opened = await openIndexDatabase(options.stateDirectory);
  const database = opened.database;
  try {
    const session = summaryForSession(database, sessionRef);
    const count = database.prepare(`
      SELECT count(*) AS count
      FROM conversation_fts
      WHERE session_ref = ? AND conversation_fts MATCH ?
    `).get(session.sessionRef, search.expression) as { readonly count: number };
    const rows = database.prepare(`
      SELECT f.item_ordinal, i.item_json
      FROM conversation_fts f
      JOIN conversation_item i
        ON i.session_ref = f.session_ref AND i.ordinal = CAST(f.item_ordinal AS INTEGER)
      WHERE f.session_ref = ? AND conversation_fts MATCH ?
      ORDER BY CAST(f.item_ordinal AS INTEGER)
      LIMIT ?
    `).all(session.sessionRef, search.expression, limit) as
      Array<{ readonly item_ordinal: unknown; readonly item_json: unknown }>;
    const matches = rows.map((row): DesktopConversationMatch => {
      const ordinal = typeof row.item_ordinal === "number"
        ? row.item_ordinal
        : typeof row.item_ordinal === "bigint" ? Number(row.item_ordinal) : Number.NaN;
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
        throw new DesktopHistoryIndexRebuildRequired("indexed conversation search result is invalid");
      }
      const item = parsedConversationItem(row.item_json);
      const text = item.kind === "gap" ? item.label : visibleMessageText(item);
      return { ordinal, snippet: boundedPreview(text) };
    });
    return { query: search.query, total: count.count, returned: matches.length, matches };
  } finally {
    database.close();
  }
}

interface RebuildQuarantineEntry {
  readonly source: string;
  readonly quarantine: string;
}

function validatedRebuildStateDirectory(value: string): string {
  if (
    typeof value !== "string" || value === "" || /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > 64 * 1024 || !path.isAbsolute(value)
  ) throw new Error("desktop history index rebuild requires an absolute valid state directory");
  return path.normalize(value);
}

function rebuildTargets(stateDirectory: string): readonly string[] {
  const file = desktopHistoryIndexPath(stateDirectory);
  return [file, `${file}-journal`, `${file}-wal`, `${file}-shm`];
}

async function quarantineRebuildTargets(stateDirectory: string): Promise<RebuildQuarantineEntry[]> {
  await ensureIndexDirectory(stateDirectory);
  const nonce = randomUUID();
  const available: string[] = [];
  for (const target of rebuildTargets(stateDirectory)) {
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`desktop history index rebuild target is unsafe: ${target}`);
      }
      available.push(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const moved: RebuildQuarantineEntry[] = [];
  try {
    for (const source of available) {
      const quarantine = path.join(
        path.dirname(source),
        `.${path.basename(source)}.rebuild-${nonce}`,
      );
      await rename(source, quarantine);
      moved.push({ source, quarantine });
    }
    return moved;
  } catch (error) {
    for (const entry of [...moved].reverse()) {
      try {
        await lstat(entry.source);
      } catch (observationError) {
        if ((observationError as NodeJS.ErrnoException).code === "ENOENT") {
          try { await rename(entry.quarantine, entry.source); } catch { /* preserve the quarantine error */ }
        }
      }
    }
    throw error;
  }
}

async function cleanupSuccessfulQuarantine(entries: readonly RebuildQuarantineEntry[]): Promise<void> {
  for (const entry of entries) {
    try {
      const info = await lstat(entry.quarantine);
      if (info.isFile() && !info.isSymbolicLink()) await rm(entry.quarantine, { force: true });
    } catch {
      // The rebuilt index is already authoritative; never undo it for best-effort quarantine cleanup.
    }
  }
}

async function restoreFailedQuarantine(entries: readonly RebuildQuarantineEntry[]): Promise<void> {
  const nonce = randomUUID();
  for (const entry of [...entries].reverse()) {
    try {
      const quarantined = await lstat(entry.quarantine);
      if (!quarantined.isFile() || quarantined.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let displaced: string | undefined;
    try {
      const current = await lstat(entry.source);
      if (!current.isFile() || current.isSymbolicLink()) continue;
      displaced = `${entry.quarantine}.failed-${nonce}`;
      await rename(entry.source, displaced);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    try {
      await rename(entry.quarantine, entry.source);
    } catch {
      if (displaced !== undefined) {
        try {
          await lstat(entry.source);
        } catch (observationError) {
          if ((observationError as NodeJS.ErrnoException).code === "ENOENT") {
            try { await rename(displaced, entry.source); } catch { /* preserve both recoverable files */ }
          }
        }
      }
      continue;
    }
    if (displaced !== undefined) {
      try { await rm(displaced, { force: true }); } catch { /* the failed derived file remains quarantined */ }
    }
  }
}

async function rebuildDesktopHistoryIndexUnlocked(
  stateDirectory: string,
): Promise<RebuildDesktopHistoryIndexResult> {
  const quarantined = await quarantineRebuildTargets(stateDirectory);
  try {
    const synced = await syncDesktopHistoryIndexUnlocked(stateDirectory);
    if (synced.issues.length !== 0) {
      throw new Error(`desktop history index rebuild was incomplete: ${synced.issues[0]!.code}`);
    }
    await cleanupSuccessfulQuarantine(quarantined);
    return { ...synced, removed: quarantined.length !== 0 };
  } catch (error) {
    await restoreFailedQuarantine(quarantined);
    throw error;
  }
}

export function syncDesktopHistoryIndex(stateDirectory: string): Promise<DesktopHistoryIndexSyncResult> {
  return withIndexOperation(stateDirectory, () => syncDesktopHistoryIndexUnlocked(stateDirectory));
}

export function listDesktopHistoryIndex(
  options: ListDesktopHistoryIndexOptions,
): Promise<DesktopHistoryIndexPage> {
  return withIndexOperation(options.stateDirectory, () => listDesktopHistoryIndexUnlocked(options));
}

export function getDesktopConversationChunk(
  options: GetDesktopConversationChunkOptions,
): Promise<DesktopConversationChunk> {
  return withIndexOperation(options.stateDirectory, () => getDesktopConversationChunkUnlocked(options));
}

export function findInDesktopConversation(
  options: FindInDesktopConversationOptions,
): Promise<DesktopConversationSearchResult> {
  return withIndexOperation(options.stateDirectory, () => findInDesktopConversationUnlocked(options));
}

export function rebuildDesktopHistoryIndex(stateDirectory: string): Promise<RebuildDesktopHistoryIndexResult> {
  let normalized: string;
  try {
    normalized = validatedRebuildStateDirectory(stateDirectory);
  } catch (error) {
    return Promise.reject(error);
  }
  const key = indexOperationKey(normalized);
  const existing = ACTIVE_REBUILDS.get(key);
  if (existing !== undefined) return existing;
  const pending = withIndexOperation(normalized, () => rebuildDesktopHistoryIndexUnlocked(normalized))
    .finally(() => {
      if (ACTIVE_REBUILDS.get(key) === pending) ACTIVE_REBUILDS.delete(key);
    });
  ACTIVE_REBUILDS.set(key, pending);
  return pending;
}
