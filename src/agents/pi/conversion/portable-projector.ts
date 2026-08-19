import { writeFile } from "node:fs/promises";

import {
  derivedConversionNativeId,
  derivedConversionUuid,
  normalizeConversionFindings,
  type ConversionFinding,
} from "../../../domain/conversion.js";
import type { JsonValue } from "../../../domain/history.js";
import {
  renderPortableContextMessage,
  type PortableContextSession,
} from "../../../domain/portable-context.js";
import type { PreparedArchiveEntries } from "../../../infrastructure/archive.js";
import { parsePiSession } from "../history/session.js";
import { piSessionRef } from "../identity.js";
import { piSessionRelativePath } from "../session-path.js";

const CONVERTED_PROVIDER = "agenthist-converted";

export interface PiPortableProjection {
  readonly targetAgent: "pi";
  readonly nativeId: string;
  readonly sessionRef: string;
  readonly relativePath: string;
  readonly session: Buffer;
  readonly provider: string;
  readonly findings: readonly ConversionFinding[];
}

function fileTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function usage(): Record<string, JsonValue> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function projectPortableContextToPi(
  portable: PortableContextSession,
  conversionKey: string,
): PiPortableProjection {
  if (portable.messages.length === 0) throw new Error("portable context session has no messages");
  const nativeId = derivedConversionNativeId(conversionKey, "pi");
  const created = new Date(portable.messages[0]!.timestamp);
  if (Number.isNaN(created.valueOf())) throw new Error("portable context timestamp cannot produce Pi history");
  const header = {
    type: "session",
    version: 3,
    id: nativeId,
    timestamp: created.toISOString(),
    cwd: portable.workingDirectory,
  };
  const records: Record<string, unknown>[] = [header];
  let parentId: string | null = null;
  if (portable.title.trim() !== "") {
    const id = derivedConversionUuid(conversionKey, "pi.session-info");
    records.push({
      type: "session_info",
      id,
      parentId,
      timestamp: created.toISOString(),
      name: portable.title,
    });
    parentId = id;
  }
  for (const message of portable.messages) {
    const instant = new Date(message.timestamp);
    if (Number.isNaN(instant.valueOf())) throw new Error("portable context timestamp cannot produce Pi history");
    const id = derivedConversionUuid(conversionKey, `pi.message.${message.ordinal}`);
    const text = renderPortableContextMessage(portable, message);
    records.push({
      type: "message",
      id,
      parentId,
      timestamp: instant.toISOString(),
      message: message.role === "user"
        ? { role: "user", content: [{ type: "text", text }], timestamp: instant.valueOf() }
        : {
            role: "assistant",
            content: [{ type: "text", text }],
            api: CONVERTED_PROVIDER,
            provider: CONVERTED_PROVIDER,
            model: message.model || portable.defaultModel || CONVERTED_PROVIDER,
            usage: usage(),
            stopReason: "stop",
            timestamp: instant.valueOf(),
          },
    });
    parentId = id;
  }
  const fileName = `${fileTimestamp(created)}_${nativeId}.jsonl`;
  return {
    targetAgent: "pi",
    nativeId,
    sessionRef: piSessionRef(nativeId),
    relativePath: piSessionRelativePath(portable.workingDirectory, fileName),
    session: Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"),
    provider: CONVERTED_PROVIDER,
    findings: normalizeConversionFindings([
      { code: "pi.session_identity.synthesized", disposition: "synthesized", count: 1 },
      { code: "pi.entry_identity.synthesized", disposition: "synthesized", count: records.length - 1 },
      { code: "pi.parent_graph.synthesized", disposition: "synthesized", count: records.length - 1 },
      { code: "pi.native_envelope.synthesized", disposition: "synthesized", count: records.length },
      { code: "pi.provider_metadata.synthesized", disposition: "synthesized", count: 1 },
    ]),
  };
}

export async function writePiPortableProjection(
  projection: PiPortableProjection,
  objectId: string,
  outputPath: string,
  sourceUpdatedAt: string,
): Promise<PreparedArchiveEntries> {
  await writeFile(outputPath, projection.session, { flag: "wx", mode: 0o600 });
  const parsed = await parsePiSession(outputPath, sourceUpdatedAt);
  if (
    parsed.header.id !== projection.nativeId || parsed.header.parentSession !== undefined ||
    parsed.provider !== projection.provider
  ) throw new Error("Pi conversion projection changed its derived metadata");
  return {
    sources: [{ id: objectId, kind: "pi.session-jsonl", filePath: outputPath }],
    entries: [{
      kind: "history",
      agent: "pi",
      sessionRef: projection.sessionRef,
      nativeId: projection.nativeId,
      title: parsed.title,
      context: parsed.header.cwd,
      model: parsed.model,
      provider: parsed.provider,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      nativeArchived: false,
      objects: [{ id: objectId, role: "session", relativePath: projection.relativePath }],
      native: {
        carrier: {
          relativePath: projection.relativePath,
          fileName: projection.relativePath.split("/").at(-1)!,
          mode: 0o600,
        },
        header: { version: 3, parentSession: null },
        tree: {
          leafId: parsed.leafId,
          roots: parsed.roots,
          branchPoints: parsed.branchPoints,
          entries: parsed.entries.length,
          messages: parsed.messageCount,
        },
        relationStatus: "verified",
        parentSessionRef: null,
        migrationBlockers: [],
      },
    }],
  };
}
