export { AGENTS, agentLabel, isAgent } from "../domain/agent.js";
export type { Agent } from "../domain/agent.js";
export type {
  ConversationGap,
  ConversationItem,
  ConversationMessage,
  JsonValue,
  LibraryState,
} from "../domain/history.js";
export type {
  ConversionDisposition,
  ConversionFinding,
  ConversionStatus,
} from "../domain/conversion.js";
export type {
  HistoricalContextEvidence,
  HistoricalReferenceEvidence,
  HistoricalToolEvidence,
  HistoricalWorkItemEvidence,
  HistoricalWorkStateEvidence,
  PortableContextBlock,
  PortableContextJson,
} from "../domain/portable-context.js";
export type { ManagedResourceReference } from "../domain/resource.js";
export type {
  TransactionDirection,
  TransactionState,
  TransactionSummary,
} from "../domain/transaction.js";

export { resolveStateDirectory } from "./state-location.js";
export type { StateLocationOptions } from "./state-location.js";

export {
  openImportCatalog,
  inspectImportCatalogWorkspaces,
  previewImportSession,
} from "./import-catalog.js";
export type {
  ImportCatalog,
  ImportCatalogEntry,
  ImportSessionPreview,
} from "./import-catalog.js";
export type {
  ImportWorkspaceAvailability,
  ImportWorkspaceInspection,
} from "./workspace-projection.js";
export {
  detectHistorySources,
  inspectHistorySources,
  scanHistory,
} from "./acquisition.js";
export type {
  ClaudeHistorySourceOptions,
  CodexHistorySourceOptions,
  HistorySourceContext,
  HistorySourceInspection,
  HistorySourceInspectionResult,
  HistorySourceLocation,
  HistorySourceLocationRole,
  HistorySourceOptions,
  HistorySourceStatus,
  OpenCodeHistorySourceOptions,
  ScannedHistoryAgent,
  ScanHistoryOptions,
  ScanHistoryProgress,
  ScanHistoryResult,
} from "./acquisition.js";

export {
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_HISTORY_OFFSET,
  listHistory,
  MAX_HISTORY_LIMIT,
  MAX_HISTORY_OFFSET,
  mutateHistory,
  searchHistory,
  showHistory,
} from "./history.js";
export type {
  HistoryLibraryView,
  HistoryMutationOperation,
  HistoryPage,
  HistorySessionDetail,
  HistorySessionSummary,
  HistoryView,
  ListHistoryOptions,
  ListHistoryResult,
  MutateHistoryOptions,
  MutateHistoryResult,
  SearchHistoryResult,
  SearchHit,
} from "./history.js";

export {
  DEFAULT_INSPECT_LIMIT,
  exportHistory,
  inspectHistoryArchive,
  MAX_INSPECT_LIMIT,
  planExportHistory,
} from "./transfer.js";
export type {
  ArchiveArtifactResult,
  ExportHistoryPlan,
  ExportHistoryPlanItem,
  ExportHistoryOptions,
  ExportHistoryResult,
  ExportSkippedSession,
  InspectArchiveOptions,
  InspectArchiveResult,
  InspectedArchiveWorkspace,
  InspectedHistoryEntry,
} from "./transfer.js";

export { importHistoryArchive } from "./history-import.js";
export type {
  ImportAgentSummary,
  ImportAgentTarget,
  ImportBlockedSession,
  ImportClassification,
  ImportHistoryItem,
  ImportHistoryOptions,
  ImportHistoryResource,
  ImportHistoryResult,
  ImportHistoryStatus,
  ImportHistoryWorkspace,
  ImportRouteQuality,
  ImportRouteSummary,
  ImportWorkspaceStatus,
} from "./history-import.js";

export type {
  ImportConversionPlanItem,
  ImportConversionStatusCounts,
  PreparedImportConversions,
  PrepareImportConversionsOptions,
} from "./conversion.js";

export {
  listNativeTransactions,
  recoverNativeTransaction,
  rollbackNativeTransaction,
} from "./transactions.js";
export type {
  NativeTransactionFinding,
  NativeTransactionPreview,
  TransactionAction,
  TransactionActionResult,
  TransactionActionSummary,
  TransactionFindingPosition,
} from "./transactions.js";

export {
  listCodexHistoryProviders,
  listCodexImportProviders,
  resolveCodexCurrentProvider,
  unifyCodexHistoryProviders,
} from "./provider-history.js";
export type {
  CodexCurrentProviderOptions,
  CodexProviderHistoryChange,
  CodexProviderHistoryCount,
  CodexProviderHistoryList,
  CodexProviderHistoryOptions,
  CodexProviderHistoryUnifyResult,
} from "./provider-history.js";

export {
  checkExperienceModels,
  DEFAULT_EXPERIENCE_MAX_DEEP_INPUT_TOKENS,
  DEFAULT_EXPERIENCE_MAX_INPUT_TOKENS,
  DEFAULT_EXPERIENCE_REQUEST_INPUT_TOKENS,
  dryRunExperienceReview,
  experienceReviewResultJson,
  OperationError,
  prepareExperienceReview,
} from "../experience/index.js";
export type {
  DiscoveryCard,
  ExperienceAgentCorpus,
  AnalysisProcessRunner,
  ExperienceBeat,
  ExperienceCorpusProfile,
  ExperienceDryRunOptions,
  ExperienceDryRunResult,
  ExperienceHistorySelection,
  ExperienceIndexSummary,
  ExperienceModelCheckOptions,
  ExperienceModelCheckResult,
  ExperienceModelProfileCheck,
  ExperienceReviewPack,
  ExperienceReviewPublication,
  ExperienceWorkspaceSelection,
  PrepareExperienceReviewOptions,
  PrepareExperienceReviewProgress,
  PrepareExperienceReviewResult,
} from "../experience/index.js";
