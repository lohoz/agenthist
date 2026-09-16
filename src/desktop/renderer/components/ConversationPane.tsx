import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  ChevronDown,
  Code2,
  CornerDownRight,
  Download,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Trash2,
  Undo2,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  Agent,
  AgentHistDesktopApi,
  AgentSettingDto,
  ChatSummaryDto,
  ConversationItemDto,
  ConversationMatchDto,
  ConversationPageDto,
  DesktopError,
  ResumeConfirmResultDto,
  ResumePlanDto,
} from "../../contracts.js";
import { AGENT_LABELS, classes, formatAbsoluteTime } from "../lib/display.js";
import { MarkdownMessage, type ClipboardWriter } from "./MarkdownMessage.js";
import { ResumeDialog } from "./ResumeDialog.js";
import { AgentLogo } from "./AgentLogo.js";
import { TechnicalDetailView } from "./TechnicalDetailView.js";

const PAGE_SIZE = 80;

interface ConversationState {
  readonly chat: ChatSummaryDto;
  readonly model: string;
  readonly provider: string;
  readonly total: number;
  readonly items: readonly (ConversationItemDto | undefined)[];
}

interface ConversationPaneProps {
  readonly api: AgentHistDesktopApi;
  readonly agentSettings: readonly AgentSettingDto[];
  readonly chat: ChatSummaryDto | undefined;
  readonly showTechnicalDetails: boolean;
  readonly onShowTechnicalDetailsChange: (show: boolean) => void;
  readonly onNotice: (message: string) => void;
  readonly onChatHidden: (sessionRef: string) => void;
  readonly onChatRestored?: (sessionRef: string) => void;
  readonly onResumed?: (sessionRef: string) => void;
  readonly writeClipboard?: ClipboardWriter;
  readonly placeholderMode?: "select" | "empty" | "filtered" | "hidden";
}

