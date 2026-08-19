import { createHash } from "node:crypto";

import type { Agent } from "./agent.js";
import { canonicalDigest } from "./history-identity.js";
import type { StoredSession } from "./history.js";
import {
  PORTABLE_CONTEXT_PROFILE,
  type PortableContextSession,
} from "./portable-context.js";
import type { ManagedResourceObject } from "./resource.js";

export type ConversionDisposition = "exact" | "degraded" | "skipped" | "synthesized" | "blocked";
export type ConversionStatus = "exact" | "degraded" | "blocked";

export interface ConversionFinding {
  readonly code: string;
  readonly disposition: ConversionDisposition;
  readonly count: number;
}

export interface PortableSourceNormalization {
  readonly status: ConversionStatus;
  readonly findings: readonly ConversionFinding[];
  readonly session?: PortableContextSession;
}

export interface PreparedPortableSource {
  readonly source: StoredSession;
  readonly normalization: PortableSourceNormalization;
  readonly resources: readonly ManagedResourceObject[];
}

export function deriveConversionKey(
  sourceAgent: Agent,
  targetAgent: Agent,
  sourceSessionRef: string,
  revision: string,
): string {
  if (sourceAgent === targetAgent || sourceSessionRef === "" || !/^ahrev1_[0-9a-f]{64}$/.test(revision)) {
    throw new Error("conversion identity inputs are invalid");
  }
  return `ahcv1_${canonicalDigest({
    profile: PORTABLE_CONTEXT_PROFILE,
    sourceAgent,
    targetAgent,
    sourceSessionRef,
    sourceRevision: revision,
  })}`;
}

export function derivedConversionUuid(conversionKey: string, purpose: string): string {
  if (!/^ahcv1_[0-9a-f]{64}$/.test(conversionKey) || purpose === "") {
    throw new Error("converted UUID inputs are invalid");
  }
  const bytes = Buffer.from(createHash("sha256").update(`agenthist.converted-uuid/v1\0${purpose}\0${conversionKey}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function derivedConversionNativeId(conversionKey: string, targetAgent: Agent): string {
  const uuid = derivedConversionUuid(conversionKey, `${targetAgent}.session`);
  return targetAgent === "opencode" ? `ses_agenthist_${uuid.replaceAll("-", "")}` : uuid;
}

export function normalizeConversionFindings(findings: readonly ConversionFinding[]): ConversionFinding[] {
  const allowed = new Set<ConversionDisposition>(["exact", "degraded", "skipped", "synthesized", "blocked"]);
  const merged = new Map<string, ConversionFinding>();
  for (const finding of findings) {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(finding.code) || !allowed.has(finding.disposition) ||
      !Number.isSafeInteger(finding.count) || finding.count <= 0) {
      throw new Error("conversion finding is invalid");
    }
    const key = `${finding.code}\0${finding.disposition}`;
    const previous = merged.get(key);
    merged.set(key, {
      ...finding,
      count: (previous?.count ?? 0) + finding.count,
    });
  }
  return [...merged.values()].sort((left, right) =>
    left.code.localeCompare(right.code) || left.disposition.localeCompare(right.disposition));
}

export function conversionStatus(findings: readonly ConversionFinding[]): ConversionStatus {
  if (findings.some((finding) => finding.disposition === "blocked")) return "blocked";
  if (findings.some((finding) => finding.disposition !== "exact")) return "degraded";
  return "exact";
}
