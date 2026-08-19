import { AGENTS, isAgent, type Agent } from "./agent.js";
import type { PortableContextBlock } from "./portable-context.js";

export type LibraryState = "active" | "archived" | "deleted";
export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export interface LibraryMetadata {
  readonly name: string;
  readonly tags: readonly string[];
  readonly archived: boolean;
  readonly deleted: boolean;
}

const SESSION_REFERENCE = new RegExp(`^ahsr1_(${AGENTS.join("|")})_ck1_[0-9a-f]{64}$`);
const HISTORY_SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LIBRARY_NAME_BYTES = 4 * 1024;
const MAX_LIBRARY_TAGS = 64;
const MAX_LIBRARY_TAG_BYTES = 256;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validLibraryText(value: string, maximumBytes: number, allowEmpty: boolean): boolean {
  return (allowEmpty || value !== "") && Buffer.byteLength(value, "utf8") <= maximumBytes &&
    Buffer.from(value, "utf8").toString("utf8") === value && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function readLibraryMetadata(value: unknown): LibraryMetadata | undefined {
  const item = objectValue(value);
  if (item === undefined || Object.keys(item).sort().join("\0") !== "archived\0deleted\0name\0tags" ||
    typeof item.name !== "string" || !validLibraryText(item.name, MAX_LIBRARY_NAME_BYTES, true) ||
    !Array.isArray(item.tags) ||
    typeof item.archived !== "boolean" || typeof item.deleted !== "boolean") {
    return undefined;
  }
  const tags = item.tags;
  if (tags.length > MAX_LIBRARY_TAGS ||
    tags.some((tag) => typeof tag !== "string" || !validLibraryText(tag, MAX_LIBRARY_TAG_BYTES, false))) {
    return undefined;
  }
  const stringTags = tags as string[];
  if (stringTags.some((tag, index) => index !== 0 && stringTags[index - 1]! >= tag)) return undefined;
  return {
    name: item.name,
    tags: [...stringTags],
    archived: item.archived,
    deleted: item.deleted,
  };
}

export function libraryState(value: LibraryMetadata): LibraryState {
  return value.deleted ? "deleted" : value.archived ? "archived" : "active";
}

export function libraryMetadataEqual(left: LibraryMetadata, right: LibraryMetadata): boolean {
  return left.name === right.name && left.archived === right.archived && left.deleted === right.deleted &&
    left.tags.length === right.tags.length && left.tags.every((tag, index) => tag === right.tags[index]);
}

export function sessionAgent(reference: string): Agent | undefined {
  const value = SESSION_REFERENCE.exec(reference)?.[1];
  return value !== undefined && isAgent(value) ? value : undefined;
}

export function isHistorySnapshotId(value: string): boolean {
  return HISTORY_SNAPSHOT_ID.test(value);
}

export interface ConversationMessage {
  readonly kind: "message";
  readonly role: "user" | "assistant" | "system" | "developer";
  readonly text: string;
  readonly timestamp: string;
  readonly model?: string;
  readonly contentKinds?: readonly string[];
  readonly portableBlocks?: readonly PortableContextBlock[];
  readonly portableNotes?: readonly string[];
}

export interface ConversationGap {
  readonly kind: "gap";
  readonly label: string;
  readonly timestamp: string;
  readonly code?: string;
}

export type ConversationItem = ConversationMessage | ConversationGap;

export interface StoredSession {
  readonly sessionRef: string;
  readonly agent: Agent;
  readonly nativeId: string;
  readonly title: string;
  readonly context: string;
  readonly model: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nativeArchived: boolean;
  readonly library: LibraryMetadata;
  readonly conversation: readonly ConversationItem[];
  readonly searchText: readonly string[];
  readonly rawFiles: readonly string[];
  readonly native: JsonValue;
  readonly scan?: SessionScanState;
}

export interface SessionScanState {
  readonly fingerprint: string;
  readonly source?: JsonValue;
}

export interface SnapshotScanState {
  readonly sourceKey: string;
  readonly reusedSessions: number;
  readonly rebuiltSessions: number;
  readonly removedSessions: number;
}

export interface AgentSnapshot {
  readonly schemaVersion: "agenthist.history-snapshot/v2";
  readonly snapshotId: string;
  readonly agent: Agent;
  readonly scannedAt: string;
  readonly sessions: readonly StoredSession[];
  readonly auxiliaryFiles: readonly string[];
  readonly warnings: readonly string[];
  readonly scan?: SnapshotScanState;
}
