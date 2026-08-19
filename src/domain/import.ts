import type { Agent } from "./agent.js";
import type { ArchiveEntry } from "./archive.js";
import type { ConversionFinding, ConversionStatus } from "./conversion.js";

export interface ImportProjection {
  readonly sourceAgent: Agent;
  readonly sourceSessionRef: string;
  readonly sourceNativeId: string;
  readonly sourceRevision: string;
  readonly targetAgent: Agent;
  readonly conversionKey: string;
  readonly status: Exclude<ConversionStatus, "blocked">;
  readonly findings: readonly ConversionFinding[];
}

export interface ImportEntry extends ArchiveEntry {
  readonly projection?: ImportProjection;
}
