import path from "node:path";
import os from "node:os";
import { lstat, mkdir } from "node:fs/promises";
import { listCodexHistoryProviders, listCodexImportProviders, unifyCodexHistoryProviders } from "../application/provider-history.js";
import { codexProviderPlanDto } from "./providers.js";
import { validateCodexProviderUnifyRequest, validateConfirmCodexProviderUnifyRequest } from "./validation.js";
import type { CodexProvidersDto, CodexProviderUnifyRequest, CodexProviderPlanDto, ConfirmCodexProviderUnifyRequest, CodexProviderConfirmDto } from "./contracts.js";

import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  listHistory,
  mutateHistory,
  searchHistory,
  showHistory,
  type HistorySessionDetail,
  type HistorySessionSummary,
} from "../application/history.js";
import type {
  ConfirmConversationResumeOptions,
  ConversationResumeConfirmation,
  ConversationResumePlan,
  HistorySourceInspection,
  HistorySourceInspectionResult,
  HistorySourceOptions,
  PlanConversationResumeOptions,
  ResumeLaunchOptions,
  ScanHistoryOptions,
  ScanHistoryResult,
} from "../application/index.js";
import type { AgentLaunchSpec } from "../agents/contracts.js";
import { AGENTS, agentLabel, type Agent } from "../domain/agent.js";
import type { ConversationItem } from "../domain/history.js";
import { isAbsolutePath, pathFlavorForPlatform, samePath } from "../domain/host-path.js";
import { workspacePath } from "../domain/workspace-path.js";
import { resolveAgentApiAnalysisConfiguration } from "../experience/agent-api-configuration.js";
import {
  launchDetachedAgentProcess,
  prepareDetachedAgentLaunch,
  type DetachedAgentProcessOptions,
  type DetachedAgentProcessResult,
  type PreparedDetachedAgentLaunch,
} from "../infrastructure/detached-agent-process.js";
import { applyPosixMode, readStableSmallFile, writeJsonAtomic } from "../infrastructure/files.js";
import { ensurePrivateStateDirectory } from "../infrastructure/state.js";
import type {
  AgentSettingDto,
  AgentPathKind,
  AgentStatusDto,
  ApplyImportRequest,
  ApplyImportResultDto,
  BootstrapDto,
  CancelImportRequest,
  CancelImportResultDto,
  ChatMutationRequest,
  ChatMutationResultDto,
  ChatPageDto,
  ChatSummaryDto,
  ConversationFindRequest,
  ConversationFindResult,
  ConversationItemDto,
  ConversationPageDto,
  ConversationRequest,
  DesktopResult,
  DesktopSettings,
  ExperienceCandidateDetailDto,
  ExperienceConfigurationCheckDto,
  ExperienceConfigurationDto,
  ExperiencePreviewDto,
  ExperienceProgressDto,
  ExperienceScopeRequest,
  ExportHistoryRequest,
  ExportHistoryResultDto,
  ImportPlanDto,
  GetExperienceCandidateRequest,
  ListChatsRequest,
  LoadExperienceReviewResultDto,
  MapImportWorkspaceRequest,
  MapImportWorkspaceResultDto,
  OpenWorkspaceRequest,
  OpenWorkspaceResultDto,
  OpenImportResultDto,
  OpenExperienceOutputRequest,
  OpenExperienceOutputResultDto,
  OpenExperienceConfigResultDto,
  RefreshAgentResultDto,
  RefreshResultDto,
  RebuildHistoryIndexResultDto,
  ResumeConfirmRequest,
  ResumeConfirmResultDto,
  ResumePlanDto,
  ResumePlanRequest,
  ReplanImportRequest,
  RunExperienceRequest,
  RunExperienceResultDto,
  ScanProgressDto,
  TechnicalDetailDto,
  TechnicalDetailRequest,
  TechnicalDetailChunkDto,
  CloseExperienceReviewRequest,
  CloseExperienceReviewResultDto,
  ChooseAgentPathRequest,
  ChooseAgentPathResultDto,
  ClearAgentPathRequest,
  ClearAgentPathResultDto,
  SelectTerminalRequest,
  TerminalSettingsDto,
  UpdateTerminalArgumentsRequest,
  ConfirmTransactionRequest,
  ConfirmTransactionResultDto,
  PlanTransactionRequest,
  TransactionPlanDto,
  TransactionSummaryDto,
} from "./contracts.js";
import {
  applyAgentSettingsToSourceOptions,
  clearDesktopAgentPathSetting,
  inspectAgentSettings,
  loadDesktopAgentPathSettings,
  resolveConfiguredAgentExecutable,
  updateDesktopAgentPathSetting,
  type AgentSettingsInspection,
  type DesktopAgentPathSetting,
  type DesktopAgentPathSettings,
} from "./agent-settings.js";
import {
  createDesktopExperienceService,
  type DesktopExperienceService,
} from "./experience.js";
import {
  checkDesktopExperienceConfiguration,
  experienceConfigurationDirectory,
  inspectDesktopExperienceConfiguration,
  type DesktopExperienceConfigurationCheck,
  type DesktopExperienceConfigurationInspection,
} from "./experience-settings.js";
import {
  findInDesktopConversation,
  getDesktopConversationChunk,
  listDesktopHistoryIndex,
  rebuildDesktopHistoryIndex,
  syncDesktopHistoryIndex,
  type DesktopIndexedHistorySummary,
} from "./history-index.js";
import {
  createDesktopTransferService,
  type DesktopTransferService,
  type DesktopTransferServiceOptions,
} from "./transfer.js";
import { createDesktopTerminalSettingsService } from "./terminal-settings.js";
import {
  confirmDesktopTransaction,
  listDesktopTransactions,
  planDesktopTransaction,
  type DesktopTransactionConfirmation,
  type DesktopTransactionDependencies,
  type DesktopTransactionPlan,
  type DesktopTransactionSummary,
} from "./transactions.js";
import {
  getTechnicalDetailChunk,
  listTechnicalDetails,
} from "./technical-detail.js";
import {
  DEFAULT_DESKTOP_CONVERSATION_LIMIT,
  desktopFailure,
  desktopSuccess,
  redactedDesktopError,
  validateChatMutationRequest,
  validateConversationFindRequest,
  validateConversationRequest,
  validateDesktopSettings,
  validateListChatsRequest,
  validateMapImportWorkspaceRequest,
  validateApplyImportRequest,
  validateCancelImportRequest,
  validateExportHistoryRequest,
  validateExperienceScopeRequest,
  validateGetExperienceCandidateRequest,
  validateOpenWorkspaceRequest,
  validateOpenExperienceOutputRequest,
  validateReplanImportRequest,
  validateRunExperienceRequest,
  validateResumeConfirmRequest,
  validateResumePlanRequest,
  validateCloseExperienceReviewRequest,
  validateChooseAgentPathRequest,
  validateClearAgentPathRequest,
  validateConfirmTransactionRequest,
  validatePlanTransactionRequest,
  validateTechnicalDetailRequest,
} from "./validation.js";

const SETTINGS_BYTES_LIMIT = 64 * 1024;
const SEARCH_CONTEXT_CHARACTERS = 120;

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  theme: "system",
  agentFilter: "all",
  autoRefresh: false,
  showTechnicalDetails: false,
  firstRunComplete: false,
};

export interface DesktopApplicationDependencies {
  readonly detectHistorySources: (
    options: HistorySourceOptions,
  ) => Promise<HistorySourceInspectionResult>;
  readonly listHistory: typeof listHistory;
  readonly searchHistory: typeof searchHistory;
  readonly showHistory: typeof showHistory;
  readonly mutateHistory: typeof mutateHistory;
  readonly scanHistory: (options: ScanHistoryOptions) => Promise<ScanHistoryResult>;
}

export interface DesktopHistoryIndexDependencies {
  readonly syncDesktopHistoryIndex: typeof syncDesktopHistoryIndex;
  readonly listDesktopHistoryIndex: typeof listDesktopHistoryIndex;
  readonly getDesktopConversationChunk: typeof getDesktopConversationChunk;
  readonly findInDesktopConversation: typeof findInDesktopConversation;
  readonly rebuildDesktopHistoryIndex: typeof rebuildDesktopHistoryIndex;
}

export interface DesktopResumeDependencies {
  readonly planConversationResume: (
    options: PlanConversationResumeOptions,
  ) => Promise<ConversationResumePlan>;
  readonly confirmConversationResume: (
    options: ConfirmConversationResumeOptions,
  ) => Promise<ConversationResumeConfirmation>;
  readonly prepareResumeLaunch: (
    options: ResumeLaunchOptions,
  ) => AgentLaunchSpec | Promise<AgentLaunchSpec>;
}

export interface DesktopProcessDependencies {
  readonly prepareDetachedAgentLaunch: (
    spec: AgentLaunchSpec,
    options?: DetachedAgentProcessOptions,
  ) => Promise<PreparedDetachedAgentLaunch>;
  readonly launchDetachedAgentProcess: (
    spec: AgentLaunchSpec,
    options?: DetachedAgentProcessOptions,
  ) => Promise<DetachedAgentProcessResult>;
  readonly options?: DetachedAgentProcessOptions;
}

export interface DesktopPlatformDependencies {
  openPath(path: string): Promise<string>;
}

export interface DesktopAgentSettingsDependencies {
  readonly loadDesktopAgentPathSettings: typeof loadDesktopAgentPathSettings;
  readonly updateDesktopAgentPathSetting: typeof updateDesktopAgentPathSetting;
  readonly clearDesktopAgentPathSetting: typeof clearDesktopAgentPathSetting;
  readonly applyAgentSettingsToSourceOptions: typeof applyAgentSettingsToSourceOptions;
  readonly inspectAgentSettings: typeof inspectAgentSettings;
  readonly resolveConfiguredAgentExecutable: typeof resolveConfiguredAgentExecutable;
  readonly choosePath: (agent: Agent, kind: AgentPathKind) => Promise<string | undefined>;
  readonly lstat: typeof lstat;
  readonly createTransferService: typeof createDesktopTransferService;
}

export interface DesktopTransactionFacade {
  readonly listDesktopTransactions: (stateDirectory: string) => Promise<readonly DesktopTransactionSummary[]>;
  readonly planDesktopTransaction: (
    stateDirectory: string,
    request: PlanTransactionRequest,
  ) => Promise<DesktopTransactionPlan>;
  readonly confirmDesktopTransaction: (
    stateDirectory: string,
    request: ConfirmTransactionRequest,
  ) => Promise<DesktopTransactionConfirmation>;
}

