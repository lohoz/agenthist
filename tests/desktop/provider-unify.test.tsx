import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/desktop/renderer/App.js";
import { createApi, installApi } from "./fixtures.js";

describe("Provider unification", () => {
  it("shows a native-history error without offering a write action", async () => {
    const api = createApi();
    vi.mocked(api.previewCodexProviderUnify).mockResolvedValue({ ok: false, error: { code: "codex_history_invalid", message: "Codex 历史记录无法解析：fixture.jsonl。", retryable: true } });
    installApi(api);
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(await screen.findByRole("button", { name: "统一 Provider" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "预览变更" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("fixture.jsonl");
    expect(within(dialog).queryByRole("button", { name: "确认统一" })).not.toBeInTheDocument();
    expect(api.confirmCodexProviderUnify).not.toHaveBeenCalled();
  });
  it("exposes a settings entry, previews without writing, confirms and refreshes history", async () => {
    const api = createApi();
    installApi(api);
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(await screen.findByRole("button", { name: "统一 Provider" }));
    const dialog = await screen.findByRole("dialog", { name: "统一历史 Provider" });
    expect(await within(dialog).findByText("3 条原生记录")).toBeInTheDocument();
    expect(api.confirmCodexProviderUnify).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "预览变更" }));
    expect(await within(dialog).findByLabelText("Provider 变更预览")).toHaveTextContent("2");
    expect(api.previewCodexProviderUnify).toHaveBeenCalledWith({ targetProvider: "current" });
    expect(api.confirmCodexProviderUnify).not.toHaveBeenCalled();
    const before = vi.mocked(api.listChats).mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "确认统一" }));
    expect(await within(dialog).findByText("Provider 已统一")).toBeInTheDocument();
    expect(api.confirmCodexProviderUnify).toHaveBeenCalledWith({ targetProvider: "current", expectedPlanRef: `ahproviderplan1_${"1".repeat(64)}` });
    await waitFor(() => expect(vi.mocked(api.listChats).mock.calls.length).toBeGreaterThan(before));
    await user.click(within(dialog).getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("invalidates the preview when the target changes and validates custom IDs", async () => {
    const api = createApi();
    installApi(api);
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(await screen.findByRole("button", { name: "统一 Provider" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "预览变更" }));
    await within(dialog).findByRole("button", { name: "确认统一" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "目标 Provider" }), "custom");
    expect(within(dialog).queryByRole("button", { name: "确认统一" })).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "自定义 Provider ID" }), "https://invalid");
    expect(within(dialog).getByRole("button", { name: "预览变更" })).toBeDisabled();
    await user.clear(within(dialog).getByRole("textbox", { name: "自定义 Provider ID" }));
    await user.type(within(dialog).getByRole("textbox", { name: "自定义 Provider ID" }), "my-provider");
    await user.click(within(dialog).getByRole("button", { name: "预览变更" }));
    expect(api.previewCodexProviderUnify).toHaveBeenLastCalledWith({ targetProvider: "my-provider" });
    expect(api.confirmCodexProviderUnify).not.toHaveBeenCalled();
  });

  it("requires another explicit confirmation when the native history changes", async () => {
    const api = createApi();
    const plan = { planRef: `ahproviderplan1_${"2".repeat(64)}`, targetProvider: "openai", changed: 3, unchanged: 1, sources: [{ provider: "legacy", sessions: 3 }] };
    vi.mocked(api.confirmCodexProviderUnify).mockResolvedValueOnce({ ok: true, value: { status: "replan_required", plan } })
      .mockResolvedValueOnce({ ok: true, value: { status: "completed", plan } });
    installApi(api);
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(await screen.findByRole("button", { name: "统一 Provider" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "预览变更" }));
    await user.click(await within(dialog).findByRole("button", { name: "确认统一" }));
    expect(await within(dialog).findByText(/历史或配置已变化/)).toBeInTheDocument();
    expect(api.confirmCodexProviderUnify).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("button", { name: "确认统一" }));
    expect(await within(dialog).findByText("Provider 已统一")).toBeInTheDocument();
    expect(api.confirmCodexProviderUnify).toHaveBeenLastCalledWith({ targetProvider: "current", expectedPlanRef: plan.planRef });
  });
});
