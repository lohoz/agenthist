import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isAgent, type Agent } from "../domain/agent.js";
import { applyPosixMode } from "../infrastructure/files.js";
import {
  EXPERIENCE_INDEX_SCHEMA,
  EXPERIENCE_PARSER_VERSION,
  type SessionExperienceIndex,
} from "./corpus.js";
import {
  CANDIDATE_ORGANIZATION_PROMPT_VERSION,
  CANDIDATE_ORGANIZATION_SCHEMA_VERSION,
  experienceConsolidationResultJson,
  type ExperienceConsolidationResult,
} from "./candidates.js";
import {
  FAST_DISCOVERY_PROMPT_VERSION,
  FAST_DISCOVERY_SCHEMA_VERSION,
  fastDiscoveryJson,
  type FastDiscoveryResult,
} from "./evidence.js";
import type { AnalysisUsage } from "./model.js";

const DATABASE_RELATIVE_PATH = "experience/index.sqlite";

function databasePath(stateDirectory: string): string {
  return path.join(stateDirectory, DATABASE_RELATIVE_PATH);
}

function initialize(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);
  const metadata = database.prepare("SELECT key, value FROM metadata ORDER BY key").all() as
    Array<{ readonly key: string; readonly value: string }>;
  if (metadata.length === 0) {
    const insert = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    insert.run("schema_version", EXPERIENCE_INDEX_SCHEMA);
  } else if (
    metadata.length !== 1 || metadata[0]?.key !== "schema_version" ||
    metadata[0]?.value !== EXPERIENCE_INDEX_SCHEMA
  ) {
    throw new Error("experience index schema is unsupported");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_index (
      session_ref TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      index_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS current_card (
      card_ref TEXT PRIMARY KEY,
      session_ref TEXT NOT NULL REFERENCES session_index(session_ref) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS current_card_session_ref ON current_card(session_ref);
    CREATE TABLE IF NOT EXISTS fast_discovery (
      cache_key TEXT PRIMARY KEY,
      card_ref TEXT NOT NULL REFERENCES current_card(card_ref) ON DELETE CASCADE,
      profile_fingerprint TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS fast_discovery_card_ref ON fast_discovery(card_ref);
    CREATE TABLE IF NOT EXISTS fast_batch (
      batch_ref TEXT PRIMARY KEY,
      profile_fingerprint TEXT NOT NULL,
      card_count INTEGER NOT NULL,
      requests INTEGER NOT NULL,
      repaired INTEGER NOT NULL CHECK (repaired IN (0, 1)),
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      completed_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS candidate_organization (
      cache_key TEXT PRIMARY KEY,
      request_ref TEXT NOT NULL,
      profile_fingerprint TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      result_json TEXT NOT NULL,
      requests INTEGER NOT NULL,
      repaired INTEGER NOT NULL CHECK (repaired IN (0, 1)),
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS candidate_organization_request_ref ON candidate_organization(request_ref);
    CREATE TABLE IF NOT EXISTS candidate_evidence (
      cache_key TEXT NOT NULL REFERENCES candidate_organization(cache_key) ON DELETE CASCADE,
      card_ref TEXT NOT NULL,
      PRIMARY KEY (cache_key, card_ref)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS candidate_evidence_card_ref ON candidate_evidence(card_ref);
  `);
}

function readIndex(value: string): SessionExperienceIndex {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("experience session index is invalid JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("experience session index is invalid");
  }
  const item = parsed as Record<string, unknown>;
  if (
    item.parserVersion !== EXPERIENCE_PARSER_VERSION || typeof item.sessionRef !== "string" ||
    typeof item.sourceRevision !== "string" || typeof item.agent !== "string" || !isAgent(item.agent) ||
    typeof item.snapshotId !== "string" || typeof item.lineageRef !== "string" ||
    typeof item.logicalDigest !== "string" ||
    !Array.isArray(item.nativeRelationKeys) || item.nativeRelationKeys.some((key) => typeof key !== "string") ||
    typeof item.projectKey !== "string" || typeof item.context !== "string" ||
    typeof item.updatedAt !== "string" || !Array.isArray(item.beats) || !Array.isArray(item.cards)
  ) throw new Error("experience session index is invalid");
  return parsed as SessionExperienceIndex;
}

function openExisting(stateDirectory: string): DatabaseSync | undefined {
  try {
    const database = new DatabaseSync(databasePath(stateDirectory));
    initialize(database);
    return database;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadExperienceIndexes(stateDirectory: string): Promise<SessionExperienceIndex[]> {
  try {
    const info = await lstat(databasePath(stateDirectory));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("experience index is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const database = openExisting(stateDirectory);
  if (database === undefined) return [];
  try {
    const rows = database.prepare(`
      SELECT session_ref, agent, source_revision, snapshot_id, parser_version, index_json
      FROM session_index
      ORDER BY session_ref
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const index = typeof row.index_json === "string" ? readIndex(row.index_json) : undefined;
      if (
        index === undefined || row.session_ref !== index.sessionRef || row.agent !== index.agent ||
        row.source_revision !== index.sourceRevision || row.snapshot_id !== index.snapshotId ||
        row.parser_version !== index.parserVersion
      ) throw new Error("experience session index metadata is inconsistent");
      return index;
    });
  } finally {
    database.close();
  }
}

export interface SaveExperienceIndexesOptions {
  readonly stateDirectory: string;
  readonly scopeAgents: readonly Agent[];
  readonly currentSessionRefs: readonly string[];
  readonly indexes: readonly SessionExperienceIndex[];
}

export interface FastDiscoveryCacheEntry {
  readonly cacheKey: string;
  readonly cardRef: string;
  readonly result: FastDiscoveryResult;
}

export interface SaveFastDiscoveryBatchOptions {
  readonly stateDirectory: string;
  readonly batchRef: string;
  readonly profileFingerprint: string;
  readonly entries: readonly FastDiscoveryCacheEntry[];
  readonly requests: number;
  readonly repaired: boolean;
  readonly usage: AnalysisUsage;
}

export interface SaveExperienceConsolidationOptions {
  readonly stateDirectory: string;
  readonly cacheKey: string;
  readonly requestRef: string;
  readonly evidenceCardRefs: readonly string[];
  readonly profileFingerprint: string;
  readonly result: ExperienceConsolidationResult;
  readonly requests: number;
  readonly repaired: boolean;
  readonly usage: AnalysisUsage;
}

export async function loadFastDiscoveryCache(
  stateDirectory: string,
  keys: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, unknown>> {
  if (keys.size === 0) return new Map();
  const database = openExisting(stateDirectory);
  if (database === undefined) return new Map();
  try {
    const select = database.prepare(`
      SELECT card_ref, schema_version, prompt_version, result_json
      FROM fast_discovery
      WHERE cache_key = ?
    `);
    const result = new Map<string, unknown>();
    for (const [cardRef, cacheKey] of keys) {
      const row = select.get(cacheKey) as Record<string, unknown> | undefined;
      if (row === undefined) continue;
      if (
        row.card_ref !== cardRef || row.schema_version !== FAST_DISCOVERY_SCHEMA_VERSION ||
        row.prompt_version !== FAST_DISCOVERY_PROMPT_VERSION || typeof row.result_json !== "string"
      ) throw new Error("fast discovery cache metadata is inconsistent");
      let parsed: unknown;
      try { parsed = JSON.parse(row.result_json); } catch { throw new Error("fast discovery cache is invalid JSON"); }
      result.set(cardRef, parsed);
    }
    return result;
  } finally {
    database.close();
  }
}

export async function saveFastDiscoveryBatch(options: SaveFastDiscoveryBatchOptions): Promise<void> {
  if (options.entries.length === 0) throw new Error("fast discovery batch cannot be empty");
  const root = path.dirname(databasePath(options.stateDirectory));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await applyPosixMode(root, 0o700);
  const location = databasePath(options.stateDirectory);
  const database = new DatabaseSync(location);
  try {
    initialize(database);
    const insertResult = database.prepare(`
      INSERT INTO fast_discovery
        (cache_key, card_ref, profile_fingerprint, schema_version, prompt_version, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBatch = database.prepare(`
      INSERT INTO fast_batch
        (batch_ref, profile_fingerprint, card_count, requests, repaired,
         input_tokens, output_tokens, total_tokens, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_ref) DO UPDATE SET
        profile_fingerprint = excluded.profile_fingerprint,
        card_count = excluded.card_count,
        requests = excluded.requests,
        repaired = excluded.repaired,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        total_tokens = excluded.total_tokens,
        completed_at = excluded.completed_at
    `);
    const completedAt = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of options.entries) {
        insertResult.run(
          entry.cacheKey,
          entry.cardRef,
          options.profileFingerprint,
          FAST_DISCOVERY_SCHEMA_VERSION,
          FAST_DISCOVERY_PROMPT_VERSION,
          JSON.stringify(fastDiscoveryJson(entry.result)),
          completedAt,
        );
      }
      insertBatch.run(
        options.batchRef,
        options.profileFingerprint,
        options.entries.length,
        options.requests,
        options.repaired ? 1 : 0,
        options.usage.inputTokens,
        options.usage.outputTokens,
        options.usage.totalTokens,
        completedAt,
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
    await applyPosixMode(location, 0o600);
  }
}

export async function loadExperienceConsolidationCache(
  stateDirectory: string,
  keys: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, unknown>> {
  if (keys.size === 0) return new Map();
  const database = openExisting(stateDirectory);
  if (database === undefined) return new Map();
  try {
    const select = database.prepare(`
      SELECT request_ref, schema_version, prompt_version, result_json
      FROM candidate_organization
      WHERE cache_key = ?
    `);
    const result = new Map<string, unknown>();
    for (const [requestRef, cacheKey] of keys) {
      const row = select.get(cacheKey) as Record<string, unknown> | undefined;
      if (row === undefined) continue;
      if (
        row.request_ref !== requestRef || row.schema_version !== CANDIDATE_ORGANIZATION_SCHEMA_VERSION ||
        row.prompt_version !== CANDIDATE_ORGANIZATION_PROMPT_VERSION || typeof row.result_json !== "string"
      ) throw new Error("experience candidate cache metadata is inconsistent");
      let parsed: unknown;
      try { parsed = JSON.parse(row.result_json); } catch {
        throw new Error("experience candidate cache is invalid JSON");
      }
      result.set(requestRef, parsed);
    }
    return result;
  } finally {
    database.close();
  }
}

export async function saveExperienceConsolidation(
  options: SaveExperienceConsolidationOptions,
): Promise<void> {
  if (options.evidenceCardRefs.length === 0) throw new Error("experience candidate evidence cannot be empty");
  const root = path.dirname(databasePath(options.stateDirectory));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await applyPosixMode(root, 0o700);
  const location = databasePath(options.stateDirectory);
  const database = new DatabaseSync(location);
  try {
    initialize(database);
    const insertResult = database.prepare(`
      INSERT INTO candidate_organization
        (cache_key, request_ref, profile_fingerprint, schema_version, prompt_version, result_json,
         requests, repaired, input_tokens, output_tokens, total_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEvidence = database.prepare(`
      INSERT INTO candidate_evidence (cache_key, card_ref)
      VALUES (?, ?)
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      insertResult.run(
        options.cacheKey,
        options.requestRef,
        options.profileFingerprint,
        CANDIDATE_ORGANIZATION_SCHEMA_VERSION,
        CANDIDATE_ORGANIZATION_PROMPT_VERSION,
        JSON.stringify(experienceConsolidationResultJson(options.result)),
        options.requests,
        options.repaired ? 1 : 0,
        options.usage.inputTokens,
        options.usage.outputTokens,
        options.usage.totalTokens,
        new Date().toISOString(),
      );
      new Set(options.evidenceCardRefs).forEach((cardRef) => insertEvidence.run(options.cacheKey, cardRef));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
    await applyPosixMode(location, 0o600);
  }
}

export async function saveExperienceIndexes(options: SaveExperienceIndexesOptions): Promise<number> {
  const root = path.dirname(databasePath(options.stateDirectory));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await applyPosixMode(root, 0o700);
  const location = databasePath(options.stateDirectory);
  const database = new DatabaseSync(location);
  try {
    initialize(database);
    const currentRows = database.prepare("SELECT session_ref, agent FROM session_index").all() as
      Array<{ readonly session_ref: string; readonly agent: string }>;
    const currentCards = database.prepare(`
      SELECT current_card.card_ref, current_card.session_ref, session_index.agent
      FROM current_card
      JOIN session_index ON session_index.session_ref = current_card.session_ref
    `).all() as Array<{ readonly card_ref: string; readonly session_ref: string; readonly agent: string }>;
    const retained = new Set(options.currentSessionRefs);
    const updated = new Set(options.indexes.map((index) => index.sessionRef));
    const retainedCards = new Set(options.indexes.flatMap((index) => index.cards.map((card) => card.cardRef)));
    const scope = new Set<Agent>(options.scopeAgents);
    const remove = currentRows.filter((row) => isAgent(row.agent) && scope.has(row.agent) && !retained.has(row.session_ref));
    const removeCards = currentCards.filter((row) =>
      isAgent(row.agent) && scope.has(row.agent) && updated.has(row.session_ref) && !retainedCards.has(row.card_ref));
    const upsert = database.prepare(`
      INSERT INTO session_index
        (session_ref, agent, source_revision, snapshot_id, parser_version, index_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_ref) DO UPDATE SET
        agent = excluded.agent,
        source_revision = excluded.source_revision,
        snapshot_id = excluded.snapshot_id,
        parser_version = excluded.parser_version,
        index_json = excluded.index_json
    `);
    const removeRow = database.prepare("DELETE FROM session_index WHERE session_ref = ?");
    const upsertCard = database.prepare(`
      INSERT INTO current_card (card_ref, session_ref)
      VALUES (?, ?)
      ON CONFLICT(card_ref) DO UPDATE SET session_ref = excluded.session_ref
    `);
    const removeCard = database.prepare("DELETE FROM current_card WHERE card_ref = ?");
    database.exec("BEGIN IMMEDIATE");
    try {
      remove.forEach((row) => removeRow.run(row.session_ref));
      options.indexes.forEach((index) => upsert.run(
        index.sessionRef,
        index.agent,
        index.sourceRevision,
        index.snapshotId,
        index.parserVersion,
        JSON.stringify(index),
      ));
      options.indexes.forEach((index) => index.cards.forEach((card) => upsertCard.run(card.cardRef, index.sessionRef)));
      removeCards.forEach((row) => removeCard.run(row.card_ref));
      database.exec(`
        DELETE FROM candidate_organization
        WHERE cache_key IN (
          SELECT candidate_evidence.cache_key
          FROM candidate_evidence
          LEFT JOIN current_card ON current_card.card_ref = candidate_evidence.card_ref
          WHERE current_card.card_ref IS NULL
        )
      `);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return remove.length;
  } finally {
    database.close();
    await applyPosixMode(location, 0o600);
  }
}
