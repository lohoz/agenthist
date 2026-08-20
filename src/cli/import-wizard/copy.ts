export type ImportWizardLanguage = "en" | "zh";

export type ImportWizardQuality = "native" | "exact" | "degraded" | "blocked";
export type ImportWizardFindingDisposition = "exact" | "degraded" | "blocked" | "skipped" | "synthesized";

export interface ImportWizardCopy {
  readonly brand: string;
  readonly steps: readonly [string, string, string, string];
  readonly actions: {
    readonly back: string;
    readonly exit: string;
    readonly next: string;
    readonly move: string;
    readonly scroll: string;
    readonly page: string;
    readonly switchPane: string;
    readonly select: string;
    readonly search: string;
    readonly changeSearch: string;
    readonly preview: string;
    readonly selectAll: string;
    readonly clearAll: string;
    readonly choose: string;
    readonly cancel: string;
    readonly setTarget: string;
    readonly changeProvider: string;
    readonly editMapping: string;
    readonly removeMapping: string;
    readonly review: string;
    readonly continue: string;
    readonly showDetails: string;
    readonly hideDetails: string;
    readonly excludeBlocked: string;
    readonly apply: string;
    readonly switchLanguage: string;
  };
  readonly common: {
    readonly untitled: string;
    readonly unknown: string;
    readonly pleaseWait: string;
    readonly editHelp: string;
    readonly sources: string;
    readonly scopes: string;
    readonly sessions: string;
    readonly allSessions: string;
    readonly workspace: string;
    readonly updated: string;
    readonly model: string;
    readonly reference: string;
    readonly route: string;
    readonly provider: string;
    readonly resources: string;
    readonly reason: string;
    readonly sourceProviders: string;
    readonly current: string;
    readonly currentMarker: string;
    readonly native: string;
    readonly convert: string;
    readonly nativeAndConvert: string;
    readonly mixed: string;
  };
  readonly preview: {
    readonly title: string;
    readonly loading: string;
    readonly conversation: string;
    readonly you: string;
    readonly gap: string;
    collapsedGaps(count: number): string;
    moreGapTypes(count: number): string;
    readonly emptyMessage: string;
    readonly noConversation: string;
    readonly messageTruncated: string;
    remainingLines(count: number): string;
    foldedTool(phase: string, identity: string): string;
    foldedResource(name: string): string;
    readonly foldedReference: string;
    readonly foldedReasoning: string;
    historicalEvent(event: string): string;
    foldedBlock(kind: string): string;
  };
  readonly selection: {
    readonly title: string;
    readonly noMatches: string;
    readonly searchTitle: string;
    readonly searchHelp: string;
    readonly searchPrompt: string;
    readonly selectRequired: string;
    readonly previewPaneRequired: string;
    summary(selected: number, required: number): string;
    searchStatus(query: string, context: string): string;
    scopeStatus(context: string): string;
  };
  readonly targets: {
    readonly title: string;
    readonly chooserTitle: string;
    readonly currentlyMixed: string;
    readonly allNative: string;
    readonly readingProviders: string;
    readonly checkingProviders: string;
    readonly previewPaneRequired: string;
    destinationCount(count: number): string;
    currentTarget(agent: string): string;
    crossAgentCount(count: number): string;
    targetProvider(provider: string): string;
  };
  readonly providers: {
    readonly chooseTitle: string;
    readonly keepSource: string;
    readonly enterAnother: string;
    readonly enterTitle: string;
    readonly enterHelp: string;
    readonly prompt: string;
    readonly invalid: string;
    currentMachine(provider: string): string;
    existingSessions(count: number): string;
    pagePosition(start: number, end: number, total: number): string;
  };
  readonly workspaces: {
    readonly title: string;
    readonly checking: string;
    readonly inspecting: string;
    readonly missing: string;
    readonly mapped: string;
    readonly unchanged: string;
    readonly samePath: string;
    readonly noneRequired: string;
    readonly resolveAll: string;
    readonly mapTitle: string;
    readonly source: string;
    readonly directoryCandidates: string;
    readonly noDirectoryCandidates: string;
    readonly completionHelp: string;
    readonly invalidDirectory: string;
    readonly targetPrompt: string;
    sessionCount(count: number): string;
    readyCount(count: number): string;
    missingCount(count: number): string;
  };
  readonly review: {
    readonly title: string;
    readonly preparing: string;
    readonly runningPreflight: string;
    readonly preflightFailed: string;
    readonly noChangesWritten: string;
    readonly overview: string;
    readonly routes: string;
    readonly nativeImports: string;
    readonly conversions: string;
    readonly sessions: string;
    readonly impact: string;
    readonly technicalDetails: string;
    readonly technicalDetail: string;
    readonly targetSettings: string;
    readonly workspaces: string;
    readonly dryRunComplete: string;
    readonly confirmTitle: string;
    readonly applyingTitle: string;
    readonly writingTransaction: string;
    readonly genericFailure: string;
    readonly openCodeFailure: string;
    readonly genericGuidance: string;
    readonly openCodeGuidance: string;
    readonly blockedReasonFallback: string;
    readonly selectedAgentHistories: string;
    readonly confirmGuidance: string;
    quality(quality: ImportWizardQuality): string;
    finding(disposition: ImportWizardFindingDisposition): string;
    impactCount(disposition: ImportWizardFindingDisposition, count: number): string;
    itemCount(count: number, item: "session" | "item"): string;
    status(status: "blocked" | "ready_empty" | "ready", newSessions: number, blocked: number, withLoss: number): string;
    overviewSummary(selected: number, blocked: number, newSessions: number, alreadyPresent: number): string;
    blockedSessions(count: number): string;
    mappedCount(count: number): string;
    unchangedCount(count: number): string;
    confirmSummary(newSessions: number, alreadyPresent: number): string;
    applySummary(newSessions: number, destinations: string): string;
    excluded(blocked: number, related: number): string;
    position(start: number, end: number, total: number): string;
  };
}

