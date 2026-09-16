import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  DESKTOP_IPC,
  type ApplyImportRequest,
  type CancelImportRequest,
  type ChatMutationRequest,
  type ChooseAgentPathRequest,
  type ClearAgentPathRequest,
  type ConfirmTransactionRequest,
  type ConversationFindRequest,
  type ConversationRequest,
  type TechnicalDetailRequest,
  type DesktopResult,
  type DesktopSettings,
  type ExperienceProgressDto,
  type ExperienceScopeRequest,
  type ExportHistoryRequest,
  type GetExperienceCandidateRequest,
  type ListChatsRequest,
  type MapImportWorkspaceRequest,
  type OpenWorkspaceRequest,
  type OpenExperienceOutputRequest,
  type ResumeConfirmRequest,
  type ResumePlanRequest,
  type PlanTransactionRequest,
  type ReplanImportRequest,
  type RunExperienceRequest,
  type ScanProgressDto,
  type CloseExperienceReviewRequest,
  type SelectTerminalRequest,
  type UpdateTerminalArgumentsRequest,
} from "./contracts.js";
import type { DesktopService } from "./service.js";
import type { CodexProviderUnifyRequest, ConfirmCodexProviderUnifyRequest } from "./contracts.js";
import { desktopFailure, invalidIpcArguments } from "./validation.js";

export interface RegisterDesktopIpcOptions {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly service: DesktopService;
  readonly authorizeSender: (event: IpcMainInvokeEvent) => boolean;
  readonly onProgress?: (progress: ScanProgressDto) => void;
  readonly onExperienceProgress?: (progress: ExperienceProgressDto) => void;
  readonly onThemeChanged?: (theme: DesktopSettings["theme"]) => void;
  readonly onAutoRefreshChanged?: (enabled: boolean) => void;
}

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<DesktopResult<unknown>>;

const REQUEST_CHANNELS = [
  DESKTOP_IPC.listCodexProviders,
  DESKTOP_IPC.previewCodexProviderUnify,
  DESKTOP_IPC.confirmCodexProviderUnify,
  DESKTOP_IPC.bootstrap,
  DESKTOP_IPC.listChats,
  DESKTOP_IPC.getConversation,
  DESKTOP_IPC.getTechnicalDetail,
  DESKTOP_IPC.findInConversation,
  DESKTOP_IPC.refresh,
  DESKTOP_IPC.rebuildHistoryIndex,
  DESKTOP_IPC.updateChat,
  DESKTOP_IPC.planResume,
  DESKTOP_IPC.confirmResume,
  DESKTOP_IPC.openWorkspace,
  DESKTOP_IPC.exportHistory,
  DESKTOP_IPC.openImport,
  DESKTOP_IPC.replanImport,
  DESKTOP_IPC.mapImportWorkspace,
  DESKTOP_IPC.applyImport,
  DESKTOP_IPC.cancelImport,
  DESKTOP_IPC.previewExperience,
  DESKTOP_IPC.runExperience,
  DESKTOP_IPC.loadExperienceReview,
  DESKTOP_IPC.getExperienceCandidate,
  DESKTOP_IPC.openExperienceOutput,
  DESKTOP_IPC.closeExperienceReview,
  DESKTOP_IPC.inspectExperienceConfig,
  DESKTOP_IPC.checkExperienceConfig,
  DESKTOP_IPC.openExperienceConfig,
  DESKTOP_IPC.getAgentSettings,
  DESKTOP_IPC.chooseAgentPath,
  DESKTOP_IPC.clearAgentPath,
  DESKTOP_IPC.getTerminalSettings,
  DESKTOP_IPC.selectTerminal,
  DESKTOP_IPC.updateTerminalArguments,
  DESKTOP_IPC.listTransactions,
  DESKTOP_IPC.planTransaction,
  DESKTOP_IPC.confirmTransaction,
  DESKTOP_IPC.getSettings,
  DESKTOP_IPC.updateSettings,
] as const;

