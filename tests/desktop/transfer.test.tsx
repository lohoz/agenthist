import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AgentHistDesktopApi } from "../../src/desktop/contracts.js";
import { ConversationPane } from "../../src/desktop/renderer/components/ConversationPane.js";
import { TransferActions } from "../../src/desktop/renderer/components/TransferActions.js";
import {
  AGENT_SETTINGS,
  CODEX_CHAT,
  createApi,
  importPlan,
} from "./fixtures.js";

function ConversationExportHarness({ api, onNotice }: {
  readonly api: AgentHistDesktopApi;
  readonly onNotice: (message: string) => void;
}) {
  const [technical, setTechnical] = useState(false);
  return (
    <div style={{ width: 1100, height: 800 }}>
      <ConversationPane
        api={api}
        agentSettings={AGENT_SETTINGS}
        chat={CODEX_CHAT}
        showTechnicalDetails={technical}
        onShowTechnicalDetailsChange={setTechnical}
        onNotice={onNotice}
        onChatHidden={() => {}}
      />
    </div>
  );
}

describe("Desktop import and export", () => {
  it("uses the native picker for export all and reports success without renderer path input", async () => {
    const api = createApi();
    vi.mocked(api.exportHistory).mockResolvedValue({
      ok: true,
      value: {
        status: "completed",
        file: "C:\\Chosen Output\\history.agenthist",
        sizeBytes: 2048,
        sha256: "a".repeat(64),
        entries: 3,
        objects: 4,
        resources: 1,
        agents: [{ agent: "codex", sessions: 3 }],
        skipped: [],
      },
    });
    const notice = vi.fn();
    const user = userEvent.setup();
    render(<TransferActions api={api} onNotice={notice} onImported={() => {}} />);

    await user.click(screen.getByRole("button", { name: "导入与导出" }));
    await user.click(await screen.findByRole("menuitem", { name: "导出全部…" }));

    await waitFor(() => expect(api.exportHistory).toHaveBeenCalledWith({ scope: "all" }));
    expect(notice).toHaveBeenCalledWith("已导出 3 个对话");
  });

  it("reports native picker cancellation without creating an import handle", async () => {
    const api = createApi();
    const notice = vi.fn();
    const user = userEvent.setup();
    render(<TransferActions api={api} onNotice={notice} onImported={() => {}} />);

    await user.click(screen.getByRole("button", { name: "导入与导出" }));
    await user.click(await screen.findByRole("menuitem", { name: "导入…" }));

    await waitFor(() => expect(api.openImport).toHaveBeenCalledWith());
    expect(notice).toHaveBeenCalledWith("已取消导入");
    expect(api.cancelImport).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancels a stale opaque handle when the picker resolves after unmount", async () => {
    const api = createApi();
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["openImport"]>>>();
    vi.mocked(api.openImport).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    const view = render(<TransferActions api={api} onNotice={() => {}} onImported={() => {}} />);

    await user.click(screen.getByRole("button", { name: "导入与导出" }));
    await user.click(await screen.findByRole("menuitem", { name: "导入…" }));
    await waitFor(() => expect(api.openImport).toHaveBeenCalledTimes(1));
    view.unmount();

    await act(async () => {
      pending.resolve({ ok: true, value: { status: "planned", plan: importPlan() } });
      await pending.promise;
    });
    await waitFor(() => expect(api.cancelImport).toHaveBeenCalledWith({ handle: "import-handle-opaque-1" }));
  });

  it("fails closed for blocked, conflicting, or missing-workspace plans and cleans up on close", async () => {
    const api = createApi();
    const blocked = importPlan({
      status: "blocked",
      blocked: 1,
      conflicts: 2,
      routes: [{
        sourceAgent: "codex",
        targetAgent: "claude",
        quality: "blocked",
        sessions: 1,
        findings: [{ code: "portable.messages.empty", disposition: "blocked", count: 1 }],
      }],
      workspaces: [{
        source: "C:\\Old Machine\\Missing Project",
        target: "C:\\Old Machine\\Missing Project",
        status: "missing",
        agents: ["claude"],
        sessions: 1,
      }],
    });
    vi.mocked(api.openImport).mockResolvedValue({ ok: true, value: { status: "planned", plan: blocked } });
    const user = userEvent.setup();
    render(<TransferActions api={api} onNotice={() => {}} onImported={() => {}} />);

    await user.click(screen.getByRole("button", { name: "导入与导出" }));
    await user.click(await screen.findByRole("menuitem", { name: "导入…" }));
    const dialog = await screen.findByRole("dialog", { name: "history-backup.agenthist" });
    expect(within(dialog).getByText("1", { selector: ".has-problem strong" })).toBeInTheDocument();
    expect(within(dialog).getByText(/导入前必须先处理 2 个内容冲突/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 个所选对话被兼容性检查阻止/)).toBeInTheDocument();
    expect(within(dialog).getByText(/目标工作区缺失或尚未映射/)).toBeInTheDocument();
    expect(within(dialog).getByText("缺失")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /选择文件夹/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toBeDisabled();
    expect(api.applyImport).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "关闭导入窗口" }));
    await waitFor(() => expect(api.cancelImport).toHaveBeenCalledWith({ handle: "import-handle-opaque-1" }));
    expect(screen.queryByRole("dialog", { name: "history-backup.agenthist" })).not.toBeInTheDocument();
  });

  it("replans target routing, requires review after authoritative changes, then applies", async () => {
    const api = createApi();
    const initial = importPlan({
      routes: [{
        sourceAgent: "codex",
        targetAgent: "claude",
        quality: "degraded",
        sessions: 2,
        findings: [
          { code: "portable.messages.exact", disposition: "exact", count: 2 },
          { code: "claude.identity.synthesized", disposition: "synthesized", count: 1 },
          { code: "codex.tool_state.skipped", disposition: "skipped", count: 1 },
          { code: "codex.future_payload.skipped", disposition: "skipped", count: 1 },
        ],
      }],
      workspaces: [{
        source: "C:\\Old Work\\Project",
        target: "D:\\New Work\\Project",
        status: "mapped",
        agents: ["claude"],
        sessions: 2,
      }],
    });
    const routed = importPlan({ ...initial, planRef: "import-plan-routed" });
    const authoritative = importPlan({
      ...routed,
      planRef: "import-plan-authoritative",
      routes: [{
        ...routed.routes[0]!,
        findings: [{ code: "claude.identity.synthesized", disposition: "synthesized", count: 2 }],
      }],
    });
    vi.mocked(api.openImport).mockResolvedValue({ ok: true, value: { status: "planned", plan: initial } });
    vi.mocked(api.replanImport).mockResolvedValue({ ok: true, value: routed });
    vi.mocked(api.applyImport)
      .mockResolvedValueOnce({ ok: true, value: { status: "replan_required", plan: authoritative } })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          status: "completed",
          fileName: initial.fileName,
          written: 2,
          alreadyPresent: 1,
          transactionRefs: ["ahtx1_fixture"],
        },
      });
    const imported = vi.fn();
    const user = userEvent.setup();
    render(<TransferActions api={api} onNotice={() => {}} onImported={imported} />);

    await user.click(screen.getByRole("button", { name: "导入与导出" }));
    await user.click(await screen.findByRole("menuitem", { name: "导入…" }));
    const dialog = await screen.findByRole("dialog", { name: initial.fileName });
    for (const heading of ["保留", "重建", "省略"]) {
      expect(within(dialog).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(within(dialog).getByText(/可读对话消息已完整保留/)).toBeInTheDocument();
    expect(within(dialog).getByText("Claude Code 会话标识已重建")).toBeInTheDocument();
    expect(within(dialog).getByText("Codex 工具状态已省略")).toBeInTheDocument();
    const futureFinding = within(dialog).getByText("目标 Agent 不支持的相关内容已省略").closest("li");
    expect(futureFinding).toHaveAttribute("title", "技术标识：codex.future_payload.skipped");
    expect(within(dialog).queryByText("codex.future_payload.skipped")).not.toBeInTheDocument();
    expect(within(dialog).getByText("D:\\New Work\\Project")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("combobox", { name: "目标 Agent" }));
    await user.click(await screen.findByRole("option", { name: "Claude Code" }));
    await waitFor(() => expect(api.replanImport).toHaveBeenCalledWith({
      handle: initial.handle,
      sessionRefs: initial.sessions.map((session) => session.sessionRef),
      targetAgent: "claude",
    }));
    expect(await within(dialog).findByText(/选择或转换方式已更新/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    await waitFor(() => expect(api.applyImport).toHaveBeenNthCalledWith(1, {
      handle: initial.handle,
      expectedPlanRef: "import-plan-routed",
    }));
    expect(await within(dialog).findByText(/归档计划发生变化/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    await waitFor(() => expect(api.applyImport).toHaveBeenNthCalledWith(2, {
      handle: initial.handle,
      expectedPlanRef: "import-plan-authoritative",
    }));
    expect(await within(dialog).findByRole("heading", { name: "导入完成", level: 3 })).toBeInTheDocument();
    expect(within(dialog).getByText("2 个对话")).toBeInTheDocument();
    expect(within(dialog).getByText("1 个可恢复事务")).toBeInTheDocument();
    expect(imported).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: "完成" }));
    expect(api.cancelImport).not.toHaveBeenCalled();
  });

  it("admits only one rapid replan for an opaque handle and keeps the current handle owned", async () => {
    const initial = importPlan();
    const retainedRefs = initial.sessions
      .filter((session) => session.sessionRef !== CODEX_CHAT.sessionRef)
      .flatMap((session) => session.memberSessionRefs);
    const replanned = importPlan({
      planRef: "import-plan-rapid-replan",
      selectedSessions: retainedRefs.length,
      sessions: initial.sessions.map((session) => ({
        ...session,
        selected: retainedRefs.includes(session.sessionRef),
      })),
    });
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["replanImport"]>>>();
    const api = createApi();
    vi.mocked(api.openImport).mockResolvedValue({ ok: true, value: { status: "planned", plan: initial } });
    vi.mocked(api.replanImport).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<TransferActions api={api} onNotice={() => {}} onImported={() => {}} />);

    const dialog = await openImportDialog(user, initial.fileName);
    const checkbox = within(dialog).getByRole("checkbox", { name: `选择对话 ${CODEX_CHAT.title}` });
    act(() => {
      checkbox.click();
      checkbox.click();
    });

    await waitFor(() => expect(api.replanImport).toHaveBeenCalledTimes(1));
    expect(api.replanImport).toHaveBeenCalledWith({
      handle: initial.handle,
      sessionRefs: retainedRefs,
    });

    await act(async () => {
      pending.resolve({ ok: true, value: replanned });
      await pending.promise;
    });
    expect(api.replanImport).toHaveBeenCalledTimes(1);
    expect(api.cancelImport).not.toHaveBeenCalled();
    expect(await within(dialog).findByText(/选择或转换方式已更新/)).toBeInTheDocument();
  });

  it("cannot close while applying and still reports a completed import after unmount", async () => {
    const initial = importPlan();
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["applyImport"]>>>();
    const api = createApi();
    vi.mocked(api.openImport).mockResolvedValue({ ok: true, value: { status: "planned", plan: initial } });
    vi.mocked(api.applyImport).mockReturnValue(pending.promise);
    const imported = vi.fn();
    const notice = vi.fn();
    const user = userEvent.setup();
    const view = render(<TransferActions api={api} onNotice={notice} onImported={imported} />);

    const dialog = await openImportDialog(user, initial.fileName);
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    await waitFor(() => expect(api.applyImport).toHaveBeenCalledWith({
      handle: initial.handle,
      expectedPlanRef: initial.planRef,
    }));

    expect(within(dialog).getByRole("button", { name: "关闭导入窗口" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: initial.fileName })).toBeInTheDocument();

    view.unmount();
    await act(async () => {
      pending.resolve({
        ok: true,
        value: {
          status: "completed",
          fileName: initial.fileName,
          written: 3,
          alreadyPresent: 0,
          transactionRefs: ["ahtx1_background"],
        },
      });
      await pending.promise;
    });

    await waitFor(() => expect(imported).toHaveBeenCalledTimes(1));
    expect(notice).toHaveBeenCalledWith("导入已在后台完成 · 已写入 3 个对话");
  });

  it("replans an import after a workspace folder is unchecked", async () => {
    const initial = importPlan();
    const selectedRefs = initial.sessions.slice(1).map((session) => session.sessionRef);
    const subset = importPlan({
      planRef: "import-plan-subset",
      selectedSessions: selectedRefs.length,
      sessions: initial.sessions.map((session) => ({
        ...session,
        selected: selectedRefs.includes(session.sessionRef),
      })),
    });
    const api = createApi();
    vi.mocked(api.openImport).mockResolvedValue({ ok: true, value: { status: "planned", plan: initial } });
    vi.mocked(api.replanImport).mockResolvedValue({ ok: true, value: subset });
    const user = userEvent.setup();
    render(<TransferActions api={api} onNotice={() => {}} onImported={() => {}} />);

    const dialog = await openImportDialog(user, initial.fileName);
    await user.click(within(dialog).getByRole("checkbox", { name: "选择工作区 Project 1" }));

    await waitFor(() => expect(api.replanImport).toHaveBeenCalledWith({
      handle: initial.handle,
      sessionRefs: selectedRefs,
    }));
    expect(await within(dialog).findByText(`${selectedRefs.length}/${initial.sessions.length}`)).toBeInTheDocument();
  });

  it("keeps an unresolved plan when the workspace picker is cancelled", async () => {
    const source = "C:\\Old Machine\\Missing Project";
    const initial = importPlan({
      workspaces: [{
        source,
        target: source,
        status: "missing",
        agents: ["codex"],
        sessions: 2,
      }],
    });
    const api = createApi();
    vi.mocked(api.openImport).mockResolvedValue({ ok: true, value: { status: "planned", plan: initial } });
    vi.mocked(api.mapImportWorkspace).mockResolvedValue({ ok: true, value: { status: "cancelled" } });
    const user = userEvent.setup();
    render(<TransferActions api={api} onNotice={() => {}} onImported={() => {}} />);

    const dialog = await openImportDialog(user, initial.fileName);
    const workspace = within(dialog).getByRole("group", { name: `工作区 ${source}` });
    await user.click(within(workspace).getByRole("button", { name: /选择文件夹/ }));

    await waitFor(() => expect(api.mapImportWorkspace).toHaveBeenCalledWith({
      handle: initial.handle,
      source,
    }));
    expect(within(workspace).getByRole("button", { name: /选择文件夹/ })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toBeDisabled();
    expect(within(workspace).getByText(source)).toBeInTheDocument();
    expect(api.cancelImport).not.toHaveBeenCalled();
  });

  it("adopts an authoritative workspace plan and enables Apply only after review", async () => {
    const source = "C:\\Archive\\Project";
    const target = "D:\\Restored\\Project";
    const initial = importPlan({
      workspaces: [{ source, target: source, status: "unmapped", agents: ["claude"], sessions: 1 }],
    });
    const mapped = importPlan({
      ...initial,
      planRef: "import-plan-workspace-mapped",
      workspaces: [{ source, target, status: "mapped", agents: ["claude"], sessions: 1 }],
    });
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["mapImportWorkspace"]>>>();
    const api = createApi();
    vi.mocked(api.openImport).mockResolvedValue({ ok: true, value: { status: "planned", plan: initial } });
    vi.mocked(api.mapImportWorkspace).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<TransferActions api={api} onNotice={() => {}} onImported={() => {}} />);

    const dialog = await openImportDialog(user, initial.fileName);
    const workspace = within(dialog).getByRole("group", { name: `工作区 ${source}` });
    const choose = within(workspace).getByRole("button", { name: /选择文件夹/ });
    await user.click(choose);
    expect(choose).toBeDisabled();
    expect(choose).toHaveTextContent("正在选择");
    expect(within(dialog).getByRole("combobox", { name: "目标 Agent" })).toBeDisabled();

    await act(async () => {
      pending.resolve({ ok: true, value: { status: "planned", plan: mapped } });
      await pending.promise;
    });

    const mappedWorkspace = within(dialog).getByRole("group", { name: `工作区 ${source}` });
    expect(within(mappedWorkspace).getByText(source)).toBeInTheDocument();
    expect(within(mappedWorkspace).getByText(target)).toBeInTheDocument();
    expect(within(mappedWorkspace).queryByRole("button", { name: /选择文件夹/ })).not.toBeInTheDocument();
    expect(await within(dialog).findByText(/工作区映射已更新/)).toBeInTheDocument();
    const apply = within(dialog).getByRole("button", { name: "确认导入" });
    expect(apply).toBeEnabled();
    expect(api.mapImportWorkspace).toHaveBeenCalledWith({ handle: initial.handle, source });
    await user.click(apply);
    await waitFor(() => expect(api.applyImport).toHaveBeenCalledWith({
      handle: mapped.handle,
      expectedPlanRef: mapped.planRef,
    }));
  });

  it("maps multiple workspaces one at a time before allowing Apply", async () => {
    const firstSource = "C:\\Archive\\First";
    const secondSource = "C:\\Archive\\Second";
    const firstTarget = "D:\\Restored\\First";
    const secondTarget = "E:\\Restored\\Second";
    const firstMissing = {
      source: firstSource,
      target: firstSource,
      status: "missing" as const,
      agents: ["codex"] as const,
      sessions: 1,
    };
    const secondMissing = {
      source: secondSource,
      target: secondSource,
      status: "unmapped" as const,
      agents: ["claude"] as const,
      sessions: 2,
    };
    const firstMapped = { ...firstMissing, target: firstTarget, status: "mapped" as const };
    const secondMapped = { ...secondMissing, target: secondTarget, status: "mapped" as const };
    const initial = importPlan({ workspaces: [firstMissing, secondMissing] });
    const afterFirst = importPlan({ ...initial, planRef: "import-plan-first-map", workspaces: [firstMapped, secondMissing] });
    const ready = importPlan({ ...initial, planRef: "import-plan-all-mapped", workspaces: [firstMapped, secondMapped] });
    const firstMapping = deferred<Awaited<ReturnType<AgentHistDesktopApi["mapImportWorkspace"]>>>();
    const api = createApi();
    vi.mocked(api.openImport).mockResolvedValue({ ok: true, value: { status: "planned", plan: initial } });
    vi.mocked(api.mapImportWorkspace)
      .mockReturnValueOnce(firstMapping.promise)
      .mockResolvedValueOnce({ ok: true, value: { status: "planned", plan: ready } });
    const user = userEvent.setup();
    render(<TransferActions api={api} onNotice={() => {}} onImported={() => {}} />);

    const dialog = await openImportDialog(user, initial.fileName);
    expect(within(dialog).getAllByRole("button", { name: /选择文件夹/ })).toHaveLength(2);
    const firstWorkspace = within(dialog).getByRole("group", { name: `工作区 ${firstSource}` });
    const secondWorkspace = within(dialog).getByRole("group", { name: `工作区 ${secondSource}` });
    await user.click(within(firstWorkspace).getByRole("button", { name: /选择文件夹/ }));
    expect(within(firstWorkspace).getByRole("button", { name: /正在选择/ })).toBeDisabled();
    expect(within(secondWorkspace).getByRole("button", { name: /选择文件夹/ })).toBeDisabled();
    await act(async () => {
      firstMapping.resolve({ ok: true, value: { status: "planned", plan: afterFirst } });
      await firstMapping.promise;
    });

    await waitFor(() => expect(api.mapImportWorkspace).toHaveBeenNthCalledWith(1, {
      handle: initial.handle,
      source: firstSource,
    }));
    expect(within(dialog).getByText(firstTarget)).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button", { name: /选择文件夹/ })).toHaveLength(1);
    expect(within(secondWorkspace).getByRole("button", { name: /选择文件夹/ })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toBeDisabled();

    await user.click(within(within(dialog).getByRole("group", { name: `工作区 ${secondSource}` }))
      .getByRole("button", { name: /选择文件夹/ }));
    await waitFor(() => expect(api.mapImportWorkspace).toHaveBeenNthCalledWith(2, {
      handle: initial.handle,
      source: secondSource,
    }));
    expect(await within(dialog).findByText(secondTarget)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /选择文件夹/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toBeEnabled();
  });

  it("redacts bridge failures while preserving the unresolved workspace plan", async () => {
    const source = "C:\\Archive\\Sensitive";
    const initial = importPlan({
      workspaces: [{ source, target: source, status: "missing", agents: ["pi"], sessions: 1 }],
    });
    const api = createApi();
    vi.mocked(api.openImport).mockResolvedValue({ ok: true, value: { status: "planned", plan: initial } });
    vi.mocked(api.mapImportWorkspace)
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "desktop.workspace_picker_failed",
          message: "The selected folder could not be mapped.",
          retryable: true,
          details: { private_target: "D:\\Private\\Do not render" },
        },
      })
      .mockRejectedValueOnce(new Error("D:\\Private\\bridge-secret"));
    const user = userEvent.setup();
    render(<TransferActions api={api} onNotice={() => {}} onImported={() => {}} />);

    const dialog = await openImportDialog(user, initial.fileName);
    const chooseWorkspace = (): HTMLElement => within(within(dialog)
      .getByRole("group", { name: `工作区 ${source}` }))
      .getByRole("button", { name: /选择文件夹/ });
    await user.click(chooseWorkspace());
    expect(await within(dialog).findByText("The selected folder could not be mapped.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Do not render/)).not.toBeInTheDocument();

    await user.click(chooseWorkspace());
    expect(await within(dialog).findByText("无法选择工作区文件夹。")).toBeInTheDocument();
    expect(within(dialog).queryByText(/bridge-secret/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toBeDisabled();
  });

  it("cancels both the current and a stale returned handle when closed during mapping", async () => {
    const source = "C:\\Archive\\Pending";
    const initial = importPlan({
      workspaces: [{ source, target: source, status: "missing", agents: ["opencode"], sessions: 1 }],
    });
    const stale = importPlan({
      ...initial,
      handle: "import-handle-opaque-stale-map",
      planRef: "import-plan-stale-map",
      workspaces: [{
        source,
        target: "D:\\Restored\\Pending",
        status: "mapped",
        agents: ["opencode"],
        sessions: 1,
      }],
    });
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["mapImportWorkspace"]>>>();
    const api = createApi();
    vi.mocked(api.openImport).mockResolvedValue({ ok: true, value: { status: "planned", plan: initial } });
    vi.mocked(api.mapImportWorkspace).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<TransferActions api={api} onNotice={() => {}} onImported={() => {}} />);

    const dialog = await openImportDialog(user, initial.fileName);
    await user.click(within(dialog).getByRole("button", { name: /选择文件夹/ }));
    await waitFor(() => expect(api.mapImportWorkspace).toHaveBeenCalledTimes(1));
    await user.click(within(dialog).getByRole("button", { name: "关闭导入窗口" }));
    await waitFor(() => expect(api.cancelImport).toHaveBeenCalledWith({ handle: initial.handle }));

    await act(async () => {
      pending.resolve({ ok: true, value: { status: "planned", plan: stale } });
      await pending.promise;
    });
    await waitFor(() => expect(api.cancelImport).toHaveBeenCalledWith({ handle: stale.handle }));
    expect(screen.queryByRole("dialog", { name: initial.fileName })).not.toBeInTheDocument();
  });

  it("exports one conversation by session reference and reports cancellation", async () => {
    const api = createApi();
    vi.mocked(api.exportHistory).mockResolvedValue({ ok: true, value: { status: "cancelled" } });
    const notice = vi.fn();
    const user = userEvent.setup();
    render(<ConversationExportHarness api={api} onNotice={notice} />);

    await user.click(screen.getByRole("button", { name: "更多对话操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "导出对话…" }));

    await waitFor(() => expect(api.exportHistory).toHaveBeenCalledWith({
      scope: "sessions",
      sessionRefs: [CODEX_CHAT.sessionRef],
    }));
    expect(notice).toHaveBeenCalledWith("已取消导出");
  });
});

async function openImportDialog(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "导入与导出" }));
  await user.click(await screen.findByRole("menuitem", { name: /导入/ }));
  return await screen.findByRole("dialog", { name });
}

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
