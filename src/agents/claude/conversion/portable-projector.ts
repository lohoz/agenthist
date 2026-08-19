import { writeFile } from "node:fs/promises";

import {
  derivedConversionUuid,
  derivedConversionNativeId,
  normalizeConversionFindings,
  type ConversionFinding,
} from "../../../domain/conversion.js";
import {
  renderPortableContextMessage,
  type PortableContextSession,
} from "../../../domain/portable-context.js";
import type { PreparedArchiveEntries } from "../../../infrastructure/archive.js";
import { claudeSessionRef } from "../identity.js";
import { claudeProjectCarrier } from "../project.js";
import { parseClaudeTranscript } from "../history/transcript.js";

export interface ClaudePortableProjection {
  readonly targetAgent: "claude";
  readonly nativeId: string;
  readonly firstRootRecordUuid: string;
  readonly sessionRef: string;
  readonly projectCarrier: string;
  readonly relativePath: string;
  readonly transcript: Buffer;
  readonly findings: readonly ConversionFinding[];
}

export function projectPortableContextToClaude(
  session: PortableContextSession,
  conversionKey: string,
): ClaudePortableProjection {
  if (session.messages.length === 0) throw new Error("portable context session has no messages");
  const nativeId = derivedConversionNativeId(conversionKey, "claude");
  const firstRootRecordUuid = derivedConversionUuid(conversionKey, "claude.root");
  const projectCarrier = claudeProjectCarrier(session.workingDirectory);
  const records: Record<string, unknown>[] = [];
  let parent: string | null = null;
  let lastUser = "";
  for (const message of session.messages) {
    const text = renderPortableContextMessage(session, message);
    const uuid = message.ordinal === 0
      ? firstRootRecordUuid
      : derivedConversionUuid(conversionKey, `claude.record.${message.ordinal}`);
    const common = {
      parentUuid: parent,
      isSidechain: false,
      type: message.role,
      uuid,
      timestamp: message.timestamp,
      cwd: session.workingDirectory,
      sessionId: nativeId,
      userType: "external",
      entrypoint: "cli",
      gitBranch: "HEAD",
    };
    if (message.role === "user") {
      lastUser = text;
      records.push({
        ...common,
        promptId: derivedConversionUuid(conversionKey, `claude.prompt.${message.ordinal}`),
        permissionMode: "default",
        message: { role: "user", content: text },
      });
    } else {
      records.push({
        ...common,
        message: {
          id: `msg_agenthist_${derivedConversionUuid(conversionKey, `claude.message.${message.ordinal}`).replaceAll("-", "").slice(0, 24)}`,
          type: "message",
          role: "assistant",
          model: message.model || session.defaultModel || "agenthist-converted",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    parent = uuid;
  }
  if (lastUser === "" || parent === null) throw new Error("portable context session cannot produce Claude history");
  records.push({ type: "last-prompt", lastPrompt: lastUser, leafUuid: parent, sessionId: nativeId });
  const transcript = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return {
    targetAgent: "claude",
    nativeId,
    firstRootRecordUuid,
    sessionRef: claudeSessionRef(nativeId, firstRootRecordUuid),
    projectCarrier,
    relativePath: `claude/projects/${projectCarrier}/${nativeId}.jsonl`,
    transcript,
    findings: normalizeConversionFindings([
      { code: "claude.session_identity.synthesized", disposition: "synthesized", count: 1 },
      { code: "claude.record_identity.synthesized", disposition: "synthesized", count: session.messages.length },
      { code: "claude.parent_graph.synthesized", disposition: "synthesized", count: session.messages.length },
      { code: "claude.native_envelope.synthesized", disposition: "synthesized", count: session.messages.length + 1 },
    ]),
  };
}

export async function writeClaudePortableProjection(
  projection: ClaudePortableProjection,
  objectId: string,
  outputPath: string,
  sourceUpdatedAt: string,
): Promise<PreparedArchiveEntries> {
  await writeFile(outputPath, projection.transcript, { flag: "wx", mode: 0o600 });
  const parsed = await parseClaudeTranscript(outputPath, projection.nativeId, sourceUpdatedAt);
  if (parsed.firstRootRecordUuid !== projection.firstRootRecordUuid) {
    throw new Error("Claude conversion projection changed its derived identity");
  }
  return {
    sources: [{ id: objectId, kind: "claude.main-transcript", filePath: outputPath }],
    entries: [{
      kind: "history",
      agent: "claude",
      sessionRef: projection.sessionRef,
      nativeId: projection.nativeId,
      title: parsed.title,
      context: parsed.context,
      model: parsed.model,
      provider: "",
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      nativeArchived: false,
      objects: [{ id: objectId, role: "main-transcript", relativePath: projection.relativePath }],
      native: {
        carrier: {
          mainRelativePath: projection.relativePath,
          projectCarrier: projection.projectCarrier,
          relatedFiles: [],
        },
        identity: { firstRootRecordUuid: projection.firstRootRecordUuid },
        transcript: parsed.nativeSummary,
        relationStatus: "verified",
        migrationBlockers: [],
      },
    }],
  };
}