export interface DesktopExperienceSettingsFacade {
  readonly inspectExperienceConfig: (
    stateDirectory: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<DesktopExperienceConfigurationInspection>;
  readonly checkExperienceConfig: (
    stateDirectory: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<DesktopExperienceConfigurationCheck>;
  readonly configurationDirectory: (stateDirectory: string) => string;
}

export interface DesktopServiceOptions {
  readonly providers?: {
    readonly list?: typeof listCodexHistoryProviders;
    readonly unify?: typeof unifyCodexHistoryProviders;
  };
  readonly stateDirectory: string;
  readonly version: string;
  readonly sourceOptions?: HistorySourceOptions;
  readonly application?: Partial<DesktopApplicationDependencies>;
  readonly historyIndex?: Partial<DesktopHistoryIndexDependencies>;
  readonly resume?: Partial<DesktopResumeDependencies>;
  readonly process?: Partial<DesktopProcessDependencies>;
  readonly platform?: Partial<DesktopPlatformDependencies>;
  readonly transfer?: DesktopTransferService;
  readonly experience?: DesktopExperienceService;
  readonly agentSettings?: Partial<DesktopAgentSettingsDependencies>;
  readonly transactionDependencies?: Partial<DesktopTransactionDependencies>;
  readonly transactions?: Partial<DesktopTransactionFacade>;
  readonly experienceSettings?: Partial<DesktopExperienceSettingsFacade>;
  readonly chooseImportWorkspaceDirectory?: () => Promise<string | undefined>;
  readonly chooseTerminalExecutable?: () => Promise<string | undefined>;
}

export interface DesktopService {
  listCodexProviders(): Promise<DesktopResult<CodexProvidersDto>>;
  previewCodexProviderUnify(request: CodexProviderUnifyRequest): Promise<DesktopResult<CodexProviderPlanDto>>;
  confirmCodexProviderUnify(request: ConfirmCodexProviderUnifyRequest): Promise<DesktopResult<CodexProviderConfirmDto>>;
  bootstrap(): Promise<DesktopResult<BootstrapDto>>;
  listChats(request: ListChatsRequest): Promise<DesktopResult<ChatPageDto>>;
  getConversation(request: ConversationRequest): Promise<DesktopResult<ConversationPageDto>>;
  getTechnicalDetail(request: TechnicalDetailRequest): Promise<DesktopResult<TechnicalDetailChunkDto>>;
  findInConversation(request: ConversationFindRequest): Promise<DesktopResult<ConversationFindResult>>;
  refresh(onProgress?: (progress: ScanProgressDto) => void): Promise<DesktopResult<RefreshResultDto>>;
  rebuildHistoryIndex(): Promise<DesktopResult<RebuildHistoryIndexResultDto>>;
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
  runExperience(
    request: RunExperienceRequest,
    onProgress?: (progress: ExperienceProgressDto) => void,
  ): Promise<DesktopResult<RunExperienceResultDto>>;
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
  inspectExperienceConfig(): Promise<DesktopResult<ExperienceConfigurationDto>>;
  checkExperienceConfig(): Promise<DesktopResult<ExperienceConfigurationCheckDto>>;
  openExperienceConfig(): Promise<DesktopResult<OpenExperienceConfigResultDto>>;
  getSettings(): Promise<DesktopResult<DesktopSettings>>;
  updateSettings(settings: DesktopSettings): Promise<DesktopResult<DesktopSettings>>;
  dispose(): Promise<void>;
}

interface CollectedChat {
  readonly session: HistorySessionSummary;
  readonly preview?: string;
}

const DEFAULT_APPLICATION: DesktopApplicationDependencies = {
  async detectHistorySources(options) {
    const acquisition = await import("../application/acquisition.js");
    return acquisition.detectHistorySources(options);
  },
  listHistory,
  searchHistory,
  showHistory,
  mutateHistory,
  async scanHistory(options) {
    const acquisition = await import("../application/acquisition.js");
    return acquisition.scanHistory(options);
  },
};

const DEFAULT_HISTORY_INDEX: DesktopHistoryIndexDependencies = {
  syncDesktopHistoryIndex,
  listDesktopHistoryIndex,
  getDesktopConversationChunk,
  findInDesktopConversation,
  rebuildDesktopHistoryIndex,
};

const DEFAULT_RESUME: DesktopResumeDependencies = {
  async planConversationResume(options) {
    const application = await import("../application/index.js");
    return application.planConversationResume(options);
  },
  async confirmConversationResume(options) {
    const application = await import("../application/index.js");
    return application.confirmConversationResume(options);
  },
  async prepareResumeLaunch(options) {
    const application = await import("../application/index.js");
    return application.prepareResumeLaunch(options);
  },
};

const DEFAULT_PROCESS: DesktopProcessDependencies = {
  prepareDetachedAgentLaunch,
  launchDetachedAgentProcess,
};

const DEFAULT_PLATFORM: DesktopPlatformDependencies = {
  async openPath(workspace) {
    const { shell } = await import("electron");
    return shell.openPath(workspace);
  },
};

const DEFAULT_AGENT_SETTINGS: DesktopAgentSettingsDependencies = {
  loadDesktopAgentPathSettings,
  updateDesktopAgentPathSetting,
  clearDesktopAgentPathSetting,
  applyAgentSettingsToSourceOptions,
  inspectAgentSettings,
  resolveConfiguredAgentExecutable,
  choosePath: chooseConfiguredAgentPath,
  lstat,
  createTransferService: createDesktopTransferService,
};

function cloneSettings(settings: DesktopSettings): DesktopSettings {
  return {
    theme: settings.theme,
    agentFilter: settings.agentFilter,
    autoRefresh: settings.autoRefresh,
    showTechnicalDetails: settings.showTechnicalDetails,
    firstRunComplete: settings.firstRunComplete,
    ...(settings.experienceAgent === undefined ? {} : { experienceAgent: settings.experienceAgent }),
    ...(settings.lastSessionRef === undefined ? {} : { lastSessionRef: settings.lastSessionRef }),
  };
}

function cloneSourceOptions(options: HistorySourceOptions | undefined): HistorySourceOptions {
  if (options === undefined) return {};
  return {
    ...(options.agents === undefined ? {} : { agents: [...options.agents] }),
    ...(options.codex === undefined ? {} : {
      codex: {
        ...options.codex,
        ...(options.codex.environment === undefined ? {} : { environment: { ...options.codex.environment } }),
      },
    }),
    ...(options.opencode === undefined ? {} : {
      opencode: {
        ...options.opencode,
        ...(options.opencode.environment === undefined ? {} : { environment: { ...options.opencode.environment } }),
      },
    }),
    ...(options.claude === undefined ? {} : {
      claude: {
        ...options.claude,
        ...(options.claude.environment === undefined ? {} : { environment: { ...options.claude.environment } }),
      },
    }),
    ...(options.pi === undefined ? {} : {
      pi: {
        ...options.pi,
        ...(options.pi.environment === undefined ? {} : { environment: { ...options.pi.environment } }),
      },
    }),
  };
}

interface ResumeRuntimeContext {
  readonly cwd?: string;
  readonly home?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

function sameEnvironment(left: NodeJS.ProcessEnv, right: NodeJS.ProcessEnv): boolean {
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return names.every((name) => left[name] === right[name]);
}

function sharedResumeRuntimeContext(options: HistorySourceOptions): ResumeRuntimeContext {
  const contexts = [options.codex, options.opencode, options.claude, options.pi]
    .filter((value): value is NonNullable<typeof value> => value !== undefined);
  const textValue = (field: "cwd" | "home"): string | undefined => {
    const values = contexts.flatMap((context) => context[field] === undefined ? [] : [context[field]]);
    if (values.some((value) => value !== values[0])) {
      throw new Error(`Desktop Agent source ${field} contexts disagree`);
    }
    return values[0];
  };
  const environments = contexts.flatMap((context) =>
    context.environment === undefined ? [] : [context.environment]);
  if (environments.some((environment) => !sameEnvironment(environment, environments[0]!))) {
    throw new Error("Desktop Agent source environments disagree");
  }
  const cwd = textValue("cwd");
  const home = textValue("home");
  const environment = environments[0];
  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(home === undefined ? {} : { home }),
    ...(environment === undefined ? {} : { environment: { ...environment } }),
  };
}

function resumeChatSummary(source: ConversationResumePlan["source"]): ChatSummaryDto {
  return {
    sessionRef: source.sessionRef,
    memberSessionRefs: [source.sessionRef],
    agent: source.agent,
    title: source.title,
    workspace: source.workspace,
    workspaceName: workspaceName(source.workspace),
    updatedAt: source.updatedAt,
    libraryState: source.libraryState,
    tags: [...source.tags],
  };
}

function transferImportOptions(
  options: HistorySourceOptions,
): NonNullable<DesktopTransferServiceOptions["importOptions"]> {
  const runtime = sharedResumeRuntimeContext(options);
  return {
    ...(options.codex?.codexHome === undefined ? {} : { codexHome: options.codex.codexHome }),
    ...(options.codex?.sqliteHome === undefined ? {} : { sqliteHome: options.codex.sqliteHome }),
    ...(options.codex?.profile === undefined ? {} : { profile: options.codex.profile }),
    ...(options.opencode?.dataRoot === undefined ? {} : { opencodeDataRoot: options.opencode.dataRoot }),
    ...(options.opencode?.databasePath === undefined
      ? {}
      : { opencodeDatabase: options.opencode.databasePath }),
    ...(options.claude?.configRoot === undefined ? {} : { claudeConfigRoot: options.claude.configRoot }),
    ...(options.pi?.sessionRoot === undefined ? {} : { piSessionRoot: options.pi.sessionRoot }),
    ...(runtime.environment === undefined ? {} : { environment: { ...runtime.environment } }),
    ...(runtime.cwd === undefined ? {} : { cwd: runtime.cwd }),
    ...(runtime.home === undefined ? {} : { home: runtime.home }),
  };
}

async function chooseImportArchive(): Promise<string | undefined> {
  const { app, dialog } = await import("electron");
  const result = await dialog.showOpenDialog({
    defaultPath: app.getPath("documents"),
    properties: ["openFile"],
    filters: [{ name: "AgentHist archive", extensions: ["agenthist"] }],
  });
  return result.canceled || result.filePaths.length !== 1 ? undefined : result.filePaths[0];
}

async function chooseImportWorkspaceDirectory(): Promise<string | undefined> {
  const { app, dialog } = await import("electron");
  const result = await dialog.showOpenDialog({
    defaultPath: app.getPath("documents"),
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || result.filePaths.length !== 1 ? undefined : result.filePaths[0];
}

async function chooseExportArchive(suggestedName: string): Promise<string | undefined> {
  const { app, dialog } = await import("electron");
  const result = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath("documents"), path.basename(suggestedName)),
    filters: [{ name: "AgentHist archive", extensions: ["agenthist"] }],
  });
  return result.canceled || result.filePath === undefined ? undefined : result.filePath;
}

async function chooseExperienceOutputParent(): Promise<string | undefined> {
  const { app, dialog } = await import("electron");
  const result = await dialog.showOpenDialog({
    defaultPath: app.getPath("documents"),
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || result.filePaths.length !== 1 ? undefined : result.filePaths[0];
}

async function chooseExperienceReview(): Promise<string | undefined> {
  const { app, dialog } = await import("electron");
  const result = await dialog.showOpenDialog({
    defaultPath: app.getPath("documents"),
    properties: ["openFile", "openDirectory"],
    filters: [{ name: "AgentHist review (review.json)", extensions: ["json"] }],
  });
  return result.canceled || result.filePaths.length !== 1 ? undefined : result.filePaths[0];
}

async function openExperienceDirectory(directory: string): Promise<string> {
  const { shell } = await import("electron");
  return shell.openPath(directory);
}

async function chooseConfiguredAgentPath(
  agent: Agent,
  kind: AgentPathKind,
): Promise<string | undefined> {
  const { app, dialog } = await import("electron");
  const common = { defaultPath: app.getPath("documents") } as const;
  const result = kind === "history" || kind === "database" && agent === "codex"
    ? await dialog.showOpenDialog({
        ...common,
        properties: ["openDirectory"],
      })
    : await dialog.showOpenDialog({
        ...common,
        properties: ["openFile"],
        filters: kind === "database"
          ? [{ name: "SQLite database", extensions: ["db", "sqlite"] }]
          : [{ name: "Agent executable", extensions: ["exe", "cmd", "bat", "com"] }],
      });
  return result.canceled || result.filePaths.length !== 1 ? undefined : result.filePaths[0];
}

async function chooseConfiguredTerminalExecutable(): Promise<string | undefined> {
  const { app, dialog } = await import("electron");
  const result = await dialog.showOpenDialog({
    defaultPath: process.env.ProgramFiles ?? app.getPath("home"),
    properties: ["openFile"],
    ...(process.platform === "win32" ? { filters: [{ name: "Terminal executable", extensions: ["exe"] }] } : {}),
  });
  return result.canceled || result.filePaths.length !== 1 ? undefined : result.filePaths[0];
}

function missingSnapshot(error: unknown, agent: Agent): boolean {
  return error instanceof Error && (
    error.message === `no scanned ${agent} history; run agenthist scan first` ||
    error.message === "no scanned history; run agenthist scan first"
  );
}

function workspaceName(workspace: string): string {
  if (workspace === "") return "";
  const withoutTrailingSeparators = workspace.replace(/[\\/]+$/u, "");
  if (withoutTrailingSeparators === "") return workspace;
  return path.win32.basename(withoutTrailingSeparators) || path.posix.basename(withoutTrailingSeparators) || workspace;
}

function compactPreview(value: string): string | undefined {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact === "") return undefined;
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}

function chatSummary(session: HistorySessionSummary, preview?: string): ChatSummaryDto {
  const normalizedPreview = preview === undefined ? undefined : compactPreview(preview);
  return {
    sessionRef: session.sessionRef,
    memberSessionRefs: [session.sessionRef],
    agent: session.agent,
    title: session.title,
    workspace: session.context,
    workspaceName: workspaceName(session.context),
    updatedAt: session.updatedAt,
    ...(normalizedPreview === undefined ? {} : { preview: normalizedPreview }),
    libraryState: session.libraryState,
    tags: [...session.tags],
  };
}

function indexedChatSummary(session: DesktopIndexedHistorySummary): ChatSummaryDto {
  const preview = compactPreview(session.preview);
  return {
    sessionRef: session.sessionRef,
    memberSessionRefs: [...session.memberSessionRefs],
    agent: session.agent,
    title: session.title,
    workspace: session.workspace,
    workspaceName: session.workspaceName,
    updatedAt: session.updatedAt,
    ...(preview === undefined ? {} : { preview }),
    libraryState: session.libraryState,
    tags: [...session.tags],
  };
}

function compareChats(left: CollectedChat, right: CollectedChat): number {
  const leftTime = Date.parse(left.session.updatedAt);
  const rightTime = Date.parse(right.session.updatedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
  return left.session.sessionRef.localeCompare(right.session.sessionRef);
}

function pageMetadata(total: number, offset: number, limit: number, returned: number) {
  const remaining = Math.max(0, total - offset - returned);
  return {
    total,
    offset,
    limit,
    returned,
    remaining,
    ...(remaining === 0 ? {} : { nextOffset: offset + returned }),
  };
}

function technicalDetails(
  sessionRef: string,
  index: number,
  item: Extract<ConversationItem, { readonly kind: "message" }>,
): TechnicalDetailDto[] {
  return listTechnicalDetails(sessionRef, index, item).map((detail) => ({
    id: detail.id,
    detailIndex: detail.detailIndex,
    label: detail.label,
    summary: detail.summary,
    detail: detail.preview,
    totalCharacters: detail.totalCharacters,
    truncated: detail.truncated,
    available: detail.available,
    ...(detail.unavailableReason === undefined ? {} : { unavailableReason: detail.unavailableReason }),
  }));
}

function conversationItemDto(sessionRef: string, item: ConversationItem, index: number): ConversationItemDto {
  const id = `${sessionRef}:${index}`;
  if (item.kind === "gap") {
    return {
      id,
      index,
      kind: "gap",
      label: item.label,
      timestamp: item.timestamp,
      ...(item.code === undefined ? {} : { code: item.code }),
    };
  }
  return {
    id,
    index,
    kind: "message",
    role: item.role,
    text: item.text,
    timestamp: item.timestamp,
    ...(item.model === undefined ? {} : { model: item.model }),
    technical: technicalDetails(sessionRef, index, item),
  };
}

function detailSummary(detail: HistorySessionDetail): ChatSummaryDto {
  const firstMessage = detail.conversation.find((item) => item.kind === "message");
  return chatSummary(detail, firstMessage?.kind === "message" ? firstMessage.text : undefined);
}

function technicalSearchText(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

function searchableConversationValue(item: ConversationItem): string {
  if (item.kind === "gap") return [item.label, item.code ?? ""].filter(Boolean).join("\n");
  return [
    item.text,
    item.model ?? "",
    ...(item.contentKinds ?? []),
    ...(item.portableNotes ?? []),
    ...(item.portableBlocks ?? []).map(technicalSearchText),
  ].filter(Boolean).join("\n");
}

function matchingSnippet(value: string, query: string): string {
  const folded = value.toLocaleLowerCase();
  const index = folded.indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, index - SEARCH_CONTEXT_CHARACTERS);
  const end = Math.min(value.length, index + query.length + SEARCH_CONTEXT_CHARACTERS);
  return `${start === 0 ? "" : "..."}${value.slice(start, end)}${end === value.length ? "" : "..."}`;
}

function inspectionDto(inspection: HistorySourceInspection): AgentStatusDto {
  return {
    agent: inspection.agent,
    label: agentLabel(inspection.agent),
    status: inspection.status,
    locations: inspection.locations.map((location) => ({ role: location.role, path: location.path })),
    findings: [...inspection.findings],
    ...(inspection.detail === undefined ? {} : { detail: inspection.detail }),
  };
}

function agentSettingDto(
  inspection: AgentSettingsInspection,
  source: HistorySourceInspection | undefined,
): AgentSettingDto {
  const resolvedPath = (
    configured: AgentSettingsInspection["history"],
    role: "history_root" | "data_root" | "config_root" | "native_state_root" | "database",
  ): AgentSettingDto["history"] => {
    if (configured.configured) return { ...configured };
    const location = source?.locations.find((item) => item.role === role);
    return {
      configured: false,
      ...(location === undefined ? {} : { path: location.path }),
      available: source?.status === "ready" && location !== undefined,
      expected: configured.expected,
    };
  };
  const historyRole = inspection.agent === "opencode"
    ? "data_root" as const
    : inspection.agent === "claude" ? "config_root" as const : "history_root" as const;
  const databaseRole = inspection.agent === "codex" ? "native_state_root" as const : "database" as const;
  return {
    agent: inspection.agent,
    label: agentLabel(inspection.agent),
    history: resolvedPath(inspection.history, historyRole),
    ...(inspection.database === undefined
      ? {}
      : { database: resolvedPath(inspection.database, databaseRole) }),
    executable: { ...inspection.executable },
  };
}

function transactionSummaryDto(summary: DesktopTransactionSummary): TransactionSummaryDto {
  return {
    transactionRef: summary.transactionRef,
    operation: summary.operation,
    agents: [...summary.agents],
    state: summary.state,
    phase: summary.phase,
    direction: summary.direction,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    items: summary.items,
    ...(summary.failure === undefined ? {} : { failure: summary.failure }),
  };
}

function transactionPlanDto(plan: DesktopTransactionPlan): TransactionPlanDto {
  return {
    planRef: plan.planRef,
    summary: transactionSummaryDto(plan.summary),
    action: plan.action,
    ready: plan.ready,
    findings: plan.findings.map((finding) => ({
      sessionRef: finding.sessionRef,
      row: finding.row,
      ...(finding.section === undefined ? {} : { section: finding.section }),
      ...(finding.file === undefined ? {} : { file: finding.file }),
      ...(finding.resources === undefined ? {} : { resources: finding.resources }),
      ...(finding.goal === undefined ? {} : { goal: finding.goal }),
    })),
  };
}

function experienceConfigurationDto(
  value: DesktopExperienceConfigurationInspection,
): ExperienceConfigurationDto {
  if (value.status !== "configured") {
    return {
      status: value.status,
      configFile: value.configFile,
      error: { ...value.error },
    };
  }
  const profile = (item: typeof value.fast) => ({
    ...(item.contextWindow === undefined ? {} : { contextWindow: item.contextWindow }),
    tier: item.tier,
    backend: item.backend,
    model: item.model,
    modelConfigured: item.modelConfigured,
    endpoint: { ...item.endpoint },
  });
  return {
    status: "configured",
    configFile: value.configFile,
    backend: value.backend,
    deepBinding: value.deepBinding,
    fast: profile(value.fast),
    deep: profile(value.deep),
  };
}

function experienceConfigurationCheckDto(
  value: DesktopExperienceConfigurationCheck,
): ExperienceConfigurationCheckDto {
  if (value.status !== "checked") {
    return {
      status: value.status,
      configFile: value.configFile,
      historySent: false,
      requests: 0,
      error: { ...value.error },
      ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
    };
  }
  return {
    status: "checked",
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
    configFile: value.configFile,
    historySent: false,
    requests: value.requests,
    profiles: value.profiles.map((item) => ({
      tier: item.tier,
      backend: item.backend,
      model: item.model,
      modelConfigured: item.modelConfigured,
      endpoint: { ...item.endpoint },
      binding: item.binding,
      requestMade: item.requestMade,
      usage: { ...item.usage },
    })),
  };
}

export function createDesktopService(options: DesktopServiceOptions): DesktopService {
  if (typeof options.stateDirectory !== "string" || options.stateDirectory.trim() === "" ||
    options.stateDirectory.includes("\0")) {
    throw new Error("Desktop state directory is invalid");
  }
  if (typeof options.version !== "string" || options.version.trim() === "" ||
    Buffer.byteLength(options.version, "utf8") > 256) {
    throw new Error("Desktop version is invalid");
  }
  const stateDirectory = path.resolve(options.stateDirectory);
  const version = options.version;
  const baseSourceOptions = cloneSourceOptions(options.sourceOptions);
  let effectiveSourceOptions = baseSourceOptions;
  const application: DesktopApplicationDependencies = { ...DEFAULT_APPLICATION, ...options.application };
  const historyIndex: DesktopHistoryIndexDependencies = { ...DEFAULT_HISTORY_INDEX, ...options.historyIndex };
  const resumeDependencies: DesktopResumeDependencies = { ...DEFAULT_RESUME, ...options.resume };
  const processDependencies: DesktopProcessDependencies = { ...DEFAULT_PROCESS, ...options.process };
  const platformDependencies: DesktopPlatformDependencies = { ...DEFAULT_PLATFORM, ...options.platform };
  const selectImportWorkspaceDirectory = options.chooseImportWorkspaceDirectory ?? chooseImportWorkspaceDirectory;
  const agentSettingsDependencies: DesktopAgentSettingsDependencies = {
    ...DEFAULT_AGENT_SETTINGS,
    ...options.agentSettings,
  };
  const transactionDependencies = options.transactionDependencies;
  const transactionFacade: DesktopTransactionFacade = {
    listDesktopTransactions: (selectedStateDirectory) => listDesktopTransactions(
      { stateDirectory: selectedStateDirectory },
      transactionDependencies,
    ),
    planDesktopTransaction: (selectedStateDirectory, request) => planDesktopTransaction({
      stateDirectory: selectedStateDirectory,
      transactionRef: request.transactionRef,
      action: request.action,
    }, transactionDependencies),
    confirmDesktopTransaction: (selectedStateDirectory, request) => confirmDesktopTransaction({
      stateDirectory: selectedStateDirectory,
      transactionRef: request.transactionRef,
      action: request.action,
      expectedPlanRef: request.expectedPlanRef,
    }, transactionDependencies),
    ...options.transactions,
  };
  const experienceSettingsFacade: DesktopExperienceSettingsFacade = {
    inspectExperienceConfig: async (selectedStateDirectory, environment) =>
      inspectDesktopExperienceConfiguration({ stateDirectory: selectedStateDirectory, environment, getAnalysisConfiguration: selectedExperienceConfiguration }),
    checkExperienceConfig: async (selectedStateDirectory, environment) =>
      checkDesktopExperienceConfiguration({ stateDirectory: selectedStateDirectory, environment, getAnalysisConfiguration: selectedExperienceConfiguration }),
    configurationDirectory: experienceConfigurationDirectory,
    ...options.experienceSettings,
  };
  const injectedTransferService = options.transfer;
  let transferService = injectedTransferService;
  const experienceService = options.experience ?? (() => {
    const runtime = sharedResumeRuntimeContext(baseSourceOptions);
    return createDesktopExperienceService({
      getAnalysisConfiguration: () => selectedExperienceConfiguration(),
      stateDirectory,
      environment: { ...(runtime.environment ?? process.env) },
      chooseOutputParent: chooseExperienceOutputParent,
      chooseReviewPath: chooseExperienceReview,
      openPath: openExperienceDirectory,
    });
  })();
  const settingsPath = path.join(stateDirectory, "desktop", "settings.json");
  let settingsWriteTail: Promise<void> = Promise.resolve();
  let indexSyncInFlight: Promise<void> | undefined;
  const refreshListeners = new Set<(progress: ScanProgressDto) => void>();
  let refreshInFlight: Promise<DesktopResult<RefreshResultDto>> | undefined;
  let refreshGeneration = 0;
  let lastRefreshResult: DesktopResult<RefreshResultDto> | undefined;
  let stateOperationTail: Promise<void> = Promise.resolve();
  let acceptingStateOperations = true;
  let disposed = false;
  let disposeInFlight: Promise<void> | undefined;
  let agentPathSettings: DesktopAgentPathSettings | undefined;
  let agentSettingsLoadInFlight: Promise<void> | undefined;
  let agentSettingsMutationTail: Promise<void> = Promise.resolve();
  let experienceModelOperation: "run" | "check" | undefined;

  const emitProgress = (progress: ScanProgressDto): void => {
    for (const listener of refreshListeners) {
      try { listener(progress); } catch { /* presentation listeners cannot interrupt native scanning */ }
    }
  };

  const requireServiceOpen = (): void => {
    if (!acceptingStateOperations) throw new Error("Desktop service is closing");
  };

  const withStateOperation = <T>(action: () => Promise<T>): Promise<T> => {
    requireServiceOpen();
    const operation = stateOperationTail.then(action);
    // Keep the queue fulfilled so a failed operation cannot poison later work.
    stateOperationTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const withExperienceModelOperation = async <T>(
    operation: "run" | "check",
    action: () => Promise<T>,
  ): Promise<T> => {
    if (experienceModelOperation !== undefined) {
      throw new Error("another Desktop Experience model operation is running");
    }
    experienceModelOperation = operation;
    try {
      return await action();
    } finally {
      experienceModelOperation = undefined;
    }
  };

  const installAgentPathSettings = (settings: DesktopAgentPathSettings): void => {
    agentPathSettings = settings;
    effectiveSourceOptions = cloneSourceOptions(
      agentSettingsDependencies.applyAgentSettingsToSourceOptions(baseSourceOptions, settings),
    );
  };

  const ensureAgentSettingsLoaded = async (): Promise<DesktopAgentPathSettings> => {
    if (agentPathSettings !== undefined) return agentPathSettings;
    if (agentSettingsLoadInFlight === undefined) {
      agentSettingsLoadInFlight = agentSettingsDependencies.loadDesktopAgentPathSettings(stateDirectory)
        .then(installAgentPathSettings)
        .finally(() => { agentSettingsLoadInFlight = undefined; });
    }
    await agentSettingsLoadInFlight;
    return agentPathSettings!;
  };

  const serializeAgentSettingsMutation = async <T>(action: () => Promise<T>): Promise<T> => {
    const operation = agentSettingsMutationTail.then(action, action);
    agentSettingsMutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const createProductionTransferService = (): DesktopTransferService => {
    const runtime = sharedResumeRuntimeContext(effectiveSourceOptions);
    return agentSettingsDependencies.createTransferService({
      stateDirectory,
      ...(runtime.cwd === undefined ? {} : { cwd: runtime.cwd }),
      importOptions: transferImportOptions(effectiveSourceOptions),
      chooseOpenFile: chooseImportArchive,
      chooseSaveFile: chooseExportArchive,
    });
  };

  const currentTransferService = async (): Promise<DesktopTransferService> => {
    await ensureAgentSettingsLoaded();
    if (transferService === undefined) transferService = createProductionTransferService();
    return transferService;
  };

  const rebuildProductionTransferService = async (): Promise<void> => {
    if (injectedTransferService !== undefined) return;
    const previous = transferService;
    if (previous !== undefined) {
      // Retain a failed, closed service so dispose() can retry any private
      // workspace cleanup instead of losing its handle registry.
      await previous.dispose();
      transferService = undefined;
    }
    transferService = createProductionTransferService();
  };

  const agentSettingsEnvironment = (): NodeJS.ProcessEnv => {
    const runtime = sharedResumeRuntimeContext(effectiveSourceOptions);
    return { ...(runtime.environment ?? process.env) };
  };
  const terminalSettingsService = createDesktopTerminalSettingsService({
    stateDirectory,
    environment: agentSettingsEnvironment(),
    chooseExecutable: options.chooseTerminalExecutable ?? chooseConfiguredTerminalExecutable,
  });

  const selectedExperienceConfiguration = async () => {
    await settingsWriteTail;
    const settings = await readSettingsValue();
    const paths = await ensureAgentSettingsLoaded();
    const environment = agentSettingsEnvironment();
    const inspected = await agentSettingsDependencies.inspectAgentSettings(paths, environment);
    const agent = settings.experienceAgent ?? inspected.find((item) => item.executable.available)?.agent ?? "codex";
    if (effectiveSourceOptions.codex?.codexHome !== undefined) environment.CODEX_HOME = effectiveSourceOptions.codex.codexHome;
    if (effectiveSourceOptions.claude?.configRoot !== undefined) environment.CLAUDE_CONFIG_DIR = effectiveSourceOptions.claude.configRoot;
    return resolveAgentApiAnalysisConfiguration(agent, {
      home: sharedResumeRuntimeContext(effectiveSourceOptions).home ?? os.homedir(), environment,
      ...(effectiveSourceOptions.codex?.profile === undefined ? {} : { profile: effectiveSourceOptions.codex.profile }),
    });
  };

  const inspectedAgentSettings = async (
    sources?: readonly HistorySourceInspection[],
  ): Promise<readonly AgentSettingDto[]> => {
    const settings = await ensureAgentSettingsLoaded();
    const inspected = await agentSettingsDependencies.inspectAgentSettings(
      settings,
      agentSettingsEnvironment(),
    );
    const resolvedSources = sources ?? await detectSourceInspections();
    const byAgent = new Map(resolvedSources.map((source) => [source.agent, source]));
    return inspected.map((item) => agentSettingDto(item, byAgent.get(item.agent)));
  };

  const pickedAgentPath = async (
    agent: Agent,
    kind: AgentPathKind,
  ): Promise<string | undefined> => {
    const selected = await agentSettingsDependencies.choosePath(agent, kind);
    if (selected === undefined) return undefined;
    if (
      typeof selected !== "string" || selected === "" || !path.isAbsolute(selected) ||
      /[\u0000-\u001f\u007f]/u.test(selected) || Buffer.byteLength(selected, "utf8") > 64 * 1024
    ) throw new Error("system Agent path picker returned an invalid path");
    const normalized = path.normalize(selected);
    const info = await agentSettingsDependencies.lstat(normalized);
    const directoryExpected = kind === "history" || kind === "database" && agent === "codex";
    if (info.isSymbolicLink() || (directoryExpected ? !info.isDirectory() : !info.isFile())) {
      throw new Error("system Agent path picker returned an unsupported path");
    }
    if (kind === "database" && agent === "opencode" && !/\.(?:db|sqlite)$/iu.test(normalized)) {
      throw new Error("system Agent database picker returned an unsupported file");
    }
    if (kind === "executable" && !/\.(?:exe|cmd|bat|com)$/iu.test(normalized)) {
      throw new Error("system Agent executable picker returned an unsupported file");
    }
    return normalized;
  };

  const settingWithPath = (
    current: DesktopAgentPathSettings,
    agent: Agent,
    kind: AgentPathKind,
    selected: string,
  ): DesktopAgentPathSetting => {
    const existing = current.agents[agent] ?? {};
    if (kind === "history") return { ...existing, historyRoot: selected };
    if (kind === "database") return { ...existing, databasePath: selected };
    return { ...existing, executablePath: selected };
  };

  const settingWithoutPath = (
    current: DesktopAgentPathSettings,
    agent: Agent,
    kind: AgentPathKind,
  ): DesktopAgentPathSetting => {
    const existing = current.agents[agent] ?? {};
    if (kind === "history") {
      const { historyRoot: _removed, ...remaining } = existing;
      return remaining;
    }
    if (kind === "database") {
      const { databasePath: _removed, ...remaining } = existing;
      return remaining;
    }
    const { executablePath: _removed, ...remaining } = existing;
    return remaining;
  };

  const requireConfiguredExecutablePath = async (
    settings: DesktopAgentPathSettings,
    agent: Agent,
    selected: string,
  ): Promise<void> => {
    const resolved = await agentSettingsDependencies.resolveConfiguredAgentExecutable(
      agent,
      settings,
      agentSettingsEnvironment(),
    );
    if (resolved === undefined || !samePath(resolved, selected, pathFlavorForPlatform())) {
      throw new Error("configured Agent executable did not resolve to the selected trusted file");
    }
  };

  const requestForAgent = (agent: Agent): HistorySourceOptions => ({
    ...effectiveSourceOptions,
    agents: [agent],
  });

  const resumeOptionsFor = (request: ResumePlanRequest): PlanConversationResumeOptions => {
    const runtime = sharedResumeRuntimeContext(effectiveSourceOptions);
    return {
      stateDirectory,
      sessionRef: request.sessionRef,
      targetAgent: request.targetAgent,
      ...(request.allowLossyConversion === undefined
        ? {}
        : { allowLossyConversion: request.allowLossyConversion }),
      ...(request.pathMappings === undefined ? {} : { pathMappings: [...request.pathMappings] }),
      ...(effectiveSourceOptions.codex?.codexHome === undefined
        ? {}
        : { codexHome: effectiveSourceOptions.codex.codexHome }),
      ...(effectiveSourceOptions.codex?.sqliteHome === undefined
        ? {}
        : { sqliteHome: effectiveSourceOptions.codex.sqliteHome }),
      ...(effectiveSourceOptions.codex?.profile === undefined
        ? {}
        : { profile: effectiveSourceOptions.codex.profile }),
      ...(effectiveSourceOptions.opencode?.dataRoot === undefined
        ? {}
        : { opencodeDataRoot: effectiveSourceOptions.opencode.dataRoot }),
      ...(effectiveSourceOptions.opencode?.databasePath === undefined
        ? {}
        : { opencodeDatabase: effectiveSourceOptions.opencode.databasePath }),
      ...(effectiveSourceOptions.claude?.configRoot === undefined
        ? {}
        : { claudeConfigRoot: effectiveSourceOptions.claude.configRoot }),
      ...(effectiveSourceOptions.pi?.sessionRoot === undefined
        ? {}
        : { piSessionRoot: effectiveSourceOptions.pi.sessionRoot }),
      ...(runtime.environment === undefined ? {} : { environment: { ...runtime.environment } }),
      ...(runtime.cwd === undefined ? {} : { cwd: runtime.cwd }),
      ...(runtime.home === undefined ? {} : { home: runtime.home }),
    };
  };

  const detachedOptionsFor = async (
    targetAgent: Agent,
    requireTerminal = true,
  ): Promise<DetachedAgentProcessOptions> => {
    const runtime = sharedResumeRuntimeContext(effectiveSourceOptions);
    const terminal = requireTerminal
      ? await terminalSettingsService.resolveLaunchConfiguration()
      : undefined;
    const base: DetachedAgentProcessOptions = {
      ...(runtime.environment === undefined ? {} : { environment: { ...runtime.environment } }),
      ...(processDependencies.options ?? {}),
      ...(terminal === undefined ? {} : { terminal }),
    };
    const settings = await ensureAgentSettingsLoaded();
    if (settings.agents[targetAgent]?.executablePath === undefined) return base;
    const executable = await agentSettingsDependencies.resolveConfiguredAgentExecutable(
      targetAgent,
      settings,
      base.environment ?? process.env,
    );
    if (executable === undefined) throw new Error("configured Agent executable is unavailable");
    return {
      ...base,
      async resolveExecutable() { return executable; },
    };
  };

  const resumePlanDto = async (
    plan: ConversationResumePlan,
    processOptions: DetachedAgentProcessOptions,
    knownAvailable?: boolean,
  ): Promise<ResumePlanDto> => {
    let targetAvailable = knownAvailable ?? false;
    if (knownAvailable === undefined) {
      try {
        const launch = await resumeDependencies.prepareResumeLaunch({
          agent: plan.targetAgent,
          nativeId: plan.targetNativeId ?? plan.source.nativeId,
          cwd: plan.workspace.target,
        });
        await processDependencies.prepareDetachedAgentLaunch(launch, processOptions);
        targetAvailable = true;
      } catch {
        // Availability is advisory. A missing CLI or workspace must not hide a
        // useful conversion plan or its findings.
      }
    }
    return {
      planRef: plan.planRef,
      source: resumeChatSummary(plan.source),
      targetAgent: plan.targetAgent,
      targetAvailable,
      route: plan.route,
      quality: plan.quality,
      findings: plan.findings.map((finding) => ({ ...finding })),
      sourceWorkspace: plan.workspace.source,
      targetWorkspace: plan.workspace.target,
      workspaceStatus: plan.workspace.status,
      needsWrite: plan.needsWrite,
    };
  };

  const ensureSettingsDirectory = async (): Promise<void> => {
    await ensurePrivateStateDirectory(stateDirectory);
    const directory = path.dirname(settingsPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await applyPosixMode(directory, 0o700);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() ||
      process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error("Desktop settings directory is not private");
    }
  };

  const requireSafeSettingsTarget = async (): Promise<void> => {
    try {
      const info = await lstat(settingsPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Desktop settings target is unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  const synchronizeHistoryIndex = async (afterActive = false): Promise<void> => {
    if (afterActive) {
      const previous = indexSyncInFlight;
      const operation = (previous ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => historyIndex.syncDesktopHistoryIndex(stateDirectory))
        .then(() => undefined);
      const tracked = operation.finally(() => {
        if (indexSyncInFlight === tracked) indexSyncInFlight = undefined;
      });
      indexSyncInFlight = tracked;
      await tracked;
      return;
    }
    if (indexSyncInFlight === undefined) {
      const operation = historyIndex.syncDesktopHistoryIndex(stateDirectory).then(() => undefined);
      const tracked = operation.finally(() => {
        if (indexSyncInFlight === tracked) indexSyncInFlight = undefined;
      });
      indexSyncInFlight = tracked;
    }
    await indexSyncInFlight;
  };

  const readSettingsValue = async (): Promise<DesktopSettings> => {
    await ensureSettingsDirectory();
    let bytes: Buffer;
    try {
      bytes = await readStableSmallFile(settingsPath, SETTINGS_BYTES_LIMIT);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return cloneSettings(DEFAULT_DESKTOP_SETTINGS);
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("stored Desktop settings are invalid JSON"); }
    // Settings written by desktop v1 predate the opt-in auto-refresh flag.
    // Treat them as disabled instead of rejecting an otherwise valid profile.
    const migrated = typeof parsed === "object" && parsed !== null && !("autoRefresh" in parsed)
      ? { ...parsed, autoRefresh: false }
      : parsed;
    return validateDesktopSettings(migrated);
  };

  const writeSettingsValue = async (settings: DesktopSettings): Promise<DesktopSettings> => {
    const validated = validateDesktopSettings(settings);
    const operation = settingsWriteTail.then(async () => {
      await ensureSettingsDirectory();
      await requireSafeSettingsTarget();
      await writeJsonAtomic(settingsPath, validated);
    });
    settingsWriteTail = operation.then(() => undefined, () => undefined);
    await operation;
    return cloneSettings(validated);
  };

  const detectSourceInspections = async (): Promise<HistorySourceInspection[]> => {
    await ensureAgentSettingsLoaded();
    const inspections: HistorySourceInspection[] = [];
    for (const agent of AGENTS) {
      try {
        const result = await application.detectHistorySources(requestForAgent(agent));
        const inspection = result.agents.find((item) => item.agent === agent);
        if (inspection === undefined) throw new Error("Agent source inspection omitted its result");
        inspections.push(inspection);
      } catch {
        inspections.push({
          agent,
          status: "error",
          locations: [],
          findings: ["history.doctor.inspect_failed"],
          detail: "Source inspection failed.",
        });
      }
    }
    return inspections;
  };

  const collectAgentChats = async (
    agent: Agent,
    query: string | undefined,
    libraryState: NonNullable<ListChatsRequest["libraryState"]>,
  ): Promise<CollectedChat[]> => {
    const result: CollectedChat[] = [];
    let offset = 0;
    while (true) {
      try {
        if (query === undefined) {
          const page = await application.listHistory({
            stateDirectory,
            agents: [agent],
            view: libraryState,
            offset,
            limit: MAX_HISTORY_LIMIT,
          });
          result.push(...page.sessions.map((session) => ({ session })));
          if (page.nextOffset === undefined) break;
          if (page.nextOffset <= offset) throw new Error("history pagination did not advance");
          offset = page.nextOffset;
        } else {
          const page = await application.searchHistory({
            stateDirectory,
            agents: [agent],
            view: libraryState,
            offset,
            limit: MAX_HISTORY_LIMIT,
          }, query);
          result.push(...page.hits.map((hit) => ({ session: hit.session, preview: hit.snippet })));
          if (page.nextOffset === undefined) break;
          if (page.nextOffset <= offset) throw new Error("history pagination did not advance");
          offset = page.nextOffset;
        }
      } catch (error) {
        if (missingSnapshot(error, agent)) return [];
        throw error;
      }
    }
    return result;
  };

  const listChatsFromApplication = async (request: ListChatsRequest): Promise<ChatPageDto> => {
    const libraryState = request.libraryState ?? "active";
    const selectedAgents = request.agents === undefined
      ? AGENTS
      : AGENTS.filter((agent) => request.agents!.includes(agent));
    const collected = (await Promise.all(selectedAgents.map((agent) =>
      collectAgentChats(agent, request.query, libraryState)))).flat();
    const filtered = request.workspace === undefined
      ? collected
      : collected.filter((item) => {
          const parent = workspacePath(request.workspace!);
          const child = workspacePath(item.session.context);
          const prefix = parent.key.endsWith(parent.separator) ? parent.key : `${parent.key}${parent.separator}`;
          return child.key === parent.key || (request.workspaceDescendants === true && child.key.startsWith(prefix));
        });
    const unique = new Map<string, CollectedChat>();
    for (const item of filtered) unique.set(item.session.sessionRef, item);
    const ordered = [...unique.values()].sort(compareChats);
    const offset = request.offset ?? 0;
    const limit = request.limit ?? DEFAULT_HISTORY_LIMIT;
    const items = ordered.slice(offset, offset + limit);
    return {
      ...pageMetadata(ordered.length, offset, limit, items.length),
      chats: items.map((item) => chatSummary(item.session, item.preview)),
    };
  };

  const getConversationFromApplication = async (request: ConversationRequest): Promise<ConversationPageDto> => {
    const detail = await application.showHistory(stateDirectory, request.sessionRef);
    const offset = request.offset ?? 0;
    const limit = request.limit ?? DEFAULT_DESKTOP_CONVERSATION_LIMIT;
    const page = detail.conversation.slice(offset, offset + limit);
    return {
      chat: detailSummary(detail),
      model: detail.model,
      provider: detail.provider,
      ...pageMetadata(detail.conversation.length, offset, limit, page.length),
      items: page.map((item, pageIndex) => conversationItemDto(
        detail.sessionRef,
        item,
        offset + pageIndex,
      )),
    };
  };

  const findInConversationFromApplication = async (
    request: ConversationFindRequest,
  ): Promise<ConversationFindResult> => {
    const detail = await application.showHistory(stateDirectory, request.sessionRef);
    const foldedQuery = request.query.toLocaleLowerCase();
    const matches = detail.conversation.flatMap((item, index) => {
      const value = searchableConversationValue(item);
      return value.toLocaleLowerCase().includes(foldedQuery)
        ? [{ index, snippet: matchingSnippet(value, request.query) }]
        : [];
    });
    return { query: request.query, matches };
  };

  const listChatsValue = async (rawRequest: unknown): Promise<ChatPageDto> => {
    const request = validateListChatsRequest(rawRequest);
    try {
      await synchronizeHistoryIndex();
      const page = await historyIndex.listDesktopHistoryIndex({
        stateDirectory,
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.agents === undefined ? {} : { agents: request.agents }),
        ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
        ...(request.workspaceDescendants === undefined ? {} : { workspaceDescendants: request.workspaceDescendants }),
        libraryStates: [request.libraryState ?? "active"],
        ...(request.offset === undefined ? {} : { offset: request.offset }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      });
      return {
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        returned: page.returned,
        remaining: page.remaining,
        ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
        chats: page.sessions.map(indexedChatSummary),
      };
    } catch {
      return listChatsFromApplication(request);
    }
  };

  const getConversationValue = async (rawRequest: unknown): Promise<ConversationPageDto> => {
    const request = validateConversationRequest(rawRequest);
    try {
      await synchronizeHistoryIndex();
      const chunk = await historyIndex.getDesktopConversationChunk({
        stateDirectory,
        sessionRef: request.sessionRef,
        ...(request.offset === undefined ? {} : { offset: request.offset }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      });
      return {
        chat: indexedChatSummary(chunk.session),
        model: chunk.session.model,
        provider: chunk.session.provider,
        total: chunk.total,
        offset: chunk.offset,
        limit: chunk.limit,
        returned: chunk.returned,
        remaining: chunk.remaining,
        ...(chunk.nextOffset === undefined ? {} : { nextOffset: chunk.nextOffset }),
        items: chunk.items.map((item) => conversationItemDto(
          chunk.session.sessionRef,
          item.item,
          item.ordinal,
        )),
      };
    } catch {
      return getConversationFromApplication(request);
    }
  };

  const findInConversationValue = async (rawRequest: unknown): Promise<ConversationFindResult> => {
    const request = validateConversationFindRequest(rawRequest);
    try {
      await synchronizeHistoryIndex();
      const found = await historyIndex.findInDesktopConversation({
        stateDirectory,
        sessionRef: request.sessionRef,
        query: request.query,
        limit: 1_000,
      });
      return {
        query: found.query,
        matches: found.matches.map((match) => ({ index: match.ordinal, snippet: match.snippet })),
      };
    } catch {
      return findInConversationFromApplication(request);
    }
  };

  const getTechnicalDetailValue = async (rawRequest: unknown): Promise<TechnicalDetailChunkDto> => {
    const request = validateTechnicalDetailRequest(rawRequest);
    let message: Extract<ConversationItem, { readonly kind: "message" }>;
    try {
      await synchronizeHistoryIndex();
      const chunk = await historyIndex.getDesktopConversationChunk({
        stateDirectory,
        sessionRef: request.sessionRef,
        offset: request.itemIndex,
        limit: 1,
      });
      const indexed = chunk.items[0];
      if (chunk.returned !== 1 || indexed === undefined || indexed.ordinal !== request.itemIndex ||
        indexed.item.kind !== "message") {
        throw new Error("indexed technical detail item is unavailable");
      }
      message = indexed.item;
    } catch {
      const detail = await application.showHistory(stateDirectory, request.sessionRef);
      const item = detail.conversation[request.itemIndex];
      if (item === undefined || item.kind !== "message") {
        throw new Error("technical detail conversation item is not a message");
      }
      message = item;
    }
    return getTechnicalDetailChunk(
      request.sessionRef,
      request.itemIndex,
      message,
      request.detailIndex,
      request.offset ?? 0,
      request.limit ?? 64 * 1024,
    );
  };

  const performRefreshUngated = async (): Promise<DesktopResult<RefreshResultDto>> => {
    try {
      await ensureAgentSettingsLoaded();
    } catch (error) {
      return desktopFailure(error, "agent_settings_unavailable", true);
    }
    emitProgress({ phase: "detecting" });
    const results: RefreshAgentResultDto[] = [];
    for (const [index, agent] of AGENTS.entries()) {
      emitProgress({ phase: "scanning", agent, currentAgent: index + 1, totalAgents: AGENTS.length });
      let inspection: HistorySourceInspection;
      try {
        const detected = await application.detectHistorySources(requestForAgent(agent));
        const found = detected.agents.find((item) => item.agent === agent);
        if (found === undefined) throw new Error("Agent source inspection omitted its result");
        inspection = found;
      } catch (error) {
        results.push({
          agent,
          status: "failed",
          sessions: 0,
          reusedSessions: 0,
          rebuiltSessions: 0,
          removedSessions: 0,
          warnings: [],
          error: redactedDesktopError(error, "refresh_failed", true),
        });
        continue;
      }
      if (inspection.status === "not_detected") {
        results.push({
          agent,
          status: "not_detected",
          sessions: 0,
          reusedSessions: 0,
          rebuiltSessions: 0,
          removedSessions: 0,
          warnings: [...inspection.findings],
        });
        continue;
      }
      if (inspection.status !== "ready") {
        results.push({
          agent,
          status: "failed",
          sessions: 0,
          reusedSessions: 0,
          rebuiltSessions: 0,
          removedSessions: 0,
          warnings: [...inspection.findings],
          error: redactedDesktopError(undefined, "source_unavailable", true),
        });
        continue;
      }
      try {
        const scanned = await application.scanHistory({
          ...requestForAgent(agent),
          stateDirectory,
        });
        if (scanned.status === "not_detected") {
          results.push({
            agent,
            status: "not_detected",
            sessions: 0,
            reusedSessions: 0,
            rebuiltSessions: 0,
            removedSessions: 0,
            warnings: [...scanned.warnings],
          });
          continue;
        }
        const item = scanned.agents.find((candidate) => candidate.agent === agent);
        if (item === undefined) throw new Error("Agent scan omitted its result");
        results.push({
          agent,
          status: "scanned",
          sessions: item.sessions,
          reusedSessions: item.reusedSessions,
          rebuiltSessions: item.rebuiltSessions,
          removedSessions: item.removedSessions,
          warnings: [...item.warnings],
        });
      } catch (error) {
        results.push({
          agent,
          status: "failed",
          sessions: 0,
          reusedSessions: 0,
          rebuiltSessions: 0,
          removedSessions: 0,
          warnings: [],
          error: redactedDesktopError(error, "refresh_failed", true),
        });
      }
    }
    try { await synchronizeHistoryIndex(true); } catch { /* application fallback remains available */ }
    const result: RefreshResultDto = {
      agents: results,
      sessions: results.reduce((total, item) => total + item.sessions, 0),
      partial: results.some((item) => item.status === "failed"),
    };
    emitProgress({ phase: "complete", result });
    return desktopSuccess(result);
  };

  const performRefreshInsideStateOperation = async (): Promise<DesktopResult<RefreshResultDto>> => {
    const result = await performRefreshUngated();
    refreshGeneration++;
    lastRefreshResult = result;
    return result;
  };

  const refreshHistory = async (
    onProgress?: (progress: ScanProgressDto) => void,
  ): Promise<DesktopResult<RefreshResultDto>> => {
    if (onProgress !== undefined) refreshListeners.add(onProgress);
    try {
      let activeRefresh = refreshInFlight;
      if (activeRefresh === undefined) {
        const targetGeneration = refreshGeneration + 1;
        const operation = withStateOperation(async () => {
          if (refreshGeneration >= targetGeneration && lastRefreshResult !== undefined) {
            return lastRefreshResult;
          }
          return performRefreshInsideStateOperation();
        }).catch((error: unknown): DesktopResult<RefreshResultDto> =>
          desktopFailure<RefreshResultDto>(error, "refresh_failed", true));
        const tracked = operation.finally(() => {
          if (refreshInFlight === tracked) refreshInFlight = undefined;
        });
        refreshInFlight = tracked;
        activeRefresh = tracked;
      }
      return await activeRefresh;
    } catch (error) {
      return desktopFailure(error, "refresh_failed", true);
    } finally {
      if (onProgress !== undefined) refreshListeners.delete(onProgress);
    }
  };

  const service: DesktopService = {
    async listCodexProviders() {
      try {
        return await withStateOperation(async () => {
          await ensureAgentSettingsLoaded();
          const result = options.providers?.list === undefined
            ? await listCodexImportProviders(effectiveSourceOptions.codex ?? {})
            : await options.providers.list({ stateDirectory, ...effectiveSourceOptions.codex });
          return desktopSuccess({ currentProvider: result.currentProvider, totalSessions: result.totalSessions,
            providers: result.providers.map((item) => ({ ...item })) });
        });
      } catch (error) { return desktopFailure(error, "provider_list_failed", true); }
    },
    async previewCodexProviderUnify(request) {
      try {
        const validated = validateCodexProviderUnifyRequest(request);
        return await withStateOperation(async () => {
          await ensureAgentSettingsLoaded();
          const result = await (options.providers?.unify ?? unifyCodexHistoryProviders)({ stateDirectory, ...effectiveSourceOptions.codex }, validated.targetProvider, false);
          return desktopSuccess(codexProviderPlanDto(result));
        });
      } catch (error) { return desktopFailure(error, "provider_preview_failed", true); }
    },
    async confirmCodexProviderUnify(request) {
      try {
        const validated = validateConfirmCodexProviderUnifyRequest(request);
        return await withStateOperation(async () => {
          await ensureAgentSettingsLoaded();
          const result = await (options.providers?.unify ?? unifyCodexHistoryProviders)({ stateDirectory, ...effectiveSourceOptions.codex }, validated.targetProvider, true, validated.expectedPlanRef);
          const plan = codexProviderPlanDto(result);
          if (result.replanRequired) return desktopSuccess({ status: "replan_required" as const, plan });
          try { await synchronizeHistoryIndex(true); } catch { /* native transaction is committed; the derived index can be rebuilt */ }
          return desktopSuccess({ status: "completed" as const, plan,
            ...(result.transactionRef === undefined ? {} : { transactionRef: result.transactionRef }) });
        });
      } catch (error) { return desktopFailure(error, "provider_unify_failed", true); }
    },
    async bootstrap() {
      try {
        return await withStateOperation(async () => {
          const settings = await readSettingsValue();
          await ensureAgentSettingsLoaded();
          try { await synchronizeHistoryIndex(); } catch { /* fall back to application history below */ }
          const sources = await detectSourceInspections();
          const [agentSettings, chats] = await Promise.all([
            inspectedAgentSettings(sources),
            listChatsValue(settings.agentFilter === "all" ? {} : { agents: [settings.agentFilter] }),
          ]);
          const agents = sources.map(inspectionDto);
          return desktopSuccess({ version, stateDirectory, settings, agents, agentSettings, chats });
        });
      } catch (error) {
        return desktopFailure(error, "bootstrap_failed", true);
      }
    },

    async listChats(request) {
      try {
        requireServiceOpen();
        return desktopSuccess(await listChatsValue(request));
      } catch (error) {
        return desktopFailure(error, "history_unavailable", true);
      }
    },

    async getConversation(request) {
      try {
        requireServiceOpen();
        return desktopSuccess(await getConversationValue(request));
      } catch (error) {
        return desktopFailure(error, "conversation_unavailable", true);
      }
    },

    async getTechnicalDetail(request) {
      try {
        requireServiceOpen();
        return desktopSuccess(await getTechnicalDetailValue(request));
      } catch (error) {
        return desktopFailure(error, "technical_detail_unavailable", true);
      }
    },

    async findInConversation(request) {
      try {
        requireServiceOpen();
        return desktopSuccess(await findInConversationValue(request));
      } catch (error) {
        return desktopFailure(error, "conversation_unavailable", true);
      }
    },

    async refresh(onProgress) {
      return refreshHistory(onProgress);
    },

    async rebuildHistoryIndex() {
      try {
        return await withStateOperation(async () => {
          const rebuilt = await historyIndex.rebuildDesktopHistoryIndex(stateDirectory);
          return desktopSuccess({
            rebuilt: rebuilt.rebuilt,
            removed: rebuilt.removed,
            sessions: rebuilt.sessions,
            issues: rebuilt.issues.length,
          });
        });
      } catch (error) {
        return desktopFailure(error, "history_index_rebuild_failed", true);
      }
    },

    async updateChat(request) {
      try {
        const validated = validateChatMutationRequest(request);
        return await withStateOperation(async () => {
          const result = await application.mutateHistory({
            stateDirectory,
            sessionRef: validated.sessionRef,
            operation: validated.operation,
          });
          try { await synchronizeHistoryIndex(true); } catch { /* overlay remains authoritative */ }
          return desktopSuccess({
            sessionRef: result.sessionRef,
            changed: result.changed,
            state: result.after.state,
          });
        });
      } catch (error) {
        return desktopFailure(error, "history_update_failed", true);
      }
    },

    async planResume(request) {
      try {
        const validated = validateResumePlanRequest(request);
        return await withStateOperation(async () => {
          await ensureAgentSettingsLoaded();
          const plan = await resumeDependencies.planConversationResume(resumeOptionsFor(validated));
          return desktopSuccess(await resumePlanDto(plan, await detachedOptionsFor(plan.targetAgent, false)));
        });
      } catch (error) {
        return desktopFailure(error, "resume_plan_failed", true);
      }
    },

    async confirmResume(request) {
      try {
        const validated = validateResumeConfirmRequest(request);
        return await withStateOperation(async () => {
          await ensureAgentSettingsLoaded();
          const confirmation = await resumeDependencies.confirmConversationResume({
            ...resumeOptionsFor(validated),
            expectedPlanRef: validated.expectedPlanRef,
          });
          if (confirmation.status === "replan_required" || confirmation.status === "blocked") {
            return desktopSuccess({
              status: confirmation.status,
              plan: await resumePlanDto(
                confirmation.plan,
                await detachedOptionsFor(confirmation.plan.targetAgent, false),
              ),
            });
          }
          const processOptions = await detachedOptionsFor(confirmation.plan.targetAgent);
          const launched = await processDependencies.launchDetachedAgentProcess(
            confirmation.launch,
            processOptions,
          );
          try { await synchronizeHistoryIndex(true); } catch { /* imported native history remains authoritative */ }
          const plan = await resumePlanDto(confirmation.plan, processOptions, true);
          return desktopSuccess({
            status: "launched",
            plan,
            targetAgent: confirmation.targetAgent,
            targetSessionRef: confirmation.targetSessionRef,
            workspace: confirmation.workspace,
            pid: launched.pid,
            transactionRefs: [...confirmation.transactionRefs],
          });
        });
      } catch (error) {
        return desktopFailure(error, "resume_confirm_failed", true);
      }
    },

    async openWorkspace(request) {
      try {
        requireServiceOpen();
        const validated = validateOpenWorkspaceRequest(request);
        await synchronizeHistoryIndex();
        const indexed = await historyIndex.getDesktopConversationChunk({
          stateDirectory,
          sessionRef: validated.sessionRef,
          offset: 0,
          limit: 1,
        });
        const workspace = indexed.session.workspace;
        if (!isAbsolutePath(workspace, pathFlavorForPlatform())) {
          throw new Error("indexed conversation workspace is not an absolute local path");
        }
        const normalizedWorkspace = path.normalize(workspace);
        const workspaceInfo = await lstat(normalizedWorkspace);
        if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
          throw new Error("indexed conversation workspace is not a real directory");
        }
        const failure = await platformDependencies.openPath(normalizedWorkspace);
        if (typeof failure !== "string" || failure !== "") {
          throw new Error("the operating system did not open the conversation workspace");
        }
        return desktopSuccess({ workspace: normalizedWorkspace, opened: true });
      } catch (error) {
        return desktopFailure(error, "workspace_open_failed", true);
      }
    },

    async exportHistory(request) {
      try {
        const validated = validateExportHistoryRequest(request);
        return await withStateOperation(async () =>
          desktopSuccess(await (await currentTransferService()).exportHistory(validated)));
      } catch (error) {
        return desktopFailure(error, "history_export_failed", true);
      }
    },

    async openImport() {
      try {
        return await withStateOperation(async () =>
          desktopSuccess(await (await currentTransferService()).openImport()));
      } catch (error) {
        return desktopFailure(error, "history_import_open_failed", true);
      }
    },

    async replanImport(request) {
      try {
        const validated = validateReplanImportRequest(request);
        return await withStateOperation(async () =>
          desktopSuccess(await (await currentTransferService()).replanImport(validated)));
      } catch (error) {
        return desktopFailure(error, "history_import_plan_failed", true);
      }
    },

    async mapImportWorkspace(request) {
      try {
        const validated = validateMapImportWorkspaceRequest(request);
        return await withStateOperation(async () => {
          const selected = await selectImportWorkspaceDirectory();
          if (selected === undefined) return desktopSuccess({ status: "cancelled" });
          if (
            typeof selected !== "string" || selected === "" || !path.isAbsolute(selected) ||
            /[\u0000-\u001f\u007f=]/u.test(selected) || Buffer.byteLength(selected, "utf8") > 64 * 1024
          ) throw new Error("system workspace picker returned an invalid directory");
          const target = path.normalize(selected);
          const info = await lstat(target);
          if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error("system workspace picker returned an unsafe directory");
          }
          const transfer = await currentTransferService();
          return desktopSuccess(await transfer.mapImportWorkspace(validated, target));
        });
      } catch (error) {
        return desktopFailure(error, "history_import_mapping_failed", true);
      }
    },

    async applyImport(request) {
      try {
        const validated = validateApplyImportRequest(request);
        return await withStateOperation(async () => {
          const result = await (await currentTransferService()).applyImport(validated);
          if (result.status === "completed") {
            // This refresh is part of the native transaction's state turn. A
            // queued external refresh observes its generation and reuses it.
            await performRefreshInsideStateOperation();
          }
          return desktopSuccess(result);
        });
      } catch (error) {
        return desktopFailure(error, "history_import_apply_failed", true);
      }
    },

    async cancelImport(request) {
      try {
        const validated = validateCancelImportRequest(request);
        return await withStateOperation(async () =>
          desktopSuccess(await (await currentTransferService()).cancelImport(validated)));
      } catch (error) {
        return desktopFailure(error, "history_import_cancel_failed", true);
      }
    },

    async previewExperience(request) {
      try {
        const validated = validateExperienceScopeRequest(request);
        return await withStateOperation(async () =>
          desktopSuccess(await experienceService.previewExperience(validated)));
      } catch (error) {
        return desktopFailure(error, "experience_preview_failed", true);
      }
    },

    async runExperience(request, onProgress) {
      try {
        const validated = validateRunExperienceRequest(request);
        const result = await withExperienceModelOperation("run", () => withStateOperation(() =>
          experienceService.runExperience(validated, (progress) => {
            try { onProgress?.(progress); } catch { /* renderer delivery cannot interrupt analysis */ }
          })));
        return desktopSuccess(result);
      } catch (error) {
        return desktopFailure(error, "experience_run_failed", true);
      }
    },

    async loadExperienceReview() {
      try {
        return await withStateOperation(async () =>
          desktopSuccess(await experienceService.loadExperienceReview()));
      } catch (error) {
        return desktopFailure(error, "experience_load_failed", true);
      }
    },

    async getExperienceCandidate(request) {
      try {
        const validated = validateGetExperienceCandidateRequest(request);
        return await withStateOperation(async () =>
          desktopSuccess(await experienceService.getExperienceCandidate(validated)));
      } catch (error) {
        return desktopFailure(error, "experience_candidate_failed", true);
      }
    },

    async openExperienceOutput(request) {
      try {
        const validated = validateOpenExperienceOutputRequest(request);
        return await withStateOperation(async () =>
          desktopSuccess(await experienceService.openExperienceOutput(validated)));
      } catch (error) {
        return desktopFailure(error, "experience_open_failed", true);
      }
    },

    async closeExperienceReview(request) {
      try {
        const validated = validateCloseExperienceReviewRequest(request);
        return await withStateOperation(async () =>
          desktopSuccess(await experienceService.closeExperienceReview(validated)));
      } catch (error) {
        return desktopFailure(error, "experience_close_failed", true);
      }
    },

    async inspectExperienceConfig() {
      try {
        return await withStateOperation(async () => {
          await ensureAgentSettingsLoaded();
          const inspected = await experienceSettingsFacade.inspectExperienceConfig(
            stateDirectory,
            agentSettingsEnvironment(),
          );
          return desktopSuccess(experienceConfigurationDto(inspected));
        });
      } catch (error) {
        return desktopFailure(error, "experience_configuration_unavailable", true);
      }
    },

    async checkExperienceConfig() {
      try {
        const checked = await withExperienceModelOperation("check", () => withStateOperation(async () => {
          await ensureAgentSettingsLoaded();
          return experienceSettingsFacade.checkExperienceConfig(stateDirectory, agentSettingsEnvironment());
        }));
        return desktopSuccess(experienceConfigurationCheckDto(checked));
      } catch (error) {
        return desktopFailure(error, "experience_configuration_check_failed", true);
      }
    },

    async openExperienceConfig() {
      try {
        return await withStateOperation(async () => {
          const directory = experienceSettingsFacade.configurationDirectory(stateDirectory);
          const expectedDirectory = path.join(stateDirectory, "desktop", "experience");
          if (!path.isAbsolute(directory) || !samePath(directory, expectedDirectory, pathFlavorForPlatform())) {
            throw new Error("Experience configuration directory is outside Desktop state");
          }
          await ensurePrivateStateDirectory(stateDirectory);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await applyPosixMode(directory, 0o700);
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error("Experience configuration directory is not a real directory");
          }
          const failure = await platformDependencies.openPath(directory);
          if (failure !== "") throw new Error("Experience configuration directory could not be opened");
          return desktopSuccess({ opened: true });
        });
      } catch (error) {
        return desktopFailure(error, "experience_configuration_open_failed", true);
      }
    },

    async getAgentSettings() {
      try {
        return await withStateOperation(async () =>
          desktopSuccess(await inspectedAgentSettings()));
      } catch (error) {
        return desktopFailure(error, "agent_settings_unavailable", true);
      }
    },

    async chooseAgentPath(request) {
      try {
        const validated = validateChooseAgentPathRequest(request);
        return await withStateOperation(() => serializeAgentSettingsMutation(async () => {
          const selected = await pickedAgentPath(validated.agent, validated.kind);
          if (selected === undefined) return desktopSuccess({ status: "cancelled" });
          const changesNativeSource = validated.kind === "history" || validated.kind === "database";
          const current = await ensureAgentSettingsLoaded();
          const setting = settingWithPath(current, validated.agent, validated.kind, selected);
          if (validated.kind === "executable") {
            await requireConfiguredExecutablePath({
              ...current,
              agents: { ...current.agents, [validated.agent]: setting },
            }, validated.agent, selected);
          }
          const saved = await agentSettingsDependencies.updateDesktopAgentPathSetting(
            stateDirectory,
            validated.agent,
            setting,
          );
          installAgentPathSettings(saved);
          if (changesNativeSource) {
            await rebuildProductionTransferService();
            await performRefreshInsideStateOperation();
          }
          return desktopSuccess({ status: "updated", settings: await inspectedAgentSettings() });
        }));
      } catch (error) {
        return desktopFailure(error, "agent_settings_update_failed", true);
      }
    },

    async clearAgentPath(request) {
      try {
        const validated = validateClearAgentPathRequest(request);
        return await withStateOperation(() => serializeAgentSettingsMutation(async () => {
          const changesNativeSource = validated.kind === undefined ||
            validated.kind === "history" || validated.kind === "database";
          const current = await ensureAgentSettingsLoaded();
          const saved = validated.kind === undefined
            ? await agentSettingsDependencies.clearDesktopAgentPathSetting(stateDirectory, validated.agent)
            : await agentSettingsDependencies.updateDesktopAgentPathSetting(
                stateDirectory,
                validated.agent,
                settingWithoutPath(current, validated.agent, validated.kind),
              );
          installAgentPathSettings(saved);
          if (changesNativeSource) {
            await rebuildProductionTransferService();
            await performRefreshInsideStateOperation();
          }
          return desktopSuccess({ settings: await inspectedAgentSettings() });
        }));
      } catch (error) {
        return desktopFailure(error, "agent_settings_update_failed", true);
      }
    },

    async getTerminalSettings() {
      try {
        return await withStateOperation(async () => desktopSuccess(await terminalSettingsService.inspect()));
      } catch (error) {
        return desktopFailure(error, "terminal_settings_unavailable", true);
      }
    },

    async selectTerminal(request) {
      try {
        return await withStateOperation(async () => desktopSuccess(await terminalSettingsService.select(request)));
      } catch (error) {
        return desktopFailure(error, "terminal_settings_update_failed", true);
      }
    },

    async updateTerminalArguments(request) {
      try {
        return await withStateOperation(async () =>
          desktopSuccess(await terminalSettingsService.updateArguments(request)));
      } catch (error) {
        return desktopFailure(error, "terminal_settings_update_failed", true);
      }
    },

    async listTransactions() {
      try {
        return await withStateOperation(async () => {
          const transactions = await transactionFacade.listDesktopTransactions(stateDirectory);
          return desktopSuccess(transactions.map(transactionSummaryDto));
        });
      } catch (error) {
        return desktopFailure(error, "transactions_unavailable", true);
      }
    },

    async planTransaction(request) {
      try {
        const validated = validatePlanTransactionRequest(request);
        return await withStateOperation(async () => {
          const plan = await transactionFacade.planDesktopTransaction(stateDirectory, validated);
          return desktopSuccess(transactionPlanDto(plan));
        });
      } catch (error) {
        return desktopFailure(error, "transaction_plan_failed", true);
      }
    },

    async confirmTransaction(request) {
      try {
        const validated = validateConfirmTransactionRequest(request);
        return await withStateOperation(async () => {
          const confirmation = await transactionFacade.confirmDesktopTransaction(stateDirectory, validated);
          if (confirmation.status === "replan_required" || confirmation.status === "blocked") {
            return desktopSuccess({
              status: confirmation.status,
              plan: transactionPlanDto(confirmation.plan),
            });
          }
          try { await synchronizeHistoryIndex(true); } catch { /* native transaction remains authoritative */ }
          return desktopSuccess({
            status: "completed",
            plan: transactionPlanDto(confirmation.plan),
            summary: transactionSummaryDto(confirmation.summary),
          });
        });
      } catch (error) {
        return desktopFailure(error, "transaction_confirm_failed", true);
      }
    },

    async getSettings() {
      try {
        return await withStateOperation(async () => desktopSuccess(await readSettingsValue()));
      } catch (error) {
        return desktopFailure(error, "settings_unavailable", true);
      }
    },

    async updateSettings(settings) {
      try {
        return await withStateOperation(async () => desktopSuccess(await writeSettingsValue(settings)));
      } catch (error) {
        return desktopFailure(error, "settings_update_failed", true);
      }
    },

    async dispose() {
      if (disposed) return;
      if (disposeInFlight === undefined) {
        acceptingStateOperations = false;
        disposeInFlight = (async () => {
          await stateOperationTail;
          await settingsWriteTail;
          await agentSettingsMutationTail;
          try { await indexSyncInFlight; } catch { /* derived index errors do not prevent handle cleanup */ }
          const settled = await Promise.allSettled([
            transferService?.dispose() ?? Promise.resolve(),
            experienceService.dispose(),
          ]);
          const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
          if (failures.length !== 0) {
            throw new AggregateError(failures, "Desktop service disposal failed");
          }
          disposed = true;
        })();
      }
      try {
        await disposeInFlight;
      } finally {
        if (!disposed) disposeInFlight = undefined;
      }
    },
  };
  return service;
}