const EN: ImportWizardCopy = {
  brand: "AgentHist Import",
  steps: ["Select", "Targets", "Workspaces", "Review"],
  actions: {
    back: "Back",
    exit: "Exit",
    next: "Next",
    move: "Move",
    scroll: "Scroll",
    page: "Page",
    switchPane: "Switch pane",
    select: "Select",
    search: "Search",
    changeSearch: "Change search",
    preview: "Preview",
    selectAll: "Select all",
    clearAll: "Clear all",
    choose: "Choose",
    cancel: "Cancel",
    setTarget: "Set target",
    changeProvider: "Change provider",
    editMapping: "Edit mapping",
    removeMapping: "Remove mapping",
    review: "Review",
    continue: "Continue",
    showDetails: "Show details",
    hideDetails: "Hide details",
    excludeBlocked: "Exclude blocked",
    apply: "Apply",
    switchLanguage: "中文",
  },
  common: {
    untitled: "(untitled)",
    unknown: "(unknown)",
    pleaseWait: "Please wait",
    editHelp: "Esc cancels this edit; Ctrl+U clears the input.",
    sources: "SOURCES",
    scopes: "SCOPES",
    sessions: "SESSIONS",
    allSessions: "All sessions",
    workspace: "Workspace",
    updated: "Updated",
    model: "Model",
    reference: "Reference",
    route: "Route",
    provider: "Provider",
    resources: "Resources",
    reason: "Reason",
    sourceProviders: "source providers",
    current: "current",
    currentMarker: " (current)",
    native: "native",
    convert: "convert",
    nativeAndConvert: "native + convert",
    mixed: "mixed",
  },
  preview: {
    title: "Session preview",
    loading: "Loading conversation from the archive...",
    conversation: "Conversation",
    you: "YOU",
    gap: "GAP",
    collapsedGaps: (count) => `${count} technical records folded`,
    moreGapTypes: (count) => `... ${count} more record type(s)`,
    emptyMessage: "(empty message)",
    noConversation: "(no readable conversation items)",
    messageTruncated: "... [message truncated]",
    remainingLines: (count) => `${count} more line(s) below`,
    foldedTool: (phase, identity) => `[tool ${phase}${identity === "" ? "" : ` ${identity}`}; details folded]`,
    foldedResource: (name) => `[resource ${name}; details folded]`,
    foldedReference: "[historical reference; details folded]",
    foldedReasoning: "[reasoning evidence; details folded]",
    historicalEvent: (event) => `[historical event ${event}]`,
    foldedBlock: (kind) => `[${kind}; details folded]`,
  },
  selection: {
    title: "Select sessions",
    noMatches: "No sessions match the current search.",
    searchTitle: "Search sessions",
    searchHelp: "Matches title, workspace, model, native ID, or session reference.",
    searchPrompt: "Search: ",
    selectRequired: "Select at least one session before continuing.",
    previewPaneRequired: "Switch to the Sessions pane to preview a conversation.",
    summary: (selected, required) => `${selected} selected${required > 0 ? ` + ${required} required` : ""}`,
    searchStatus: (query, context) => `Search: ${query}  |  Scope: ${context}`,
    scopeStatus: (context) => `Scope: ${context}`,
  },
  targets: {
    title: "Choose target Agents",
    chooserTitle: "Set target Agent",
    currentlyMixed: "Currently mixed",
    allNative: "All native",
    readingProviders: "Reading Codex providers",
    checkingProviders: "Checking Provider IDs already used by this machine.",
    previewPaneRequired: "Switch to the Sessions pane to preview a conversation.",
    destinationCount: (count) => `Set the destination for ${count} session${count === 1 ? "" : "s"}.`,
    currentTarget: (agent) => `Current: ${agent}`,
    crossAgentCount: (count) => `${count} cross-Agent`,
    targetProvider: (provider) => `Target provider: ${provider}`,
  },
  providers: {
    chooseTitle: "Choose Codex provider",
    keepSource: "Keep each source provider",
    enterAnother: "Enter another provider ID...",
    enterTitle: "Enter Codex provider",
    enterHelp: "Enter the Provider ID to use for imported Codex history.",
    prompt: "Provider: ",
    invalid: "Provider IDs may contain only letters, numbers, '.', '_' and '-'.",
    currentMachine: (provider) => `Current machine: ${provider}`,
    existingSessions: (count) => `${count} existing session${count === 1 ? "" : "s"}`,
    pagePosition: (start, end, total) => `${start}-${end} of ${total}`,
  },
  workspaces: {
    title: "Workspace paths",
    checking: "Checking...",
    inspecting: "Inspecting selected workspaces.",
    missing: "MISSING",
    mapped: "MAPPED",
    unchanged: "UNCHANGED",
    samePath: "same path",
    noneRequired: "No workspace paths are required for this selection.",
    resolveAll: "Map every missing workspace to an existing directory before review.",
    mapTitle: "Map workspace",
    source: "Source",
    directoryCandidates: "Directory candidates",
    noDirectoryCandidates: "No matching directories",
    completionHelp: "Up/Down chooses · Enter fills choice / confirms path · Tab completes · Ctrl+U clears · Esc cancels",
    invalidDirectory: "Enter or choose an existing absolute directory.",
    targetPrompt: "Target directory: ",
    sessionCount: (count) => `${count} session${count === 1 ? "" : "s"}`,
    readyCount: (count) => `${count} path${count === 1 ? "" : "s"} ready`,
    missingCount: (count) => `${count} path${count === 1 ? "" : "s"} missing`,
  },
  review: {
    title: "Review import",
    preparing: "Preparing...",
    runningPreflight: "Running the complete dry-run preflight.",
    preflightFailed: "Preflight failed",
    noChangesWritten: "No changes written",
    overview: "Overview",
    routes: "Routes",
    nativeImports: "Native imports",
    conversions: "Cross-Agent conversions",
    sessions: "Sessions",
    impact: "Impact",
    technicalDetails: "Technical details",
    technicalDetail: "Technical detail",
    targetSettings: "Target settings",
    workspaces: "Workspaces",
    dryRunComplete: "Dry-run complete · Nothing written",
    confirmTitle: "Confirm import",
    applyingTitle: "Applying import",
    writingTransaction: "Writing the prepared transaction.",
    genericFailure: "AgentHist could not safely prepare this import.",
    openCodeFailure: "The selected OpenCode histories could not be combined safely.",
    genericGuidance: "Go back and review the selected sessions, target Agents, and workspace paths before retrying.",
    openCodeGuidance: "Go back and change the OpenCode selection or target route. If the same error remains, update AgentHist before retrying.",
    blockedReasonFallback: "conversion cannot be represented safely",
    selectedAgentHistories: "the selected Agent histories",
    confirmGuidance: "The dry-run is complete. Enter writes the prepared import; Esc returns to review.",
    quality: (quality) => quality === "native" ? "NATIVE" : quality === "exact" ? "EXACT" :
      quality === "degraded" ? "WITH LOSS" : "BLOCKED",
    finding: (disposition) => disposition === "degraded" ? "CHANGED" : disposition === "skipped" ? "OMITTED" :
      disposition === "synthesized" ? "RECONSTRUCTED" : disposition.toUpperCase(),
    impactCount: (disposition, count) => {
      const label = disposition === "blocked" ? "blocker" : disposition === "degraded" ? "changed" :
        disposition === "skipped" ? "omitted" : "reconstructed";
      return `${count} ${label}${disposition === "blocked" && count !== 1 ? "s" : ""}`;
    },
    itemCount: (count, item) => `${count} ${item}${count === 1 ? "" : "s"}`,
    status: (status, newSessions, blocked, withLoss) => {
      if (status === "blocked") return `BLOCKED · ${blocked} SESSION${blocked === 1 ? "" : "S"}`;
      if (status === "ready_empty") return "READY · NOTHING NEW";
      return `READY · ${newSessions} NEW${withLoss > 0 ? ` · ${withLoss} WITH LOSS` : ""}`;
    },
    overviewSummary: (selected, blocked, newSessions, alreadyPresent) => blocked > 0
      ? `${selected} selected · ${blocked} blocked`
      : `${selected} selected · ${newSessions} new · ${alreadyPresent} already on target`,
    blockedSessions: (count) => `Blocked sessions · ${count}`,
    mappedCount: (count) => `${count} mapped`,
    unchangedCount: (count) => `${count} unchanged`,
    confirmSummary: (newSessions, alreadyPresent) => `${newSessions} new | ${alreadyPresent} already present`,
    applySummary: (newSessions, destinations) =>
      `Apply ${newSessions} new session${newSessions === 1 ? "" : "s"} to ${destinations}.`,
    excluded: (blocked, related) => `Excluded ${blocked} blocked session${blocked === 1 ? "" : "s"}` +
      (related === 0 ? "" : ` and ${related} related session${related === 1 ? "" : "s"}`),
    position: (start, end, total) => `${start}-${end}/${total}`,
  },
};

