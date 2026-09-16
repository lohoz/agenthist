import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "../../src/desktop/renderer/App.js";
import type { AgentHistDesktopApi, ListChatsRequest } from "../../src/desktop/contracts.js";
import {
  bootstrap,
  chat,
  chatPage,
  CLAUDE_CHAT,
  CODEX_CHAT,
  conversationPage,
  createApi,
  DEFAULT_SETTINGS,
  installApi,
  PI_CHAT,
  resumePlan,
  launchedResume,
} from "./fixtures.js";

describe("Chats", () => {
  it("adds a converted conversation immediately even when it is outside the recent page and Agent filter", async () => {
    const target = chat(99, "claude", { workspace: CODEX_CHAT.workspace, workspaceName: CODEX_CHAT.workspaceName, title: "Converted continuation" });
    const plan = resumePlan({ targetAgent: "claude", route: "conversion", needsWrite: true, quality: "exact" });
    let converted = false;
    const api = createApi({ chats: [CODEX_CHAT], bootstrap: bootstrap({ chats: chatPage([CODEX_CHAT]) }) });
    vi.mocked(api.planResume).mockResolvedValue({ ok: true, value: plan });
    vi.mocked(api.confirmResume).mockImplementation(async () => {
      converted = true;
      return { ok: true, value: launchedResume(plan, { targetSessionRef: target.sessionRef }) };
    });
    vi.mocked(api.getConversation).mockImplementation(async (request) => ({ ok: true, value: conversationPage(request.sessionRef === target.sessionRef ? target : CODEX_CHAT) }));
    vi.mocked(api.listChats).mockImplementation(async () => ({ ok: true, value: chatPage([CODEX_CHAT], converted ? 2 : 1) }));
    installApi(api);
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Codex", pressed: false }));
    await user.click(screen.getByRole("button", { name: "使用其他 Agent 继续" }));
    await user.click(await screen.findByRole("menuitem", { name: "Claude Code" }));
    await user.click(await screen.findByRole("button", { name: "转换并继续" }));
    const list = screen.getByTestId("chat-list-scroll");
    expect(await within(list).findByText(target.title)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.getByRole("button", { name: "全部", pressed: true })).toBeInTheDocument();
    expect(api.getConversation).toHaveBeenCalledWith({ sessionRef: target.sessionRef, offset: 0, limit: 1 });
    expect(within(list).getAllByText(target.title)).toHaveLength(1);
    await user.click(within(list).getByText(target.title));
    expect(await screen.findByRole("heading", { name: target.title })).toBeInTheDocument();
  });
  it("shows a windowed recent list and opens a selected conversation", async () => {
    const manyChats = Array.from({ length: 160 }, (_, index) => chat(index + 1, index % 2 === 0 ? "codex" : "claude"));
    const api = createApi({
      chats: manyChats,
      bootstrap: bootstrap({ chats: chatPage(manyChats.slice(0, 100), manyChats.length) }),
    });
    installApi(api);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "对话" })).toBeInTheDocument();
    const list = screen.getByTestId("chat-list-scroll");
    await waitFor(() => expect(within(list).getByText("Codex conversation 1")).toBeInTheDocument());
    expect(within(list).queryByText("Claude conversation 100")).not.toBeInTheDocument();
    expect(within(list).getAllByRole("button").length).toBeLessThan(40);

    await userEvent.click(within(list).getByRole("button", { name: "折叠Project 1" }));
    await userEvent.click(await within(list).findByText("Claude conversation 2"));
    expect(await screen.findByRole("heading", { name: "Claude conversation 2" })).toBeInTheDocument();
    await waitFor(() => expect(api.getConversation).toHaveBeenCalled());
  });

  it("combines text search and Agent filters through the typed desktop API", async () => {
    const api = createApi({ chats: [CODEX_CHAT, CLAUDE_CHAT, PI_CHAT] });
    installApi(api);
    const user = userEvent.setup();
    render(<App />);

    const search = await screen.findByRole("searchbox", { name: "搜索对话" });
    await user.type(search, "release");
    const list = screen.getByTestId("chat-list-scroll");
    expect(await within(list).findByText("Review the release checklist")).toBeInTheDocument();
    await waitFor(() => expect(within(list).queryByText("Fix the database migration")).not.toBeInTheDocument());
    await waitFor(() => {
      const requests = vi.mocked(api.listChats).mock.calls.map(([request]) => request as ListChatsRequest);
      expect(requests.some((request) => request.query === "release")).toBe(true);
    });

    await user.clear(search);
    await user.click(screen.getByRole("button", { name: "Claude Code", pressed: false }));
    expect(await within(list).findByText("Review the release checklist")).toBeInTheDocument();
    await waitFor(() => {
      const requests = vi.mocked(api.listChats).mock.calls.map(([request]) => request as ListChatsRequest);
      expect(requests.some((request) => request.agents?.[0] === "claude")).toBe(true);
    });
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ agentFilter: "claude" }));
  });

  it("selects a workspace folder and bulk-exports every conversation beneath it", async () => {
    const sibling = {
      ...CLAUDE_CHAT,
      workspace: CODEX_CHAT.workspace,
      workspaceName: CODEX_CHAT.workspaceName,
    };
    const chats = [CODEX_CHAT, sibling];
    const api = createApi({
      chats,
      bootstrap: bootstrap({ chats: chatPage(chats) }),
    });
    vi.mocked(api.exportHistory).mockResolvedValue({ ok: true, value: { status: "cancelled" } });
    installApi(api);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "对话" });
    await user.click(await screen.findByRole("checkbox", { name: "选择Project 1中的全部对话" }));
    expect(await screen.findByText("已选择 2 条历史记录")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导出所选" }));

    await waitFor(() => expect(api.exportHistory).toHaveBeenCalledWith({
      scope: "sessions",
      sessionRefs: [CODEX_CHAT.sessionRef, sibling.sessionRef],
    }));
  });

  it("ignores a pending workspace selection after an individual selection changes", async () => {
    const sibling = {
      ...CLAUDE_CHAT,
      workspace: CODEX_CHAT.workspace,
      workspaceName: CODEX_CHAT.workspaceName,
    };
    const chats = [CODEX_CHAT, sibling];
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["listChats"]>>>();
    const api = createApi({ chats });
    vi.mocked(api.listChats).mockImplementation(async (request) => request.workspace === undefined
      ? { ok: true, value: chatPage(chats) }
      : pending.promise);
    installApi(api);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "对话" });
    await user.click(await screen.findByRole("checkbox", { name: "选择Project 1中的全部对话" }));
    await waitFor(() => expect(api.listChats).toHaveBeenCalledWith(expect.objectContaining({
      workspace: CODEX_CHAT.workspace,
    })));
    await user.click(screen.getByRole("checkbox", { name: `选择对话：${CODEX_CHAT.title}` }));
    expect(await screen.findByText("已选择 1 条历史记录")).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ ok: true, value: chatPage(chats) });
      await pending.promise;
    });
    expect(screen.getByText("已选择 1 条历史记录")).toBeInTheDocument();
    expect(screen.queryByText("已选择 2 条历史记录")).not.toBeInTheDocument();
  });

  it("ignores a pending workspace selection after selection is cleared", async () => {
    const sibling = {
      ...CLAUDE_CHAT,
      workspace: CODEX_CHAT.workspace,
      workspaceName: CODEX_CHAT.workspaceName,
    };
    const chats = [CODEX_CHAT, sibling];
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["listChats"]>>>();
    const api = createApi({ chats });
    vi.mocked(api.listChats).mockImplementation(async (request) => request.workspace === undefined
      ? { ok: true, value: chatPage(chats) }
      : pending.promise);
    installApi(api);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "对话" });
    await user.click(await screen.findByRole("checkbox", { name: `选择对话：${CODEX_CHAT.title}` }));
    await user.click(screen.getByRole("checkbox", { name: "选择Project 1中的全部对话" }));
    await waitFor(() => expect(api.listChats).toHaveBeenCalledWith(expect.objectContaining({
      workspace: CODEX_CHAT.workspace,
    })));
    await user.click(screen.getByRole("button", { name: "清除" }));

    await act(async () => {
      pending.resolve({ ok: true, value: chatPage(chats) });
      await pending.promise;
    });
    expect(screen.queryByText(/已选择 \d+ 条历史记录/u)).not.toBeInTheDocument();
  });

  it("ignores a pending workspace selection after the query changes", async () => {
    const sibling = {
      ...CLAUDE_CHAT,
      workspace: CODEX_CHAT.workspace,
      workspaceName: CODEX_CHAT.workspaceName,
    };
    const chats = [CODEX_CHAT, sibling];
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["listChats"]>>>();
    const api = createApi({ chats });
    vi.mocked(api.listChats).mockImplementation(async (request) => {
      if (request.workspace !== undefined) return pending.promise;
      const query = request.query?.toLocaleLowerCase() ?? "";
      const filtered = query === "" ? chats : chats.filter((chat) => chat.title.toLocaleLowerCase().includes(query));
      return { ok: true, value: chatPage(filtered) };
    });
    installApi(api);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "对话" });
    await user.click(await screen.findByRole("checkbox", { name: "选择Project 1中的全部对话" }));
    await waitFor(() => expect(api.listChats).toHaveBeenCalledWith(expect.objectContaining({
      workspace: CODEX_CHAT.workspace,
    })));
    await user.type(screen.getByRole("searchbox", { name: "搜索对话" }), "migration");

    await act(async () => {
      pending.resolve({ ok: true, value: chatPage(chats) });
      await pending.promise;
    });
    expect(screen.queryByText(/已选择 \d+ 条历史记录/u)).not.toBeInTheDocument();
  });

  it("opens Quick Search with Ctrl+K and selects the first result", async () => {
    const api = createApi({ chats: [CODEX_CHAT, CLAUDE_CHAT, PI_CHAT] });
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "对话" });

    await user.keyboard("{Control>}k{/Control}");
    const quickSearch = await screen.findByRole("textbox", { name: "快速搜索对话" });
    await user.type(quickSearch, "parser");
    expect(await screen.findByRole("option", { name: /Investigate the parser/ })).toBeInTheDocument();
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog", { name: "快速搜索" })).not.toBeInTheDocument();
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ lastSessionRef: PI_CHAT.sessionRef }));
    expect(await screen.findByRole("heading", { name: "Investigate the parser" })).toBeInTheDocument();
  });

  it("switches to hidden conversations without bulk selection and restores one to the active view", async () => {
    const hidden = chat(4, "codex", {
      title: "Recover hidden migration chat",
      libraryState: "deleted",
    });
    let restored = false;
    const api = createApi({
      chats: [CLAUDE_CHAT, hidden],
      bootstrap: bootstrap({ chats: chatPage([CLAUDE_CHAT]) }),
    });
    vi.mocked(api.listChats).mockImplementation(async (request) => {
      const state = request.libraryState ?? "active";
      const source = state === "deleted"
        ? restored ? [] : [hidden]
        : restored ? [hidden, CLAUDE_CHAT] : [CLAUDE_CHAT];
      return { ok: true, value: chatPage(source) };
    });
    vi.mocked(api.getConversation).mockImplementation(async (request) => {
      const requested = request.sessionRef === hidden.sessionRef
        ? { ...hidden, libraryState: restored ? "active" as const : "deleted" as const }
        : CLAUDE_CHAT;
      return { ok: true, value: conversationPage(requested) };
    });
    vi.mocked(api.updateChat).mockImplementation(async (request) => {
      restored = true;
      return {
        ok: true,
        value: { sessionRef: request.sessionRef, changed: true, state: "active" },
      };
    });
    installApi(api);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "对话" })).toBeInTheDocument();
    await user.click(await screen.findByRole("checkbox", { name: `选择对话：${CLAUDE_CHAT.title}` }));
    expect(screen.getByText("已选择 1 条历史记录")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看已隐藏" }));
    expect(await screen.findByRole("heading", { name: "已隐藏对话" })).toBeInTheDocument();
    const list = screen.getByTestId("chat-list-scroll");
    await user.click(await within(list).findByText(hidden.title));
    expect(within(list).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/已选择 \d+ 条历史记录/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导入与导出" })).not.toBeInTheDocument();
    expect(vi.mocked(api.listChats).mock.calls.some(([request]) =>
      request.libraryState === "deleted")).toBe(true);

    const activeRequestsBeforeRestore = vi.mocked(api.listChats).mock.calls.filter(([request]) =>
      request.libraryState === undefined || request.libraryState === "active").length;
    await user.click(screen.getByRole("button", { name: "更多对话操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "恢复到当前对话" }));

    await waitFor(() => expect(api.updateChat).toHaveBeenCalledWith({
      sessionRef: hidden.sessionRef,
      operation: "undelete",
    }));
    expect(await screen.findByRole("heading", { name: "对话" })).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.listChats).mock.calls.filter(([request]) =>
      request.libraryState === undefined || request.libraryState === "active").length)
      .toBeGreaterThan(activeRequestsBeforeRestore));
    expect(await screen.findByRole("heading", { name: hidden.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看已隐藏" })).toBeInTheDocument();
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ lastSessionRef: hidden.sessionRef }));
  });

  it("leaves list loading and offers retry when the desktop bridge throws", async () => {
    const api = createApi({ bootstrap: bootstrap({ chats: chatPage([]) }), chats: [] });
    vi.mocked(api.listChats)
      .mockRejectedValueOnce(new Error("private list failure"))
      .mockResolvedValueOnce({ ok: true, value: chatPage([CODEX_CHAT]) });
    installApi(api);
    const user = userEvent.setup();
    const view = render(<App />);

    expect(await screen.findByText("无法加载对话")).toBeInTheDocument();
    expect(screen.getByText("桌面桥接没有完成对话请求。")).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("private list failure");
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: CODEX_CHAT.title })).toBeInTheDocument();
    expect(screen.queryByLabelText("正在更新结果")).not.toBeInTheDocument();
  });

  it("restores a remembered conversation outside the bootstrap page", async () => {
    const chats = Array.from({ length: 160 }, (_, index) => chat(index + 1, index % 2 === 0 ? "codex" : "claude"));
    const remembered = chats[145]!;
    const initial = bootstrap({
      settings: { ...DEFAULT_SETTINGS, lastSessionRef: remembered.sessionRef },
      chats: chatPage(chats.slice(0, 100), chats.length),
    });
    const api = createApi({ bootstrap: initial, chats });
    vi.mocked(api.getConversation).mockImplementation(async (request) => ({
      ok: true,
      value: conversationPage(
        request.sessionRef === remembered.sessionRef ? remembered : chats[0]!,
        [],
        0,
      ),
    }));
    installApi(api);
    render(<App />);

    expect(await screen.findByRole("heading", { name: remembered.title })).toBeInTheDocument();
    expect(api.getConversation).toHaveBeenCalledWith({
      sessionRef: remembered.sessionRef,
      offset: 0,
      limit: 1,
    });
    await waitFor(() => expect(api.listChats).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: remembered.title })).toBeInTheDocument();
  });

  it.each([
    { chats: [CODEX_CHAT, CLAUDE_CHAT], replacement: CLAUDE_CHAT.sessionRef },
    { chats: [CODEX_CHAT], replacement: undefined },
  ])("updates the remembered conversation when the current chat is hidden", async ({ chats, replacement }) => {
    const api = createApi({
      chats,
      bootstrap: bootstrap({
        settings: { ...DEFAULT_SETTINGS, lastSessionRef: CODEX_CHAT.sessionRef },
        chats: chatPage(chats),
      }),
    });
    installApi(api);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: CODEX_CHAT.title })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "更多对话操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "从 AgentHist 隐藏…" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "隐藏此对话？" }))
      .getByRole("button", { name: "隐藏对话" }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    const saved = vi.mocked(api.updateSettings).mock.calls.at(-1)?.[0];
    if (replacement === undefined) expect(saved).not.toHaveProperty("lastSessionRef");
    else expect(saved).toHaveProperty("lastSessionRef", replacement);
  });
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("deferred promise resolver is unavailable");
      resolvePromise(value);
    },
  };
}
