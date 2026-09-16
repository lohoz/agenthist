import { contextBridge, ipcRenderer } from "electron";
import type { CodexProvidersDto, CodexProviderUnifyRequest, CodexProviderPlanDto, ConfirmCodexProviderUnifyRequest, CodexProviderConfirmDto } from "./contracts.js";

import {
  DESKTOP_IPC,
  type AgentHistDesktopApi,
  type AgentSettingDto,
  type ApplyImportRequest,
  type ApplyImportResultDto,
  type BootstrapDto,
  type ChatMutationRequest,
  type ChatMutationResultDto,
  type ChatPageDto,
  type CancelImportRequest,
  type CancelImportResultDto,
  type ChooseAgentPathRequest,
  type ChooseAgentPathResultDto,
  type ClearAgentPathRequest,
  type ClearAgentPathResultDto,
  type CloseExperienceReviewRequest,
  type CloseExperienceReviewResultDto,
  type ConfirmTransactionRequest,
  type ConfirmTransactionResultDto,
  type ConversationFindRequest,
  type ConversationFindResult,
  type ConversationPageDto,
  type ConversationRequest,
  type DesktopResult,
  type DesktopSettings,
  type ExportHistoryRequest,
  type ExportHistoryResultDto,
  type ExperienceCandidateDetailDto,
  type ExperienceConfigurationCheckDto,
  type ExperienceConfigurationDto,
  type ExperiencePreviewDto,
  type ExperienceProgressDto,
  type ExperienceScopeRequest,
  type GetExperienceCandidateRequest,
  type ImportPlanDto,
  type LoadExperienceReviewResultDto,
  type MapImportWorkspaceRequest,
  type MapImportWorkspaceResultDto,
  type ListChatsRequest,
  type OpenWorkspaceRequest,
  type OpenWorkspaceResultDto,
  type OpenExperienceOutputRequest,
  type OpenExperienceOutputResultDto,
  type OpenExperienceConfigResultDto,
  type OpenImportResultDto,
  type RefreshResultDto,
  type RebuildHistoryIndexResultDto,
  type PlanTransactionRequest,
  type ReplanImportRequest,
  type ResumeConfirmRequest,
  type ResumeConfirmResultDto,
  type ResumePlanDto,
  type ResumePlanRequest,
  type RunExperienceRequest,
  type RunExperienceResultDto,
  type ScanProgressDto,
  type TransactionPlanDto,
  type TransactionSummaryDto,
  type TechnicalDetailChunkDto,
  type TechnicalDetailRequest,
  type SelectTerminalRequest,
  type TerminalSettingsDto,
  type UpdateTerminalArgumentsRequest,
} from "./contracts.js";

function invoke<T>(channel: string, request?: unknown): Promise<DesktopResult<T>> {
  return ipcRenderer.invoke(channel, request) as Promise<DesktopResult<T>>;
}

