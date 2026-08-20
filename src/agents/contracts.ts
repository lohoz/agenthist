import type { Agent } from "../domain/agent.js";
import type {
  ArchiveEntry,
  ArchiveManifest,
  ArchiveObjectBinding,
} from "../domain/archive.js";
import type { ConversionFinding } from "../domain/conversion.js";
import type { AgentSnapshot, StoredSession } from "../domain/history.js";
import type { PreparedPortableSource } from "../domain/conversion.js";
import type { ImportEntry } from "../domain/import.js";
import type { PathMappings } from "../domain/path-mapping.js";
import type { PathFlavor } from "../domain/host-path.js";
import type {
  TransactionDirection,
  TransactionJournal,
  TransactionState,
} from "../domain/transaction.js";
import type { PortableContextSession } from "../domain/portable-context.js";
import type {
  ArchiveObjectSource,
  PreparedArchiveEntries,
} from "../infrastructure/archive.js";
import type { ManagedResourceItem } from "../infrastructure/managed-resources.js";

export type HistorySourceStatus = "ready" | "not_detected" | "blocked" | "error";
export type HistorySourceLocationRole =
  "history_root" | "native_state_root" | "data_root" | "database" | "config_root";

export interface HistorySourceLocation {
  readonly role: HistorySourceLocationRole;
  readonly path: string;
}

export interface HistorySourceInspection {
  readonly agent: Agent;
  readonly status: HistorySourceStatus;
  readonly locations: readonly HistorySourceLocation[];
  readonly findings: readonly string[];
  readonly detail?: string;
}

