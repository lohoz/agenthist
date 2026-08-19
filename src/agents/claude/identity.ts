import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYLOAD_SCHEMA = "agenthist.claude.history-identity-payload/v1";
const PROFILE = "agenthist.claude.conversation-key/v1";
const DOMAIN = "agenthist.historyidentity.conversation-key/v1";

function frame(value: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  return Buffer.concat([length, value]);
}

function frameStrings(values: readonly string[]): Buffer {
  return Buffer.concat(values.map((value) => frame(Buffer.from(value, "utf8"))));
}

export function canonicalClaudeUuid(value: string): string {
  if (!UUID.test(value)) throw new Error("invalid Claude Code UUID");
  return value.toLowerCase();
}

export function claudeSessionRef(nativeId: string, firstRootRecordUuid: string): string {
  const session = canonicalClaudeUuid(nativeId);
  const root = canonicalClaudeUuid(firstRootRecordUuid);
  const payload = frameStrings([PAYLOAD_SCHEMA, session, root]);
  const digest = createHash("sha256")
    .update(frameStrings([DOMAIN, "claude", PROFILE]))
    .update(frame(payload))
    .digest("hex");
  return `ahsr1_claude_ck1_${digest}`;
}