const api: AgentHistDesktopApi = Object.freeze({
  listCodexProviders: () => invoke<CodexProvidersDto>(DESKTOP_IPC.listCodexProviders),
  previewCodexProviderUnify: (request: CodexProviderUnifyRequest) => invoke<CodexProviderPlanDto>(DESKTOP_IPC.previewCodexProviderUnify, request),
  confirmCodexProviderUnify: (request: ConfirmCodexProviderUnifyRequest) => invoke<CodexProviderConfirmDto>(DESKTOP_IPC.confirmCodexProviderUnify, request),
  bootstrap: () => invoke<BootstrapDto>(DESKTOP_IPC.bootstrap),
  listChats: (request: ListChatsRequest) => invoke<ChatPageDto>(DESKTOP_IPC.listChats, request),
  getConversation: (request: ConversationRequest) =>
    invoke<ConversationPageDto>(DESKTOP_IPC.getConversation, request),
  findInConversation: (request: ConversationFindRequest) =>
    invoke<ConversationFindResult>(DESKTOP_IPC.findInConversation, request),
  getTechnicalDetail: (request: TechnicalDetailRequest) =>
    invoke<TechnicalDetailChunkDto>(DESKTOP_IPC.getTechnicalDetail, request),
  refresh: () => invoke<RefreshResultDto>(DESKTOP_IPC.refresh),
  updateChat: (request: ChatMutationRequest) =>
    invoke<ChatMutationResultDto>(DESKTOP_IPC.updateChat, request),
  planResume: (request: ResumePlanRequest) => invoke<ResumePlanDto>(DESKTOP_IPC.planResume, request),
  confirmResume: (request: ResumeConfirmRequest) =>
    invoke<ResumeConfirmResultDto>(DESKTOP_IPC.confirmResume, request),
  openWorkspace: (request: OpenWorkspaceRequest) =>
    invoke<OpenWorkspaceResultDto>(DESKTOP_IPC.openWorkspace, request),
  exportHistory: (request: ExportHistoryRequest) =>
    invoke<ExportHistoryResultDto>(DESKTOP_IPC.exportHistory, request),
  openImport: () => invoke<OpenImportResultDto>(DESKTOP_IPC.openImport),
  replanImport: (request: ReplanImportRequest) =>
    invoke<ImportPlanDto>(DESKTOP_IPC.replanImport, request),
  applyImport: (request: ApplyImportRequest) =>
    invoke<ApplyImportResultDto>(DESKTOP_IPC.applyImport, request),
  cancelImport: (request: CancelImportRequest) =>
    invoke<CancelImportResultDto>(DESKTOP_IPC.cancelImport, request),
  mapImportWorkspace: (request: MapImportWorkspaceRequest) =>
    invoke<MapImportWorkspaceResultDto>(DESKTOP_IPC.mapImportWorkspace, request),
  previewExperience: (request: ExperienceScopeRequest) =>
    invoke<ExperiencePreviewDto>(DESKTOP_IPC.previewExperience, request),
  runExperience: (request: RunExperienceRequest) =>
    invoke<RunExperienceResultDto>(DESKTOP_IPC.runExperience, request),
  loadExperienceReview: () =>
    invoke<LoadExperienceReviewResultDto>(DESKTOP_IPC.loadExperienceReview),
  getExperienceCandidate: (request: GetExperienceCandidateRequest) =>
    invoke<ExperienceCandidateDetailDto>(DESKTOP_IPC.getExperienceCandidate, request),
  openExperienceOutput: (request: OpenExperienceOutputRequest) =>
    invoke<OpenExperienceOutputResultDto>(DESKTOP_IPC.openExperienceOutput, request),
  closeExperienceReview: (request: CloseExperienceReviewRequest) =>
    invoke<CloseExperienceReviewResultDto>(DESKTOP_IPC.closeExperienceReview, request),
  inspectExperienceConfig: () =>
    invoke<ExperienceConfigurationDto>(DESKTOP_IPC.inspectExperienceConfig),
  checkExperienceConfig: () =>
    invoke<ExperienceConfigurationCheckDto>(DESKTOP_IPC.checkExperienceConfig),
  openExperienceConfig: () =>
    invoke<OpenExperienceConfigResultDto>(DESKTOP_IPC.openExperienceConfig),
  getAgentSettings: () => invoke<readonly AgentSettingDto[]>(DESKTOP_IPC.getAgentSettings),
  chooseAgentPath: (request: ChooseAgentPathRequest) =>
    invoke<ChooseAgentPathResultDto>(DESKTOP_IPC.chooseAgentPath, request),
  clearAgentPath: (request: ClearAgentPathRequest) =>
    invoke<ClearAgentPathResultDto>(DESKTOP_IPC.clearAgentPath, request),
  getTerminalSettings: () =>
    invoke<TerminalSettingsDto>(DESKTOP_IPC.getTerminalSettings),
  selectTerminal: (request: SelectTerminalRequest) =>
    invoke<TerminalSettingsDto>(DESKTOP_IPC.selectTerminal, request),
  updateTerminalArguments: (request: UpdateTerminalArgumentsRequest) =>
    invoke<TerminalSettingsDto>(DESKTOP_IPC.updateTerminalArguments, request),
  listTransactions: () =>
    invoke<readonly TransactionSummaryDto[]>(DESKTOP_IPC.listTransactions),
  planTransaction: (request: PlanTransactionRequest) =>
    invoke<TransactionPlanDto>(DESKTOP_IPC.planTransaction, request),
  confirmTransaction: (request: ConfirmTransactionRequest) =>
    invoke<ConfirmTransactionResultDto>(DESKTOP_IPC.confirmTransaction, request),
  rebuildHistoryIndex: () =>
    invoke<RebuildHistoryIndexResultDto>(DESKTOP_IPC.rebuildHistoryIndex),
  getSettings: () => invoke<DesktopSettings>(DESKTOP_IPC.getSettings),
  updateSettings: (settings: DesktopSettings) =>
    invoke<DesktopSettings>(DESKTOP_IPC.updateSettings, settings),
  onScanProgress(listener: (progress: ScanProgressDto) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, progress: ScanProgressDto): void => {
      listener(progress);
    };
    ipcRenderer.on(DESKTOP_IPC.scanProgress, handler);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.scanProgress, handler);
  },
  onExperienceProgress(listener: (progress: ExperienceProgressDto) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, progress: ExperienceProgressDto): void => {
      listener(progress);
    };
    ipcRenderer.on(DESKTOP_IPC.experienceProgress, handler);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.experienceProgress, handler);
  },
});

contextBridge.exposeInMainWorld("agentHist", api);
