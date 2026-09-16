export type Agent = "codex" | "claude" | "opencode" | "pi";
export type LibraryState = "active" | "archived" | "deleted";

export interface ConversionFinding {
  readonly code: string;
  readonly disposition: "exact" | "degraded" | "skipped" | "synthesized" | "blocked";
  readonly count: number;
}

export const DESKTOP_IPC = {
  listCodexProviders: "agenthist:provider:list",
  previewCodexProviderUnify: "agenthist:provider:preview",
  confirmCodexProviderUnify: "agenthist:provider:confirm",
  bootstrap: "agenthist:bootstrap",
  listChats: "agenthist:chats:list",
  getConversation: "agenthist:conversation:get",
  findInConversation: "agenthist:conversation:find",
  getTechnicalDetail: "agenthist:conversation:technical-detail",
  refresh: "agenthist:history:refresh",
  updateChat: "agenthist:chat:update",
  planResume: "agenthist:resume:plan",
  confirmResume: "agenthist:resume:confirm",
  openWorkspace: "agenthist:workspace:open",
  exportHistory: "agenthist:transfer:export",
  openImport: "agenthist:transfer:import-open",
  replanImport: "agenthist:transfer:import-replan",
  applyImport: "agenthist:transfer:import-apply",
  cancelImport: "agenthist:transfer:import-cancel",
  mapImportWorkspace: "agenthist:transfer:import-map-workspace",
  previewExperience: "agenthist:experience:preview",
  runExperience: "agenthist:experience:run",
  loadExperienceReview: "agenthist:experience:load",
  getExperienceCandidate: "agenthist:experience:candidate",
  openExperienceOutput: "agenthist:experience:open-output",
  closeExperienceReview: "agenthist:experience:close",
  inspectExperienceConfig: "agenthist:experience:config-inspect",
  checkExperienceConfig: "agenthist:experience:config-check",
  openExperienceConfig: "agenthist:experience:config-open",
  getAgentSettings: "agenthist:agents:settings-get",
  chooseAgentPath: "agenthist:agents:path-choose",
  clearAgentPath: "agenthist:agents:path-clear",
  getTerminalSettings: "agenthist:terminal-settings:get",
  selectTerminal: "agenthist:terminal-settings:select",
  updateTerminalArguments: "agenthist:terminal-settings:update-arguments",
  listTransactions: "agenthist:transactions:list",
  planTransaction: "agenthist:transactions:plan",
  confirmTransaction: "agenthist:transactions:confirm",
  rebuildHistoryIndex: "agenthist:data:rebuild-index",
  getSettings: "agenthist:settings:get",
  updateSettings: "agenthist:settings:update",
  scanProgress: "agenthist:event:scan-progress",
  experienceProgress: "agenthist:event:experience-progress",
} as const;

export type DesktopTheme = "system" | "light" | "dark";

export interface CodexProvidersDto {
  readonly currentProvider: string;
  readonly totalSessions: number;
  readonly providers: readonly { readonly provider: string; readonly sessions: number; readonly current: boolean }[];
}
export interface CodexProviderUnifyRequest { readonly targetProvider: string }
export interface ConfirmCodexProviderUnifyRequest extends CodexProviderUnifyRequest { readonly expectedPlanRef: string }
export interface CodexProviderPlanDto {
  readonly planRef: string;
  readonly targetProvider: string;
  readonly changed: number;
  readonly unchanged: number;
  readonly sources: readonly { readonly provider: string; readonly sessions: number }[];
}
export type CodexProviderConfirmDto =
  | { readonly status: "replan_required"; readonly plan: CodexProviderPlanDto }
  | { readonly status: "completed"; readonly plan: CodexProviderPlanDto; readonly transactionRef?: string };
export type DesktopAgentFilter = "all" | Agent;

