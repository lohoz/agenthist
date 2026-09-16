import { ArrowLeft, EyeOff, RefreshCw, Search, Settings2, TriangleAlert, X } from "lucide-react";
import { useRef, useState } from "react";

import type {
  Agent,
  AgentHistDesktopApi,
  AgentSettingDto,
  ChatSummaryDto,
  DesktopAgentFilter,
  DesktopError,
  ScanProgressDto,
} from "../../contracts.js";
import { classes } from "../lib/display.js";
import { ChatList } from "./ChatList.js";
import { AgentLogo } from "./AgentLogo.js";
import { ConversationPane } from "./ConversationPane.js";
import { TransferActions } from "./TransferActions.js";

interface ChatsPageProps {
  readonly api: AgentHistDesktopApi;
  readonly agentSettings: readonly AgentSettingDto[];
  readonly chats: readonly ChatSummaryDto[];
  readonly total: number;
  readonly query: string;
  readonly filter: DesktopAgentFilter;
  readonly libraryState: "active" | "deleted";
  readonly selected: ChatSummaryDto | undefined;
  readonly selectedSessionRefs: ReadonlySet<string>;
  readonly selectionBusy: ReadonlySet<string>;
  readonly listLoading: boolean;
  readonly loadingMore: boolean;
  readonly refreshing: boolean;
  readonly listError: DesktopError | undefined;
  readonly refreshError: DesktopError | undefined;
  readonly scanProgress: ScanProgressDto | undefined;
  readonly showTechnicalDetails: boolean;
  readonly onQueryChange: (query: string) => void;
  readonly onFilterChange: (filter: DesktopAgentFilter) => void;
  readonly onLibraryStateChange: (state: "active" | "deleted") => void;
  readonly onSelect: (chat: ChatSummaryDto) => void;
  readonly onToggleChatSelection: (chat: ChatSummaryDto, selected: boolean) => void;
  readonly onToggleWorkspaceSelection: (
    workspace: string,
    agent: Agent | undefined,
    chats: readonly ChatSummaryDto[],
    selected: boolean,
  ) => void;
  readonly onClearSelection: () => void;
  readonly onLoadMore: () => void;
  readonly onRefresh: () => void;
  readonly onRetryList: () => void;
  readonly onOpenQuickSearch: () => void;
  readonly onOpenSettings: () => void;
  readonly onShowTechnicalDetailsChange: (show: boolean) => void;
  readonly onNotice: (message: string) => void;
  readonly onChatHidden: (sessionRef: string) => void;
  readonly onChatRestored: (sessionRef: string) => void;
  readonly onImported: () => void;
  readonly onResumed: (sessionRef: string) => void;
}

