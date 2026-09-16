import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentHistDesktopApi,
  AgentSettingDto,
  ChatSummaryDto,
  DesktopResult,
  ResumePlanDto,
} from "../../src/desktop/contracts.js";
import { ConversationPane } from "../../src/desktop/renderer/components/ConversationPane.js";
import {
  AGENT_SETTINGS,
  CODEX_CHAT,
  chat,
  createApi,
  launchedResume,
  resumePlan,
} from "./fixtures.js";

interface PaneHarnessProps {
  readonly api: AgentHistDesktopApi;
  readonly agentSettings?: readonly AgentSettingDto[];
  readonly chat?: ChatSummaryDto;
  readonly onNotice?: (message: string) => void;
  readonly onChatHidden?: (sessionRef: string) => void;
}

function PaneHarness({
  api,
  agentSettings = AGENT_SETTINGS,
  chat: selectedChat = CODEX_CHAT,
  onNotice = () => {},
  onChatHidden = () => {},
}: PaneHarnessProps) {
  const [technical, setTechnical] = useState(false);
  return (
    <div style={{ width: 1100, height: 800 }}>
      <ConversationPane
        api={api}
        agentSettings={agentSettings}
        chat={selectedChat}
        showTechnicalDetails={technical}
        onShowTechnicalDetailsChange={setTechnical}
        onNotice={onNotice}
        onChatHidden={onChatHidden}
      />
    </div>
  );
}

