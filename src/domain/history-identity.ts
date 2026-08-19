import { createHash } from "node:crypto";

import type { StoredSession } from "./history.js";

export function canonicalHistoryValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical history value contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalHistoryValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${fields.map((key) => `${JSON.stringify(key)}:${canonicalHistoryValue(record[key])}`).join(",")}}`;
  }
  throw new Error("canonical history value has an unsupported type");
}

export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalHistoryValue(value), "utf8").digest("hex");
}

export function sourceRevision(session: StoredSession): string {
  return `ahrev1_${canonicalDigest({
    agent: session.agent,
    sessionRef: session.sessionRef,
    nativeId: session.nativeId,
    context: session.context,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    nativeArchived: session.nativeArchived,
    conversation: session.conversation,
    native: session.native,
  })}`;
}
