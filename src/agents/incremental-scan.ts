import { createHash } from "node:crypto";
import path from "node:path";

import type { Agent } from "../domain/agent.js";
import type { AgentSnapshot, SnapshotScanState, StoredSession } from "../domain/history.js";

export function incrementalSourceKey(agent: Agent, roots: readonly string[]): string {
  return `${agent}/1:${roots.map((root) => path.resolve(root)).join("\0")}`;
}

export function metadataFingerprint(kind: string, value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`cannot fingerprint ${kind} scan metadata`);
  return `${kind}:${createHash("sha256").update(encoded).digest("hex")}`;
}

export function reusableSessionMap(
  previous: AgentSnapshot | undefined,
  sourceKey: string,
): ReadonlyMap<string, StoredSession> {
  return previous?.scan?.sourceKey === sourceKey
    ? new Map(previous.sessions.map((session) => [session.sessionRef, session]))
    : new Map();
}

export function reusableNativeSessionMap(
  previous: AgentSnapshot | undefined,
  sourceKey: string,
): ReadonlyMap<string, StoredSession> {
  return previous?.scan?.sourceKey === sourceKey
    ? new Map(previous.sessions.map((session) => [session.nativeId, session]))
    : new Map();
}

export function scanState(
  sourceKey: string,
  previous: AgentSnapshot | undefined,
  sessions: readonly StoredSession[],
  reusedSessions: number,
): SnapshotScanState {
  const current = new Set(sessions.map((session) => session.sessionRef));
  return {
    sourceKey,
    reusedSessions,
    rebuiltSessions: sessions.length - reusedSessions,
    removedSessions: previous?.sessions.filter((session) => !current.has(session.sessionRef)).length ?? 0,
  };
}