const ZH: ImportWizardCopy = {
  brand: "AgentHist 导入",
  steps: ["选择", "目标", "工作区", "检查"],
  actions: {
    back: "返回",
    exit: "退出",
    next: "下一步",
    move: "移动",
    scroll: "滚动",
    page: "翻页",
    switchPane: "切换栏",
    select: "选择",
    search: "搜索",
    changeSearch: "修改搜索",
    preview: "预览",
    selectAll: "全选",
    clearAll: "清空",
    choose: "确定",
    cancel: "取消",
    setTarget: "设置目标",
    changeProvider: "修改 Provider",
    editMapping: "修改映射",
    removeMapping: "移除映射",
    review: "检查",
    continue: "继续",
    showDetails: "展开详情",
    hideDetails: "收起详情",
    excludeBlocked: "排除阻断会话",
    apply: "执行",
    switchLanguage: "English",
  },
  common: {
    untitled: "（无标题）",
    unknown: "（未知）",
    pleaseWait: "请稍候",
    editHelp: "Esc 取消编辑；Ctrl+U 清空输入。",
    sources: "来源",
    scopes: "范围",
    sessions: "会话",
    allSessions: "全部会话",
    workspace: "工作区",
    updated: "更新时间",
    model: "模型",
    reference: "会话引用",
    route: "路线",
    provider: "Provider",
    resources: "资源",
    reason: "原因",
    sourceProviders: "各会话原有 Provider",
    current: "当前",
    currentMarker: "（当前）",
    native: "原生",
    convert: "转换",
    nativeAndConvert: "原生 + 转换",
    mixed: "混合",
  },
  preview: {
    title: "会话预览",
    loading: "正在从归档中读取会话...",
    conversation: "对话内容",
    you: "用户",
    gap: "缺口",
    collapsedGaps: (count) => `已折叠 ${count} 条技术记录`,
    moreGapTypes: (count) => `... 另有 ${count} 种记录`,
    emptyMessage: "（空消息）",
    noConversation: "（没有可读的对话内容）",
    messageTruncated: "... [消息已截断]",
    remainingLines: (count) => `下方还有 ${count} 行`,
    foldedTool: (phase, identity) => `[工具 ${phase}${identity === "" ? "" : ` ${identity}`}；详情已折叠]`,
    foldedResource: (name) => `[资源 ${name}；详情已折叠]`,
    foldedReference: "[历史引用；详情已折叠]",
    foldedReasoning: "[推理记录；详情已折叠]",
    historicalEvent: (event) => `[历史事件 ${event}]`,
    foldedBlock: (kind) => `[${kind}；详情已折叠]`,
  },
  selection: {
    title: "选择会话",
    noMatches: "没有会话符合当前搜索条件。",
    searchTitle: "搜索会话",
    searchHelp: "匹配标题、工作区、模型、原生 ID 或会话引用。",
    searchPrompt: "搜索：",
    selectRequired: "请至少选择一个会话后再继续。",
    previewPaneRequired: "请先切换到会话栏再预览对话。",
    summary: (selected, required) => `已选择 ${selected} 个${required > 0 ? `，另有 ${required} 个必选会话` : ""}`,
    searchStatus: (query, context) => `搜索：${query}  |  范围：${context}`,
    scopeStatus: (context) => `范围：${context}`,
  },
  targets: {
    title: "选择目标 Agent",
    chooserTitle: "设置目标 Agent",
    currentlyMixed: "当前目标不一致",
    allNative: "全部原生导入",
    readingProviders: "正在读取 Codex Provider",
    checkingProviders: "正在检查本机历史中已有的 Provider ID。",
    previewPaneRequired: "请先切换到会话栏再预览对话。",
    destinationCount: (count) => `为 ${count} 个会话设置目标 Agent。`,
    currentTarget: (agent) => `当前目标：${agent}`,
    crossAgentCount: (count) => `${count} 个跨 Agent 转换`,
    targetProvider: (provider) => `目标 Provider：${provider}`,
  },
  providers: {
    chooseTitle: "选择 Codex Provider",
    keepSource: "保留各会话原有的 Provider",
    enterAnother: "输入其他 Provider ID...",
    enterTitle: "输入 Codex Provider",
    enterHelp: "输入导入后的 Codex 历史所使用的 Provider ID。",
    prompt: "Provider：",
    invalid: "Provider ID 只能包含字母、数字、'.'、'_' 和 '-'。",
    currentMachine: (provider) => `本机当前：${provider}`,
    existingSessions: (count) => `${count} 个现有会话`,
    pagePosition: (start, end, total) => `${start}-${end} / ${total}`,
  },
  workspaces: {
    title: "工作区路径",
    checking: "检查中...",
    inspecting: "正在检查所选会话的工作区。",
    missing: "缺失",
    mapped: "已映射",
    unchanged: "未修改",
    samePath: "原路径",
    noneRequired: "当前选择不需要处理工作区路径。",
    resolveAll: "请将所有缺失的工作区映射到已有目录后再继续。",
    mapTitle: "映射工作区",
    source: "来源",
    directoryCandidates: "候选目录",
    noDirectoryCandidates: "没有匹配的目录",
    completionHelp: "上下键选择 · Enter 填入候选 / 确认路径 · Tab 补全 · Ctrl+U 清空 · Esc 取消",
    invalidDirectory: "请输入或选择一个已有的绝对目录。",
    targetPrompt: "目标目录：",
    sessionCount: (count) => `${count} 个会话`,
    readyCount: (count) => `${count} 个路径可用`,
    missingCount: (count) => `${count} 个路径缺失`,
  },
  review: {
    title: "检查导入方案",
    preparing: "准备中...",
    runningPreflight: "正在执行完整预检。",
    preflightFailed: "预检失败",
    noChangesWritten: "未写入任何内容",
    overview: "概览",
    routes: "导入路线",
    nativeImports: "原生导入",
    conversions: "跨 Agent 转换",
    sessions: "会话",
    impact: "影响",
    technicalDetails: "技术详情",
    technicalDetail: "技术信息",
    targetSettings: "目标设置",
    workspaces: "工作区",
    dryRunComplete: "预检完成 · 未写入任何内容",
    confirmTitle: "确认导入",
    applyingTitle: "正在导入",
    writingTransaction: "正在写入已准备的事务。",
    genericFailure: "AgentHist 无法安全地准备本次导入。",
    openCodeFailure: "所选 OpenCode 历史无法安全合并。",
    genericGuidance: "请返回检查所选会话、目标 Agent 和工作区路径后重试。",
    openCodeGuidance: "请返回修改 OpenCode 会话选择或目标路线；如果问题仍然存在，请更新 AgentHist 后重试。",
    blockedReasonFallback: "该转换无法安全表示",
    selectedAgentHistories: "所选 Agent 的历史记录",
    confirmGuidance: "预检已经完成。按 Enter 写入准备好的导入内容；按 Esc 返回检查页面。",
    quality: (quality) => quality === "native" ? "原生" : quality === "exact" ? "无损" :
      quality === "degraded" ? "有损" : "阻断",
    finding: (disposition) => disposition === "degraded" ? "已变更" : disposition === "skipped" ? "已省略" :
      disposition === "synthesized" ? "已重建" : disposition === "blocked" ? "阻断" : "无损",
    impactCount: (disposition, count) => `${count} 项${
      disposition === "blocked" ? "阻断" : disposition === "degraded" ? "变更" :
        disposition === "skipped" ? "省略" : "重建"}`,
    itemCount: (count, item) => `${count} 个${item === "session" ? "会话" : "项目"}`,
    status: (status, newSessions, blocked, withLoss) => {
      if (status === "blocked") return `已阻断 · ${blocked} 个会话`;
      if (status === "ready_empty") return "就绪 · 没有新增会话";
      return `就绪 · ${newSessions} 个新增${withLoss > 0 ? ` · ${withLoss} 个有损` : ""}`;
    },
    overviewSummary: (selected, blocked, newSessions, alreadyPresent) => blocked > 0
      ? `已选择 ${selected} 个 · ${blocked} 个阻断`
      : `已选择 ${selected} 个 · ${newSessions} 个新增 · ${alreadyPresent} 个已存在`,
    blockedSessions: (count) => `阻断会话 · ${count}`,
    mappedCount: (count) => `${count} 个已映射`,
    unchangedCount: (count) => `${count} 个未修改`,
    confirmSummary: (newSessions, alreadyPresent) => `${newSessions} 个新增 | ${alreadyPresent} 个已存在`,
    applySummary: (newSessions, destinations) => `将 ${newSessions} 个新会话导入：${destinations}。`,
    excluded: (blocked, related) => `已排除 ${blocked} 个阻断会话${related === 0 ? "" : `及 ${related} 个关联会话`}`,
    position: (start, end, total) => `${start}-${end}/${total}`,
  },
};

const COPY: Readonly<Record<ImportWizardLanguage, ImportWizardCopy>> = { en: EN, zh: ZH };

export function importWizardCopy(language: ImportWizardLanguage): ImportWizardCopy {
  return COPY[language];
}

export function detectImportWizardLanguage(
  environment: NodeJS.ProcessEnv,
  systemLocale = Intl.DateTimeFormat().resolvedOptions().locale,
): ImportWizardLanguage {
  const locale = [environment.LC_ALL, environment.LC_MESSAGES, environment.LANGUAGE, environment.LANG]
    .find((value) => (value?.trim() ?? "") !== "") ?? systemLocale;
  return /^zh(?:[_-]|\.|$)/iu.test(locale.trim().split(":", 1)[0] ?? "") ? "zh" : "en";
}

export function toggleImportWizardLanguage(language: ImportWizardLanguage): ImportWizardLanguage {
  return language === "en" ? "zh" : "en";
}