export interface DesktopSettings {
  readonly experienceAgent?: Agent;
  readonly theme: DesktopTheme;
  readonly agentFilter: DesktopAgentFilter;
  readonly autoRefresh: boolean;
  readonly showTechnicalDetails: boolean;
  readonly firstRunComplete: boolean;
  readonly lastSessionRef?: string;
}

export interface DesktopError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export type DesktopResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DesktopError };

export interface AgentLocationDto {
  readonly role: string;
  readonly path: string;
}

export interface AgentStatusDto {
  readonly agent: Agent;
  readonly label: string;
  readonly status: "ready" | "not_detected" | "blocked" | "error";
  readonly locations: readonly AgentLocationDto[];
  readonly findings: readonly string[];
  readonly detail?: string;
}

export type AgentPathKind = "history" | "database" | "executable";

export interface AgentConfiguredPathDto {
  readonly configured: boolean;
  readonly path?: string;
  readonly available: boolean;
  readonly expected: "directory" | "file";
}

export interface AgentExecutableDto {
  readonly configured: boolean;
  readonly configuredPath?: string;
  readonly resolvedPath?: string;
  readonly available: boolean;
}

export interface AgentSettingDto {
  readonly agent: Agent;
  readonly label: string;
  readonly history: AgentConfiguredPathDto;
  readonly database?: AgentConfiguredPathDto;
  readonly executable: AgentExecutableDto;
}

export interface ChooseAgentPathRequest {
  readonly agent: Agent;
  readonly kind: AgentPathKind;
}

export type ChooseAgentPathResultDto =
  | { readonly status: "cancelled" }
  | { readonly status: "updated"; readonly settings: readonly AgentSettingDto[] };

export interface ClearAgentPathRequest {
  readonly agent: Agent;
  readonly kind?: AgentPathKind;
}

export interface ClearAgentPathResultDto {
  readonly settings: readonly AgentSettingDto[];
}

export interface TerminalCandidateDto {
  readonly id: string;
  readonly label: string;
  readonly executablePath: string;
  readonly arguments: readonly string[];
}

export interface TerminalSettingsDto {
  readonly mode: "auto" | "configured";
  readonly effectiveLabel: string;
  readonly effectiveExecutablePath?: string;
  readonly arguments: readonly string[];
  readonly candidates: readonly TerminalCandidateDto[];
  readonly requiresSetup: boolean;
}

export interface SelectTerminalRequest {
  readonly candidateId: string;
}

export interface UpdateTerminalArgumentsRequest {
  readonly arguments: readonly string[];
}

export type TransactionStateDto =
  | "planned" | "running" | "committed" | "rolled_back" | "failed" | "needs_recovery";
export type TransactionActionDto = "rollback" | "recover";
export type TransactionFindingPositionDto = "before" | "after" | "unchanged" | "diverged";

export interface TransactionSummaryDto {
  readonly transactionRef: string;
  readonly operation: string;
  readonly agents: readonly Agent[];
  readonly state: TransactionStateDto;
  readonly phase: string;
  readonly direction: "forward" | "rollback";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: number;
  readonly failure?: string;
}

export interface TransactionFindingDto {
  readonly sessionRef: string;
  readonly row: TransactionFindingPositionDto;
  readonly section?: TransactionFindingPositionDto;
  readonly file?: TransactionFindingPositionDto;
  readonly resources?: TransactionFindingPositionDto;
  readonly goal?: TransactionFindingPositionDto;
}

export interface TransactionPlanDto {
  readonly planRef: string;
  readonly summary: TransactionSummaryDto;
  readonly action: TransactionActionDto;
  readonly ready: boolean;
  readonly findings: readonly TransactionFindingDto[];
}

export interface PlanTransactionRequest {
  readonly transactionRef: string;
  readonly action: TransactionActionDto;
}

export interface ConfirmTransactionRequest extends PlanTransactionRequest {
  readonly expectedPlanRef: string;
}

