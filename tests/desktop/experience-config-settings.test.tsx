import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/desktop/renderer/App.js";
import type { AgentHistDesktopApi } from "../../src/desktop/contracts.js";
import { createApi, installApi } from "./fixtures.js";

describe("Experience uses native Agent configuration", () => {
  it("offers installed Agent profiles and logos without a separate configuration file", async () => {
    const api = createApi();
    installApi(api);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "设置" }));
    const section = (await screen.findByRole("heading", { name: "经验模型" })).closest("section")!;
    expect(within(section).getByRole("radio", { name: "Codex 当前配置" })).toBeChecked();
    expect(within(section).getByRole("radio", { name: "Claude Code 当前配置" })).toBeEnabled();
    expect(within(section).getByRole("radio", { name: "OpenCode 当前配置" })).toBeDisabled();
    expect(within(section).getByRole("radio", { name: "Pi 当前配置" })).toBeDisabled();
    expect(section.querySelectorAll(".agent-logo")).toHaveLength(4);
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "打开配置目录" })).not.toBeInTheDocument();
    expect(api.checkExperienceConfig).not.toHaveBeenCalled();
    expect(api.openExperienceConfig).not.toHaveBeenCalled();
  });

  it("persists the selected Agent and uses the same selection on the experience page", async () => {
    const api = createApi();
    installApi(api);
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(await screen.findByRole("radio", { name: "Claude Code 当前配置" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ experienceAgent: "claude" })));
    await user.click(screen.getByRole("button", { name: "经验" }));
    expect(await screen.findByRole("radio", { name: "Claude Code 当前配置", checked: true })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Codex 当前配置" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ experienceAgent: "codex" })));
  });

  it("checks only on click and prevents switching profiles during a check", async () => {
    const api = createApi();
    let resolve!: (value: Awaited<ReturnType<AgentHistDesktopApi["checkExperienceConfig"]>>) => void;
    vi.mocked(api.checkExperienceConfig).mockReturnValue(new Promise((done) => { resolve = done; }));
    installApi(api);
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "检查模型" }));
    expect(screen.getByRole("radio", { name: "Claude Code 当前配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在检查…" })).toBeDisabled();
    await act(async () => resolve({ ok: true, value: { status: "checked", configFile: "private-config", historySent: false, requests: 1, profiles: [] } }));
    expect(await screen.findByText("模型可用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查模型" })).toBeEnabled();
    expect(screen.queryByText("private-config")).not.toBeInTheDocument();
    expect(api.runExperience).not.toHaveBeenCalled();
  });

  it("shows actionable authentication failures and hides private exception details", async () => {
    const api = createApi();
    vi.mocked(api.checkExperienceConfig)
      .mockResolvedValueOnce({ ok: true, value: { status: "failed", configFile: "private-config", historySent: false, requests: 0,
        error: { code: "authentication_failed", stage: "model_check", retryable: false } } })
      .mockRejectedValueOnce(new Error("private-secret-key"));
    installApi(api);
    const view = render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "检查模型" }));
    expect(await screen.findByText("API 认证失败，请检查所选 Agent 的密钥。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "检查模型" }));
    expect(await screen.findByText("无法检查模型，请确认所选 Agent 的 API 配置和网络后重试。")).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("private-secret-key");
  });

  it("shows the detected API model, protocol, endpoint and actual HTTP failure timing", async () => {
    const api = createApi();
    const profile = { tier: "fast" as const, backend: "openai-responses" as const, model: "configured-model", modelConfigured: true,
      endpoint: { kind: "remote" as const, label: "https://api.example.test" } };
    vi.mocked(api.inspectExperienceConfig).mockResolvedValue({ ok: true, value: { status: "configured", configFile: "private-path", backend: "openai-responses", deepBinding: "fast", fast: profile, deep: { ...profile, tier: "deep" } } });
    vi.mocked(api.checkExperienceConfig).mockResolvedValue({ ok: true, value: { status: "failed", configFile: "private-path", historySent: false, requests: 0,
      durationMs: 1200, error: { code: "upstream_failed", status: 503, stage: "model_check", retryable: true } } });
    installApi(api);
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "设置" }));
    expect(await screen.findByText("configured-model")).toBeInTheDocument();
    expect(screen.getByText("Responses")).toBeInTheDocument();
    expect(screen.getByText("https://api.example.test")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "检查模型" }));
    expect(await screen.findByText(/HTTP 503/)).toHaveTextContent("1.20 秒");
    expect(screen.queryByText("private-path")).not.toBeInTheDocument();
    expect(api.runExperience).not.toHaveBeenCalled();
  });
});