export function ConversationPane({
  api,
  agentSettings,
  chat,
  showTechnicalDetails,
  onShowTechnicalDetailsChange,
  onNotice,
  onChatHidden,
  onChatRestored,
  onResumed,
  writeClipboard,
  placeholderMode = "select",
}: ConversationPaneProps) {
  const sessionRef = chat?.sessionRef;
  const memberSessionRefs = chat?.memberSessionRefs ?? (sessionRef === undefined ? [] : [sessionRef]);
  const [conversation, setConversation] = useState<ConversationState>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DesktopError>();
  const [pageError, setPageError] = useState<DesktopError>();
  const requestedPages = useRef(new Set<number>());
  const requestGeneration = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState<readonly ConversationMatchDto[]>([]);
  const [findIndex, setFindIndex] = useState(0);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string>();
  const [highlightedIndex, setHighlightedIndex] = useState<number>();
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeTarget, setResumeTarget] = useState<Agent>(chat?.agent ?? "codex");
  const [resumePlan, setResumePlan] = useState<ResumePlanDto>();
  const [resumeOutcome, setResumeOutcome] = useState<Extract<ResumeConfirmResultDto, { readonly status: "launched" }>>();
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeConfirming, setResumeConfirming] = useState(false);
  const [resumeError, setResumeError] = useState<DesktopError>();
  const [resumeReplanMessage, setResumeReplanMessage] = useState<string>();
  const [nativeResumeBusy, setNativeResumeBusy] = useState(false);
  const [hideDialogOpen, setHideDialogOpen] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [exportingConversation, setExportingConversation] = useState(false);
  const resumeGeneration = useRef(0);

  const readyAgents = useMemo(
    () => agentSettings.filter((agent) => agent.executable.available),
    [agentSettings],
  );

  const clearResume = useCallback((): void => {
    setResumePlan(undefined);
    setResumeOutcome(undefined);
    setResumeError(undefined);
    setResumeReplanMessage(undefined);
    setResumeLoading(false);
    setResumeConfirming(false);
  }, []);

  const confirmResumePlan = useCallback(async (
    plan: ResumePlanDto,
    immediateNative: boolean,
    generation: number,
  ): Promise<void> => {
    setResumeConfirming(true);
    setResumeError(undefined);
    try {
      const result = await api.confirmResume({
        sessionRef: plan.source.sessionRef,
        targetAgent: plan.targetAgent,
        ...(plan.findings.some((finding) => finding.code === "portable.lossy_text_fallback")
          ? { allowLossyConversion: true }
          : {}),
        expectedPlanRef: plan.planRef,
      });
      if (result.ok && result.value.status === "launched" && result.value.plan.route !== "native") {
        onResumed?.(result.value.targetSessionRef);
      }
      if (generation !== resumeGeneration.current) return;
      setResumeConfirming(false);
      setNativeResumeBusy(false);
      if (!result.ok) {
        setResumeError(result.error);
        setResumeOpen(true);
        return;
      }
      if (result.value.status === "launched") {
        if (immediateNative) {
          onNotice(`${AGENT_LABELS[result.value.targetAgent]} 已启动 · PID ${result.value.pid} · 已打开原生对话`);
          setResumeOpen(false);
          return;
        }
        setResumeOutcome(result.value);
        setResumeOpen(true);
        return;
      }
      setResumePlan(result.value.plan);
      setResumeOpen(true);
      setResumeReplanMessage(result.value.status === "replan_required"
        ? "来源或目标发生变化，请重新检查计划后确认。"
        : "更新后的计划仍被阻止，未启动 Agent。" );
    } catch (error) {
      if (generation !== resumeGeneration.current) return;
      setResumeConfirming(false);
      setNativeResumeBusy(false);
      setResumeError(toDesktopError(error, "无法确认继续对话。"));
      setResumeOpen(true);
    }
  }, [api, onNotice, onResumed]);

  const planResume = useCallback(async (
    targetAgent: Agent,
    immediateNative: boolean,
    allowLossyConversion = false,
  ): Promise<void> => {
    if (sessionRef === undefined) return;
    const generation = ++resumeGeneration.current;
    clearResume();
    setResumeTarget(targetAgent);
    setResumeLoading(true);
    setNativeResumeBusy(immediateNative);
    if (!immediateNative) setResumeOpen(true);
    try {
      const result = await api.planResume({
        sessionRef,
        targetAgent,
        ...(allowLossyConversion ? { allowLossyConversion: true } : {}),
      });
      if (generation !== resumeGeneration.current) return;
      setResumeLoading(false);
      if (!result.ok) {
        setNativeResumeBusy(false);
        setResumeError(result.error);
        setResumeOpen(true);
        return;
      }
      setResumePlan(result.value);
      if (immediateNative && result.value.route === "native" && result.value.quality === "native" &&
        result.value.targetAvailable) {
        await confirmResumePlan(result.value, true, generation);
        return;
      }
      setNativeResumeBusy(false);
      setResumeOpen(true);
    } catch (error) {
      if (generation !== resumeGeneration.current) return;
      setResumeLoading(false);
      setNativeResumeBusy(false);
      setResumeError(toDesktopError(error, "无法规划继续对话。"));
      setResumeOpen(true);
    }
  }, [api, clearResume, confirmResumePlan, sessionRef]);

  const changeResumeOpen = (open: boolean): void => {
    if (!open && !resumeConfirming) {
      resumeGeneration.current += 1;
      clearResume();
    }
    setResumeOpen(open);
  };

  const openWorkspace = async (): Promise<void> => {
    if (sessionRef === undefined) return;
    try {
      const result = await api.openWorkspace({ sessionRef });
      if (result.ok) onNotice(`已打开工作区 · ${result.value.workspace}`);
      else onNotice(`无法打开工作区 · ${result.error.message}`);
    } catch (error) {
      onNotice(toDesktopError(error, "无法打开工作区。" ).message);
    }
  };

  const hideConversation = async (): Promise<void> => {
    if (sessionRef === undefined || mutationBusy) return;
    setMutationBusy(true);
    try {
      let changed = false;
      for (const memberSessionRef of memberSessionRefs) {
        const result = await api.updateChat({ sessionRef: memberSessionRef, operation: "delete" });
        if (!result.ok) {
          onNotice(`无法隐藏对话 · ${result.error.message}`);
          return;
        }
        changed ||= result.value.changed;
      }
      onNotice(changed ? "对话已从 AgentHist 中隐藏" : "对话已经处于隐藏状态");
      onChatHidden(sessionRef);
    } catch (error) {
      onNotice(toDesktopError(error, "无法隐藏对话。" ).message);
    } finally {
      setMutationBusy(false);
      setHideDialogOpen(false);
    }
  };

  const exportConversation = async (): Promise<void> => {
    if (sessionRef === undefined || exportingConversation) return;
    setExportingConversation(true);
    try {
      const result = await api.exportHistory({ scope: "sessions", sessionRefs: [...memberSessionRefs] });
      if (!result.ok) onNotice(`导出失败 · ${result.error.message}`);
      else if (result.value.status === "cancelled") onNotice("已取消导出");
      else onNotice(`已导出对话 · 共 ${result.value.entries} 条记录`);
    } catch {
      onNotice("导出失败 · 桌面桥接没有完成请求。" );
    } finally {
      setExportingConversation(false);
    }
  };

  const restoreConversation = async (): Promise<void> => {
    if (sessionRef === undefined || mutationBusy) return;
    setMutationBusy(true);
    try {
      for (const memberSessionRef of memberSessionRefs) {
        const result = await api.updateChat({ sessionRef: memberSessionRef, operation: "undelete" });
        if (!result.ok) {
          onNotice(`无法恢复到当前对话 · ${result.error.message}`);
          return;
        }
        if (result.value.state === "archived") {
          const unarchived = await api.updateChat({ sessionRef: memberSessionRef, operation: "unarchive" });
          if (!unarchived.ok) {
            onNotice(`无法恢复到当前对话 · ${unarchived.error.message}；对话已取消隐藏但仍在归档中，可重试恢复`);
            return;
          }
          if (unarchived.value.state !== "active") {
            onNotice("无法恢复到当前对话 · 对话状态仍不可见，请重试恢复");
            return;
          }
        } else if (result.value.state !== "active") {
          onNotice("无法恢复到当前对话 · 对话状态仍不可见，请重试恢复");
          return;
        }
      }
      onNotice("对话已恢复到当前对话");
      onChatRestored?.(sessionRef);
    } catch (error) {
      onNotice(toDesktopError(error, "无法恢复对话。" ).message);
    } finally {
      setMutationBusy(false);
    }
  };

  const mergePage = useCallback((page: ConversationPageDto): void => {
    setConversation((current) => {
      const items = current?.chat.sessionRef === page.chat.sessionRef && current.total === page.total
        ? [...current.items]
        : Array<ConversationItemDto | undefined>(page.total);
      for (const item of page.items) {
        const position = item.index >= 0 && item.index < page.total
          ? item.index
          : page.offset + page.items.indexOf(item);
        if (position >= 0 && position < items.length) items[position] = item;
      }
      return { chat: page.chat, model: page.model, provider: page.provider, total: page.total, items };
    });
  }, []);

  const loadPage = useCallback(async (offset: number, generation = requestGeneration.current): Promise<boolean> => {
    if (sessionRef === undefined || requestedPages.current.has(offset)) return false;
    requestedPages.current.add(offset);
    try {
      const result = await api.getConversation({ sessionRef, offset, limit: PAGE_SIZE });
      if (generation !== requestGeneration.current) return false;
      if (!result.ok) {
        requestedPages.current.delete(offset);
        if (offset === 0) setError(result.error);
        else setPageError(result.error);
        return false;
      }
      setError(undefined);
      setPageError(undefined);
      mergePage(result.value);
      return true;
    } catch {
      if (generation !== requestGeneration.current) return false;
      requestedPages.current.delete(offset);
      const bridgeFailure: DesktopError = {
        code: "renderer.conversation_failed",
        message: "桌面桥接没有完成对话请求。",
        retryable: true,
      };
      if (offset === 0) setError(bridgeFailure);
      else setPageError(bridgeFailure);
      return false;
    }
  }, [api, mergePage, sessionRef]);

  useEffect(() => {
    resumeGeneration.current += 1;
    setResumeOpen(false);
    clearResume();
    setNativeResumeBusy(false);
    setHideDialogOpen(false);
  }, [clearResume, sessionRef]);

  useEffect(() => {
    requestGeneration.current += 1;
    const generation = requestGeneration.current;
    requestedPages.current.clear();
    setConversation(undefined);
    setError(undefined);
    setPageError(undefined);
    setFindOpen(false);
    setFindQuery("");
    setFindMatches([]);
    setFindIndex(0);
    setFinding(false);
    setFindError(undefined);
    setHighlightedIndex(undefined);
    if (sessionRef === undefined) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadPage(0, generation).finally(() => {
      if (generation === requestGeneration.current) setLoading(false);
    });
  }, [chat?.updatedAt, loadPage, sessionRef]);

  const virtualizer = useVirtualizer({
    count: conversation?.total ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = conversation?.items[index];
      return item?.kind === "message" ? Math.min(520, Math.max(90, 74 + item.text.length * 0.12)) : 44;
    },
    overscan: 6,
    getItemKey: (index) => index,
    initialRect: { width: 760, height: 720 },
    initialOffset: 0,
    useFlushSync: false,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const visiblePages = useMemo(() => {
    const pages = new Set<number>();
    for (const row of virtualRows) {
      if (conversation?.items[row.index] === undefined) pages.add(Math.floor(row.index / PAGE_SIZE) * PAGE_SIZE);
    }
    return [...pages].sort((left, right) => left - right);
  }, [conversation?.items, virtualRows]);

  useEffect(() => {
    for (const offset of visiblePages) void loadPage(offset);
  }, [loadPage, visiblePages.join(",")]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (sessionRef === undefined || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setFindOpen(true);
      window.setTimeout(() => findInputRef.current?.focus(), 0);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [sessionRef]);

  useEffect(() => {
    if (!findOpen || sessionRef === undefined || findQuery.trim() === "") {
      setFindMatches([]);
      setFindIndex(0);
      setFindError(undefined);
      setFinding(false);
      return;
    }
    const generation = requestGeneration.current;
    let active = true;
    const timeout = window.setTimeout(() => {
      setFinding(true);
      setFindError(undefined);
      void api.findInConversation({ sessionRef, query: findQuery.trim() }).then((result) => {
        if (!active || generation !== requestGeneration.current) return;
        setFinding(false);
        if (!result.ok) {
          setFindError(result.error.message);
          setFindMatches([]);
          return;
        }
        setFindMatches(result.value.matches);
        setFindIndex(0);
        const first = result.value.matches[0];
        if (first !== undefined) void jumpToMatch(first);
      }).catch(() => {
        if (!active || generation !== requestGeneration.current) return;
        setFinding(false);
        setFindMatches([]);
        setFindError("桌面桥接没有完成对话搜索。" );
      });
    }, 160);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [api, findOpen, findQuery, sessionRef]);

  const jumpToMatch = useCallback(async (match: ConversationMatchDto): Promise<void> => {
    const offset = Math.floor(match.index / PAGE_SIZE) * PAGE_SIZE;
    await loadPage(offset);
    setHighlightedIndex(match.index);
    window.requestAnimationFrame(() => virtualizer.scrollToIndex(match.index, { align: "center" }));
  }, [loadPage, virtualizer]);

  const moveMatch = (direction: 1 | -1): void => {
    if (findMatches.length === 0) return;
    const next = (findIndex + direction + findMatches.length) % findMatches.length;
    setFindIndex(next);
    const match = findMatches[next];
    if (match !== undefined) void jumpToMatch(match);
  };

  if (chat === undefined) return <ConversationPlaceholder mode={placeholderMode} />;

  return (
    <section className="conversation-pane" aria-label="对话详情">
      <header className="conversation-header">
        <div className="conversation-heading">
          <div className="agent-glyph"><AgentLogo agent={chat.agent} size={19} /></div>
          <div>
            <h2>{chat.title || "未命名对话"}</h2>
            <div className="conversation-meta">
              <span>{AGENT_LABELS[chat.agent]}</span>
              <span aria-hidden="true">·</span>
              <span title={chat.workspace}>{chat.workspaceName || chat.workspace}</span>
              <span aria-hidden="true">·</span>
              <time dateTime={chat.updatedAt}>{formatAbsoluteTime(chat.updatedAt)}</time>
            </div>
          </div>
        </div>
        <div className="conversation-actions">
          <button
            className={classes("quiet-icon-button", showTechnicalDetails && "is-active")}
            type="button"
            aria-label="显示技术细节"
            aria-pressed={showTechnicalDetails}
            title="显示技术细节"
            onClick={() => onShowTechnicalDetailsChange(!showTechnicalDetails)}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
          </button>
          <button className="continue-button" type="button" disabled={nativeResumeBusy} onClick={() => void planResume(chat.agent, true)}>
            {nativeResumeBusy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <CornerDownRight size={16} aria-hidden="true" />}
            {nativeResumeBusy ? "正在检查…" : "继续"}
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="continue-menu-placeholder" type="button" aria-label="使用其他 Agent 继续">
                <ChevronDown size={15} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="action-menu" sideOffset={6} align="end">
                <DropdownMenu.Label>使用以下 Agent 继续</DropdownMenu.Label>
                {readyAgents.map((agent) => (
                  <DropdownMenu.Item key={agent.agent} onSelect={() => void planResume(agent.agent, false)}>
                    <AgentLogo agent={agent.agent} size={16} />
                    <span>{agent.label}</span>
                    {agent.agent === chat.agent ? <small>原 Agent</small> : null}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="quiet-icon-button" type="button" aria-label="更多对话操作">
                <MoreHorizontal size={17} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="action-menu" sideOffset={6} align="end">
                <DropdownMenu.Item onSelect={() => void openWorkspace()}>
                  <FolderOpen size={14} /><span>打开工作区</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item disabled={exportingConversation} onSelect={() => void exportConversation()}>
                  {exportingConversation ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
                  <span>{exportingConversation ? "正在导出…" : "导出对话…"}</span>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                {chat.libraryState === "deleted" ? (
                  <DropdownMenu.Item onSelect={() => void restoreConversation()}>
                    <Undo2 size={14} /><span>恢复到当前对话</span>
                  </DropdownMenu.Item>
                ) : (
                  <DropdownMenu.Item className="danger-menu-item" onSelect={() => setHideDialogOpen(true)}>
                    <Trash2 size={14} /><span>从 AgentHist 隐藏…</span>
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      {findOpen ? (
        <div className="conversation-find" role="search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={findInputRef}
            value={findQuery}
            aria-label="在对话中搜索"
            placeholder="在当前对话中查找"
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") moveMatch(event.shiftKey ? -1 : 1);
              if (event.key === "Escape") setFindOpen(false);
            }}
          />
          <span className={classes("find-count", findError !== undefined && "is-error")}>
            {findError ?? (finding ? "正在搜索…" : findQuery.trim() === "" ? "" : findMatches.length === 0 ? "无匹配" : `${findIndex + 1}/${findMatches.length}`)}
          </span>
          <button type="button" aria-label="上一个匹配" disabled={findMatches.length === 0} onClick={() => moveMatch(-1)}><ArrowUp size={15} /></button>
          <button type="button" aria-label="下一个匹配" disabled={findMatches.length === 0} onClick={() => moveMatch(1)}><ArrowDown size={15} /></button>
          <button type="button" aria-label="关闭对话搜索" onClick={() => setFindOpen(false)}><X size={15} /></button>
        </div>
      ) : null}

      {loading ? <ConversationLoading /> : error !== undefined ? (
        <ConversationError error={error} onRetry={() => {
          const generation = requestGeneration.current;
          setLoading(true);
          void loadPage(0, generation).finally(() => {
            if (generation === requestGeneration.current) setLoading(false);
          });
        }} />
      ) : conversation?.total === 0 ? (
        <div className="conversation-state"><p>此对话没有可阅读的消息。</p></div>
      ) : (
        <div className="conversation-scroll" ref={scrollRef} data-testid="conversation-scroll">
          <div className="virtual-conversation-spacer" style={{ height: virtualizer.getTotalSize() }}>
            {virtualRows.map((row) => {
              const item = conversation?.items[row.index];
              return (
                <div
                  className="virtual-conversation-row"
                  data-index={row.index}
                  key={row.key}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  {item === undefined ? <MessageSkeleton /> : (
                    <ConversationRow
                      api={api}
                      sessionRef={chat.sessionRef}
                      item={item}
                      highlighted={highlightedIndex === item.index}
                      showTechnicalDetails={showTechnicalDetails}
                      writeClipboard={writeClipboard}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {pageError === undefined ? null : (
            <button className="page-load-error" type="button" onClick={() => {
              const first = visiblePages[0];
              if (first !== undefined) void loadPage(first);
            }}>
              部分对话加载失败，点击重试
            </button>
          )}
        </div>
      )}
      <ResumeDialog
        open={resumeOpen}
        targetAgent={resumeTarget}
        plan={resumePlan}
        outcome={resumeOutcome}
        loading={resumeLoading}
        confirming={resumeConfirming}
        error={resumeError}
        replanMessage={resumeReplanMessage}
        onOpenChange={changeResumeOpen}
        onConfirm={() => {
          if (resumePlan !== undefined) void confirmResumePlan(resumePlan, false, resumeGeneration.current);
        }}
        onRetry={() => void planResume(resumeTarget, false)}
        onAllowLossy={() => void planResume(resumeTarget, false, true)}
      />
      <AlertDialog.Root open={hideDialogOpen} onOpenChange={setHideDialogOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="dialog-backdrop resume-dialog-backdrop" />
          <AlertDialog.Content className="alert-dialog">
            <AlertDialog.Title>隐藏此对话？</AlertDialog.Title>
            <AlertDialog.Description>
              这只会在 AgentHist 中隐藏该对话，不会删除或修改原始 {AGENT_LABELS[chat.agent]} 历史，之后仍可恢复。
            </AlertDialog.Description>
            <div className="alert-dialog-actions">
              <AlertDialog.Cancel className="secondary-button">取消</AlertDialog.Cancel>
              <AlertDialog.Action className="danger-button" disabled={mutationBusy} onClick={() => void hideConversation()}>
                {mutationBusy ? "正在隐藏…" : "隐藏对话"}
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}

interface ConversationRowProps {
  readonly api: AgentHistDesktopApi;
  readonly sessionRef: string;
  readonly item: ConversationItemDto;
  readonly highlighted: boolean;
  readonly showTechnicalDetails: boolean;
  readonly writeClipboard: ClipboardWriter | undefined;
}

function ConversationRow({ api, sessionRef, item, highlighted, showTechnicalDetails, writeClipboard }: ConversationRowProps) {
  if (item.kind === "gap") {
    return showTechnicalDetails ? (
      <div className={classes("technical-row", highlighted && "is-highlighted")}>
        <Code2 size={14} aria-hidden="true" />
        <span>{item.label}</span>
        {item.code === undefined ? null : <code>{item.code}</code>}
      </div>
    ) : <div className="collapsed-technical-row"><span>技术事件已折叠</span></div>;
  }

  if ((item.role === "system" || item.role === "developer") && !showTechnicalDetails) {
    return (
      <div className="collapsed-technical-row">
        <span>{item.role === "system" ? "系统上下文" : "开发者上下文"}已折叠</span>
      </div>
    );
  }

  const isUser = item.role === "user";
  const isAssistant = item.role === "assistant";
  return (
    <article className={classes("message-row", `role-${item.role}`, highlighted && "is-highlighted")}>
      <div className="message-avatar" aria-hidden="true">
        {isUser ? <UserRound size={15} /> : isAssistant ? <Bot size={16} /> : <Code2 size={15} />}
      </div>
      <div className="message-content">
        <div className="message-label">
          <strong>{isUser ? "用户" : isAssistant ? "助手" : item.role === "system" ? "系统" : "开发者"}</strong>
          <time dateTime={item.timestamp}>{formatAbsoluteTime(item.timestamp)}</time>
        </div>
        <MarkdownMessage text={item.text} writeClipboard={writeClipboard} />
        {showTechnicalDetails && item.technical.length > 0 ? (
          <div className="technical-details">
            {item.technical.map((detail) => (
              <TechnicalDetailView
                key={`${sessionRef}:${item.index}:${detail.id}`}
                api={api}
                sessionRef={sessionRef}
                itemIndex={item.index}
                detail={detail}
                writeClipboard={writeClipboard}
              />
            ))}
          </div>
        ) : item.technical.length > 0 ? (
          <span className="technical-count">已折叠 {item.technical.length} 项技术细节</span>
        ) : null}
      </div>
    </article>
  );
}

function ConversationPlaceholder({ mode }: { readonly mode: "select" | "empty" | "filtered" | "hidden" }) {
  if (mode === "hidden") {
    return (
      <div className="conversation-placeholder">
        <div className="placeholder-icon"><MessageSquareIcon /></div>
        <h2>没有已隐藏的对话</h2>
        <p>隐藏的记录会保留在 AgentHist 中，并可随时恢复。</p>
      </div>
    );
  }
  if (mode === "empty") {
    return (
      <div className="conversation-placeholder">
        <div className="placeholder-icon"><MessageSquareIcon /></div>
        <h2>尚无可阅读的对话</h2>
        <p>请从左侧扫描本机历史，或前往设置检查 Agent 路径。</p>
      </div>
    );
  }
  if (mode === "filtered") {
    return (
      <div className="conversation-placeholder">
        <div className="placeholder-icon"><MessageSquareIcon /></div>
        <h2>没有可打开的结果</h2>
        <p>请调整左侧的搜索关键词或 Agent 筛选条件。</p>
      </div>
    );
  }
  return (
    <div className="conversation-placeholder">
      <div className="placeholder-icon"><MessageSquareIcon /></div>
      <h2>选择一个对话</h2>
      <p>从左侧选择最近对话进行阅读。</p>
      <span><kbd>Ctrl</kbd><kbd>K</kbd> 打开快速搜索</span>
    </div>
  );
}

function MessageSquareIcon() {
  return <ExternalLink size={21} strokeWidth={1.5} aria-hidden="true" />;
}

function ConversationLoading() {
  return (
    <div className="conversation-loading" aria-label="正在加载对话">
      <LoaderCircle className="spin" size={20} aria-hidden="true" />
      <span>正在加载对话…</span>
    </div>
  );
}

function ConversationError({ error, onRetry }: { readonly error: DesktopError; readonly onRetry: () => void }) {
  return (
    <div className="conversation-state" role="alert">
      <h3>对话不可用</h3>
      <p>{error.message}</p>
      {error.retryable ? <button className="secondary-button" type="button" onClick={onRetry}>重试</button> : null}
    </div>
  );
}

function MessageSkeleton() {
  return <div className="message-skeleton" aria-label="正在加载更多消息"><span /><span /><span /></div>;
}

function toDesktopError(error: unknown, fallback: string): DesktopError {
  return {
    code: "renderer.bridge_failed",
    message: error instanceof Error && error.message.trim() !== "" ? error.message : fallback,
    retryable: true,
  };
}
