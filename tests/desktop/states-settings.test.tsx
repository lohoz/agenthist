import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "../../src/desktop/renderer/App.js";
import type { AgentHistDesktopApi } from "../../src/desktop/contracts.js";
import { AGENTS, bootstrap, chatPage, createApi, DEFAULT_SETTINGS, installApi, TERMINAL_SETTINGS } from "./fixtures.js";

describe("Desktop states and settings", () => {
  it("shows loading, recoverable bootstrap error, and a useful empty state", async () => {
    const pending = createApi();
    vi.mocked(pending.bootstrap).mockImplementation(async () => await new Promise(() => {}));
    installApi(pending);
    const first = render(<App />);
    expect(screen.getByLabelText("正在加载 AgentHist")).toBeInTheDocument();
    first.unmount();

    const failed = createApi({ bootstrapFailure: { message: "The local index is unavailable", retryable: true } });
    installApi(failed);
    const second = render(<App />);
    expect(await screen.findByText("AgentHist 无法启动")).toBeInTheDocument();
    expect(screen.getByText("The local index is unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    second.unmount();

    const emptyBootstrap = bootstrap({ chats: chatPage([]) });
    const empty = createApi({ bootstrap: emptyBootstrap, chats: [] });
    installApi(empty);
    render(<App />);
    expect(await screen.findByText("还没有发现编程对话")).toBeInTheDocument();
    expect(screen.getByText(/支持的 Coding Agent/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "扫描本机历史" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "尚无可阅读的对话" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "选择一个对话" })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "扫描本机历史" }));
    expect(empty.refresh).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "打开设置" }));
    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
  });

  it("offers Agent path configuration when first-run detection finds nothing", async () => {
    const api = createApi({
      bootstrap: bootstrap({
        settings: { ...DEFAULT_SETTINGS, firstRunComplete: false },
        agents: AGENTS.map((agent) => ({ ...agent, status: "not_detected" as const, locations: [] })),
        chats: chatPage([]),
      }),
      chats: [],
    });
    installApi(api);
    const user = userEvent.setup();
    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "欢迎使用 AgentHist" });
    expect(within(dialog).getByText(/尚未检测到可用 Agent/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "配置 Agent 路径" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "欢迎使用 AgentHist" })).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ firstRunComplete: true }));
  });

  it("keeps first run to one detection screen and persists Start", async () => {
    const api = createApi({
      bootstrap: bootstrap({ settings: { ...DEFAULT_SETTINGS, firstRunComplete: false } }),
    });
    installApi(api);
    const user = userEvent.setup();
    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "欢迎使用 AgentHist" });
    expect(dialog).toHaveTextContent("Codex");
    expect(dialog).toHaveTextContent("Claude Code");
    expect(dialog).toHaveTextContent("已检测");
    expect(screen.getByRole("button", { name: "开始使用" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "开始使用" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "欢迎使用 AgentHist" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始使用" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "欢迎使用 AgentHist" })).not.toBeInTheDocument());
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ firstRunComplete: true }));
  });

  it("applies a theme only after persistence and rolls back a thrown save", async () => {
    const api = createApi();
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["updateSettings"]>>>();
    vi.mocked(api.updateSettings).mockReturnValueOnce(pending.promise);
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "对话" });
    await user.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("heading", { name: "设置" });

    expect(document.documentElement.dataset.theme).toBe("light");
    await user.click(screen.getByRole("button", { name: "深色" }));
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" }));
    expect(document.documentElement.dataset.theme).toBe("light");

    await act(async () => {
      pending.resolve({ ok: true, value: { ...DEFAULT_SETTINGS, theme: "dark" } });
      await pending.promise;
    });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));

    vi.mocked(api.updateSettings).mockRejectedValueOnce(new Error("private persistence failure"));
    await user.click(screen.getByRole("button", { name: "浅色" }));
    expect(await screen.findByText(/桌面桥接没有完成请求/)).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.queryByText(/private persistence failure/)).not.toBeInTheDocument();

    vi.mocked(api.updateSettings).mockResolvedValueOnce({
      ok: false,
      error: { code: "settings_write_failed", message: "The Agent filter could not be saved.", retryable: true },
    });
    await user.click(screen.getByRole("button", { name: "对话" }));
    await user.click(screen.getByRole("button", { name: "Claude Code", pressed: false }));
    expect(await screen.findByText(/The Agent filter could not be saved/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claude Code", pressed: false })).toBeInTheDocument();
  });

  it("shows essential Agent and data settings and applies theme choices", async () => {
    const api = createApi();
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "对话" });

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByText("C:\\Tools\\codex.exe")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\Alice\\AppData\\Local\\AgentHist")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "事务恢复…" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "深色" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" }));
    await user.click(screen.getByRole("button", { name: "手动刷新" }));
    expect(api.refresh).toHaveBeenCalled();
  });

  it("keeps automatic refresh off until the user enables it", async () => {
    const api = createApi();
    installApi(api);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "对话" });
    await waitFor(() => expect(api.listChats).toHaveBeenCalled());
    expect(api.refresh).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "设置" }));
    const toggle = await screen.findByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ autoRefresh: true })));
    await waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1));
  });

  it("detects a terminal and saves a literal command argument template", async () => {
    const api = createApi();
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "对话" });
    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(await screen.findByRole("heading", { name: "命令行终端" })).toBeInTheDocument();
    expect(await screen.findByText("Windows Terminal（自动）")).toBeInTheDocument();
    expect(screen.getAllByText(TERMINAL_SETTINGS.effectiveExecutablePath!)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "使用" }));
    await waitFor(() => expect(api.selectTerminal).toHaveBeenCalledWith({ candidateId: "windows-terminal" }));

    await user.click(screen.getByText("启动参数（高级）"));
    const argumentsInput = screen.getByRole("textbox", { name: "终端默认启动参数" });
    fireEvent.change(argumentsInput, { target: { value: "new-tab\n--cwd\n{cwd}\n{command}" } });
    await user.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => expect(api.updateTerminalArguments).toHaveBeenCalledWith({
      arguments: ["new-tab", "--cwd", "{cwd}", "{command}"],
    }));
  });

  it("describes Experience as an evidence package without invented acceptance storage", async () => {
    const api = createApi();
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "对话" });
    await user.click(screen.getByRole("button", { name: "经验" }));

    expect(await screen.findByRole("heading", { name: "经验" })).toBeInTheDocument();
    expect(screen.getByText(/只有确认运行后才会发送内容/)).toBeInTheDocument();
    expect(screen.getByText(/不会自动成为指令/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分析历史" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开审阅" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept|Merge/ })).not.toBeInTheDocument();
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
