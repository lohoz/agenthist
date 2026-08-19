import { createHash } from "node:crypto";

const SESSION_ID = /^ses_[A-Za-z0-9_]+$/;
const PAYLOAD_SCHEMA = "agenthist.opencode.history-identity-payload/v1";
const PROFILE = "agenthist.opencode.conversation-key/v1";
const DOMAIN = "agenthist.historyidentity.conversation-key/v1";

function frame(value: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  return Buffer.concat([length, value]);
}

function frameStrings(values: readonly string[]): Buffer {
  return Buffer.concat(values.map((value) => frame(Buffer.from(value, "utf8"))));
}

export function canonicalOpenCodeSessionId(value: string): string {
  if (!SESSION_ID.test(value) || Buffer.byteLength(value, "utf8") > 4096) {
    throw new Error("invalid OpenCode session ID");
  }
  return value;
}

export function openCodeSessionRef(nativeId: string): string {
  const canonicalId = canonicalOpenCodeSessionId(nativeId);
  const payload = frameStrings([PAYLOAD_SCHEMA, canonicalId]);
  const digest = createHash("sha256")
    .update(frameStrings([DOMAIN, "opencode", PROFILE]))
    .update(frame(payload))
    .digest("hex");
  return `ahsr1_opencode_ck1_${digest}`;
}