export type ConfirmTransactionResultDto =
  | { readonly status: "replan_required" | "blocked"; readonly plan: TransactionPlanDto }
  | { readonly status: "completed"; readonly plan: TransactionPlanDto; readonly summary: TransactionSummaryDto };

export interface RebuildHistoryIndexResultDto {
  readonly rebuilt: boolean;
  readonly removed: boolean;
  readonly sessions: number;
  readonly issues: number;
}

export interface ChatSummaryDto {
  readonly sessionRef: string;
  readonly memberSessionRefs: readonly string[];
  readonly agent: Agent;
  readonly title: string;
  readonly workspace: string;
  readonly workspaceName: string;
  readonly updatedAt: string;
  readonly preview?: string;
  readonly libraryState: LibraryState;
  readonly tags: readonly string[];
}

export interface ChatPageDto {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly returned: number;
  readonly remaining: number;
  readonly nextOffset?: number;
  readonly chats: readonly ChatSummaryDto[];
}

export interface ListChatsRequest {
  readonly query?: string;
  readonly agents?: readonly Agent[];
  readonly workspace?: string;
  readonly workspaceDescendants?: boolean;
  readonly libraryState?: "active" | "deleted";
  readonly offset?: number;
  readonly limit?: number;
}

export interface TechnicalDetailDto {
  readonly id: string;
  readonly detailIndex: number;
  readonly label: string;
  readonly summary: string;
  readonly detail: string;
  readonly totalCharacters: number;
  readonly truncated: boolean;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface TechnicalDetailRequest {
  readonly sessionRef: string;
  readonly itemIndex: number;
  readonly detailIndex: number;
  readonly offset?: number;
  readonly limit?: number;
}

export type TechnicalDetailChunkDto =
  | {
      readonly status: "available";
      readonly id: string;
      readonly detailIndex: number;
      readonly label: string;
      readonly offset: number;
      readonly limit: number;
      readonly totalCharacters: number;
      readonly returnedCharacters: number;
      readonly text: string;
      readonly nextOffset?: number;
    }
  | {
      readonly status: "unavailable";
      readonly id: string;
      readonly detailIndex: number;
      readonly label: string;
      readonly reason: string;
    };

export type ConversationItemDto =
  | {
      readonly id: string;
      readonly index: number;
      readonly kind: "message";
      readonly role: "user" | "assistant" | "system" | "developer";
      readonly text: string;
      readonly timestamp: string;
      readonly model?: string;
      readonly technical: readonly TechnicalDetailDto[];
    }
  | {
      readonly id: string;
      readonly index: number;
      readonly kind: "gap";
      readonly label: string;
      readonly timestamp: string;
      readonly code?: string;
    };

export interface ConversationRequest {
  readonly sessionRef: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface ConversationPageDto {
  readonly chat: ChatSummaryDto;
  readonly model: string;
  readonly provider: string;
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly returned: number;
  readonly remaining: number;
  readonly nextOffset?: number;
  readonly items: readonly ConversationItemDto[];
}

export interface ConversationFindRequest {
  readonly sessionRef: string;
  readonly query: string;
}

export interface ConversationMatchDto {
  readonly index: number;
  readonly snippet: string;
}

export interface ConversationFindResult {
  readonly query: string;
  readonly matches: readonly ConversationMatchDto[];
}

export interface RefreshAgentResultDto {
  readonly agent: Agent;
  readonly status: "scanned" | "not_detected" | "failed";
  readonly sessions: number;
  readonly reusedSessions: number;
  readonly rebuiltSessions: number;
  readonly removedSessions: number;
  readonly warnings: readonly string[];
  readonly error?: DesktopError;
}

export interface RefreshResultDto {
  readonly agents: readonly RefreshAgentResultDto[];
  readonly sessions: number;
  readonly partial: boolean;
}

export type ScanProgressDto =
  | { readonly phase: "detecting" }
  | { readonly phase: "scanning"; readonly agent: Agent; readonly currentAgent: number; readonly totalAgents: number }
  | { readonly phase: "complete"; readonly result: RefreshResultDto }
  | { readonly phase: "error"; readonly error: DesktopError };

export interface ChatMutationRequest {
  readonly sessionRef: string;
  readonly operation: "archive" | "unarchive" | "delete" | "undelete";
}

export interface ChatMutationResultDto {
  readonly sessionRef: string;
  readonly changed: boolean;
  readonly state: LibraryState;
}

export interface ResumePlanDto {
  readonly planRef: string;
  readonly source: ChatSummaryDto;
  readonly targetAgent: Agent;
  readonly targetAvailable: boolean;
  readonly route: "native" | "existing" | "conversion";
  readonly quality: "native" | "exact" | "degraded" | "blocked";
  readonly findings: readonly ConversionFinding[];
  readonly sourceWorkspace: string;
  readonly targetWorkspace: string;
  readonly workspaceStatus: "unchanged" | "mapped";
  readonly needsWrite: boolean;
}

export interface ResumePlanRequest {
  readonly sessionRef: string;
  readonly targetAgent: Agent;
  readonly allowLossyConversion?: boolean;
  readonly pathMappings?: readonly string[];
}

export interface ResumeConfirmRequest extends ResumePlanRequest {
  readonly expectedPlanRef: string;
}

export type ResumeConfirmResultDto =
  | { readonly status: "replan_required" | "blocked"; readonly plan: ResumePlanDto }
  | {
      readonly status: "launched";
      readonly plan: ResumePlanDto;
      readonly targetAgent: Agent;
      readonly targetSessionRef: string;
      readonly workspace: string;
      readonly pid: number;
      readonly transactionRefs: readonly string[];
    };

export interface OpenWorkspaceRequest {
  readonly sessionRef: string;
}

export interface OpenWorkspaceResultDto {
  readonly workspace: string;
  readonly opened: true;
}

export type ExportHistoryRequest =
  | { readonly scope: "all" }
  | { readonly scope: "sessions"; readonly sessionRefs: readonly string[] };

export type ExportHistoryResultDto =
  | { readonly status: "cancelled" }
  | {
      readonly status: "completed";
      readonly file: string;
      readonly sizeBytes: number;
      readonly sha256: string;
      readonly entries: number;
      readonly objects: number;
      readonly resources: number;
      readonly agents: readonly { readonly agent: Agent; readonly sessions: number }[];
      readonly skipped: readonly {
        readonly agent: Agent;
        readonly sessionRef: string;
        readonly title: string;
        readonly reason: string;
      }[];
    };

export interface ImportRouteDto {
  readonly sourceAgent: Agent;
  readonly targetAgent: Agent;
  readonly quality: "native" | "exact" | "degraded" | "blocked";
  readonly sessions: number;
  readonly findings: readonly ConversionFinding[];
}

export interface ImportWorkspaceDto {
  readonly source: string;
  readonly target: string;
  readonly status: "unchanged" | "mapped" | "missing" | "unmapped";
  readonly agents: readonly Agent[];
  readonly sessions: number;
}

export interface ImportSessionDto {
  readonly sessionRef: string;
  readonly memberSessionRefs: readonly string[];
  readonly sourceAgent: Agent;
  readonly title: string;
  readonly workspace: string;
  readonly updatedAt: string;
  readonly selected: boolean;
}

export interface ImportPlanDto {
  readonly handle: string;
  readonly planRef: string;
  readonly fileName: string;
  readonly status: "ready" | "blocked";
  readonly selectedSessions: number;
  readonly newSessions: number;
  readonly alreadyPresent: number;
  readonly blocked: number;
  readonly conflicts: number;
  readonly routes: readonly ImportRouteDto[];
  readonly workspaces: readonly ImportWorkspaceDto[];
  readonly sessions: readonly ImportSessionDto[];
  readonly transactionRequired: boolean;
}

export type OpenImportResultDto =
  | { readonly status: "cancelled" }
  | { readonly status: "planned"; readonly plan: ImportPlanDto };

export interface ReplanImportRequest {
  readonly handle: string;
  readonly targetAgent?: Agent;
  readonly sessionRefs?: readonly string[];
  readonly allowLossyConversion?: boolean;
  readonly pathMappings?: readonly string[];
}

export interface ApplyImportRequest {
  readonly handle: string;
  readonly expectedPlanRef: string;
}

export type ApplyImportResultDto =
  | { readonly status: "replan_required" | "blocked"; readonly plan: ImportPlanDto }
  | {
      readonly status: "completed";
      readonly fileName: string;
      readonly written: number;
      readonly alreadyPresent: number;
      readonly transactionRefs: readonly string[];
    };

export interface CancelImportRequest {
  readonly handle: string;
}

export interface CancelImportResultDto {
  readonly closed: true;
}

export interface MapImportWorkspaceRequest {
  readonly handle: string;
  readonly source: string;
}

export type MapImportWorkspaceResultDto =
  | { readonly status: "cancelled" }
  | { readonly status: "planned"; readonly plan: ImportPlanDto };

export type ExperienceScopeRequest =
  | { readonly scope: "all" }
  | { readonly scope: "sessions"; readonly sessionRefs: readonly string[] };

export interface ExperiencePreviewDto {
  readonly originalInputTokens?: number;
  readonly inputCompacted?: boolean;
  readonly inputBudgetSource?: "agent" | "default" | "explicit";
  readonly modelContextWindow?: number;
  readonly singleRequest?: true;
  readonly inputLimitExceeded?: boolean;
  readonly inputTokenLimit?: number;
  readonly previewRef: string;
  readonly scope: "all" | "sessions";
  readonly sessions: number;
  readonly lineages: number;
  readonly projects: number;
  readonly cards: number;
  readonly queuedCards: number;
  readonly reusedSessions: number;
  readonly rebuiltSessions: number;
  readonly estimatedInputTokens: number;
  readonly evidenceRequests: number;
  readonly candidateRequestsUpperBound: number;
}

export interface ExperienceCandidateSummaryDto {
  readonly candidateRef: string;
  readonly category: "requirement" | "preference" | "working_method";
  readonly topic: string;
  readonly lens: string;
  readonly draft: string;
  readonly evidence: number;
  readonly sessions: number;
  readonly projects: number;
}

export interface ExperienceReviewDto {
  readonly handle: string;
  readonly reviewRef: string;
  readonly createdAt: string;
  readonly directoryName: string;
  readonly sessions: number;
  readonly lineages: number;
  readonly projects: number;
  readonly candidates: readonly ExperienceCandidateSummaryDto[];
  readonly unroutedEvidence: number;
}

export interface ExperienceEvidenceDto {
  readonly occurrenceRef: string;
  readonly sessionRef: string;
  readonly agent: Agent;
  readonly workspace: string;
  readonly timestamp: string;
  readonly observation: string;
  readonly userText: string;
  readonly assistant: readonly string[];
}

export interface ExperienceCandidateDetailDto extends ExperienceCandidateSummaryDto {
  readonly relation: string;
  readonly evidenceItems: readonly ExperienceEvidenceDto[];
}

export interface RunExperienceRequest {
  readonly scope: ExperienceScopeRequest;
  readonly expectedPreviewRef: string;
}

export type RunExperienceResultDto =
  | { readonly status: "cancelled" }
  | { readonly status: "replan_required"; readonly preview: ExperiencePreviewDto }
  | { readonly status: "partial"; readonly remainingCards: number }
  | { readonly status: "completed"; readonly review: ExperienceReviewDto };

export type LoadExperienceReviewResultDto =
  | { readonly status: "cancelled" }
  | { readonly status: "loaded"; readonly review: ExperienceReviewDto };

export interface GetExperienceCandidateRequest {
  readonly handle: string;
  readonly candidateRef: string;
}

export interface OpenExperienceOutputRequest {
  readonly handle: string;
}

export interface OpenExperienceOutputResultDto {
  readonly opened: true;
}

export interface CloseExperienceReviewRequest {
  readonly handle: string;
}

export interface CloseExperienceReviewResultDto {
  readonly closed: true;
}

export type ExperienceProgressDto =
  | { readonly phase: "indexing" | "configuring" | "publishing" | "finalizing" }
  | { readonly phase: "extracting"; readonly currentBatch: number; readonly totalBatches: number }
  | {
      readonly phase: "organizing";
      readonly currentRequest?: number;
      readonly totalRequests?: number;
    };

export type ExperienceBackendDto =
  | "openai-compatible-chat" | "openai-responses" | "anthropic-messages" | "codex-cli" | "claude-cli" | "opencode-cli" | "pi-cli";

export interface ExperienceModelProfileDto {
  readonly contextWindow?: number;
  readonly tier: "fast" | "deep";
  readonly backend: ExperienceBackendDto;
  readonly model: string;
  readonly modelConfigured: boolean;
  readonly endpoint: { readonly kind: "remote" | "local"; readonly label: string };
}

export interface ExperienceConfigurationErrorDto {
  readonly code: string;
  readonly retryable: boolean;
  readonly stage: string;
  readonly status?: number;
}

export type ExperienceConfigurationDto =
  | {
      readonly status: "configured";
      readonly configFile: string;
      readonly backend: ExperienceBackendDto;
      readonly deepBinding: "configured" | "fast";
      readonly fast: ExperienceModelProfileDto;
      readonly deep: ExperienceModelProfileDto;
    }
  | {
      readonly status: "not_configured" | "invalid";
      readonly configFile: string;
      readonly error: ExperienceConfigurationErrorDto;
    };

export interface ExperienceCheckedProfileDto extends ExperienceModelProfileDto {
  readonly binding: "configured" | "fast";
  readonly requestMade: boolean;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}

export type ExperienceConfigurationCheckDto =
  | {
      readonly durationMs?: number;
      readonly status: "checked";
      readonly configFile: string;
      readonly historySent: false;
      readonly requests: number;
      readonly profiles: readonly ExperienceCheckedProfileDto[];
    }
  | {
      readonly status: "not_configured" | "invalid" | "failed";
      readonly durationMs?: number;
      readonly configFile: string;
      readonly historySent: false;
      readonly requests: 0;
      readonly error: ExperienceConfigurationErrorDto;
    };

export interface OpenExperienceConfigResultDto {
  readonly opened: true;
}

export interface BootstrapDto {
  readonly version: string;
  readonly stateDirectory: string;
  readonly settings: DesktopSettings;
  readonly agents: readonly AgentStatusDto[];
  readonly agentSettings: readonly AgentSettingDto[];
  readonly chats: ChatPageDto;
}

export interface AgentHistDesktopApi {
  listCodexProviders(): Promise<DesktopResult<CodexProvidersDto>>;
  previewCodexProviderUnify(request: CodexProviderUnifyRequest): Promise<DesktopResult<CodexProviderPlanDto>>;
  confirmCodexProviderUnify(request: ConfirmCodexProviderUnifyRequest): Promise<DesktopResult<CodexProviderConfirmDto>>;
  bootstrap(): Promise<DesktopResult<BootstrapDto>>;
  listChats(request: ListChatsRequest): Promise<DesktopResult<ChatPageDto>>;
  getConversation(request: ConversationRequest): Promise<DesktopResult<ConversationPageDto>>;
  findInConversation(request: ConversationFindRequest): Promise<DesktopResult<ConversationFindResult>>;
  getTechnicalDetail(request: TechnicalDetailRequest): Promise<DesktopResult<TechnicalDetailChunkDto>>;
  refresh(): Promise<DesktopResult<RefreshResultDto>>;
  updateChat(request: ChatMutationRequest): Promise<DesktopResult<ChatMutationResultDto>>;
  planResume(request: ResumePlanRequest): Promise<DesktopResult<ResumePlanDto>>;
  confirmResume(request: ResumeConfirmRequest): Promise<DesktopResult<ResumeConfirmResultDto>>;
  openWorkspace(request: OpenWorkspaceRequest): Promise<DesktopResult<OpenWorkspaceResultDto>>;
  exportHistory(request: ExportHistoryRequest): Promise<DesktopResult<ExportHistoryResultDto>>;
  openImport(): Promise<DesktopResult<OpenImportResultDto>>;
  replanImport(request: ReplanImportRequest): Promise<DesktopResult<ImportPlanDto>>;
  applyImport(request: ApplyImportRequest): Promise<DesktopResult<ApplyImportResultDto>>;
  cancelImport(request: CancelImportRequest): Promise<DesktopResult<CancelImportResultDto>>;
  mapImportWorkspace(
    request: MapImportWorkspaceRequest,
  ): Promise<DesktopResult<MapImportWorkspaceResultDto>>;
  previewExperience(request: ExperienceScopeRequest): Promise<DesktopResult<ExperiencePreviewDto>>;
  runExperience(request: RunExperienceRequest): Promise<DesktopResult<RunExperienceResultDto>>;
  loadExperienceReview(): Promise<DesktopResult<LoadExperienceReviewResultDto>>;
  getExperienceCandidate(
    request: GetExperienceCandidateRequest,
  ): Promise<DesktopResult<ExperienceCandidateDetailDto>>;
  openExperienceOutput(
    request: OpenExperienceOutputRequest,
  ): Promise<DesktopResult<OpenExperienceOutputResultDto>>;
  closeExperienceReview(
    request: CloseExperienceReviewRequest,
  ): Promise<DesktopResult<CloseExperienceReviewResultDto>>;
  inspectExperienceConfig(): Promise<DesktopResult<ExperienceConfigurationDto>>;
  checkExperienceConfig(): Promise<DesktopResult<ExperienceConfigurationCheckDto>>;
  openExperienceConfig(): Promise<DesktopResult<OpenExperienceConfigResultDto>>;
  getAgentSettings(): Promise<DesktopResult<readonly AgentSettingDto[]>>;
  chooseAgentPath(request: ChooseAgentPathRequest): Promise<DesktopResult<ChooseAgentPathResultDto>>;
  clearAgentPath(request: ClearAgentPathRequest): Promise<DesktopResult<ClearAgentPathResultDto>>;
  getTerminalSettings(): Promise<DesktopResult<TerminalSettingsDto>>;
  selectTerminal(request: SelectTerminalRequest): Promise<DesktopResult<TerminalSettingsDto>>;
  updateTerminalArguments(
    request: UpdateTerminalArgumentsRequest,
  ): Promise<DesktopResult<TerminalSettingsDto>>;
  listTransactions(): Promise<DesktopResult<readonly TransactionSummaryDto[]>>;
  planTransaction(request: PlanTransactionRequest): Promise<DesktopResult<TransactionPlanDto>>;
  confirmTransaction(request: ConfirmTransactionRequest): Promise<DesktopResult<ConfirmTransactionResultDto>>;
  rebuildHistoryIndex(): Promise<DesktopResult<RebuildHistoryIndexResultDto>>;
  getSettings(): Promise<DesktopResult<DesktopSettings>>;
  updateSettings(settings: DesktopSettings): Promise<DesktopResult<DesktopSettings>>;
  onScanProgress(listener: (progress: ScanProgressDto) => void): () => void;
  onExperienceProgress(listener: (progress: ExperienceProgressDto) => void): () => void;
}
