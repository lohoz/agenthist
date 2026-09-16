import { vi } from "vitest";

import type {
  Agent,
  AgentHistDesktopApi,
  AgentSettingDto,
  AgentStatusDto,
  BootstrapDto,
  ChatPageDto,
  ChatSummaryDto,
  ConversationItemDto,
  ConversationPageDto,
  DesktopSettings,
  ExperienceCandidateDetailDto,
  ExperienceCandidateSummaryDto,
  ExperiencePreviewDto,
  ExperienceReviewDto,
  ImportPlanDto,
  ListChatsRequest,
  ResumeConfirmResultDto,
  ResumePlanDto,
  TransactionActionDto,
  TransactionPlanDto,
  TransactionStateDto,
  TransactionSummaryDto,
  TerminalSettingsDto,
} from "../../src/desktop/contracts.js";

export const DEFAULT_SETTINGS: DesktopSettings = {
  theme: "system",
  agentFilter: "all",
  autoRefresh: false,
  showTechnicalDetails: false,
  firstRunComplete: true,
};

export const TERMINAL_SETTINGS: TerminalSettingsDto = {
  mode: "auto",
  effectiveLabel: "Windows Terminal（自动）",
  effectiveExecutablePath: "C:\\Program Files\\WindowsApps\\wt.exe",
  arguments: ["-w", "new", "new-tab", "--startingDirectory", "{cwd}", "{command}"],
  candidates: [{
    id: "windows-terminal",
    label: "Windows Terminal",
    executablePath: "C:\\Program Files\\WindowsApps\\wt.exe",
    arguments: ["-w", "new", "new-tab", "--startingDirectory", "{cwd}", "{command}"],
  }],
  requiresSetup: false,
};

export const AGENTS: readonly AgentStatusDto[] = [
  {
    agent: "codex",
    label: "Codex",
    status: "ready",
    locations: [{ role: "history", path: "C:\\Users\\Alice\\.codex" }],
    findings: [],
  },
  {
    agent: "claude",
    label: "Claude Code",
    status: "ready",
    locations: [{ role: "history", path: "C:\\Users\\Alice\\.claude" }],
    findings: [],
  },
  { agent: "opencode", label: "OpenCode", status: "not_detected", locations: [], findings: [] },
  { agent: "pi", label: "Pi", status: "not_detected", locations: [], findings: [] },
];

export const AGENT_SETTINGS: readonly AgentSettingDto[] = [
  {
    agent: "codex",
    label: "Codex",
    history: { configured: false, available: true, expected: "directory" },
    database: { configured: false, available: true, expected: "file" },
    executable: {
      configured: false,
      resolvedPath: "C:\\Tools\\codex.exe",
      available: true,
    },
  },
  {
    agent: "claude",
    label: "Claude Code",
    history: { configured: false, available: true, expected: "directory" },
    executable: {
      configured: false,
      resolvedPath: "C:\\Tools\\claude.exe",
      available: true,
    },
  },
  {
    agent: "opencode",
    label: "OpenCode",
    history: { configured: false, available: false, expected: "directory" },
    database: { configured: false, available: false, expected: "file" },
    executable: { configured: false, available: false },
  },
  {
    agent: "pi",
    label: "Pi",
    history: { configured: false, available: false, expected: "directory" },
    executable: { configured: false, available: false },
  },
];

export function chat(index: number, agent: Agent = "codex", overrides: Partial<ChatSummaryDto> = {}): ChatSummaryDto {
  const sessionRef = `ahsr1_${agent}_ck1_${index.toString().padStart(64, "0")}`;
  return {
    sessionRef,
    memberSessionRefs: [sessionRef],
    agent,
    title: `${agent === "claude" ? "Claude" : agent === "codex" ? "Codex" : agent} conversation ${index}`,
    workspace: `C:\\Work\\Project ${index % 4}`,
    workspaceName: `Project ${index % 4}`,
    updatedAt: new Date(Date.UTC(2026, 8, 4, 8, 0, 0) - index * 60_000).toISOString(),
    preview: `A short preview for conversation ${index}`,
    libraryState: "active",
    tags: [],
    ...overrides,
  };
}

export const CODEX_CHAT = chat(1, "codex", { title: "Fix the database migration" });
export const CLAUDE_CHAT = chat(2, "claude", { title: "Review the release checklist" });
export const PI_CHAT = chat(3, "pi", { title: "Investigate the parser" });