const FILTERS: ReadonlyArray<{ readonly id: DesktopAgentFilter; readonly label: string }> = [
  { id: "all", label: "全部" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi" },
];

export function ChatsPage({
  api,
  agentSettings,
  chats,
  total,
  query,
  filter,
  libraryState,
  selected,
  selectedSessionRefs,
  selectionBusy,
  listLoading,
  loadingMore,
  refreshing,
  listError,
  refreshError,
  scanProgress,
  showTechnicalDetails,
  onQueryChange,
  onFilterChange,
  onLibraryStateChange,
  onSelect,
  onToggleChatSelection,
  onToggleWorkspaceSelection,
  onClearSelection,
  onLoadMore,
  onRefresh,
  onRetryList,
  onOpenQuickSearch,
  onOpenSettings,
  onShowTechnicalDetailsChange,
  onNotice,
  onChatHidden,
  onChatRestored,
  onImported,
  onResumed,
}: ChatsPageProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [bulkExporting, setBulkExporting] = useState(false);
  const hiddenView = libraryState === "deleted";
  const unfiltered = query.trim() === "" && filter === "all";
  const pristineEmpty = !hiddenView && chats.length === 0 && unfiltered;
  const exportSelected = async (): Promise<void> => {
    if (hiddenView || bulkExporting || selectedSessionRefs.size === 0) return;
    setBulkExporting(true);
    try {
      const result = await api.exportHistory({ scope: "sessions", sessionRefs: [...selectedSessionRefs] });
      if (!result.ok) onNotice(`导出失败 · ${result.error.message}`);
      else if (result.value.status === "cancelled") onNotice("已取消导出");
      else {
        onNotice(`已导出 ${result.value.entries} 个对话`);
        onClearSelection();
      }
    } catch {
      onNotice("导出失败 · 桌面桥接没有完成请求。");
    } finally {
      setBulkExporting(false);
    }
  };
  return (
    <div className="chats-layout">
      <section className="conversation-library" aria-label="对话历史">
        <header className="library-header">
          <div className="library-title-row">
            <div>
              <p className="eyebrow">{hiddenView ? "AgentHist 隐藏记录" : "本地历史"}</p>
              <h1>{hiddenView ? "已隐藏对话" : "对话"}</h1>
            </div>
            <div className="library-actions">
              <button
                className={classes("library-view-toggle", hiddenView && "is-active")}
                type="button"
                onClick={() => onLibraryStateChange(hiddenView ? "active" : "deleted")}
              >
                {hiddenView
                  ? <ArrowLeft size={14} aria-hidden="true" />
                  : <EyeOff size={14} aria-hidden="true" />}
                <span>{hiddenView ? "返回当前对话" : "查看已隐藏"}</span>
              </button>
              <button
                className="quiet-icon-button"
                type="button"
                aria-label="刷新对话"
                title="刷新对话"
                disabled={refreshing}
                onClick={onRefresh}
              >
                <RefreshCw className={refreshing ? "spin" : undefined} size={17} />
              </button>
              {hiddenView ? null : <TransferActions api={api} onNotice={onNotice} onImported={onImported} />}
            </div>
          </div>
          <div className="search-control">
            <Search size={16} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="搜索对话…"
              aria-label="搜索对话"
              onChange={(event) => onQueryChange(event.target.value)}
            />
            {query === "" ? (
              <button className="search-shortcut" type="button" onClick={onOpenQuickSearch} aria-label="打开快速搜索">
                Ctrl K
              </button>
            ) : (
              <button type="button" className="clear-search" aria-label="清除搜索" onClick={() => {
                onQueryChange("");
                searchRef.current?.focus();
              }}><X size={14} /></button>
            )}
          </div>
          <div className="agent-filters" aria-label="按 Agent 筛选对话">
            {FILTERS.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={filter === item.id}
                className={classes(filter === item.id && "is-selected")}
                onClick={() => onFilterChange(item.id)}
              >
                {item.id === "all" ? null : <AgentLogo agent={item.id} size={15} />}{item.label}
              </button>
            ))}
          </div>
          {hiddenView || selectedSessionRefs.size === 0 ? null : (
            <div className="bulk-selection-bar" role="status">
              <span>已选择 {selectedSessionRefs.size} 条历史记录</span>
              <button type="button" disabled={bulkExporting} onClick={() => void exportSelected()}>
                {bulkExporting ? "正在导出…" : "导出所选"}
              </button>
              <button type="button" disabled={bulkExporting} onClick={onClearSelection}>清除</button>
            </div>
          )}
          <ScanStatus progress={scanProgress} refreshing={refreshing} />
          {refreshError === undefined ? null : (
            <div className="compact-warning" role="status">
              <TriangleAlert size={14} />
              <span>刷新未完全成功：{refreshError.message}</span>
              {refreshError.retryable ? (
                <button type="button" disabled={refreshing} onClick={onRefresh}>重试</button>
              ) : null}
            </div>
          )}
        </header>

        <div className="library-body" aria-busy={listLoading}>
          {listError !== undefined ? (
            <div className="list-error" role="alert">
              <TriangleAlert size={21} />
              <strong>无法加载对话</strong>
              <span>{listError.message}</span>
              {listError.retryable ? <button type="button" onClick={onRetryList}>重试</button> : null}
            </div>
          ) : (
            <ChatList
              chats={chats}
              total={total}
              selectedSessionRef={selected?.sessionRef}
              selectedSessionRefs={selectedSessionRefs}
              selectionBusy={selectionBusy}
              selectionEnabled={!hiddenView}
              loadingMore={loadingMore}
              emptyTitle={hiddenView
                ? unfiltered ? "没有已隐藏的对话" : "没有匹配的已隐藏对话"
                : unfiltered ? "还没有发现编程对话" : "没有匹配的对话"}
              emptyDescription={hiddenView && unfiltered
                ? "从当前对话中隐藏的记录会显示在这里，并可从详情菜单恢复。"
                : hiddenView
                  ? "请尝试其他关键词或 Agent 筛选条件。"
                  : unfiltered
                    ? "支持的 Coding Agent 产生对话后会显示在这里。"
                    : "请尝试其他关键词或 Agent 筛选条件。"}
              emptyActions={hiddenView && unfiltered ? (
                <div className="empty-list-actions">
                  <button className="secondary-button" type="button" onClick={() => onLibraryStateChange("active")}>
                    <ArrowLeft size={14} aria-hidden="true" />返回当前对话
                  </button>
                </div>
              ) : pristineEmpty ? (
                <div className="empty-list-actions">
                  <button className="primary-button" type="button" disabled={refreshing} onClick={onRefresh}>
                    <RefreshCw className={refreshing ? "spin" : undefined} size={14} aria-hidden="true" />
                    {refreshing ? "正在扫描…" : "扫描本机历史"}
                  </button>
                  <button className="secondary-button" type="button" onClick={onOpenSettings}>
                    <Settings2 size={14} aria-hidden="true" />打开设置
                  </button>
                </div>
              ) : (
                <div className="empty-list-actions">
                  <button className="secondary-button" type="button" onClick={() => {
                    onQueryChange("");
                    onFilterChange("all");
                  }}>
                    清除搜索和筛选
                  </button>
                </div>
              )}
              onLoadMore={onLoadMore}
              onSelect={onSelect}
              onToggleChatSelection={onToggleChatSelection}
              onToggleWorkspaceSelection={onToggleWorkspaceSelection}
            />
          )}
          {listLoading ? <div className="list-refresh-overlay" aria-label="正在更新结果" /> : null}
        </div>
      </section>

      <ConversationPane
        api={api}
        agentSettings={agentSettings}
        chat={selected}
        showTechnicalDetails={showTechnicalDetails}
        onShowTechnicalDetailsChange={onShowTechnicalDetailsChange}
        onNotice={onNotice}
        onChatHidden={onChatHidden}
        onChatRestored={onChatRestored}
        onResumed={onResumed}
        placeholderMode={hiddenView && chats.length === 0
          ? "hidden"
          : pristineEmpty ? "empty" : chats.length === 0 ? "filtered" : "select"}
      />
    </div>
  );
}

function ScanStatus({ progress, refreshing }: {
  readonly progress: ScanProgressDto | undefined;
  readonly refreshing: boolean;
}) {
  if (!refreshing && progress?.phase !== "scanning") return null;
  const message = progress?.phase === "scanning"
    ? `正在刷新 ${progress.agent} · ${progress.currentAgent}/${progress.totalAgents}`
    : progress?.phase === "detecting" ? "正在检查本地 Agent…" : "正在刷新本地历史…";
  return <div className="scan-status"><span className="status-pulse" />{message}</div>;
}
