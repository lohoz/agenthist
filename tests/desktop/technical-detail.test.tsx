import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentHistDesktopApi,
  TechnicalDetailDto,
} from "../../src/desktop/contracts.js";
import { TechnicalDetailView } from "../../src/desktop/renderer/components/TechnicalDetailView.js";
import { CODEX_CHAT, createApi } from "./fixtures.js";

const ITEM_INDEX = 17;
const DETAIL_INDEX = 2;
const DETAIL_ID = `${CODEX_CHAT.sessionRef}:${ITEM_INDEX}:technical:${DETAIL_INDEX}`;
const CHUNK_CHARACTERS = 64 * 1024;

describe("Technical detail pagination", () => {
  it("appends multi-chunk emoji content by Unicode code point and copies the complete result", async () => {
    const preview = "\u{1F642}".repeat(32 * 1024);
    const middle = "\u{1F9EA}".repeat(CHUNK_CHARACTERS);
    const ending = `${"\u7D42".repeat(12_000)} done`;
    const previewLength = codePointCount(preview);
    const middleOffset = previewLength + codePointCount(middle);
    const totalCharacters = middleOffset + codePointCount(ending);
    const detail = technicalDetail({ detail: preview, totalCharacters, truncated: true });
    const api = createApi();
    vi.mocked(api.getTechnicalDetail)
      .mockResolvedValueOnce({
        ok: true,
        value: {
          status: "available",
          id: detail.id,
          detailIndex: detail.detailIndex,
          label: detail.label,
          offset: previewLength,
          limit: CHUNK_CHARACTERS,
          totalCharacters,
          returnedCharacters: codePointCount(middle),
          text: middle,
          nextOffset: middleOffset,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          status: "available",
          id: detail.id,
          detailIndex: detail.detailIndex,
          label: detail.label,
          offset: middleOffset,
          limit: CHUNK_CHARACTERS,
          totalCharacters,
          returnedCharacters: codePointCount(ending),
          text: ending,
        },
      });
    const copied = vi.fn(async (_text: string): Promise<void> => {});
    const user = userEvent.setup();
    const view = renderDetail(api, detail, copied);

    const disclosure = view.container.querySelector("details");
    const output = view.container.querySelector("pre");
    expect(disclosure).not.toHaveAttribute("open");
    expect(output).not.toBeVisible();
    expect(api.getTechnicalDetail).not.toHaveBeenCalled();

    await user.click(screen.getByText(detail.label, { selector: "summary" }));
    await waitFor(() => expect(api.getTechnicalDetail).toHaveBeenNthCalledWith(1, {
      sessionRef: CODEX_CHAT.sessionRef,
      itemIndex: ITEM_INDEX,
      detailIndex: DETAIL_INDEX,
      offset: previewLength,
      limit: CHUNK_CHARACTERS,
    }));
    expect(await screen.findByRole("button", { name: "加载更多" })).toBeInTheDocument();
    expect(output?.textContent).toBe(`${preview}${middle}`);

    await user.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() => expect(api.getTechnicalDetail).toHaveBeenNthCalledWith(2, {
      sessionRef: CODEX_CHAT.sessionRef,
      itemIndex: ITEM_INDEX,
      detailIndex: DETAIL_INDEX,
      offset: middleOffset,
      limit: CHUNK_CHARACTERS,
    }));
    await screen.findByText(new RegExp(`已完整加载.*${new Intl.NumberFormat().format(totalCharacters)} 个字符`));
    expect(output?.textContent).toBe(`${preview}${middle}${ending}`);
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();

    const copyButton = screen.getByRole("button", { name: "复制已加载的技术细节" });
    await user.click(copyButton);
    await waitFor(() => expect(screen.getByRole("button", { name: "复制已加载的技术细节" })).toHaveTextContent("已复制"));
    expect(copied).toHaveBeenCalledWith(`${preview}${middle}${ending}`);
  });

  it("shows an unavailable reason without requesting content", async () => {
    const detail = technicalDetail({
      detail: "",
      totalCharacters: 0,
      truncated: false,
      available: false,
      unavailableReason: "The original tool payload is no longer available.",
    });
    const api = createApi();
    const user = userEvent.setup();
    renderDetail(api, detail);

    expect(api.getTechnicalDetail).not.toHaveBeenCalled();
    await user.click(screen.getByText(detail.label, { selector: "summary" }));
    expect(screen.getByText("The original tool payload is no longer available.")).toBeVisible();
    expect(api.getTechnicalDetail).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "复制已加载的技术细节" })).not.toBeInTheDocument();
  });

  it("retries failures without exposing private error details", async () => {
    const preview = `preview \u{1F642}`;
    const ending = " and recovered";
    const offset = codePointCount(preview);
    const totalCharacters = offset + codePointCount(ending);
    const detail = technicalDetail({ detail: preview, totalCharacters, truncated: true });
    const api = createApi();
    vi.mocked(api.getTechnicalDetail)
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "technical_detail_read_failed",
          message: "The next segment is temporarily unavailable.",
          retryable: true,
          details: { private_path: "C:\\Private\\tool-output.json" },
        },
      })
      .mockRejectedValueOnce(new Error("C:\\Private\\bridge-secret"))
      .mockResolvedValueOnce({
        ok: true,
        value: {
          status: "available",
          id: detail.id,
          detailIndex: detail.detailIndex,
          label: detail.label,
          offset,
          limit: CHUNK_CHARACTERS,
          totalCharacters,
          returnedCharacters: codePointCount(ending),
          text: ending,
        },
      });
    const user = userEvent.setup();
    const view = renderDetail(api, detail);

    await user.click(screen.getByText(detail.label, { selector: "summary" }));
    expect(await screen.findByText("The next segment is temporarily unavailable.")).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("tool-output.json");

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("无法加载下一段技术细节。")).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("bridge-secret");

    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText(/已完整加载/);
    expect(view.container.querySelector("pre")?.textContent).toBe(`${preview}${ending}`);
    expect(api.getTechnicalDetail).toHaveBeenCalledTimes(3);
  });

  it("does not duplicate the automatic chunk across collapse and reopen", async () => {
    const preview = "preview";
    const ending = "-loaded-once";
    const offset = codePointCount(preview);
    const totalCharacters = offset + codePointCount(ending);
    const detail = technicalDetail({ detail: preview, totalCharacters, truncated: true });
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["getTechnicalDetail"]>>>();
    const api = createApi();
    vi.mocked(api.getTechnicalDetail).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    const view = renderDetail(api, detail);
    const summary = screen.getByText(detail.label, { selector: "summary" });

    await user.click(summary);
    await waitFor(() => expect(api.getTechnicalDetail).toHaveBeenCalledTimes(1));
    await user.click(summary);
    expect(view.container.querySelector("details")).not.toHaveAttribute("open");
    await user.click(summary);
    expect(api.getTechnicalDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({
        ok: true,
        value: {
          status: "available",
          id: detail.id,
          detailIndex: detail.detailIndex,
          label: detail.label,
          offset,
          limit: CHUNK_CHARACTERS,
          totalCharacters,
          returnedCharacters: codePointCount(ending),
          text: ending,
        },
      });
      await pending.promise;
    });
    expect(view.container.querySelector("pre")?.textContent).toBe(`${preview}${ending}`);
    await user.click(summary);
    await user.click(summary);
    expect(api.getTechnicalDetail).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale chunk after switching sessions", async () => {
    const oldPreview = "old-preview";
    const oldDetail = technicalDetail({
      detail: oldPreview,
      totalCharacters: codePointCount(oldPreview) + 5,
      truncated: true,
    });
    const nextSessionRef = CODEX_CHAT.sessionRef.replace("_codex_", "_claude_");
    const nextDetail = technicalDetail({
      id: `${nextSessionRef}:${ITEM_INDEX}:technical:${DETAIL_INDEX}`,
      detail: "new-session-preview",
      totalCharacters: codePointCount("new-session-preview"),
      truncated: false,
    });
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["getTechnicalDetail"]>>>();
    const api = createApi();
    vi.mocked(api.getTechnicalDetail).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    const view = renderDetail(api, oldDetail);

    await user.click(screen.getByText(oldDetail.label, { selector: "summary" }));
    await waitFor(() => expect(api.getTechnicalDetail).toHaveBeenCalledTimes(1));
    view.rerender(
      <TechnicalDetailView
        api={api}
        sessionRef={nextSessionRef}
        itemIndex={ITEM_INDEX}
        detail={nextDetail}
        writeClipboard={undefined}
      />,
    );

    await act(async () => {
      pending.resolve({
        ok: true,
        value: {
          status: "available",
          id: oldDetail.id,
          detailIndex: oldDetail.detailIndex,
          label: oldDetail.label,
          offset: codePointCount(oldPreview),
          limit: CHUNK_CHARACTERS,
          totalCharacters: codePointCount(oldPreview) + 5,
          returnedCharacters: 5,
          text: "STALE",
        },
      });
      await pending.promise;
    });

    expect(view.container.querySelector("pre")?.textContent).toBe("new-session-preview");
    expect(view.container).not.toHaveTextContent("STALE");
    expect(view.container.querySelector("details")).not.toHaveAttribute("open");
  });
});

function renderDetail(
  api: AgentHistDesktopApi,
  detail: TechnicalDetailDto,
  writeClipboard?: (text: string) => Promise<void>,
) {
  return render(
    <TechnicalDetailView
      api={api}
      sessionRef={CODEX_CHAT.sessionRef}
      itemIndex={ITEM_INDEX}
      detail={detail}
      writeClipboard={writeClipboard}
    />,
  );
}

function technicalDetail(overrides: Partial<TechnicalDetailDto> = {}): TechnicalDetailDto {
  return {
    id: DETAIL_ID,
    detailIndex: DETAIL_INDEX,
    label: "Tool output",
    summary: "Large local result",
    detail: "preview",
    totalCharacters: 7,
    truncated: false,
    available: true,
    ...overrides,
  };
}

function codePointCount(value: string): number {
  return Array.from(value).length;
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
