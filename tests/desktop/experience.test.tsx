import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentHistDesktopApi,
  DesktopResult,
  ExperienceProgressDto,
  LoadExperienceReviewResultDto,
  RunExperienceResultDto,
} from "../../src/desktop/contracts.js";
import { ExperiencePage } from "../../src/desktop/renderer/components/ExperiencePage.js";
import { App } from "../../src/desktop/renderer/App.js";
import {
  CODEX_CHAT,
  createApi,
  experienceDetail,
  experiencePreview,
  experienceReview,
  installApi,
} from "./fixtures.js";

describe("Experience review", () => {
  it("shows a single request and prevents oversized history from being split into extra requests", async () => {
    const api = createApi();
    vi.mocked(api.previewExperience)
      .mockResolvedValueOnce({ ok: true, value: experiencePreview({ singleRequest: true, evidenceRequests: 1, candidateRequestsUpperBound: 0 }) })
      .mockResolvedValueOnce({ ok: true, value: experiencePreview({ singleRequest: true, evidenceRequests: 1, candidateRequestsUpperBound: 0, inputLimitExceeded: true, inputTokenLimit: 50000, estimatedInputTokens: 80000 }) });
    render(<ExperiencePage api={api} onOpenSession={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "分析历史" }));
    expect((await screen.findByText("模型请求")).parentElement).toHaveTextContent("1模型请求");
    expect(screen.getByText(/只请求模型一次/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "刷新预览" }));
    expect(await screen.findByText("当前模型的单次上下文不足")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "运行分析" })).not.toBeInTheDocument();
    expect(api.runExperience).not.toHaveBeenCalled();
  });

  it("shows complete coverage and permits a large library within the configured model capacity", async () => {
    const api = createApi();
    vi.mocked(api.previewExperience).mockResolvedValue({ ok: true, value: experiencePreview({ singleRequest: true, sessions: 218, queuedCards: 518,
      evidenceRequests: 1, candidateRequestsUpperBound: 0, estimatedInputTokens: 58104, originalInputTokens: 95011,
      modelContextWindow: 1000000, inputTokenLimit: 891808, inputBudgetSource: "agent", inputCompacted: true, inputLimitExceeded: false,
    }) });
    render(<ExperiencePage api={api} onOpenSession={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "分析历史" }));
    expect(await screen.findByText(/全部 218 个对话、518 条证据/)).toBeInTheDocument();
    expect(screen.getByText(/输入从约 95,011 压缩到 58,104/)).toBeInTheDocument();
    expect(screen.getByText(/1,000,000 上下文容量/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行分析" })).toBeEnabled();
    expect(screen.queryByText(/减少勾选范围/)).not.toBeInTheDocument();
  });
  it("uses selected history for both preview and execution and invalidates the preview when scope changes", async () => {
    const api = createApi();
    vi.mocked(api.previewExperience).mockResolvedValue({ ok: true, value: experiencePreview({ scope: "sessions" }) });
    vi.mocked(api.runExperience).mockResolvedValue({ ok: true, value: { status: "cancelled" } });
    const selected = new Set([CODEX_CHAT.sessionRef]);
    render(<ExperiencePage api={api} onOpenSession={() => {}} selectedSessionRefs={selected} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "分析历史" }));
    expect(api.previewExperience).toHaveBeenCalledWith({ scope: "sessions", sessionRefs: [...selected] });
    await user.click(await screen.findByRole("button", { name: "运行分析" }));
    expect(api.runExperience).toHaveBeenCalledWith(expect.objectContaining({ scope: { scope: "sessions", sessionRefs: [...selected] } }));
    await screen.findByText("已取消分析，没有创建审阅。");
    await user.click(screen.getByRole("radio", { name: "全部历史" }));
    expect(screen.queryByRole("button", { name: "运行分析" })).not.toBeInTheDocument();
  });

  it("keeps a running analysis and its review when navigating to history and back", async () => {
    const api = createApi();
    const pending = deferred<DesktopResult<RunExperienceResultDto>>();
    const review = experienceReview();
    vi.mocked(api.previewExperience).mockResolvedValue({ ok: true, value: experiencePreview() });
    vi.mocked(api.runExperience).mockReturnValue(pending.promise);
    installApi(api);
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "经验" }));
    await user.click(await screen.findByRole("button", { name: "分析历史" }));
    await user.click(await screen.findByRole("button", { name: "运行分析" }));
    await user.click(screen.getByRole("button", { name: "对话" }));
    await act(async () => { pending.resolve({ ok: true, value: { status: "completed", review } }); await pending.promise; });
    expect(api.closeExperienceReview).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "经验" }));
    expect(await screen.findByText(review.directoryName)).toBeVisible();
    expect(api.runExperience).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "对话" }));
    await user.click(screen.getByRole("button", { name: "经验" }));
    expect(screen.getByText(review.directoryName)).toBeVisible();
  });
  it("previews the full history scope without starting model work", async () => {
    const api = createApi();
    vi.mocked(api.previewExperience).mockResolvedValue({ ok: true, value: experiencePreview() });
    const user = userEvent.setup();
    render(<ExperiencePage api={api} onOpenSession={() => {}} />);

    expect(screen.queryByRole("button", { name: /Accept|Edit|Merge|Ignore/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "分析历史" }));

    expect(await screen.findByRole("heading", { name: "分析预览" })).toBeInTheDocument();
    expect(api.previewExperience).toHaveBeenCalledWith({ scope: "all" });
    expect(api.runExperience).not.toHaveBeenCalled();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("24,500")).toBeInTheDocument();
    expect(screen.getByText("模型请求").parentElement).toHaveTextContent("4模型请求");
    expect(screen.getByText("尚未发送任何内容")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行分析" })).toBeEnabled();
  });

  it("runs only after confirmation, renders typed progress, and adopts the completed review", async () => {
    const api = createApi();
    const preview = experiencePreview();
    const review = experienceReview();
    const pending = deferred<DesktopResult<RunExperienceResultDto>>();
    let progressListener: ((progress: ExperienceProgressDto) => void) | undefined;
    vi.mocked(api.previewExperience).mockResolvedValue({ ok: true, value: preview });
    vi.mocked(api.runExperience).mockReturnValue(pending.promise);
    vi.mocked(api.onExperienceProgress).mockImplementation((listener) => {
      progressListener = listener;
      return () => {};
    });
    const user = userEvent.setup();
    render(<ExperiencePage api={api} onOpenSession={() => {}} />);

    await user.click(screen.getByRole("button", { name: "分析历史" }));
    await user.click(await screen.findByRole("button", { name: "运行分析" }));
    expect(api.runExperience).toHaveBeenCalledWith({
      scope: { scope: "all" },
      expectedPreviewRef: preview.previewRef,
    });
    act(() => progressListener?.({ phase: "extracting", currentBatch: 2, totalBatches: 5 }));
    expect(await screen.findByText("正在提取证据 · 批次 2/5")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0.4");
    act(() => progressListener?.({ phase: "organizing", currentRequest: 3, totalRequests: 9 }));
    expect(await screen.findByText("正在整理重复候选项 · 请求 3/9")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", String(3 / 9));

    await act(async () => {
      pending.resolve({ ok: true, value: { status: "completed", review } });
      await pending.promise;
    });
    expect(await screen.findByText(review.directoryName)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "重复要求" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "偏好" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "工作方式" })).toBeInTheDocument();
  });

  it("requires review after replan and explains partial and cancelled runs", async () => {
    const api = createApi();
    const initial = experiencePreview();
    const refreshed = experiencePreview({ previewRef: "experience-preview-2", sessions: 14, queuedCards: 34 });
    vi.mocked(api.previewExperience).mockResolvedValue({ ok: true, value: initial });
    vi.mocked(api.runExperience)
      .mockResolvedValueOnce({ ok: true, value: { status: "replan_required", preview: refreshed } })
      .mockResolvedValueOnce({ ok: true, value: { status: "partial", remainingCards: 7 } })
      .mockResolvedValueOnce({ ok: true, value: { status: "cancelled" } });
    const user = userEvent.setup();
    render(<ExperiencePage api={api} onOpenSession={() => {}} />);

    await user.click(screen.getByRole("button", { name: "分析历史" }));
    await user.click(await screen.findByRole("button", { name: "运行分析" }));
    expect(await screen.findByText(/预览后历史发生变化/)).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(api.runExperience).toHaveBeenNthCalledWith(1, {
      scope: { scope: "all" },
      expectedPreviewRef: initial.previewRef,
    });

    await user.click(screen.getByRole("button", { name: "运行分析" }));
    expect(await screen.findByText(/仍有 7 张证据卡未处理/)).toBeInTheDocument();
    expect(api.runExperience).toHaveBeenNthCalledWith(2, {
      scope: { scope: "all" },
      expectedPreviewRef: refreshed.previewRef,
    });

    await user.click(screen.getByRole("button", { name: "继续分析" }));
    expect(await screen.findByText("已取消分析，没有创建审阅。")).toBeInTheDocument();
  });

  it("loads grouped candidates, evidence, source navigation, and the output folder", async () => {
    const api = createApi();
    const review = experienceReview();
    const detail = experienceDetail();
    vi.mocked(api.loadExperienceReview).mockResolvedValue({ ok: true, value: { status: "loaded", review } });
    vi.mocked(api.getExperienceCandidate).mockResolvedValue({ ok: true, value: detail });
    vi.mocked(api.openExperienceOutput).mockResolvedValue({ ok: true, value: { opened: true } });
    const openSession = vi.fn();
    const user = userEvent.setup();
    render(<ExperiencePage api={api} onOpenSession={openSession} />);

    await user.click(screen.getByRole("button", { name: "打开审阅" }));
    expect(await screen.findByText(review.directoryName)).toBeInTheDocument();
    for (const group of ["重复要求", "偏好", "工作方式"]) {
      expect(screen.getByRole("heading", { name: group })).toBeInTheDocument();
    }
    expect(screen.getByText(/尚未把候选项接受、编辑、合并或保存/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept|Edit|Merge|Ignore/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Verify source evidence before making a claim\./ }));
    const evidence = await screen.findByLabelText("候选证据");
    expect(api.getExperienceCandidate).toHaveBeenCalledWith({
      handle: review.handle,
      candidateRef: detail.candidateRef,
    });
    expect(within(evidence).getByText(detail.relation)).toBeInTheDocument();
    expect(within(evidence).getByText("Open the source and verify that it directly supports this claim.")).toBeInTheDocument();
    const assistant = within(evidence).getByText("I will verify it against the original source.");
    expect(assistant).not.toBeVisible();
    await user.click(within(evidence).getByText(/助手回复/));
    expect(assistant).toBeVisible();
    await user.click(within(evidence).getByRole("button", { name: "来源对话" }));
    expect(openSession).toHaveBeenCalledWith(CODEX_CHAT.sessionRef);

    await user.click(screen.getByRole("button", { name: "打开输出目录" }));
    expect(api.openExperienceOutput).toHaveBeenCalledWith({ handle: review.handle });
    expect(await screen.findByText("已打开审阅输出目录。")).toBeInTheDocument();
  });

  it("closes replaced and unmounted review handles", async () => {
    const api = createApi();
    const first = experienceReview();
    const second = experienceReview({ handle: "experience-handle-opaque-2", reviewRef: "experience-review-2", directoryName: "agenthist-experience-second" });
    vi.mocked(api.loadExperienceReview)
      .mockResolvedValueOnce({ ok: true, value: { status: "loaded", review: first } })
      .mockResolvedValueOnce({ ok: true, value: { status: "loaded", review: second } });
    const user = userEvent.setup();
    const view = render(<ExperiencePage api={api} onOpenSession={() => {}} />);

    await user.click(screen.getByRole("button", { name: "打开审阅" }));
    await screen.findByText(first.directoryName);
    await user.click(screen.getByRole("button", { name: "打开审阅" }));
    await screen.findByText(second.directoryName);
    await waitFor(() => expect(api.closeExperienceReview).toHaveBeenCalledWith({ handle: first.handle }));

    view.unmount();
    await waitFor(() => expect(api.closeExperienceReview).toHaveBeenCalledWith({ handle: second.handle }));
  });

  it("closes a review handle returned after the page has unmounted", async () => {
    const api = createApi();
    const pending = deferred<DesktopResult<LoadExperienceReviewResultDto>>();
    const review = experienceReview({ handle: "experience-handle-stale" });
    vi.mocked(api.loadExperienceReview).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    const view = render(<ExperiencePage api={api} onOpenSession={() => {}} />);

    await user.click(screen.getByRole("button", { name: "打开审阅" }));
    await waitFor(() => expect(api.loadExperienceReview).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      pending.resolve({ ok: true, value: { status: "loaded", review } });
      await pending.promise;
    });
    await waitFor(() => expect(api.closeExperienceReview).toHaveBeenCalledWith({ handle: review.handle }));
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
