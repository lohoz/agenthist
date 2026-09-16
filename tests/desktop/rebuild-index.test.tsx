import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AgentHistDesktopApi } from "../../src/desktop/contracts.js";
import { App } from "../../src/desktop/renderer/App.js";
import {
  bootstrap,
  chat,
  chatPage,
  CODEX_CHAT,
  createApi,
  installApi,
} from "./fixtures.js";

describe("safe index rebuild", () => {
  it("explains preserved data and cancels without invoking the rebuild", async () => {
    const api = createApi();
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await openSettings(user);

    const dialog = await openRebuildDialog(user);
    expect(dialog).toHaveTextContent("搜索索引和对话读取缓存");
    expect(dialog).toHaveTextContent("各 Agent 的原生历史记录");
    expect(dialog).toHaveTextContent("AgentHist 快照或设置");
    expect(dialog).toHaveTextContent("经验复盘结果");
    expect(dialog).toHaveTextContent("源历史记录不会被改动");

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(api.rebuildHistoryIndex).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog", { name: "要重建本地索引吗？" })).not.toBeInTheDocument();
  });

  it("shows busy state, reports counts, and reloads Chats without another source scan", async () => {
    const rebuiltChat = chat(91, "claude", { title: "Conversation from rebuilt index" });
    let currentChats = [CODEX_CHAT];
    const api = createApi({ bootstrap: bootstrap({ chats: chatPage(currentChats) }), chats: currentChats });
    vi.mocked(api.listChats).mockImplementation(async () => ({ ok: true, value: chatPage(currentChats) }));
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["rebuildHistoryIndex"]>>>();
    vi.mocked(api.rebuildHistoryIndex).mockReturnValue(pending.promise);
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await openSettings(user);
    await waitFor(() => expect(api.listChats).toHaveBeenCalled());
    const refreshCalls = vi.mocked(api.refresh).mock.calls.length;
    const listCalls = vi.mocked(api.listChats).mock.calls.length;

    const dialog = await openRebuildDialog(user);
    const confirm = within(dialog).getByRole("button", { name: "重建索引" });
    await user.click(confirm);
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveTextContent("正在重建");
    expect(api.rebuildHistoryIndex).toHaveBeenCalledWith();

    currentChats = [rebuiltChat];
    await act(async () => {
      pending.resolve({
        ok: true,
        value: { rebuilt: true, removed: true, sessions: 7, issues: 2 },
      });
      await pending.promise;
    });

    expect(await screen.findByText(/索引重建完成.*7 个会话.*2 个问题/)).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.listChats).mock.calls.length).toBeGreaterThan(listCalls));
    expect(api.refresh).toHaveBeenCalledTimes(refreshCalls);
    expect(screen.queryByRole("alertdialog", { name: "要重建本地索引吗？" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "对话" }));
    expect(await screen.findByRole("heading", { name: rebuiltChat.title })).toBeInTheDocument();
  });

  it("keeps the dialog retryable and redacts result details and thrown bridge errors", async () => {
    const api = createApi();
    vi.mocked(api.rebuildHistoryIndex)
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "history_index_rebuild_failed",
          message: "The local index could not be rebuilt.",
          retryable: true,
          details: { private_path: "C:\\Private\\index.sqlite" },
        },
      })
      .mockRejectedValueOnce(new Error("C:\\Private\\bridge-secret"));
    installApi(api);
    const user = userEvent.setup();
    const view = render(<App />);
    await openSettings(user);

    const dialog = await openRebuildDialog(user);
    const confirm = within(dialog).getByRole("button", { name: "重建索引" });
    await user.click(confirm);
    expect(await within(dialog).findByText("The local index could not be rebuilt.")).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("index.sqlite");
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(await within(dialog).findByText("桌面端未能完成索引重建。")).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("bridge-secret");
    expect(confirm).toBeEnabled();
  });
});

async function openSettings(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByRole("heading", { name: "对话" });
  await user.click(screen.getByRole("button", { name: "设置" }));
  await screen.findByRole("heading", { name: "设置" });
}

async function openRebuildDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: /重建索引/ }));
  return await screen.findByRole("alertdialog", { name: "要重建本地索引吗？" });
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
