import path from "node:path";
import { writeFile } from "node:fs/promises";

import {
  derivedConversionNativeId,
  normalizeConversionFindings,
  type ConversionFinding,
} from "../../../domain/conversion.js";
import type { JsonValue } from "../../../domain/history.js";
import {
  renderPortableContextMessage,
  type PortableContextSession,
} from "../../../domain/portable-context.js";
import type { PreparedArchiveEntries } from "../../../infrastructure/archive.js";
import { codexSessionRef } from "../identity.js";
import { parseCodexRollout } from "../history/rollout.js";
import { synthesizedThreadRow } from "../storage/database.js";

const CONVERTED_PROVIDER = "agenthist-converted";

export interface CodexPortableProjection {
  readonly targetAgent: "codex";
  readonly nativeId: string;
  readonly sessionRef: string;
  readonly relativePath: string;
  readonly rollout: Buffer;
  readonly provider: string;
  readonly thread: Record<string, JsonValue>;
  readonly findings: readonly ConversionFinding[];
}

function compact(value: string, maximum = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`;
}

export function projectPortableContextToCodex(
  session: PortableContextSession,
  conversionKey: string,
): CodexPortableProjection {
  if (session.messages.length === 0) throw new Error("portable context session has no messages");
  const nativeId = derivedConversionNativeId(conversionKey, "codex");
  const created = new Date(session.messages[0]!.timestamp);
  const updated = new Date(session.messages.at(-1)!.timestamp);
  if (Number.isNaN(created.valueOf()) || Number.isNaN(updated.valueOf()) || updated < created) {
    throw new Error("portable context timestamps cannot produce Codex history");
  }
  const relativePath = path.posix.join(
    "sessions",
    created.toISOString().slice(0, 4),
    created.toISOString().slice(5, 7),
    created.toISOString().slice(8, 10),
    `rollout-${created.toISOString().slice(0, 19).replaceAll(":", "-")}-${nativeId}.jsonl`,
  );
  const records: unknown[] = [
    {
      timestamp: session.messages[0]!.timestamp,
      type: "session_meta",
      payload: {
        id: nativeId,
        session_id: nativeId,
        timestamp: session.messages[0]!.timestamp,
        cwd: session.workingDirectory,
        originator: "agenthist",
        cli_version: "agenthist-converted",
        source: "exec",
        model_provider: CONVERTED_PROVIDER,
        model: session.defaultModel,
        memory_mode: "disabled",
      },
    },
    {
      timestamp: session.messages[0]!.timestamp,
      type: "turn_context",
      payload: { cwd: session.workingDirectory, model: session.defaultModel },
    },
    ...session.messages.map((message) => {
      const text = renderPortableContextMessage(session, message);
      return {
        timestamp: message.timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: message.role,
          content: [{ type: message.role === "user" ? "input_text" : "output_text", text }],
        },
      };
    }),
  ];
  const rollout = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const firstUser = renderPortableContextMessage(
    session,
    session.messages.find((message) => message.role === "user")!,
  );
  const title = compact(session.title) || compact(firstUser);
  return {
    targetAgent: "codex",
    nativeId,
    sessionRef: codexSessionRef(nativeId),
    relativePath,
    rollout,
    provider: CONVERTED_PROVIDER,
    thread: synthesizedThreadRow({
      id: nativeId,
      rolloutPath: relativePath,
      provider: CONVERTED_PROVIDER,
      cwd: session.workingDirectory,
      title,
      model: session.defaultModel,
      firstUserMessage: compact(firstUser),
      createdAt: created,
      updatedAt: updated,
      archived: false,
      cliVersion: "agenthist-converted",
      historyMode: "legacy",
    }),
    findings: normalizeConversionFindings([
      { code: "codex.session_identity.synthesized", disposition: "synthesized", count: 1 },
      { code: "codex.rollout_envelope.synthesized", disposition: "synthesized", count: session.messages.length + 2 },
      { code: "codex.thread_row.synthesized", disposition: "synthesized", count: 1 },
      { code: "codex.memory_eligibility.disabled", disposition: "synthesized", count: 1 },
      { code: "codex.provider_metadata.synthesized", disposition: "synthesized", count: 1 },
      { code: "codex.rollout_path.synthesized", disposition: "synthesized", count: 1 },
    ]),
  };
}

export async function writeCodexPortableProjection(
  projection: CodexPortableProjection,
  objectId: string,
  outputPath: string,
): Promise<PreparedArchiveEntries> {
  await writeFile(outputPath, projection.rollout, { flag: "wx", mode: 0o600 });
  const parsed = await parseCodexRollout(outputPath);
  if (
    parsed.nativeId !== projection.nativeId || parsed.provider !== projection.provider ||
    parsed.cwd !== projection.thread.cwd
  ) throw new Error("Codex conversion projection changed its derived metadata");
  return {
    sources: [{ id: objectId, kind: "codex.rollout", filePath: outputPath }],
    entries: [{
      kind: "history",
      agent: "codex",
      sessionRef: projection.sessionRef,
      nativeId: projection.nativeId,
      title: parsed.title,
      context: parsed.cwd,
      model: parsed.model,
      provider: parsed.provider,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      nativeArchived: false,
      objects: [{ id: objectId, role: "rollout", relativePath: projection.relativePath }],
      native: {
        rollout: {
          relativePath: projection.relativePath,
          archived: false,
          summary: parsed.nativeSummary,
        },
        lineage: {
          historyMode: "legacy",
          sessionId: parsed.sessionId,
          subagentHistoryStartOrdinal: null,
          forkedFromId: null,
          parentThreadId: null,
          historyBase: null,
        },
        spawn: {
          incoming: null,
          componentNativeIds: [projection.nativeId],
          relationStatus: "valid",
        },
        thread: projection.thread,
        section: null,
        dynamicTools: [],
        goal: null,
        unsupportedRelationStatus: "empty",
      },
    }],
  };
}