export interface AgentSourceOptions {
  readonly historyRoot?: string;
  readonly nativeStateRoot?: string;
  readonly databasePath?: string;
  readonly profile?: string;
  readonly cwd?: string;
  readonly home?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ScanAgentSourceOptions extends AgentSourceOptions {
  readonly stateDirectory: string;
}

export interface AgentSourceCapability {
  detect(options: AgentSourceOptions): Promise<HistorySourceInspection>;
  inspect(options: AgentSourceOptions): Promise<HistorySourceInspection>;
  roots(options: AgentSourceOptions): Promise<readonly string[]>;
  scan(options: ScanAgentSourceOptions): Promise<AgentSnapshot>;
}

export interface PreparedAgentArchive {
  readonly sessions: readonly StoredSession[];
  readonly sources: readonly ArchiveObjectSource[];
  readonly bindings: ReadonlyMap<string, readonly ArchiveObjectBinding[]>;
}

export interface PrepareAgentArchiveOptions {
  readonly stateDirectory: string;
  readonly snapshot: AgentSnapshot;
  readonly sessions: readonly StoredSession[];
  readonly workspace: string;
  readonly allocateObjectId: () => string;
}

export interface AgentArchiveCapability {
  closeExportSelection(
    snapshot: AgentSnapshot,
    selected: readonly StoredSession[],
  ): readonly StoredSession[];
  prepare(options: PrepareAgentArchiveOptions): Promise<PreparedAgentArchive>;
  validateEntries(
    entries: readonly ArchiveEntry[],
    objects: ReadonlyMap<string, ArchiveManifest["objects"][number]>,
    extracted?: ReadonlyMap<string, string>,
  ): void;
  validateObjects(
    entries: readonly ArchiveEntry[],
    extracted: ReadonlyMap<string, string>,
    pathFlavor: PathFlavor,
  ): Promise<void>;
  closeSelection(entries: readonly ArchiveEntry[], selected: ReadonlySet<string>): ReadonlySet<string>;
}

export type NativeImportClassification = "new" | "already_present" | "conflict";

export interface NativeImportItem {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly classification: NativeImportClassification;
  readonly destination: string;
  readonly provider: string;
  readonly cwd: string;
  readonly reason?: string;
}

export interface NativeImportTarget {
  readonly root: string;
  readonly databaseRoot?: string;
  readonly database?: string;
}

export interface NativeImportResult {
  readonly target: NativeImportTarget;
  readonly items: readonly NativeImportItem[];
  readonly newSessions: number;
  readonly alreadyPresent: number;
  readonly resources: readonly ManagedResourceItem[];
  readonly transactionRef?: string;
}

export interface PrepareNativeImportOptions {
  readonly stateDirectory: string;
  readonly entries: readonly ImportEntry[];
  readonly objects: ReadonlyMap<string, string>;
  readonly providerPolicy: string;
  readonly pathMappings: PathMappings;
  readonly workspace: string;
  readonly source: AgentSourceOptions;
}

export interface PreparedNativeImport {
  readonly result: NativeImportResult;
  apply(): Promise<NativeImportResult>;
}

export interface AgentNativeImportCapability {
  prepare(options: PrepareNativeImportOptions): Promise<PreparedNativeImport>;
}

export type AgentTransactionFindingPosition = "before" | "after" | "unchanged" | "diverged";

export interface AgentTransactionFinding {
  readonly sessionRef: string;
  readonly row: AgentTransactionFindingPosition;
  readonly section?: AgentTransactionFindingPosition;
  readonly file?: AgentTransactionFindingPosition;
  readonly resources?: AgentTransactionFindingPosition;
  readonly goal?: AgentTransactionFindingPosition;
}

export interface AgentTransactionPreview {
  readonly transactionRef: string;
  readonly operation: string;
  readonly state: TransactionState;
  readonly direction: TransactionDirection;
  readonly ready: boolean;
  readonly items: number;
  readonly findings: readonly AgentTransactionFinding[];
}

export interface AgentTransactionCapability {
  owns(journal: TransactionJournal): boolean;
  previewRollback(stateDirectory: string, journal: TransactionJournal): Promise<AgentTransactionPreview>;
  rollback(stateDirectory: string, journal: TransactionJournal): Promise<TransactionJournal>;
  previewRecovery(stateDirectory: string, journal: TransactionJournal): Promise<AgentTransactionPreview>;
  recover(stateDirectory: string, journal: TransactionJournal): Promise<TransactionJournal>;
}

export interface AgentPortableProjection {
  readonly targetAgent: Agent;
  readonly nativeId: string;
  readonly sessionRef: string;
  readonly findings: readonly ConversionFinding[];
}

export interface AgentPortableProjectionInput {
  readonly projection: AgentPortableProjection;
  readonly sourceUpdatedAt: string;
}

export interface AgentPortableSourceMaterializer {
  readonly sessions: readonly StoredSession[];
  prepare(sessionRef: string): Promise<PreparedPortableSource>;
}

export interface CreateAgentPortableSourceOptions {
  readonly stateDirectory: string;
  readonly snapshot: AgentSnapshot;
  readonly entries: readonly ArchiveEntry[];
}

export interface AgentPortableSourceCapability {
  create(options: CreateAgentPortableSourceOptions): Promise<AgentPortableSourceMaterializer>;
}

export interface WriteAgentPortableProjectionsOptions {
  readonly projections: readonly AgentPortableProjectionInput[];
  readonly workspace: string;
  readonly allocateObjectId: () => string;
}

export interface AgentPortableTargetCapability {
  readonly writeMode: "independent" | "shared";
  project(session: PortableContextSession, conversionKey: string): AgentPortableProjection;
  write(options: WriteAgentPortableProjectionsOptions): Promise<PreparedArchiveEntries>;
}

export interface AgentAdapter<A extends Agent = Agent> {
  readonly id: A;
  readonly source: AgentSourceCapability;
  readonly archive: AgentArchiveCapability;
  readonly nativeImport: AgentNativeImportCapability;
  readonly transaction: AgentTransactionCapability;
  readonly portableSource: AgentPortableSourceCapability;
  readonly portableTarget: AgentPortableTargetCapability;
}