export function chatPage(chats: readonly ChatSummaryDto[], total = chats.length, offset = 0): ChatPageDto {
  const remaining = Math.max(0, total - offset - chats.length);
  return {
    total,
    offset,
    limit: 100,
    returned: chats.length,
    remaining,
    ...(remaining === 0 ? {} : { nextOffset: offset + chats.length }),
    chats,
  };
}

export function bootstrap(overrides: Partial<BootstrapDto> = {}): BootstrapDto {
  const chats = chatPage([CODEX_CHAT, CLAUDE_CHAT, PI_CHAT]);
  return {
    version: "0.3.0-test",
    stateDirectory: "C:\\Users\\Alice\\AppData\\Local\\AgentHist",
    settings: DEFAULT_SETTINGS,
    agents: AGENTS,
    agentSettings: AGENT_SETTINGS,
    chats,
    ...overrides,
  };
}

export const CONVERSATION_ITEMS: readonly ConversationItemDto[] = [
  {
    id: "message-user",
    index: 0,
    kind: "message",
    role: "user",
    text: "Please fix **the parser** and keep this code:\n\n```ts\nconst answer = 42;\n```",
    timestamp: "2026-09-04T08:00:00.000Z",
    technical: [],
  },
  {
    id: "message-system",
    index: 1,
    kind: "message",
    role: "system",
    text: "Private system context shown only on request",
    timestamp: "2026-09-04T08:00:01.000Z",
    technical: [],
  },
  {
    id: "gap-tool",
    index: 2,
    kind: "gap",
    label: "Read src/parser.ts",
    code: "tool.read",
    timestamp: "2026-09-04T08:00:02.000Z",
  },
  {
    id: "message-assistant",
    index: 3,
    kind: "message",
    role: "assistant",
    text: "The parser is fixed and the focused test passes.",
    timestamp: "2026-09-04T08:00:03.000Z",
    model: "gpt-test",
    technical: [{
      id: "detail-1",
      detailIndex: 0,
      label: "Read",
      summary: "src/parser.ts",
      detail: "complete tool output",
      totalCharacters: 20,
      truncated: false,
      available: true,
    }],
  },
];

export function conversationPage(
  selectedChat: ChatSummaryDto = CODEX_CHAT,
  items: readonly ConversationItemDto[] = CONVERSATION_ITEMS,
  total = items.length,
): ConversationPageDto {
  return {
    chat: selectedChat,
    model: "gpt-test",
    provider: "test-provider",
    total,
    offset: items[0]?.index ?? 0,
    limit: 80,
    returned: items.length,
    remaining: Math.max(0, total - items.length),
    items,
  };
}

export function resumePlan(overrides: Partial<ResumePlanDto> = {}): ResumePlanDto {
  return {
    planRef: "resume-plan-1",
    source: CODEX_CHAT,
    targetAgent: "codex",
    targetAvailable: true,
    route: "native",
    quality: "native",
    findings: [],
    sourceWorkspace: CODEX_CHAT.workspace,
    targetWorkspace: CODEX_CHAT.workspace,
    workspaceStatus: "unchanged",
    needsWrite: false,
    ...overrides,
  };
}

export function launchedResume(
  plan: ResumePlanDto = resumePlan(),
  overrides: Partial<Extract<ResumeConfirmResultDto, { readonly status: "launched" }>> = {},
): Extract<ResumeConfirmResultDto, { readonly status: "launched" }> {
  return {
    status: "launched",
    plan,
    targetAgent: plan.targetAgent,
    targetSessionRef: plan.source.sessionRef,
    workspace: plan.targetWorkspace,
    pid: 4242,
    transactionRefs: [],
    ...overrides,
  };
}

export function importPlan(overrides: Partial<ImportPlanDto> = {}): ImportPlanDto {
  return {
    handle: "import-handle-opaque-1",
    planRef: "import-plan-1",
    fileName: "history-backup.agenthist",
    status: "ready",
    selectedSessions: 3,
    newSessions: 2,
    alreadyPresent: 1,
    blocked: 0,
    conflicts: 0,
    routes: [{
      sourceAgent: "codex",
      targetAgent: "codex",
      quality: "native",
      sessions: 3,
      findings: [],
    }],
    workspaces: [{
      source: "C:\\Source Work\\Project",
      target: "C:\\Source Work\\Project",
      status: "unchanged",
      agents: ["codex"],
      sessions: 3,
    }],
    sessions: [CODEX_CHAT, CLAUDE_CHAT, PI_CHAT].map((chat) => ({
      sessionRef: chat.sessionRef,
      memberSessionRefs: chat.memberSessionRefs,
      sourceAgent: chat.agent,
      title: chat.title,
      workspace: chat.workspace,
      updatedAt: chat.updatedAt,
      selected: true,
    })),
    transactionRequired: true,
    ...overrides,
  };
}

