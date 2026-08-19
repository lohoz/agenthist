import type { Agent } from "./agent.js";
import type { JsonValue, LibraryMetadata } from "./history.js";
import type { PathFlavor } from "./host-path.js";
import type { ManagedResourceReference } from "./resource.js";

export interface ArchiveObjectDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ArchiveObjectBinding {
  readonly id: string;
  readonly role: string;
  readonly relativePath: string;
}

export interface ArchiveResourceBinding extends ManagedResourceReference {
  readonly id: string;
}

export interface ArchiveEntry {
  readonly kind: "history";
  readonly agent: Agent;
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly title: string;
  readonly context: string;
  readonly model: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nativeArchived: boolean;
  readonly library: LibraryMetadata;
  readonly objects: readonly ArchiveObjectBinding[];
  readonly resources: readonly ArchiveResourceBinding[];
  readonly native: JsonValue;
}

export type ProjectedArchiveEntry = Omit<ArchiveEntry, "library" | "resources">;

export interface ArchiveManifest {
  readonly schemaVersion: "agenthist.archive/v1";
  readonly createdAt: string;
  readonly pathFlavor: PathFlavor;
  readonly entries: readonly ArchiveEntry[];
  readonly objects: readonly ArchiveObjectDescriptor[];
}
