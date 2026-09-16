import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentHistDesktopApi,
  AgentSettingDto,
  DesktopResult,
  RefreshResultDto,
  ScanProgressDto,
} from "../../src/desktop/contracts.js";
import { App } from "../../src/desktop/renderer/App.js";
import {
  AGENT_SETTINGS,
  bootstrap,
  chat,
  chatPage,
  CODEX_CHAT,
  createApi,
  DEFAULT_SETTINGS,
  installApi,
} from "./fixtures.js";

describe("background history refresh", () => {
  it("reloads Chats and Agent settings after scheduler or focus completion without a render loop", async () => {
    const scheduledChat = chat(81, "claude", { title: "Scheduled history update" });
    const focusedChat = chat(82, "codex", { title: "Focused history update" });
    const refreshedSettings = replaceAgentSetting(AGENT_SETTINGS, "codex", (setting) => ({
      ...setting,
      executable: {
        configured: true,
        configuredPath: "D:\\Tools\\refreshed-codex.exe",
        resolvedPath: "D:\\Tools\\refreshed-codex.exe",
        available: true,
      },
    }));
    let currentChats = [CODEX_CHAT];
    let scanListener: ((progress: ScanProgressDto) => void) | undefined;
    const api = createApi({
      bootstrap: bootstrap({
        chats: chatPage(currentChats),
        agentSettings: AGENT_SETTINGS,
        settings: { ...DEFAULT_SETTINGS, autoRefresh: true },
      }),
      chats: currentChats,
    });
    vi.mocked(api.listChats).mockImplementation(async () => ({
      ok: true,
      value: chatPage(currentChats),
    }));
    vi.mocked(api.getAgentSettings).mockResolvedValue({ ok: true, value: refreshedSettings });
    vi.mocked(api.onScanProgress).mockImplementation((listener) => {
      scanListener = listener;
      return () => {};
    });
    installApi(api);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "对话" });
    await waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.listChats).toHaveBeenCalled());
    const initialListCalls = vi.mocked(api.listChats).mock.calls.length;
    const initialSettingsCalls = vi.mocked(api.getAgentSettings).mock.calls.length;
    const complete: ScanProgressDto = {
      phase: "complete",
      result: { agents: [], sessions: 1, partial: false },
    };

    currentChats = [scheduledChat];
    act(() => scanListener?.(complete));

    expect(await screen.findByRole("heading", { name: "Scheduled history update" })).toBeInTheDocument();
    await waitFor(() => expect(api.getAgentSettings).toHaveBeenCalledTimes(initialSettingsCalls + 1));
    expect(api.listChats).toHaveBeenCalledTimes(initialListCalls + 1);

    const listCallsBeforeSearch = vi.mocked(api.listChats).mock.calls.length;
    const settingsCallsBeforeSearch = vi.mocked(api.getAgentSettings).mock.calls.length;
    await user.type(screen.getByRole("searchbox", { name: "搜索对话" }), "Scheduled");
    await waitFor(() => expect(api.listChats).toHaveBeenCalledTimes(listCallsBeforeSearch + 1));
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(api.listChats).toHaveBeenCalledTimes(listCallsBeforeSearch + 1);
    expect(api.getAgentSettings).toHaveBeenCalledTimes(settingsCallsBeforeSearch);

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("D:\\Tools\\refreshed-codex.exe")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "对话" }));

    currentChats = [focusedChat];
    const listCallsBeforeFocus = vi.mocked(api.listChats).mock.calls.length;
    act(() => scanListener?.(complete));
    expect(await screen.findByRole("heading", { name: "Focused history update" })).toBeInTheDocument();
    await waitFor(() => expect(api.getAgentSettings).toHaveBeenCalledTimes(initialSettingsCalls + 2));
    expect(api.listChats).toHaveBeenCalledTimes(listCallsBeforeFocus + 1);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.listChats).toHaveBeenCalledTimes(listCallsBeforeFocus + 1);
    expect(api.getAgentSettings).toHaveBeenCalledTimes(initialSettingsCalls + 2);
  });

  it("shows a retryable warning for a background refresh error", async () => {
    const { api, emit } = installProgressApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "对话" });
    await waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1));

    act(() => emit({
      phase: "error",
      error: {
        code: "desktop.scheduled_refresh_failed",
        message: "The scheduled history scan failed.",
        retryable: true,
      },
    }));

    expect(await screen.findByText(/The scheduled history scan failed/)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "重试" });
    expect(retry).toBeEnabled();
    await user.click(retry);
    await waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(2));
  });

  it("releases foreground busy state and reports rejected results and thrown bridge errors", async () => {
    const { api } = installProgressApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "对话" });
    await waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1));

    const rejected = deferred<DesktopResult<RefreshResultDto>>();
    vi.mocked(api.refresh).mockReturnValueOnce(rejected.promise);
    const refresh = screen.getByRole("button", { name: "刷新对话" });
    await user.click(refresh);
    expect(refresh).toBeDisabled();

    await act(async () => {
      rejected.resolve({
        ok: false,
        error: {
          code: "desktop.refresh_rejected",
          message: "The history directory is temporarily unavailable.",
          retryable: true,
        },
      });
      await rejected.promise;
    });
    expect(await screen.findByText(/history directory is temporarily unavailable/)).toBeInTheDocument();
    expect(refresh).toBeEnabled();

    vi.mocked(api.refresh).mockRejectedValueOnce(new Error("private bridge failure"));
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/桌面桥接没有完成历史刷新/)).toBeInTheDocument();
    expect(refresh).toBeEnabled();
    expect(screen.queryByText(/private bridge failure/)).not.toBeInTheDocument();
  });
});

function installProgressApi(): {
  readonly api: AgentHistDesktopApi;
  readonly emit: (progress: ScanProgressDto) => void;
} {
  let listener: ((progress: ScanProgressDto) => void) | undefined;
  const api = createApi({
    bootstrap: bootstrap({ settings: { ...DEFAULT_SETTINGS, autoRefresh: true } }),
  });
  vi.mocked(api.onScanProgress).mockImplementation((nextListener) => {
    listener = nextListener;
    return () => {};
  });
  installApi(api);
  return {
    api,
    emit(progress) {
      if (listener === undefined) throw new Error("scan progress listener is not installed");
      listener(progress);
    },
  };
}

function replaceAgentSetting(
  settings: readonly AgentSettingDto[],
  agent: AgentSettingDto["agent"],
  replace: (setting: AgentSettingDto) => AgentSettingDto,
): readonly AgentSettingDto[] {
  return settings.map((setting) => setting.agent === agent ? replace(setting) : setting);
}

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
