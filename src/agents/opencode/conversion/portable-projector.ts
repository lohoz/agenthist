import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import {
  derivedConversionNativeId,
  normalizeConversionFindings,
  type ConversionFinding,
} from "../../../domain/conversion.js";
import {
  renderPortableContextMessage,
  type PortableContextSession,
} from "../../../domain/portable-context.js";
import type { PreparedArchiveEntries } from "../../../infrastructure/archive.js";
import { createOpenCodeHistoryDatabase } from "../storage/database.js";
import { openCodeSessionRef } from "../identity.js";
import { readOpenCodeHistory } from "../history/reader.js";

const CONVERTED_PROVIDER = "agenthist-converted";

export interface OpenCodePortableProjection {
  readonly targetAgent: "opencode";
  readonly nativeId: string;
  readonly sessionRef: string;
  readonly session: PortableContextSession;
  readonly provider: string;
  readonly findings: readonly ConversionFinding[];
}

function compact(value: string, maximum = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`;
}

function suffix(nativeId: string): string {
  return nativeId.slice("ses_agenthist_".length);
}

export function projectPortableContextToOpenCode(
  session: PortableContextSession,
  conversionKey: string,
): OpenCodePortableProjection {
  if (session.messages.length === 0) throw new Error("portable context session has no messages");
  const nativeId = derivedConversionNativeId(conversionKey, "opencode");
  return {
    targetAgent: "opencode",
    nativeId,
    sessionRef: openCodeSessionRef(nativeId),
    session,
    provider: CONVERTED_PROVIDER,
    findings: normalizeConversionFindings([
      { code: "opencode.session_row.synthesized", disposition: "synthesized", count: 1 },
      { code: "opencode.project_row.synthesized", disposition: "synthesized", count: 1 },
      { code: "opencode.message_rows.synthesized", disposition: "synthesized", count: session.messages.length },
      { code: "opencode.part_rows.synthesized", disposition: "synthesized", count: session.messages.length },
      { code: "opencode.provider_metadata.synthesized", disposition: "synthesized", count: 1 },
    ]),
  };
}

async function writeOpenCodePortableContextDatabase(
  projections: readonly OpenCodePortableProjection[],
  outputPath: string,
): Promise<void> {
  if (projections.length === 0) throw new Error("OpenCode portable projection is empty");
  const rawPath = `${outputPath}.native`;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(rawPath);
    database.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY);
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        directory TEXT NOT NULL,
        path TEXT,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        model TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      INSERT INTO project (id) VALUES ('global');
    `);
    const insertSession = database.prepare(`
      INSERT INTO session
        (id, project_id, parent_id, directory, path, title, version, model, time_created, time_updated, time_archived)
      VALUES (?, 'global', NULL, ?, '.', ?, 'agenthist-converted', ?, ?, ?, NULL)
    `);
    const insertMessage = database.prepare(`
      INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)
    `);
    const insertPart = database.prepare(`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const projection of projections) {
        const session = projection.session;
        const created = Date.parse(session.messages[0]!.timestamp);
        const updated = Date.parse(session.messages.at(-1)!.timestamp);
        if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created) {
          throw new Error("portable context timestamps cannot produce OpenCode history");
        }
        const firstUserMessage = session.messages.find((message) => message.role === "user");
        const firstUser = firstUserMessage === undefined
          ? ""
          : renderPortableContextMessage(session, firstUserMessage);
        const title = compact(session.title) || compact(firstUser);
        insertSession.run(
          projection.nativeId,
          session.workingDirectory,
          title,
          JSON.stringify({ id: session.defaultModel, providerID: CONVERTED_PROVIDER }),
          created,
          updated,
        );
        let previousMessageId = "";
        for (const message of session.messages) {
          const instant = Date.parse(message.timestamp);
          const ordinal = message.ordinal.toString().padStart(6, "0");
          const messageId = `msg_agenthist_${suffix(projection.nativeId)}_${ordinal}`;
          const partId = `prt_agenthist_${suffix(projection.nativeId)}_${ordinal}`;
          const data = message.role === "user"
            ? {
                role: "user",
                time: { created: instant },
                agent: "build",
                model: { providerID: CONVERTED_PROVIDER, modelID: session.defaultModel },
              }
            : {
                role: "assistant",
                time: { created: instant, completed: instant },
                parentID: previousMessageId,
                modelID: message.model || session.defaultModel,
                providerID: CONVERTED_PROVIDER,
                mode: "build",
                agent: "build",
                path: { cwd: session.workingDirectory, root: session.workingDirectory },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                finish: "stop",
              };
          insertMessage.run(messageId, projection.nativeId, instant, instant, JSON.stringify(data));
          insertPart.run(
            partId,
            messageId,
            projection.nativeId,
            instant,
            instant,
            JSON.stringify({ type: "text", text: renderPortableContextMessage(session, message) }),
          );
          previousMessageId = messageId;
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database?.close();
  }
  try {
    createOpenCodeHistoryDatabase(rawPath, outputPath);
  } finally {
    await rm(rawPath, { force: true });
  }
}

export async function writeOpenCodePortableProjections(
  projections: readonly OpenCodePortableProjection[],
  objectId: string,
  outputPath: string,
): Promise<PreparedArchiveEntries> {
  await writeOpenCodePortableContextDatabase(projections, outputPath);
  const relativePath = "opencode/history.sqlite";
  const captured = readOpenCodeHistory({
    databasePath: outputPath,
    databaseRelativePath: relativePath,
    sidecarFiles: [],
  });
  const byNativeId = new Map(captured.sessions.map((session) => [session.nativeId, session]));
  return {
    sources: [{ id: objectId, kind: "opencode.history-sqlite", filePath: outputPath }],
    entries: projections.map((projection) => {
      const session = byNativeId.get(projection.nativeId);
      if (
        session === undefined || session.sessionRef !== projection.sessionRef ||
        session.provider !== projection.provider || session.context !== projection.session.workingDirectory
      ) throw new Error("OpenCode conversion projection changed its derived metadata");
      return {
        kind: "history",
        agent: "opencode",
        sessionRef: session.sessionRef,
        nativeId: session.nativeId,
        title: session.title,
        context: session.context,
        model: session.model,
        provider: session.provider,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        nativeArchived: false,
        objects: [{ id: objectId, role: "history-database", relativePath }],
        native: session.native,
      };
    }),
  };
}