export function experiencePreview(overrides: Partial<ExperiencePreviewDto> = {}): ExperiencePreviewDto {
  return {
    previewRef: "experience-preview-1",
    scope: "all",
    sessions: 12,
    lineages: 10,
    projects: 4,
    cards: 36,
    queuedCards: 30,
    reusedSessions: 9,
    rebuiltSessions: 3,
    estimatedInputTokens: 24_500,
    evidenceRequests: 3,
    candidateRequestsUpperBound: 1,
    ...overrides,
  };
}

export const EXPERIENCE_CANDIDATES: readonly ExperienceCandidateSummaryDto[] = [
  {
    candidateRef: "candidate-requirement",
    category: "requirement",
    topic: "verification",
    lens: "correction",
    draft: "Verify source evidence before making a claim.",
    evidence: 3,
    sessions: 3,
    projects: 2,
  },
  {
    candidateRef: "candidate-preference",
    category: "preference",
    topic: "writing",
    lens: "style",
    draft: "Prefer concise, restrained technical prose.",
    evidence: 2,
    sessions: 2,
    projects: 2,
  },
  {
    candidateRef: "candidate-method",
    category: "working_method",
    topic: "testing",
    lens: "workflow",
    draft: "Reproduce defects with a focused test before fixing them.",
    evidence: 4,
    sessions: 4,
    projects: 3,
  },
];

export function experienceReview(overrides: Partial<ExperienceReviewDto> = {}): ExperienceReviewDto {
  return {
    handle: "experience-handle-opaque-1",
    reviewRef: "experience-review-1",
    createdAt: "2026-09-04T10:00:00.000Z",
    directoryName: "agenthist-experience-20260904",
    sessions: 12,
    lineages: 10,
    projects: 4,
    candidates: EXPERIENCE_CANDIDATES,
    unroutedEvidence: 2,
    ...overrides,
  };
}

export function experienceDetail(
  candidate: ExperienceCandidateSummaryDto = EXPERIENCE_CANDIDATES[0]!,
  overrides: Partial<ExperienceCandidateDetailDto> = {},
): ExperienceCandidateDetailDto {
  return {
    ...candidate,
    relation: "correction_pattern",
    evidenceItems: [{
      occurrenceRef: "occurrence-1",
      sessionRef: CODEX_CHAT.sessionRef,
      agent: "codex",
      workspace: CODEX_CHAT.workspace,
      timestamp: "2026-09-04T08:00:00.000Z",
      observation: "The user explicitly requested source verification.",
      userText: "Open the source and verify that it directly supports this claim.",
      assistant: ["I will verify it against the original source."],
    }],
    ...overrides,
  };
}

export function transactionSummary(
  state: TransactionStateDto = "committed",
  overrides: Partial<TransactionSummaryDto> = {},
): TransactionSummaryDto {
  return {
    transactionRef: "ahtx1_00000000-0000-4000-8000-000000000001",
    operation: "history_import",
    agents: ["codex"],
    state,
    phase: state,
    direction: state === "rolled_back" ? "rollback" : "forward",
    createdAt: "2026-09-04T08:00:00.000Z",
    updatedAt: "2026-09-04T09:00:00.000Z",
    items: 2,
    ...(state === "needs_recovery" ? { failure: "fixture_interrupted" } : {}),
    ...overrides,
  };
}

export function transactionPlan(
  summary: TransactionSummaryDto = transactionSummary(),
  action: TransactionActionDto = summary.state === "needs_recovery" ? "recover" : "rollback",
  overrides: Partial<TransactionPlanDto> = {},
): TransactionPlanDto {
  return {
    planRef: "transaction-plan-1",
    summary,
    action,
    ready: true,
    findings: [{
      sessionRef: CODEX_CHAT.sessionRef,
      row: "after",
      file: "after",
      resources: "unchanged",
    }],
    ...overrides,
  };
}

