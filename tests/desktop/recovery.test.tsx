import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AgentHistDesktopApi } from "../../src/desktop/contracts.js";
import { RecoveryActions } from "../../src/desktop/renderer/components/RecoveryActions.js";
import {
  createApi,
  transactionPlan,
  transactionSummary,
} from "./fixtures.js";

describe("Transaction recovery", () => {
  it("lists unfinished transactions first and recent terminal transactions next", async () => {
    const api = createApi();
    const committed = transactionSummary("committed", {
      transactionRef: "ahtx1_committed",
      operation: "history_import",
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
    const recovery = transactionSummary("needs_recovery", {
      transactionRef: "ahtx1_recovery",
      operation: "provider_unify",
      updatedAt: "2026-09-04T08:00:00.000Z",
    });
    const rolledBack = transactionSummary("rolled_back", {
      transactionRef: "ahtx1_rolled_back",
      operation: "old_import",
      updatedAt: "2026-09-04T13:00:00.000Z",
    });
    vi.mocked(api.listTransactions).mockResolvedValue({ ok: true, value: [committed, rolledBack, recovery] });
    const user = userEvent.setup();
    render(<RecoveryActions api={api} onNotice={() => {}} />);

    await user.click(screen.getByRole("button", { name: "事务恢复…" }));
    const rows = await screen.findAllByTestId("transaction-row");
    expect(rows.map((row) => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining("Provider 统一"),
      expect.stringContaining("旧版导入"),
      expect.stringContaining("历史导入"),
    ]));
    expect(rows[0]).toHaveTextContent("Provider 统一");
    expect(rows[1]).toHaveTextContent("旧版导入");
    expect(rows[2]).toHaveTextContent("历史导入");
    expect(within(rows[0]!).getByRole("button", { name: "恢复" })).toBeInTheDocument();
    expect(within(rows[2]!).getByRole("button", { name: "回滚" })).toBeInTheDocument();
    expect(within(rows[1]!).getByText("无需处理")).toBeInTheDocument();
    expect(screen.getByText("1 项需要处理")).toBeInTheDocument();
  });

  it("renders an accessible empty state", async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(<RecoveryActions api={api} onNotice={() => {}} />);
    await user.click(screen.getByRole("button", { name: "事务恢复…" }));
    expect(await screen.findByText("暂时没有 AgentHist 写入事务。")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "事务恢复" })).toBeInTheDocument();
  });

  it("previews a recovery with row, file, and resource positions before confirmation", async () => {
    const api = createApi();
    const summary = transactionSummary("needs_recovery");
    const plan = transactionPlan(summary, "recover", {
      findings: [{
        sessionRef: "ahsr1_codex_fixture-session",
        row: "after",
        file: "before",
        resources: "unchanged",
      }],
    });
    vi.mocked(api.listTransactions).mockResolvedValue({ ok: true, value: [summary] });
    vi.mocked(api.planTransaction).mockResolvedValue({ ok: true, value: plan });
    const user = userEvent.setup();
    render(<RecoveryActions api={api} onNotice={() => {}} />);

    await user.click(screen.getByRole("button", { name: "事务恢复…" }));
    await user.click(await screen.findByRole("button", { name: "恢复" }));
    expect(api.planTransaction).toHaveBeenCalledWith({ transactionRef: summary.transactionRef, action: "recover" });
    expect(await screen.findByText("恢复预览")).toBeInTheDocument();
    expect(screen.getByText("可以执行")).toBeInTheDocument();
    expect(screen.getByText("记录 · 写入后")).toBeInTheDocument();
    expect(screen.getByText("文件 · 写入前")).toBeInTheDocument();
    expect(screen.getByText("资源 · 未变化")).toBeInTheDocument();
    expect(screen.getByText(/目标历史已经偏离/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认恢复" })).toBeEnabled();
    expect(api.confirmTransaction).not.toHaveBeenCalled();
  });

  it("blocks confirmation when core reports a diverged target", async () => {
    const api = createApi();
    const summary = transactionSummary("committed");
    const plan = transactionPlan(summary, "rollback", {
      ready: false,
      findings: [{ sessionRef: "ahsr1_codex_diverged", row: "diverged", file: "diverged" }],
    });
    vi.mocked(api.listTransactions).mockResolvedValue({ ok: true, value: [summary] });
    vi.mocked(api.planTransaction).mockResolvedValue({ ok: true, value: plan });
    const user = userEvent.setup();
    render(<RecoveryActions api={api} onNotice={() => {}} />);

    await user.click(screen.getByRole("button", { name: "事务恢复…" }));
    await user.click(await screen.findByRole("button", { name: "回滚" }));
    expect(await screen.findByText("记录 · 已偏离")).toBeInTheDocument();
    expect(screen.getByText("文件 · 已偏离")).toBeInTheDocument();
    expect(screen.getByText("已阻止")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认回滚" })).toBeDisabled();
    expect(api.confirmTransaction).not.toHaveBeenCalled();
  });

  it("requires review after replan, then completes and updates the list", async () => {
    const api = createApi();
    const summary = transactionSummary("committed");
    const initial = transactionPlan(summary, "rollback");
    const refreshed = transactionPlan(summary, "rollback", {
      planRef: "transaction-plan-refreshed",
      findings: [{ sessionRef: "ahsr1_codex_fixture", row: "unchanged", file: "after" }],
    });
    const completedSummary = transactionSummary("rolled_back", {
      transactionRef: summary.transactionRef,
      operation: summary.operation,
      updatedAt: "2026-09-04T14:00:00.000Z",
    });
    vi.mocked(api.listTransactions).mockResolvedValue({ ok: true, value: [summary] });
    vi.mocked(api.planTransaction).mockResolvedValue({ ok: true, value: initial });
    vi.mocked(api.confirmTransaction)
      .mockResolvedValueOnce({ ok: true, value: { status: "replan_required", plan: refreshed } })
      .mockResolvedValueOnce({ ok: true, value: { status: "completed", plan: refreshed, summary: completedSummary } });
    const notice = vi.fn();
    const user = userEvent.setup();
    render(<RecoveryActions api={api} onNotice={notice} />);

    await user.click(screen.getByRole("button", { name: "事务恢复…" }));
    await user.click(await screen.findByRole("button", { name: "回滚" }));
    await user.click(await screen.findByRole("button", { name: "确认回滚" }));
    expect(await screen.findByText(/目标在预览后发生变化/)).toBeInTheDocument();
    expect(api.confirmTransaction).toHaveBeenNthCalledWith(1, {
      transactionRef: summary.transactionRef,
      action: "rollback",
      expectedPlanRef: initial.planRef,
    });

    await user.click(screen.getByRole("button", { name: "确认回滚" }));
    expect(await screen.findByText("事务已安全回滚。")).toBeInTheDocument();
    expect(api.confirmTransaction).toHaveBeenNthCalledWith(2, {
      transactionRef: summary.transactionRef,
      action: "rollback",
      expectedPlanRef: refreshed.planRef,
    });
    expect(notice).toHaveBeenCalledWith("事务已安全回滚 · 历史导入");
    await user.click(screen.getByRole("button", { name: "返回" }));
    const row = await screen.findByTestId("transaction-row");
    expect(row).toHaveTextContent("已回滚");
    expect(within(row).getByText("无需处理")).toBeInTheDocument();
  });

  it("keeps both back actions disabled while a confirmation is in progress", async () => {
    const api = createApi();
    const summary = transactionSummary("committed");
    const plan = transactionPlan(summary, "rollback");
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["confirmTransaction"]>>>();
    vi.mocked(api.listTransactions).mockResolvedValue({ ok: true, value: [summary] });
    vi.mocked(api.planTransaction).mockResolvedValue({ ok: true, value: plan });
    vi.mocked(api.confirmTransaction).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<RecoveryActions api={api} onNotice={() => {}} />);

    await user.click(screen.getByRole("button", { name: "事务恢复…" }));
    await user.click(await screen.findByRole("button", { name: "回滚" }));
    await user.click(await screen.findByRole("button", { name: "确认回滚" }));
    await waitFor(() => expect(api.confirmTransaction).toHaveBeenCalledTimes(1));

    expect(screen.getByRole("button", { name: "事务列表" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "返回" })).toBeDisabled();

    await act(async () => {
      pending.resolve({ ok: true, value: { status: "replan_required", plan } });
      await pending.promise;
    });
  });

  it("shows list and plan errors and closes with the keyboard", async () => {
    const api = createApi();
    const summary = transactionSummary("committed");
    vi.mocked(api.listTransactions)
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "list_failed", message: "Transaction journals are unavailable.", retryable: true },
      })
      .mockResolvedValueOnce({ ok: true, value: [summary] });
    vi.mocked(api.planTransaction).mockResolvedValue({
      ok: false,
      error: { code: "plan_failed", message: "Current target state could not be checked.", retryable: false },
    });
    const user = userEvent.setup();
    render(<RecoveryActions api={api} onNotice={() => {}} />);

    await user.click(screen.getByRole("button", { name: "事务恢复…" }));
    expect(await screen.findByText("Transaction journals are unavailable.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await user.click(await screen.findByRole("button", { name: "回滚" }));
    expect(await screen.findByText("Current target state could not be checked.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "事务恢复" })).not.toBeInTheDocument();
  });

  it("ignores a completed confirmation after Settings unmounts", async () => {
    const api = createApi();
    const summary = transactionSummary("committed");
    const plan = transactionPlan(summary, "rollback");
    const pending = deferred<Awaited<ReturnType<AgentHistDesktopApi["confirmTransaction"]>>>();
    vi.mocked(api.listTransactions).mockResolvedValue({ ok: true, value: [summary] });
    vi.mocked(api.planTransaction).mockResolvedValue({ ok: true, value: plan });
    vi.mocked(api.confirmTransaction).mockReturnValue(pending.promise);
    const notice = vi.fn();
    const user = userEvent.setup();
    const view = render(<RecoveryActions api={api} onNotice={notice} />);

    await user.click(screen.getByRole("button", { name: /事务恢复/ }));
    await user.click(await screen.findByRole("button", { name: "回滚" }));
    await user.click(await screen.findByRole("button", { name: "确认回滚" }));
    await waitFor(() => expect(api.confirmTransaction).toHaveBeenCalledTimes(1));
    view.unmount();

    await act(async () => {
      pending.resolve({ ok: true, value: { status: "completed", plan, summary: transactionSummary("rolled_back") } });
      await pending.promise;
    });
    expect(notice).not.toHaveBeenCalled();
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
