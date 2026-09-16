import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  Agent,
  AgentPathKind,
  AgentSettingDto,
  AgentHistDesktopApi,
  BootstrapDto,
  ChatSummaryDto,
  DesktopAgentFilter,
  DesktopError,
  DesktopSettings,
  ScanProgressDto,
} from "../contracts.js";
import { AppShell, type PrimaryPage } from "./components/AppShell.js";
import { ChatsPage } from "./components/ChatsPage.js";
import { FirstRunDialog } from "./components/FirstRunDialog.js";
import { QuickSearch } from "./components/QuickSearch.js";
import { useTheme } from "./hooks/use-theme.js";
import { workspacePath } from "../../domain/workspace-path.js";

const CHAT_PAGE_SIZE = 100;
const ExperiencePage = lazy(async () => {
  const module = await import("./components/ExperiencePage.js");
  return { default: module.ExperiencePage };
});
const SettingsPage = lazy(async () => {
  const module = await import("./components/SettingsPage.js");
  return { default: module.SettingsPage };
});

function agentPathKey(agent: Agent, kind: AgentPathKind): string {
  return `${agent}:${kind}`;
}

type BootstrapState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: DesktopError }
  | { readonly status: "ready"; readonly value: BootstrapDto };

export function App() {
  const api: AgentHistDesktopApi = window.agentHist;
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: "loading" });
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [page, setPage] = useState<PrimaryPage>("chats");
  const [experienceVisited, setExperienceVisited] = useState(false);
  useEffect(() => { if (page === "experience") setExperienceVisited(true); }, [page]);
  const [settings, setSettings] = useState<DesktopSettings>({
    theme: "system",
    agentFilter: "all",
    autoRefresh: false,
    showTechnicalDetails: false,
    firstRunComplete: true,
  });
  const [agentSettings, setAgentSettings] = useState<readonly AgentSettingDto[]>([]);
  const [busyAgentPaths, setBusyAgentPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [chats, setChats] = useState<readonly ChatSummaryDto[]>([]);
  const resumedChats = useRef(new Map<string, ChatSummaryDto>());
  const [historyRevision, setHistoryRevision] = useState(0);
  const [chatTotal, setChatTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number>();
  const [selected, setSelected] = useState<ChatSummaryDto>();
  const [selectedSessionRefs, setSelectedSessionRefs] = useState<ReadonlySet<string>>(() => new Set());
  const [selectionBusy, setSelectionBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DesktopAgentFilter>("all");
  const [libraryState, setLibraryState] = useState<"active" | "deleted">("active");
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<DesktopError>();
  const [refreshError, setRefreshError] = useState<DesktopError>();
  const [refreshing, setRefreshing] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgressDto>();
  const [scanRevision, setScanRevision] = useState(0);
  const [quickSearchOpen, setQuickSearchOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string>();
  const listSequence = useRef(0);
  const autoRefreshGeneration = useRef(0);
  const settingsSequence = useRef(0);
  const persistedSettings = useRef(settings);
  const agentSettingsGeneration = useRef(0);
  const loadingMoreRef = useRef(false);
  const selectionGeneration = useRef(0);

  useTheme(settings.theme);

  useEffect(() => {
    let active = true;
    setBootstrap({ status: "loading" });
    const unsubscribe = api.onScanProgress((progress) => {
      if (!active) return;
      setScanProgress(progress);
      if (progress.phase === "complete") {
        setRefreshing(false);
        setRefreshError(refreshResultError(progress.result));
        setScanRevision((revision) => revision + 1);
      }
      if (progress.phase === "error") {
        setRefreshing(false);
        setRefreshError(progress.error);
      }
    });
    void api.bootstrap().then((result) => {
      if (!active) return;
      if (!result.ok) {
        setBootstrap({ status: "error", error: result.error });
        return;
      }
      const value = result.value;
      setBootstrap({ status: "ready", value });
      setSettings(value.settings);
      persistedSettings.current = value.settings;
      agentSettingsGeneration.current += 1;
      setAgentSettings(value.agentSettings);
      setFilter(value.settings.agentFilter);
      setChats(value.chats.chats);
      setChatTotal(value.chats.total);
      setNextOffset(value.chats.nextOffset);
      const restoreGeneration = ++selectionGeneration.current;
      const remembered = value.settings.lastSessionRef === undefined
        ? undefined
        : value.chats.chats.find((chat) => chat.sessionRef === value.settings.lastSessionRef);
      setSelected(remembered ?? value.chats.chats[0]);
      if (value.settings.lastSessionRef !== undefined && remembered === undefined) {
        const rememberedSessionRef = value.settings.lastSessionRef;
        void api.getConversation({ sessionRef: rememberedSessionRef, offset: 0, limit: 1 }).then((conversation) => {
          if (!active || restoreGeneration !== selectionGeneration.current || !conversation.ok ||
            conversation.value.chat.sessionRef !== rememberedSessionRef ||
            conversation.value.chat.libraryState !== "active") return;
          setSelected(conversation.value.chat);
        }).catch(() => undefined);
      }
    }).catch((error: unknown) => {
      if (!active) return;
      setBootstrap({
        status: "error",
        error: {
          code: "renderer.bootstrap_failed",
          message: error instanceof Error ? error.message : "AgentHist 无法启动",
          retryable: true,
        },
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, bootstrapAttempt]);

  const fetchChats = useCallback(async (offset: number, append: boolean): Promise<void> => {
    if (append && loadingMoreRef.current) return;
    const sequence = append ? listSequence.current : ++listSequence.current;
    if (append) {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else {
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setListLoading(true);
    }
    if (!append) setListError(undefined);
    const trimmed = query.trim();
    try {
      const result = await api.listChats({
        ...(trimmed === "" ? {} : { query: trimmed }),
        ...(filter === "all" ? {} : { agents: [filter] }),
        ...(libraryState === "active" ? {} : { libraryState }),
        offset,
        limit: CHAT_PAGE_SIZE,
      });
      if (sequence !== listSequence.current) return;
      if (!result.ok) {
        setListError(result.error);
        return;
      }
      setListError(undefined);
      setChatTotal(result.value.total);
      setNextOffset(result.value.nextOffset);
      if (append) {
        setChats((current) => [
          ...current,
          ...result.value.chats.filter((chat) => !current.some((item) => item.sessionRef === chat.sessionRef)),
        ]);
      } else {
        const next = [...result.value.chats];
        if (libraryState === "active" && trimmed === "") {
          for (const pinned of resumedChats.current.values()) {
            if ((filter === "all" || filter === pinned.agent) && !next.some((chat) => chat.sessionRef === pinned.sessionRef)) next.push(pinned);
          }
        }
        setChats(next);
        setSelected((currentSelected) => {
          const retained = currentSelected === undefined
            ? undefined
            : next.find((chat) => chat.sessionRef === currentSelected.sessionRef);
          const remembered = libraryState === "active" && query.trim() === ""
            ? next.find((chat) => chat.sessionRef === persistedSettings.current.lastSessionRef)
            : undefined;
          const retainRemembered = libraryState === "active" && currentSelected !== undefined &&
            currentSelected.libraryState === "active" && query.trim() === "" &&
            currentSelected.sessionRef === persistedSettings.current.lastSessionRef &&
            (filter === "all" || currentSelected.agent === filter);
          return retained ?? remembered ?? (retainRemembered ? currentSelected : next[0]);
        });
      }
    } catch {
      if (sequence === listSequence.current) {
        setListError({
          code: "renderer.chats_failed",
          message: "桌面桥接没有完成对话请求。",
          retryable: true,
        });
      }
    } finally {
      if (sequence === listSequence.current) {
        if (append) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        } else {
          setListLoading(false);
        }
      }
    }
  }, [api, filter, libraryState, query]);
  const refreshChats = useRef(fetchChats);

  useEffect(() => {
    refreshChats.current = fetchChats;
  }, [fetchChats]);

  useEffect(() => {
    if (bootstrap.status !== "ready") return;
    const timeout = window.setTimeout(() => void fetchChats(0, false), 140);
    return () => window.clearTimeout(timeout);
  }, [bootstrap.status, fetchChats, historyRevision]);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(undefined);
    try {
      const result = await api.refresh();
      if (!result.ok) {
        setRefreshError(result.error);
        return;
      }
      if (result.value.partial) {
        const failed = result.value.agents.find((agent) => agent.status === "failed")?.error;
        setRefreshError(failed ?? {
          code: "desktop.refresh_partial",
          message: "部分 Agent 历史刷新失败。",
          retryable: true,
        });
      }
    } catch {
      setRefreshError({
        code: "renderer.refresh_failed",
        message: "桌面桥接没有完成历史刷新。",
        retryable: true,
      });
    } finally {
      setRefreshing(false);
    }
  }, [api, refreshing]);

  useEffect(() => {
    if (scanRevision === 0 || bootstrap.status !== "ready") return;
    let active = true;
    const currentAgentSettingsGeneration = agentSettingsGeneration.current;
    void (async () => {
      try {
        await refreshChats.current(0, false);
        const currentAgentSettings = await api.getAgentSettings();
        if (
          active && currentAgentSettings.ok &&
          currentAgentSettingsGeneration === agentSettingsGeneration.current
        ) {
          setAgentSettings(currentAgentSettings.value);
        }
      } catch {
        if (active) {
          setRefreshError({
            code: "renderer.refresh_sync_failed",
            message: "历史已刷新，但无法加载最新视图。",
            retryable: true,
          });
        }
      }
    })();
    return () => { active = false; };
  }, [api, bootstrap.status, scanRevision]);

  useEffect(() => {
    if (bootstrap.status !== "ready" || !settings.autoRefresh) return;
    const generation = ++autoRefreshGeneration.current;
    const timeout = window.setTimeout(() => {
      if (generation === autoRefreshGeneration.current) void refresh();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [bootstrap.status, settings.autoRefresh]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || !["k", "p"].includes(event.key.toLowerCase())) return;
      event.preventDefault();
      setQuickSearchOpen(true);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    if (notice === undefined) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 4_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const persistSettings = useCallback(async (next: DesktopSettings): Promise<boolean> => {
    const sequence = ++settingsSequence.current;
    const previous = persistedSettings.current;
    persistedSettings.current = next;
    try {
      const result = await api.updateSettings(next);
      if (sequence !== settingsSequence.current) return result.ok;
      if (!result.ok) {
        persistedSettings.current = previous;
        setSettings(previous);
        setFilter(previous.agentFilter);
        setNotice(`无法保存设置：${result.error.message}`);
        return false;
      }
      persistedSettings.current = result.value;
      setSettings(result.value);
      setFilter(result.value.agentFilter);
      return true;
    } catch {
      if (sequence === settingsSequence.current) {
        persistedSettings.current = previous;
        setSettings(previous);
        setFilter(previous.agentFilter);
        setNotice("无法保存设置：桌面桥接没有完成请求。");
      }
      return false;
    }
  }, [api]);

  const conversationResumed = useCallback(async (sessionRef: string): Promise<void> => {
    try {
      const result = await api.getConversation({ sessionRef, offset: 0, limit: 1 });
      if (result.ok) resumedChats.current.set(result.value.chat.sessionRef, result.value.chat);
      else setNotice("对话已转换，暂时无法读取历史，请刷新重试。");
    } catch {
      setNotice("对话已转换，暂时无法读取历史，请刷新重试。");
    }
    setQuery("");
    setFilter("all");
    setLibraryState("active");
    setHistoryRevision((revision) => revision + 1);
    void persistSettings({ ...persistedSettings.current, agentFilter: "all" });
  }, [api, persistSettings]);

  const setAgentPathBusy = (key: string, busy: boolean): void => {
    setBusyAgentPaths((current) => {
      const next = new Set(current);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const chooseAgentPath = async (agent: Agent, kind: AgentPathKind): Promise<void> => {
    const key = agentPathKey(agent, kind);
    if (busyAgentPaths.has(key)) return;
    const generation = ++agentSettingsGeneration.current;
    setAgentPathBusy(key, true);
    try {
      const result = await api.chooseAgentPath({ agent, kind });
      if (!result.ok) {
        setNotice(`无法更新 Agent 路径 · ${result.error.message}`);
        return;
      }
      if (result.value.status === "cancelled") return;
      if (generation !== agentSettingsGeneration.current) return;
      setAgentSettings(result.value.settings);
      const label = result.value.settings.find((item) => item.agent === agent)?.label ?? agent;
      setNotice(`${label} 的${kind === "history" ? "历史" : kind === "database" ? "数据库" : "可执行文件"}路径已更新`);
      await fetchChats(0, false);
    } catch {
      setNotice("无法更新 Agent 路径。");
    } finally {
      setAgentPathBusy(key, false);
    }
  };

  const clearAgentPath = async (agent: Agent, kind: AgentPathKind): Promise<void> => {
    const key = agentPathKey(agent, kind);
    if (busyAgentPaths.has(key)) return;
    const generation = ++agentSettingsGeneration.current;
    setAgentPathBusy(key, true);
    try {
      const result = await api.clearAgentPath({ agent, kind });
      if (!result.ok) {
        setNotice(`无法重置 Agent 路径 · ${result.error.message}`);
        return;
      }
      if (generation !== agentSettingsGeneration.current) return;
      setAgentSettings(result.value.settings);
      const label = result.value.settings.find((item) => item.agent === agent)?.label ?? agent;
      setNotice(`${label} 的${kind === "history" ? "历史" : kind === "database" ? "数据库" : "可执行文件"}路径已恢复默认`);
      await fetchChats(0, false);
    } catch {
      setNotice("无法重置 Agent 路径。");
    } finally {
      setAgentPathBusy(key, false);
    }
  };

  const selectChat = (chat: ChatSummaryDto): void => {
    selectionGeneration.current += 1;
    setSelected(chat);
    setPage("chats");
    if (chat.libraryState === "active") {
      const next: DesktopSettings = { ...persistedSettings.current, lastSessionRef: chat.sessionRef };
      void persistSettings(next);
    }
  };

  const changeQuery = (value: string): void => {
    selectionGeneration.current += 1;
    setQuery(value);
  };

  const changeFilter = (value: DesktopAgentFilter): void => {
    selectionGeneration.current += 1;
    void persistSettings({ ...persistedSettings.current, agentFilter: value });
  };

  const changeLibraryState = (value: "active" | "deleted"): void => {
    if (value === libraryState) return;
    listSequence.current += 1;
    selectionGeneration.current += 1;
    loadingMoreRef.current = false;
    setLibraryState(value);
    setChats([]);
    setChatTotal(0);
    setNextOffset(undefined);
    setSelected(undefined);
    setSelectedSessionRefs(new Set());
    setSelectionBusy(new Set());
    setLoadingMore(false);
    setListError(undefined);
    setListLoading(true);
  };

  const finishFirstRun = async (nextPage: PrimaryPage): Promise<void> => {
    setOnboardingBusy(true);
    setOnboardingError(undefined);
    const saved = await persistSettings({ ...persistedSettings.current, firstRunComplete: true });
    setOnboardingBusy(false);
    if (!saved) {
      setOnboardingError("无法保存首次启动设置，请重试。");
      return;
    }
    setPage(nextPage);
  };

  const loadMore = useCallback((): void => {
    if (nextOffset !== undefined && !loadingMore) void fetchChats(nextOffset, true);
  }, [fetchChats, loadingMore, nextOffset]);

  const quickChoose = (chat: ChatSummaryDto): void => {
    listSequence.current += 1;
    selectionGeneration.current += 1;
    setQuery("");
    setFilter("all");
    setLibraryState("active");
    setSelectedSessionRefs(new Set());
    setSelected(chat);
    setPage("chats");
    void persistSettings({ ...persistedSettings.current, agentFilter: "all", lastSessionRef: chat.sessionRef });
  };

  const chatHidden = useCallback((sessionRef: string): void => {
    resumedChats.current.delete(sessionRef);
    selectionGeneration.current += 1;
    const index = chats.findIndex((chat) => chat.sessionRef === sessionRef);
    const hidden = chats[index];
    const remaining = chats.filter((chat) => chat.sessionRef !== sessionRef);
    const replacement = remaining[index] ?? remaining[Math.max(0, index - 1)];
    setChats(remaining);
    setChatTotal((total) => Math.max(0, total - 1));
    setSelected((current) => current?.sessionRef === sessionRef
      ? replacement
      : current);
    if (persistedSettings.current.lastSessionRef === sessionRef) {
      void persistSettings(withLastSessionRef(persistedSettings.current, replacement?.sessionRef));
    }
    if (hidden !== undefined) {
      setSelectedSessionRefs((current) => {
        const next = new Set(current);
        for (const reference of hidden.memberSessionRefs) next.delete(reference);
        return next;
      });
    }
  }, [chats, persistSettings]);

  const chatRestored = useCallback((sessionRef: string): void => {
    listSequence.current += 1;
    selectionGeneration.current += 1;
    loadingMoreRef.current = false;
    setLibraryState("active");
    setChats([]);
    setChatTotal(0);
    setNextOffset(undefined);
    setSelectedSessionRefs(new Set());
    setSelectionBusy(new Set());
    setLoadingMore(false);
    setListError(undefined);
    setListLoading(true);
    setSelected((current) => current?.sessionRef === sessionRef
      ? { ...current, libraryState: "active" }
      : current);
    void persistSettings({ ...persistedSettings.current, lastSessionRef: sessionRef });
    if (libraryState === "active") void fetchChats(0, false);
  }, [fetchChats, libraryState, persistSettings]);

  const toggleChatSelection = useCallback((chat: ChatSummaryDto, checked: boolean): void => {
    selectionGeneration.current += 1;
    setSelectedSessionRefs((current) => {
      const next = new Set(current);
      for (const reference of chat.memberSessionRefs) {
        if (checked) next.add(reference);
        else next.delete(reference);
      }
      return next;
    });
  }, []);

  const clearChatSelection = useCallback((): void => {
    selectionGeneration.current += 1;
    setSelectedSessionRefs(new Set());
  }, []);

  const toggleWorkspaceSelection = useCallback(async (
    workspace: string,
    agent: Agent | undefined,
    visibleChats: readonly ChatSummaryDto[],
    checked: boolean,
  ): Promise<void> => {
    const generation = ++selectionGeneration.current;
    const normalizedWorkspace = workspacePath(workspace).key;
    const key = `workspace:${normalizedWorkspace}${agent === undefined ? "" : `:agent:${agent}`}`;
    setSelectionBusy((current) => new Set(current).add(key));
    const references = new Set(visibleChats.flatMap((chat) => chat.memberSessionRefs));
    let offset = 0;
    try {
      while (true) {
        const trimmed = query.trim();
        const selectedAgent = agent ?? (filter === "all" ? undefined : filter);
        const result = await api.listChats({
          ...(trimmed === "" ? {} : { query: trimmed }),
          ...(selectedAgent === undefined ? {} : { agents: [selectedAgent] }),
          ...(libraryState === "active" ? {} : { libraryState }),
          workspace,
          workspaceDescendants: true,
          offset,
          limit: 500,
        });
        if (!result.ok) {
          if (generation === selectionGeneration.current) {
            setNotice(`无法选择文件夹 · ${result.error.message}`);
          }
          return;
        }
        for (const chat of result.value.chats) {
          for (const reference of chat.memberSessionRefs) references.add(reference);
        }
        if (result.value.nextOffset === undefined) break;
        offset = result.value.nextOffset;
      }
      if (generation !== selectionGeneration.current) return;
      setSelectedSessionRefs((current) => {
        const next = new Set(current);
        for (const reference of references) {
          if (checked) next.add(reference);
          else next.delete(reference);
        }
        return next;
      });
    } catch {
      if (generation === selectionGeneration.current) {
        setNotice("无法读取文件夹中的全部对话。");
      }
    } finally {
      setSelectionBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [api, filter, libraryState, query]);

  const openExperienceSession = useCallback(async (sessionRef: string): Promise<void> => {
    listSequence.current += 1;
    const selection = ++selectionGeneration.current;
    setPage("chats");
    setQuery("");
    setFilter("all");
    setLibraryState("active");
    setSelectedSessionRefs(new Set());
    const known = chats.find((chat) => chat.sessionRef === sessionRef);
    if (known !== undefined) {
      setSelected(known);
      void persistSettings({ ...persistedSettings.current, agentFilter: "all", lastSessionRef: sessionRef });
      return;
    }
    try {
      const result = await api.getConversation({ sessionRef, offset: 0, limit: 1 });
      if (selection !== selectionGeneration.current) return;
      if (!result.ok) {
        setNotice(`无法打开来源对话 · ${result.error.message}`);
        return;
      }
      setSelected(result.value.chat);
      void persistSettings({ ...persistedSettings.current, agentFilter: "all", lastSessionRef: sessionRef });
    } catch {
      if (selection === selectionGeneration.current) setNotice("无法打开来源对话。");
    }
  }, [api, chats, persistSettings]);

  const currentPage = useMemo(() => {
    if (bootstrap.status !== "ready") return null;
    if (page === "experience") return null;
    if (page === "settings") {
      return (
        <Suspense fallback={<SectionLoading label="正在加载设置…" />}>
          <SettingsPage
            api={api}
            agentSettings={agentSettings}
            settings={settings}
            stateDirectory={bootstrap.value.stateDirectory}
            version={bootstrap.value.version}
            refreshing={refreshing}
            busyPaths={busyAgentPaths}
            onChange={persistSettings}
            onRefresh={() => void refresh()}
            onIndexRebuilt={() => void fetchChats(0, false)}
            onChoosePath={(agent, kind) => void chooseAgentPath(agent, kind)}
            onClearPath={(agent, kind) => void clearAgentPath(agent, kind)}
            onNotice={setNotice}
          />
        </Suspense>
      );
    }
    return (
      <ChatsPage
        api={api}
        agentSettings={agentSettings}
        chats={chats}
        total={chatTotal}
        query={query}
        filter={filter}
        libraryState={libraryState}
        selected={selected}
        selectedSessionRefs={selectedSessionRefs}
        selectionBusy={selectionBusy}
        listLoading={listLoading}
        loadingMore={loadingMore}
        refreshing={refreshing}
        listError={listError}
        refreshError={refreshError}
        scanProgress={scanProgress}
        showTechnicalDetails={settings.showTechnicalDetails}
        onQueryChange={changeQuery}
        onFilterChange={changeFilter}
        onLibraryStateChange={changeLibraryState}
        onSelect={selectChat}
        onToggleChatSelection={toggleChatSelection}
        onToggleWorkspaceSelection={(workspace, agent, visibleChats, checked) =>
          void toggleWorkspaceSelection(workspace, agent, visibleChats, checked)}
        onClearSelection={clearChatSelection}
        onLoadMore={loadMore}
        onRefresh={() => void refresh()}
        onRetryList={() => void fetchChats(0, false)}
        onOpenQuickSearch={() => setQuickSearchOpen(true)}
        onOpenSettings={() => setPage("settings")}
        onShowTechnicalDetailsChange={(show) => void persistSettings({
          ...persistedSettings.current,
          showTechnicalDetails: show,
        })}
        onNotice={setNotice}
        onChatHidden={chatHidden}
        onChatRestored={chatRestored}
        onImported={() => void fetchChats(0, false)}
        onResumed={(sessionRef) => void conversationResumed(sessionRef)}
      />
    );
  }, [
    api,
    agentSettings,
    bootstrap,
    busyAgentPaths,
    chatTotal,
    chatHidden,
    chatRestored,
    chats,
    clearChatSelection,
    conversationResumed,
    filter,
    fetchChats,
    listError,
    listLoading,
    libraryState,
    loadMore,
    loadingMore,
    openExperienceSession,
    page,
    query,
    refresh,
    refreshError,
    refreshing,
    scanProgress,
    selected,
    selectedSessionRefs,
    selectionBusy,
    settings,
    toggleChatSelection,
    toggleWorkspaceSelection,
  ]);

  if (bootstrap.status === "loading") return <StartupLoading />;
  if (bootstrap.status === "error") {
    return <StartupError error={bootstrap.error} onRetry={() => setBootstrapAttempt((value) => value + 1)} />;
  }

  return (
    <>
      <AppShell page={page} version={bootstrap.value.version} onNavigate={setPage}>
        {currentPage}
        {experienceVisited ? <div className="experience-page-host" hidden={page !== "experience"}>
          <Suspense fallback={<SectionLoading label="正在加载经验…" />}>
            <ExperiencePage api={api} onOpenSession={(sessionRef) => void openExperienceSession(sessionRef)}
              agentSettings={agentSettings} selectedAgent={settings.experienceAgent}
              onSelectAgent={(experienceAgent) => persistSettings({ ...persistedSettings.current, experienceAgent })}
              selectedSessionRefs={selectedSessionRefs} />
          </Suspense>
        </div> : null}
      </AppShell>
      <QuickSearch api={api} open={quickSearchOpen} onClose={() => setQuickSearchOpen(false)} onChoose={quickChoose} />
      {!settings.firstRunComplete ? (
        <FirstRunDialog
          agents={bootstrap.value.agents}
          busy={onboardingBusy}
          error={onboardingError}
          onStart={() => void finishFirstRun("chats")}
          onOpenSettings={() => void finishFirstRun("settings")}
        />
      ) : null}
      {notice === undefined ? null : (
        <div className="toast-notice" role="status">
          <span>{notice}</span>
          <button type="button" aria-label="关闭通知" onClick={() => setNotice(undefined)}><X size={14} /></button>
        </div>
      )}
    </>
  );
}

function StartupLoading() {
  return (
    <div className="startup-state" aria-label="正在加载 AgentHist">
      <div className="startup-mark">AH</div>
      <div className="startup-line"><span /></div>
      <p>正在打开你的对话…</p>
    </div>
  );
}

function StartupError({ error, onRetry }: { readonly error: DesktopError; readonly onRetry: () => void }) {
  return (
    <div className="startup-state startup-error" role="alert">
      <AlertTriangle size={28} strokeWidth={1.5} />
      <h1>AgentHist 无法启动</h1>
      <p>{error.message}</p>
      {error.retryable ? (
        <button className="primary-button" type="button" onClick={onRetry}><RotateCcw size={15} />重试</button>
      ) : null}
    </div>
  );
}

function SectionLoading({ label }: { readonly label: string }) {
  return <div className="section-loading" role="status"><span className="status-pulse" />{label}</div>;
}

function withLastSessionRef(settings: DesktopSettings, sessionRef: string | undefined): DesktopSettings {
  const { lastSessionRef: _lastSessionRef, ...rest } = settings;
  return sessionRef === undefined ? rest : { ...rest, lastSessionRef: sessionRef };
}

function refreshResultError(result: Extract<ScanProgressDto, { readonly phase: "complete" }>["result"]): DesktopError | undefined {
  if (!result.partial) return undefined;
  return result.agents.find((agent) => agent.status === "failed")?.error ?? {
    code: "desktop.refresh_partial",
    message: "部分 Agent 历史刷新失败。",
    retryable: true,
  };
}