export function createApi(options: {
  readonly bootstrap?: BootstrapDto;
  readonly bootstrapFailure?: { readonly message: string; readonly retryable: boolean };
  readonly conversation?: ConversationPageDto;
  readonly chats?: readonly ChatSummaryDto[];
} = {}): AgentHistDesktopApi {
  let settings = options.bootstrap?.settings ?? DEFAULT_SETTINGS;
  let agentSettings = options.bootstrap?.agentSettings ?? AGENT_SETTINGS;
  const sourceChats = options.chats ?? options.bootstrap?.chats.chats ?? [CODEX_CHAT, CLAUDE_CHAT, PI_CHAT];

  return {
    bootstrap: vi.fn(async () => options.bootstrapFailure === undefined
      ? { ok: true as const, value: options.bootstrap ?? bootstrap({ settings, chats: chatPage(sourceChats) }) }
      : {
          ok: false as const,
          error: {
            code: "test.bootstrap",
            message: options.bootstrapFailure.message,
            retryable: options.bootstrapFailure.retryable,
          },
        }),
    listChats: vi.fn(async (request: ListChatsRequest) => {
      const query = request.query?.toLocaleLowerCase() ?? "";
      const agents = new Set(request.agents ?? []);
      const libraryState = request.libraryState ?? "active";
      const filtered = sourceChats.filter((item) =>
        item.libraryState === libraryState &&
        (agents.size === 0 || agents.has(item.agent)) &&
        (query === "" || `${item.title} ${item.preview ?? ""} ${item.workspaceName}`.toLocaleLowerCase().includes(query))
      );
      const offset = request.offset ?? 0;
      const limit = request.limit ?? 100;
      return { ok: true as const, value: chatPage(filtered.slice(offset, offset + limit), filtered.length, offset) };
    }),
    getConversation: vi.fn(async () => ({
      ok: true as const,
      value: options.conversation ?? conversationPage(sourceChats[0] ?? CODEX_CHAT),
    })),
    findInConversation: vi.fn(async (request) => ({
      ok: true as const,
      value: {
        query: request.query,
        matches: request.query.toLocaleLowerCase().includes("parser")
          ? [{ index: 0, snippet: "Please fix the parser" }, { index: 3, snippet: "The parser is fixed" }]
          : [],
      },
    })),
    getTechnicalDetail: vi.fn(async (request) => ({
      ok: true as const,
      value: {
        status: "unavailable" as const,
        id: `${request.sessionRef}:${request.itemIndex}:technical:${request.detailIndex}`,
        detailIndex: request.detailIndex,
        label: "Technical detail",
        reason: "Technical detail is unavailable in this fixture.",
      },
    })),
    refresh: vi.fn(async () => ({
      ok: true as const,
      value: { agents: [], sessions: sourceChats.length, partial: false },
    })),
    updateChat: vi.fn(async (request) => ({
      ok: true as const,
      value: { sessionRef: request.sessionRef, changed: true, state: "active" as const },
    })),
    planResume: vi.fn(async (request) => {
      const plan = request.targetAgent === CODEX_CHAT.agent
        ? resumePlan()
        : resumePlan({
            planRef: `resume-plan-${request.targetAgent}`,
            targetAgent: request.targetAgent,
            route: "conversion",
            quality: "degraded",
            findings: [{ code: "fixture.message.reconstructed", disposition: "synthesized", count: 1 }],
            needsWrite: true,
          });
      return { ok: true as const, value: plan };
    }),
    confirmResume: vi.fn(async (request) => {
      const plan = resumePlan({ planRef: request.expectedPlanRef, targetAgent: request.targetAgent });
      return { ok: true as const, value: launchedResume(plan) };
    }),
    openWorkspace: vi.fn(async () => ({
      ok: true as const,
      value: { workspace: CODEX_CHAT.workspace, opened: true as const },
    })),
    exportHistory: vi.fn(async () => ({ ok: true as const, value: { status: "cancelled" as const } })),
    openImport: vi.fn(async () => ({ ok: true as const, value: { status: "cancelled" as const } })),
    replanImport: vi.fn(async () => ({
      ok: false as const,
      error: { code: "test.import_unavailable", message: "Import is not configured in this fixture", retryable: false },
    })),
    applyImport: vi.fn(async () => ({
      ok: false as const,
      error: { code: "test.import_unavailable", message: "Import is not configured in this fixture", retryable: false },
    })),
    cancelImport: vi.fn(async () => ({ ok: true as const, value: { closed: true as const } })),
    mapImportWorkspace: vi.fn(async () => ({ ok: true as const, value: { status: "cancelled" as const } })),
    previewExperience: vi.fn(async () => ({
      ok: false as const,
      error: { code: "test.experience_unavailable", message: "Experience is not configured in this fixture", retryable: false },
    })),
    runExperience: vi.fn(async () => ({ ok: true as const, value: { status: "cancelled" as const } })),
    loadExperienceReview: vi.fn(async () => ({ ok: true as const, value: { status: "cancelled" as const } })),
    getExperienceCandidate: vi.fn(async () => ({
      ok: false as const,
      error: { code: "test.experience_unavailable", message: "Experience is not configured in this fixture", retryable: false },
    })),
    openExperienceOutput: vi.fn(async () => ({
      ok: false as const,
      error: { code: "test.experience_unavailable", message: "Experience is not configured in this fixture", retryable: false },
    })),
    closeExperienceReview: vi.fn(async () => ({ ok: true as const, value: { closed: true as const } })),
    inspectExperienceConfig: vi.fn(async () => ({
      ok: true as const,
      value: {
        status: "not_configured" as const,
        configFile: "C:\\Users\\Alice\\AppData\\Local\\AgentHist\\experience\\.env",
        error: { code: "configuration_missing", retryable: false, stage: "configuration" },
      },
    })),
    checkExperienceConfig: vi.fn(async () => ({
      ok: true as const,
      value: {
        status: "not_configured" as const,
        configFile: "C:\\Users\\Alice\\AppData\\Local\\AgentHist\\experience\\.env",
        historySent: false as const,
        requests: 0 as const,
        error: { code: "configuration_missing", retryable: false, stage: "configuration" },
      },
    })),
    openExperienceConfig: vi.fn(async () => ({ ok: true as const, value: { opened: true as const } })),
    getAgentSettings: vi.fn(async () => ({ ok: true as const, value: agentSettings })),
    chooseAgentPath: vi.fn(async () => ({ ok: true as const, value: { status: "cancelled" as const } })),
    clearAgentPath: vi.fn(async () => ({ ok: true as const, value: { settings: agentSettings } })),
    getTerminalSettings: vi.fn(async () => ({ ok: true as const, value: TERMINAL_SETTINGS })),
    selectTerminal: vi.fn(async () => ({ ok: true as const, value: TERMINAL_SETTINGS })),
    updateTerminalArguments: vi.fn(async (request) => ({
      ok: true as const,
      value: { ...TERMINAL_SETTINGS, mode: "configured" as const, arguments: request.arguments },
    })),
    listCodexProviders: vi.fn(async () => ({ ok: true as const, value: { currentProvider: "openai", totalSessions: 3,
      providers: [{ provider: "legacy", sessions: 2, current: false }, { provider: "openai", sessions: 1, current: true }] } })),
    previewCodexProviderUnify: vi.fn(async () => ({ ok: true as const, value: {
      planRef: `ahproviderplan1_${"1".repeat(64)}`, targetProvider: "openai", changed: 2, unchanged: 1, sources: [{ provider: "legacy", sessions: 2 }],
    } })),
    confirmCodexProviderUnify: vi.fn(async () => ({ ok: true as const, value: { status: "completed" as const,
      plan: { planRef: `ahproviderplan1_${"1".repeat(64)}`, targetProvider: "openai", changed: 2, unchanged: 1, sources: [{ provider: "legacy", sessions: 2 }] },
      transactionRef: "ahtx1_00000000-0000-4000-8000-000000000001",
    } })),
    listTransactions: vi.fn(async () => ({ ok: true as const, value: [] })),
    planTransaction: vi.fn(async () => ({
      ok: false as const,
      error: { code: "test.transaction_unavailable", message: "Transactions are not configured in this fixture", retryable: false },
    })),
    confirmTransaction: vi.fn(async () => ({
      ok: false as const,
      error: { code: "test.transaction_unavailable", message: "Transactions are not configured in this fixture", retryable: false },
    })),
    rebuildHistoryIndex: vi.fn(async () => ({
      ok: true as const,
      value: { rebuilt: true, removed: false, sessions: sourceChats.length, issues: 0 },
    })),
    getSettings: vi.fn(async () => ({ ok: true as const, value: settings })),
    updateSettings: vi.fn(async (next) => {
      settings = next;
      return { ok: true as const, value: settings };
    }),
    onScanProgress: vi.fn(() => () => {}),
    onExperienceProgress: vi.fn(() => () => {}),
  };
}

export function installApi(api: AgentHistDesktopApi): void {
  Object.defineProperty(window, "agentHist", { configurable: true, value: api });
}
