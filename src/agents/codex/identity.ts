import { createHash } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYLOAD_SCHEMA = "agenthist.codex.history-identity-payload/v1";
const PROFILE = "agenthist.codex.conversation-key/v1";
const DOMAIN = "agenthist.historyidentity.conversation-key/v1";

function frame(value: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  return Buffer.concat([length, value]);
}

function frameStrings(values: readonly string[]): Buffer {
  return Buffer.concat(values.map((value) => frame(Buffer.from(value, "utf8"))));
}

export function canonicalCodexSessionId(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error("invalid Codex session ID");
  }
  return value.toLowerCase();
}

export function codexSessionRef(nativeId: string): string {
  const canonicalId = canonicalCodexSessionId(nativeId);
  const payload = frameStrings([PAYLOAD_SCHEMA, canonicalId]);
  const digest = createHash("sha256")
    .update(frameStrings([DOMAIN, "codex", PROFILE]))
    .update(frame(payload))
    .digest("hex");
  return `ahsr1_codex_ck1_${digest}`;
}