export function registerDesktopIpc(options: RegisterDesktopIpcOptions): () => void {
  let active = true;

  const register = (
    channel: (typeof REQUEST_CHANNELS)[number],
    argumentCount: number,
    action: (args: readonly unknown[]) => Promise<DesktopResult<unknown>>,
  ): void => {
    options.ipcMain.removeHandler(channel);
    const handler: InvokeHandler = async (event, ...args) => {
      let authorized = false;
      try { authorized = options.authorizeSender(event); } catch { /* reject an indeterminate sender */ }
      if (!authorized) return desktopFailure(undefined, "ipc_sender_rejected", false);
      // The preload's generic invoke helper sends one explicit `undefined` for
      // request-less methods. Treat that wire representation as no arguments,
      // while continuing to reject every other surplus argument.
      const normalizedArgs = argumentCount === 0 && args.length === 1 && args[0] === undefined
        ? []
        : args;
      if (normalizedArgs.length !== argumentCount) return invalidIpcArguments();
      try {
        return await action(normalizedArgs);
      } catch (error) {
        return desktopFailure(error, "ipc_operation_failed", true);
      }
    };
    options.ipcMain.handle(channel, handler);
  };

  register(DESKTOP_IPC.bootstrap, 0, () => options.service.bootstrap());
  register(DESKTOP_IPC.listCodexProviders, 0, () => options.service.listCodexProviders());
  register(DESKTOP_IPC.previewCodexProviderUnify, 1, (args) => options.service.previewCodexProviderUnify(args[0] as CodexProviderUnifyRequest));
  register(DESKTOP_IPC.confirmCodexProviderUnify, 1, (args) => options.service.confirmCodexProviderUnify(args[0] as ConfirmCodexProviderUnifyRequest));
  register(DESKTOP_IPC.listChats, 1, (args) =>
    options.service.listChats(args[0] as ListChatsRequest));
  register(DESKTOP_IPC.getConversation, 1, (args) =>
    options.service.getConversation(args[0] as ConversationRequest));
  register(DESKTOP_IPC.getTechnicalDetail, 1, (args) =>
    options.service.getTechnicalDetail(args[0] as TechnicalDetailRequest));
  register(DESKTOP_IPC.findInConversation, 1, (args) =>
    options.service.findInConversation(args[0] as ConversationFindRequest));
  register(DESKTOP_IPC.refresh, 0, () => options.service.refresh((progress) => {
    try { options.onProgress?.(progress); } catch { /* renderer delivery cannot interrupt scanning */ }
  }));
  register(DESKTOP_IPC.rebuildHistoryIndex, 0, () => options.service.rebuildHistoryIndex());
  register(DESKTOP_IPC.updateChat, 1, (args) =>
    options.service.updateChat(args[0] as ChatMutationRequest));
  register(DESKTOP_IPC.planResume, 1, (args) =>
    options.service.planResume(args[0] as ResumePlanRequest));
  register(DESKTOP_IPC.confirmResume, 1, (args) =>
    options.service.confirmResume(args[0] as ResumeConfirmRequest));
  register(DESKTOP_IPC.openWorkspace, 1, (args) =>
    options.service.openWorkspace(args[0] as OpenWorkspaceRequest));
  register(DESKTOP_IPC.exportHistory, 1, (args) =>
    options.service.exportHistory(args[0] as ExportHistoryRequest));
  register(DESKTOP_IPC.openImport, 0, () => options.service.openImport());
  register(DESKTOP_IPC.replanImport, 1, (args) =>
    options.service.replanImport(args[0] as ReplanImportRequest));
  register(DESKTOP_IPC.mapImportWorkspace, 1, (args) =>
    options.service.mapImportWorkspace(args[0] as MapImportWorkspaceRequest));
  register(DESKTOP_IPC.applyImport, 1, (args) =>
    options.service.applyImport(args[0] as ApplyImportRequest));
  register(DESKTOP_IPC.cancelImport, 1, (args) =>
    options.service.cancelImport(args[0] as CancelImportRequest));
  register(DESKTOP_IPC.previewExperience, 1, (args) =>
    options.service.previewExperience(args[0] as ExperienceScopeRequest));
  register(DESKTOP_IPC.runExperience, 1, (args) =>
    options.service.runExperience(args[0] as RunExperienceRequest, (progress) => {
      try { options.onExperienceProgress?.(progress); } catch { /* renderer delivery cannot interrupt analysis */ }
    }));
  register(DESKTOP_IPC.loadExperienceReview, 0, () => options.service.loadExperienceReview());
  register(DESKTOP_IPC.getExperienceCandidate, 1, (args) =>
    options.service.getExperienceCandidate(args[0] as GetExperienceCandidateRequest));
  register(DESKTOP_IPC.openExperienceOutput, 1, (args) =>
    options.service.openExperienceOutput(args[0] as OpenExperienceOutputRequest));
  register(DESKTOP_IPC.closeExperienceReview, 1, (args) =>
    options.service.closeExperienceReview(args[0] as CloseExperienceReviewRequest));
  register(DESKTOP_IPC.inspectExperienceConfig, 0, () => options.service.inspectExperienceConfig());
  register(DESKTOP_IPC.checkExperienceConfig, 0, () => options.service.checkExperienceConfig());
  register(DESKTOP_IPC.openExperienceConfig, 0, () => options.service.openExperienceConfig());
  register(DESKTOP_IPC.getAgentSettings, 0, () => options.service.getAgentSettings());
  register(DESKTOP_IPC.chooseAgentPath, 1, (args) =>
    options.service.chooseAgentPath(args[0] as ChooseAgentPathRequest));
  register(DESKTOP_IPC.clearAgentPath, 1, (args) =>
    options.service.clearAgentPath(args[0] as ClearAgentPathRequest));
  register(DESKTOP_IPC.getTerminalSettings, 0, () => options.service.getTerminalSettings());
  register(DESKTOP_IPC.selectTerminal, 1, (args) =>
    options.service.selectTerminal(args[0] as SelectTerminalRequest));
  register(DESKTOP_IPC.updateTerminalArguments, 1, (args) =>
    options.service.updateTerminalArguments(args[0] as UpdateTerminalArgumentsRequest));
  register(DESKTOP_IPC.listTransactions, 0, () => options.service.listTransactions());
  register(DESKTOP_IPC.planTransaction, 1, (args) =>
    options.service.planTransaction(args[0] as PlanTransactionRequest));
  register(DESKTOP_IPC.confirmTransaction, 1, (args) =>
    options.service.confirmTransaction(args[0] as ConfirmTransactionRequest));
  register(DESKTOP_IPC.getSettings, 0, () => options.service.getSettings());
  register(DESKTOP_IPC.updateSettings, 1, async (args) => {
    const result = await options.service.updateSettings(args[0] as DesktopSettings);
    if (result.ok) {
      try { options.onThemeChanged?.(result.value.theme); } catch { /* native theme sync cannot undo saved settings */ }
      try { options.onAutoRefreshChanged?.(result.value.autoRefresh); } catch { /* scheduler sync cannot undo saved settings */ }
    }
    return result;
  });

  return () => {
    if (!active) return;
    active = false;
    for (const channel of REQUEST_CHANNELS) options.ipcMain.removeHandler(channel);
  };
}
