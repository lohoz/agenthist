import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AgentHistDesktopApi, ChatSummaryDto } from "../../src/desktop/contracts.js";
import { ConversationPane } from "../../src/desktop/renderer/components/ConversationPane.js";
import type { ClipboardWriter } from "../../src/desktop/renderer/components/MarkdownMessage.js";
import { AGENT_SETTINGS, CLAUDE_CHAT, CODEX_CHAT, conversationPage, createApi } from "./fixtures.js";

function Harness({ api, chat = CODEX_CHAT, writeClipboard, onChatRestored, onNotice = () => {} }: {
  readonly api: AgentHistDesktopApi;
  readonly chat?: ChatSummaryDto;
  readonly writeClipboard?: ClipboardWriter;
  readonly onChatRestored?: (sessionRef: string) => void;
  readonly onNotice?: (message: string) => void;
}) {
  const [technical, setTechnical] = useState(false);
  return (
    <div style={{ width: 1000, height: 800 }}>
      <ConversationPane
        api={api}
        agentSettings={AGENT_SETTINGS}
        chat={chat}
        showTechnicalDetails={technical}
        onShowTechnicalDetailsChange={setTechnical}
        onNotice={onNotice}
        onChatHidden={() => {}}
        {...(onChatRestored === undefined ? {} : { onChatRestored })}
        {...(writeClipboard === undefined ? {} : { writeClipboard })}
      />
    </div>
  );
}

