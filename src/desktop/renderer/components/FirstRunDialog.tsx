import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Check, CircleDashed, ShieldAlert, X } from "lucide-react";
import { useRef } from "react";

import type { AgentStatusDto } from "../../contracts.js";
import { classes } from "../lib/display.js";

interface FirstRunDialogProps {
  readonly agents: readonly AgentStatusDto[];
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onStart: () => void;
  readonly onOpenSettings: () => void;
}

export function FirstRunDialog({ agents, busy, error, onStart, onOpenSettings }: FirstRunDialogProps) {
  const startRef = useRef<HTMLButtonElement>(null);
  const hasDetectedAgent = agents.some((agent) => agent.status === "ready");

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <div className="dialog-layer" role="presentation">
          <Dialog.Overlay className="dialog-backdrop" />
          <Dialog.Content
            className="dialog-card first-run-dialog"
            onEscapeKeyDown={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              startRef.current?.focus();
            }}
          >
        <div className="dialog-brand">AH</div>
        <p className="eyebrow">本地 AI 编程对话中心</p>
        <Dialog.Title asChild><h1>欢迎使用 AgentHist</h1></Dialog.Title>
        <Dialog.Description className="dialog-lead">已自动检查本机 Agent，所有数据都留在本地。</Dialog.Description>
        <div className="detection-list" aria-label="Agent 检测结果">
          {agents.map((agent) => (
            <div className="detection-row" key={agent.agent}>
              <DetectionIcon status={agent.status} />
              <span>{agent.label}</span>
              <small>{statusLabel(agent.status)}</small>
            </div>
          ))}
        </div>
        {hasDetectedAgent ? null : (
          <p className="first-run-no-agents">
            尚未检测到可用 Agent。你可以先指定历史目录和可执行文件，之后再扫描本机历史。
          </p>
        )}
        {error === undefined ? null : <p className="inline-error" role="alert">{error}</p>}
        <div className="first-run-actions">
          {hasDetectedAgent ? null : (
            <button className="secondary-button" type="button" disabled={busy} onClick={onOpenSettings}>
              配置 Agent 路径
            </button>
          )}
          <button ref={startRef} className="primary-button welcome-start" type="button" disabled={busy} onClick={onStart}>
            {busy ? "正在保存…" : "开始使用"}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DetectionIcon({ status }: { readonly status: AgentStatusDto["status"] }) {
  const Icon = status === "ready" ? Check : status === "not_detected" ? CircleDashed : status === "blocked" ? ShieldAlert : X;
  return <Icon className={classes("detection-icon", `status-${status}`)} size={17} aria-hidden="true" />;
}

function statusLabel(status: AgentStatusDto["status"]): string {
  switch (status) {
    case "ready": return "已检测";
    case "not_detected": return "未找到";
    case "blocked": return "受阻";
    case "error": return "错误";
  }
}