describe("Resume and conversation actions", () => {
  it("plans and confirms an available native continuation in one click", async () => {
    const api = createApi();
    const notice = vi.fn();
    const user = userEvent.setup();
    render(<PaneHarness api={api} onNotice={notice} />);

    await user.click(screen.getByRole("button", { name: "继续" }));

    await waitFor(() => expect(api.planResume).toHaveBeenCalledWith({
      sessionRef: CODEX_CHAT.sessionRef,
      targetAgent: "codex",
    }));
    await waitFor(() => expect(api.confirmResume).toHaveBeenCalledWith({
      sessionRef: CODEX_CHAT.sessionRef,
      targetAgent: "codex",
      expectedPlanRef: "resume-plan-1",
    }));
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/Codex 已启动 · PID 4242 · 已打开原生对话/));
    expect(screen.queryByRole("dialog", { name: /使用.*继续/ })).not.toBeInTheDocument();
  });

  it("keeps an in-flight native plan alive when refresh replaces only the summary object", async () => {
    const api = createApi();
    const pending = deferred<DesktopResult<ResumePlanDto>>();
    vi.mocked(api.planResume).mockReturnValue(pending.promise);
    const notice = vi.fn();
    const user = userEvent.setup();
    const view = render(<PaneHarness api={api} onNotice={notice} />);

    await user.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(api.planResume).toHaveBeenCalledTimes(1));
    const refreshedSummary: ChatSummaryDto = {
      ...CODEX_CHAT,
      title: "Refreshed database migration title",
      updatedAt: "2026-09-04T09:30:00.000Z",
    };
    view.rerender(<PaneHarness api={api} chat={refreshedSummary} onNotice={notice} />);
    expect(screen.getByRole("heading", { name: "Refreshed database migration title" })).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ ok: true, value: resumePlan() });
      await pending.promise;
    });

    await waitFor(() => expect(api.confirmResume).toHaveBeenCalledWith({
      sessionRef: CODEX_CHAT.sessionRef,
      targetAgent: "codex",
      expectedPlanRef: "resume-plan-1",
    }));
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("PID 4242"));
  });

  it("cancels an in-flight resume plan only when the selected session reference changes", async () => {
    const api = createApi();
    const pending = deferred<DesktopResult<ResumePlanDto>>();
    vi.mocked(api.planResume).mockReturnValue(pending.promise);
    const notice = vi.fn();
    const user = userEvent.setup();
    const view = render(<PaneHarness api={api} onNotice={notice} />);

    await user.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(api.planResume).toHaveBeenCalledTimes(1));
    const anotherChat = chat(99, "codex", { title: "A different selected conversation" });
    view.rerender(<PaneHarness api={api} chat={anotherChat} onNotice={notice} />);
    expect(screen.getByRole("heading", { name: "A different selected conversation" })).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ ok: true, value: resumePlan() });
      await pending.promise;
    });

    expect(api.confirmResume).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "继续" })).toBeEnabled();
  });

  it("lists only detected Agents and explains cross-Agent conversion impact before launch", async () => {
    const api = createApi();
    const plan = resumePlan({
      planRef: "cross-plan-1",
      targetAgent: "claude",
      route: "conversion",
      quality: "degraded",
      targetWorkspace: "D:\\Mapped Work\\Project 1",
      workspaceStatus: "mapped",
      needsWrite: true,
      findings: [
        { code: "portable.messages.exact", disposition: "exact", count: 2 },
        { code: "claude.session_identity.synthesized", disposition: "synthesized", count: 1 },
        { code: "codex.tool_state.skipped", disposition: "skipped", count: 3 },
        { code: "codex.future_payload.skipped", disposition: "skipped", count: 1 },
      ],
    });
    vi.mocked(api.planResume).mockResolvedValue({ ok: true, value: plan });
    vi.mocked(api.confirmResume).mockResolvedValue({ ok: true, value: launchedResume(plan, { pid: 7788 }) });
    const user = userEvent.setup();
    render(<PaneHarness api={api} />);

    await user.click(screen.getByRole("button", { name: "使用其他 Agent 继续" }));
    expect(await screen.findByRole("menuitem", { name: /Codex.*原 Agent/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "OpenCode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Pi" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Claude Code" }));
    const dialog = await screen.findByRole("dialog", { name: "使用 Claude Code 继续" });
    expect(within(dialog).getByText("Codex")).toBeInTheDocument();
    expect(within(dialog).getByText("Claude Code")).toBeInTheDocument();
    expect(within(dialog).getByText("新建转换对话")).toBeInTheDocument();
    expect(within(dialog).getByText(CODEX_CHAT.workspace)).toBeInTheDocument();
    expect(within(dialog).getByText("D:\\Mapped Work\\Project 1")).toBeInTheDocument();
    for (const heading of ["保留", "重建", "省略"]) {
      expect(within(dialog).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(within(dialog).getByText("可读对话消息已完整保留")).toBeInTheDocument();
    expect(within(dialog).getByText("Claude Code 会话标识已重建")).toBeInTheDocument();
    expect(within(dialog).getByText("Codex 工具状态已省略")).toBeInTheDocument();
    const futureFinding = within(dialog).getByText("目标 Agent 不支持的相关内容已省略").closest("li");
    expect(futureFinding).toHaveAttribute("title", "技术标识：codex.future_payload.skipped");
    expect(within(dialog).queryByText("codex.future_payload.skipped")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/通过事务创建目标对话/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "转换并继续" }));
    expect(await within(dialog).findByText("PID 7788")).toBeInTheDocument();
    expect(within(dialog).getByText("已打开转换后的对话")).toBeInTheDocument();
    expect(api.confirmResume).toHaveBeenCalledWith({
      sessionRef: CODEX_CHAT.sessionRef,
      targetAgent: "claude",
      expectedPlanRef: "cross-plan-1",
    });
  });

  it("requires a second confirmation after an authoritative replan", async () => {
    const api = createApi();
    const first = resumePlan({
      planRef: "plan-before-change",
      targetAgent: "claude",
      route: "conversion",
      quality: "exact",
      needsWrite: true,
      findings: [{ code: "portable.messages.exact", disposition: "exact", count: 1 }],
    });
    const refreshed = resumePlan({
      ...first,
      planRef: "plan-after-change",
      quality: "degraded",
      findings: [{ code: "claude.identity.synthesized", disposition: "synthesized", count: 1 }],
    });
    vi.mocked(api.planResume).mockResolvedValue({ ok: true, value: first });
    vi.mocked(api.confirmResume)
      .mockResolvedValueOnce({ ok: true, value: { status: "replan_required", plan: refreshed } })
      .mockResolvedValueOnce({ ok: true, value: launchedResume(refreshed, { pid: 9001 }) });
    const user = userEvent.setup();
    render(<PaneHarness api={api} />);

    await user.click(screen.getByRole("button", { name: "使用其他 Agent 继续" }));
    await user.click(await screen.findByRole("menuitem", { name: "Claude Code" }));
    const dialog = await screen.findByRole("dialog", { name: "使用 Claude Code 继续" });
    await user.click(within(dialog).getByRole("button", { name: "转换并继续" }));

    expect(await within(dialog).findByText(/来源或目标发生变化/)).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "重建" })).toBeInTheDocument();
    expect(api.confirmResume).toHaveBeenNthCalledWith(1, {
      sessionRef: CODEX_CHAT.sessionRef,
      targetAgent: "claude",
      expectedPlanRef: "plan-before-change",
    });

    await user.click(within(dialog).getByRole("button", { name: "转换并继续" }));
    expect(await within(dialog).findByText("PID 9001")).toBeInTheDocument();
    expect(api.confirmResume).toHaveBeenNthCalledWith(2, {
      sessionRef: CODEX_CHAT.sessionRef,
      targetAgent: "claude",
      expectedPlanRef: "plan-after-change",
    });
  });

  it("prevents confirmation when the target is unavailable or conversion is blocked", async () => {
    const api = createApi();
    vi.mocked(api.planResume).mockResolvedValue({
      ok: true,
      value: resumePlan({
        targetAgent: "claude",
        targetAvailable: false,
        route: "conversion",
        quality: "blocked",
        findings: [{ code: "portable.messages.empty", disposition: "blocked", count: 1 }],
      }),
    });
    const user = userEvent.setup();
    render(<PaneHarness api={api} />);

    await user.click(screen.getByRole("button", { name: "使用其他 Agent 继续" }));
    await user.click(await screen.findByRole("menuitem", { name: "Claude Code" }));
    const dialog = await screen.findByRole("dialog", { name: "使用 Claude Code 继续" });
    expect(within(dialog).getByRole("heading", { name: "阻止" })).toBeInTheDocument();
    expect(within(dialog).getByText(/Claude Code 不可用/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "转换并继续" })).toBeDisabled();
    expect(api.confirmResume).not.toHaveBeenCalled();
  });

  it("offers an explicit readable-text fallback for a blocked conversion", async () => {
    const api = createApi();
    vi.mocked(api.planResume)
      .mockResolvedValueOnce({
        ok: true,
        value: resumePlan({
          targetAgent: "claude",
          targetAvailable: true,
          route: "conversion",
          quality: "blocked",
          findings: [{ code: "portable.messages.empty", disposition: "blocked", count: 1 }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: resumePlan({
          planRef: "resume-plan-lossy",
          targetAgent: "claude",
          targetAvailable: true,
          route: "conversion",
          quality: "degraded",
          findings: [
            { code: "portable.lossy_text_fallback", disposition: "degraded", count: 1 },
            { code: "portable.lossy_content_omitted", disposition: "skipped", count: 3 },
          ],
        }),
      });
    const user = userEvent.setup();
    render(<PaneHarness api={api} />);

    await user.click(screen.getByRole("button", { name: "使用其他 Agent 继续" }));
    await user.click(await screen.findByRole("menuitem", { name: "Claude Code" }));
    const dialog = await screen.findByRole("dialog", { name: "使用 Claude Code 继续" });
    await user.click(within(dialog).getByRole("button", { name: "尝试有损转换" }));

    await waitFor(() => expect(api.planResume).toHaveBeenNthCalledWith(2, {
      sessionRef: CODEX_CHAT.sessionRef,
      targetAgent: "claude",
      allowLossyConversion: true,
    }));
    expect(await within(dialog).findByText(/这是有损转换/)).toBeInTheDocument();
    expect(within(dialog).getByText("仅保留可读的用户与助手文本")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "转换并继续" })).toBeEnabled();
  });

  it("opens a workspace and confirms recoverable hiding using only the session reference", async () => {
    const api = createApi();
    const notice = vi.fn();
    const hidden = vi.fn();
    const user = userEvent.setup();
    render(<PaneHarness api={api} onNotice={notice} onChatHidden={hidden} />);

    await user.click(screen.getByRole("button", { name: "更多对话操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "打开工作区" }));
    expect(api.openWorkspace).toHaveBeenCalledWith({ sessionRef: CODEX_CHAT.sessionRef });
    expect(notice).toHaveBeenCalledWith(`已打开工作区 · ${CODEX_CHAT.workspace}`);

    await user.click(screen.getByRole("button", { name: "更多对话操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "从 AgentHist 隐藏…" }));
    const alert = await screen.findByRole("alertdialog", { name: "隐藏此对话？" });
    expect(alert).toHaveTextContent("只会在 AgentHist 中隐藏该对话");
    expect(alert).toHaveTextContent("不会删除或修改原始 Codex 历史");
    expect(alert).toHaveTextContent("之后仍可恢复");

    await user.click(within(alert).getByRole("button", { name: "隐藏对话" }));
    await waitFor(() => expect(api.updateChat).toHaveBeenCalledWith({
      sessionRef: CODEX_CHAT.sessionRef,
      operation: "delete",
    }));
    expect(hidden).toHaveBeenCalledWith(CODEX_CHAT.sessionRef);
  });
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("deferred promise resolver is unavailable");
      resolvePromise(value);
    },
  };
}
