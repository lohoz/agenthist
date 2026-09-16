import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AgentHistDesktopApi } from "../../src/desktop/contracts.js";
import { QuickSearch } from "../../src/desktop/renderer/components/QuickSearch.js";
import { chat, chatPage, createApi } from "./fixtures.js";

describe("Quick Search dialog", () => {
  it("traps keyboard focus and closes with Escape", async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(<Harness api={api} />);

    const dialog = await screen.findByRole("dialog", { name: "快速搜索" });
    const input = within(dialog).getByRole("textbox", { name: "快速搜索对话" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "快速搜索" })).not.toBeInTheDocument();
  });

  it("ignores a stale result after close and reports a later thrown search", async () => {
    const staleChat = chat(301, "codex", { title: "Stale quick result" });
    const freshChat = chat(302, "claude", { title: "Fresh quick result" });
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["listChats"]>>>();
    const api = createApi();
    vi.mocked(api.listChats)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true, value: chatPage([freshChat]) })
      .mockRejectedValueOnce(new Error("private quick-search failure"));
    const user = userEvent.setup();
    const view = render(<Harness api={api} />);
    await screen.findByRole("dialog", { name: "快速搜索" });
    await waitFor(() => expect(api.listChats).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Open Quick Search" }));
    expect(await screen.findByRole("option", { name: /Fresh quick result/ })).toBeInTheDocument();
    await act(async () => {
      pending.resolve({ ok: true, value: chatPage([staleChat]) });
      await pending.promise;
    });
    expect(screen.queryByRole("option", { name: /Stale quick result/ })).not.toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "快速搜索对话" });
    await user.type(input, "fail");
    expect(await screen.findByText("桌面桥接没有完成搜索请求。")).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("private quick-search failure");
  });
});

function Harness({ api }: { readonly api: AgentHistDesktopApi }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open Quick Search</button>
      <QuickSearch api={api} open={open} onClose={() => setOpen(false)} onChoose={() => {}} />
    </>
  );
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