describe("Conversation detail", () => {
  it("renders readable Markdown and copies code without Node access", async () => {
    const api = createApi();
    const user = userEvent.setup();
    const copied: string[] = [];
    const copy = async (text: string): Promise<void> => { copied.push(text); };
    const view = render(<Harness api={api} writeClipboard={copy} />);
    const rendered = within(view.container);

    expect(await rendered.findByText("the parser", { selector: "strong" })).toBeInTheDocument();
    expect(rendered.getByText("const answer = 42;")).toBeInTheDocument();
    const copyButton = rendered.getByRole("button", { name: "复制代码" });
    await user.click(copyButton);
    await waitFor(() => expect(rendered.getByRole("button", { name: "复制代码" })).toHaveTextContent("已复制"));
    expect(copied).toEqual(["const answer = 42;"]);
  });

  it("keeps system, gap, and tool details quiet until explicitly revealed", async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(<Harness api={api} />);
    await screen.findByText("The parser is fixed and the focused test passes.");

    expect(screen.queryByText("Private system context shown only on request")).not.toBeInTheDocument();
    expect(screen.queryByText("Read src/parser.ts")).not.toBeInTheDocument();
    expect(screen.getByText("已折叠 1 项技术细节")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "显示技术细节" }));
    expect(await screen.findByText("Private system context shown only on request")).toBeInTheDocument();
    expect(screen.getByText("Read src/parser.ts")).toBeInTheDocument();
    expect(screen.getByText("src/parser.ts")).toBeInTheDocument();
    expect(screen.getByText("complete tool output")).not.toBeVisible();
    await user.click(screen.getByText("Read", { selector: "summary" }));
    expect(screen.getByText("complete tool output")).toBeVisible();
  });

  it("uses Ctrl+F for indexed in-conversation search and match navigation", async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(<Harness api={api} />);
    await screen.findByText("The parser is fixed and the focused test passes.");

    await user.keyboard("{Control>}f{/Control}");
    const input = await screen.findByRole("textbox", { name: "在对话中搜索" });
    await user.type(input, "parser");
    expect(await screen.findByText("1/2")).toBeInTheDocument();
    expect(api.findInConversation).toHaveBeenCalledWith({ sessionRef: CODEX_CHAT.sessionRef, query: "parser" });

    await user.click(screen.getByRole("button", { name: "下一个匹配" }));
    expect(await screen.findByText("2/2")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("The parser is fixed and the focused test passes.").closest("article"))
      .toHaveClass("is-highlighted"));
  });

  it("requests only a bounded first page for a large conversation", async () => {
    const api = createApi({ conversation: {
      ...conversationPage(),
      total: 5_000,
      remaining: 4_996,
    } });
    render(<Harness api={api} />);
    await screen.findByText("The parser is fixed and the focused test passes.");
    expect(api.getConversation).toHaveBeenCalledWith({ sessionRef: CODEX_CHAT.sessionRef, offset: 0, limit: 80 });
    expect(document.querySelectorAll(".virtual-conversation-row").length).toBeLessThan(40);
  });

  it("recovers from thrown conversation and in-conversation search bridge calls", async () => {
    const api = createApi();
    vi.mocked(api.getConversation)
      .mockRejectedValueOnce(new Error("private conversation failure"))
      .mockResolvedValueOnce({ ok: true, value: conversationPage() });
    vi.mocked(api.findInConversation).mockRejectedValue(new Error("private search failure"));
    const user = userEvent.setup();
    const view = render(<Harness api={api} />);

    expect(await screen.findByText("对话不可用")).toBeInTheDocument();
    expect(screen.getByText("桌面桥接没有完成对话请求。")).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("private conversation failure");
    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("The parser is fixed and the focused test passes.");

    await user.keyboard("{Control>}f{/Control}");
    await user.type(screen.getByRole("textbox", { name: "在对话中搜索" }), "parser");
    expect(await screen.findByText("桌面桥接没有完成对话搜索。")).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("private search failure");
  });

  it("does not let an old retry clear the loading state for a newly selected conversation", async () => {
    const retry = deferred<Awaited<ReturnType<AgentHistDesktopApi["getConversation"]>>>();
    const nextConversation = deferred<Awaited<ReturnType<AgentHistDesktopApi["getConversation"]>>>();
    const api = createApi();
    vi.mocked(api.getConversation)
      .mockRejectedValueOnce(new Error("initial failure"))
      .mockReturnValueOnce(retry.promise)
      .mockReturnValueOnce(nextConversation.promise);
    const user = userEvent.setup();
    const view = render(<Harness api={api} />);

    await screen.findByText("对话不可用");
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.getConversation).toHaveBeenCalledTimes(2));
    view.rerender(<Harness api={api} chat={CLAUDE_CHAT} />);
    await waitFor(() => expect(api.getConversation).toHaveBeenCalledTimes(3));

    await act(async () => {
      retry.resolve({ ok: true, value: conversationPage(CODEX_CHAT) });
      await retry.promise;
    });
    expect(screen.getByLabelText("正在加载对话")).toBeInTheDocument();

    await act(async () => {
      nextConversation.resolve({ ok: true, value: conversationPage(CLAUDE_CHAT) });
      await nextConversation.promise;
    });
    await waitFor(() => expect(screen.queryByLabelText("正在加载对话")).not.toBeInTheDocument());
  });

  it("reloads the selected conversation when a refresh updates the same session", async () => {
    const refreshedChat = { ...CODEX_CHAT, updatedAt: "2026-09-08T08:30:00.000Z" };
    const refreshedPage = conversationPage(refreshedChat);
    const refreshedText = "The refreshed session includes a newly completed answer.";
    const api = createApi();
    vi.mocked(api.getConversation)
      .mockResolvedValueOnce({ ok: true, value: conversationPage() })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ...refreshedPage,
          items: refreshedPage.items.map((item) =>
            item.kind === "message" && item.role === "assistant" ? { ...item, text: refreshedText } : item),
        },
      });
    const view = render(<Harness api={api} />);

    await screen.findByText("The parser is fixed and the focused test passes.");
    view.rerender(<Harness api={api} chat={refreshedChat} />);

    expect(await screen.findByText(refreshedText)).toBeInTheDocument();
    expect(api.getConversation).toHaveBeenCalledTimes(2);
    expect(api.getConversation).toHaveBeenLastCalledWith({
      sessionRef: CODEX_CHAT.sessionRef,
      offset: 0,
      limit: 80,
    });
  });

  it("makes an archived deleted conversation active before notifying its owner", async () => {
    const restored = vi.fn();
    const notice = vi.fn();
    const api = createApi();
    vi.mocked(api.updateChat)
      .mockResolvedValueOnce({
        ok: true,
        value: { sessionRef: CODEX_CHAT.sessionRef, changed: true, state: "archived" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { sessionRef: CODEX_CHAT.sessionRef, changed: true, state: "active" },
      });
    const user = userEvent.setup();
    render(<Harness
      api={api}
      chat={{ ...CODEX_CHAT, libraryState: "deleted" }}
      onChatRestored={restored}
      onNotice={notice}
    />);

    await screen.findByText("The parser is fixed and the focused test passes.");
    await user.click(screen.getByRole("button", { name: "更多对话操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "恢复到当前对话" }));

    await waitFor(() => expect(restored).toHaveBeenCalledWith(CODEX_CHAT.sessionRef));
    expect(api.updateChat).toHaveBeenNthCalledWith(1, {
      sessionRef: CODEX_CHAT.sessionRef,
      operation: "undelete",
    });
    expect(api.updateChat).toHaveBeenNthCalledWith(2, {
      sessionRef: CODEX_CHAT.sessionRef,
      operation: "unarchive",
    });
    expect(notice).toHaveBeenCalledWith("对话已恢复到当前对话");
  });

  it("does not report an archived conversation as active when unarchive fails", async () => {
    const restored = vi.fn();
    const notice = vi.fn();
    const api = createApi();
    vi.mocked(api.updateChat)
      .mockResolvedValueOnce({
        ok: true,
        value: { sessionRef: CODEX_CHAT.sessionRef, changed: true, state: "archived" },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "test.unarchive_failed", message: "无法取消归档", retryable: true },
      });
    const user = userEvent.setup();
    render(<Harness
      api={api}
      chat={{ ...CODEX_CHAT, libraryState: "deleted" }}
      onChatRestored={restored}
      onNotice={notice}
    />);

    await screen.findByText("The parser is fixed and the focused test passes.");
    await user.click(screen.getByRole("button", { name: "更多对话操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "恢复到当前对话" }));

    await waitFor(() => expect(api.updateChat).toHaveBeenCalledTimes(2));
    expect(restored).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(
      "无法恢复到当前对话 · 无法取消归档；对话已取消隐藏但仍在归档中，可重试恢复",
    );
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
