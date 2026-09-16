import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentHistDesktopApi,
  AgentSettingDto,
  ChooseAgentPathResultDto,
  DesktopResult,
} from "../../src/desktop/contracts.js";
import { App } from "../../src/desktop/renderer/App.js";
import { ConversationPane } from "../../src/desktop/renderer/components/ConversationPane.js";
import {
  AGENT_SETTINGS,
  CODEX_CHAT,
  bootstrap,
  createApi,
  installApi,
  resumePlan,
} from "./fixtures.js";

describe("Agent settings", () => {
  it("keeps settings unchanged when the native picker is cancelled", async () => {
    const api = createApi();
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await openSettings(user);

    expect(screen.queryByRole("textbox", { name: /Codex.*(?:历史|数据库|可执行文件)/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "浏览 Codex 历史目录" }));
    await waitFor(() => expect(api.chooseAgentPath).toHaveBeenCalledWith({ agent: "codex", kind: "history" }));
    expect(screen.getAllByText("默认位置").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "重置 Codex 历史目录" })).not.toBeInTheDocument();
  });

  it("shows per-path busy state, adopts picker updates, and reloads Chats", async () => {
    const api = createApi();
    const pending = deferred<DesktopResult<ChooseAgentPathResultDto>>();
    const updated = replaceAgentSetting(AGENT_SETTINGS, "codex", (setting) => ({
      ...setting,
      history: {
        configured: true,
        path: "D:\\AI History\\Codex",
        available: true,
        expected: "directory",
      },
    }));
    vi.mocked(api.chooseAgentPath).mockReturnValue(pending.promise);
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await openSettings(user);
    const callsBefore = vi.mocked(api.listChats).mock.calls.length;

    const codexBrowse = screen.getByRole("button", { name: "浏览 Codex 历史目录" });
    await user.click(codexBrowse);
    expect(codexBrowse).toBeDisabled();
    expect(codexBrowse).toHaveTextContent("正在选择…");
    expect(screen.getByRole("button", { name: "浏览 Claude Code 历史目录" })).toBeEnabled();

    await act(async () => {
      pending.resolve({ ok: true, value: { status: "updated", settings: updated } });
      await pending.promise;
    });
    expect(await screen.findByText("D:\\AI History\\Codex")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重置 Codex 历史目录" })).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.listChats).mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("resets a configured path using only Agent and path kind", async () => {
    const configured = replaceAgentSetting(AGENT_SETTINGS, "codex", (setting) => ({
      ...setting,
      history: {
        configured: true,
        path: "D:\\Configured\\Codex",
        available: true,
        expected: "directory",
      },
    }));
    const api = createApi({ bootstrap: bootstrap({ agentSettings: configured }) });
    vi.mocked(api.clearAgentPath).mockResolvedValue({ ok: true, value: { settings: AGENT_SETTINGS } });
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await openSettings(user);

    expect(screen.getByText("D:\\Configured\\Codex")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重置 Codex 历史目录" }));
    await waitFor(() => expect(api.clearAgentPath).toHaveBeenCalledWith({ agent: "codex", kind: "history" }));
    expect(screen.queryByText("D:\\Configured\\Codex")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重置 Codex 历史目录" })).not.toBeInTheDocument();
  });

  it("shows a redacted picker failure and preserves the previous setting", async () => {
    const api = createApi();
    vi.mocked(api.chooseAgentPath).mockResolvedValue({
      ok: false,
      error: {
        code: "path_rejected",
        message: "The selected executable is unavailable.",
        retryable: true,
        details: { private_path: "C:\\Private\\must-not-render.exe" },
      },
    });
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await openSettings(user);

    await user.click(screen.getByRole("button", { name: "浏览 Pi 可执行文件" }));
    expect(await screen.findByText(/selected executable is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/must-not-render/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "浏览 Pi 可执行文件" })).toBeEnabled();
  });

  it("shows database controls only for Codex and OpenCode plus a safe About link", async () => {
    const api = createApi();
    installApi(api);
    const user = userEvent.setup();
    render(<App />);
    await openSettings(user);

    expect(screen.getByRole("button", { name: "浏览 Codex 数据库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "浏览 OpenCode 数据库" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "浏览 Claude Code 数据库" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "浏览 Pi 数据库" })).not.toBeInTheDocument();
    expect(screen.getByText("AgentHist 0.3.0-test")).toBeInTheDocument();
    const github = screen.getByRole("link", { name: "GitHub" });
    expect(github).toHaveAttribute("href", "https://github.com/lohoz/agenthist");
    expect(github).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("uses executable availability for Continue targets while keeping original Continue available", async () => {
    const availability = AGENT_SETTINGS.map((setting): AgentSettingDto => {
      if (setting.agent === "codex") return { ...setting, executable: { configured: false, available: false } };
      if (setting.agent === "opencode") {
        return { ...setting, executable: { configured: false, resolvedPath: "C:\\Tools\\opencode.exe", available: true } };
      }
      return { ...setting, executable: { ...setting.executable, available: false } };
    });
    const api = createApi();
    vi.mocked(api.planResume).mockResolvedValue({
      ok: true,
      value: resumePlan({ targetAvailable: false }),
    });
    const user = userEvent.setup();
    render(<AvailabilityHarness api={api} settings={availability} />);

    await user.click(screen.getByRole("button", { name: "使用其他 Agent 继续" }));
    expect(await screen.findByRole("menuitem", { name: "OpenCode" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Codex/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Claude Code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Pi" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "继续" }));
    const dialog = await screen.findByRole("dialog", { name: "使用 Codex 继续" });
    expect(dialog).toHaveTextContent("Codex 不可用");
    expect(withinDialogButton(dialog, "继续")).toBeDisabled();
    expect(api.planResume).toHaveBeenCalledWith({ sessionRef: CODEX_CHAT.sessionRef, targetAgent: "codex" });
  });
});

function AvailabilityHarness({ api, settings }: {
  readonly api: AgentHistDesktopApi;
  readonly settings: readonly AgentSettingDto[];
}) {
  const [technical, setTechnical] = useState(false);
  return (
    <div style={{ width: 1100, height: 800 }}>
      <ConversationPane
        api={api}
        agentSettings={settings}
        chat={CODEX_CHAT}
        showTechnicalDetails={technical}
        onShowTechnicalDetailsChange={setTechnical}
        onNotice={() => {}}
        onChatHidden={() => {}}
      />
    </div>
  );
}

async function openSettings(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByRole("heading", { name: "对话" });
  await user.click(screen.getByRole("button", { name: "设置" }));
  await screen.findByRole("heading", { name: "设置" });
}

function replaceAgentSetting(
  settings: readonly AgentSettingDto[],
  agent: AgentSettingDto["agent"],
  replace: (setting: AgentSettingDto) => AgentSettingDto,
): readonly AgentSettingDto[] {
  return settings.map((setting) => setting.agent === agent ? replace(setting) : setting);
}

function withinDialogButton(dialog: HTMLElement, name: string): HTMLButtonElement {
  const button = Array.from(dialog.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === name);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`dialog button not found: ${name}`);
  return button;
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
