import { createHash } from "node:crypto";

const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const MAX_SESSION_ID_BYTES = 4096;
const PAYLOAD_SCHEMA = "agenthist.pi.history-identity-payload/v1";
const PROFILE = "agenthist.pi.conversation-key/v1";
const DOMAIN = "agenthist.historyidentity.conversation-key/v1";

function frame(value: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  return Buffer.concat([length, value]);
}

function frameStrings(values: readonly string[]): Buffer {
  return Buffer.concat(values.map((value) => frame(Buffer.from(value, "utf8"))));
}

export function canonicalPiSessionId(value: string): string {
  if (!SESSION_ID.test(value) || Buffer.byteLength(value, "utf8") > MAX_SESSION_ID_BYTES) {
    throw new Error("invalid Pi session ID");
  }
  return value;
}

export function piSessionRef(nativeId: string): string {
  const id = canonicalPiSessionId(nativeId);
  const payload = frameStrings([PAYLOAD_SCHEMA, id]);
  const digest = createHash("sha256")
    .update(frameStrings([DOMAIN, "pi", PROFILE]))
    .update(frame(payload))
    .digest("hex");
  return `ahsr1_pi_ck1_${digest}`;
}
