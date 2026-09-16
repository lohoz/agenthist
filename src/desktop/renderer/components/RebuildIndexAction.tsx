import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { AlertTriangle, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AgentHistDesktopApi, DesktopError } from "../../contracts.js";

interface RebuildIndexActionProps {
  readonly api: AgentHistDesktopApi;
  readonly onIndexRebuilt: () => void;
  readonly onNotice: (message: string) => void;
}

export function RebuildIndexAction({ api, onIndexRebuilt, onNotice }: RebuildIndexActionProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DesktopError>();
  const generation = useRef(0);

  useEffect(() => () => { generation.current += 1; }, []);

  const changeOpen = (nextOpen: boolean): void => {
    if (busy) return;
    generation.current += 1;
    setOpen(nextOpen);
    setError(undefined);
  };

  const rebuild = async (): Promise<void> => {
    if (busy) return;
    const requestGeneration = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.rebuildHistoryIndex();
      if (requestGeneration !== generation.current) return;
      if (!result.ok) {
        setError(publicError(result.error));
        return;
      }
      onIndexRebuilt();
      onNotice(
        `索引重建完成 · ${result.value.sessions} 个会话 · ${result.value.issues} 个问题`,
      );
      setOpen(false);
    } catch {
      if (requestGeneration === generation.current) {
        setError({
          code: "renderer.index_rebuild_failed",
          message: "桌面端未能完成索引重建。",
          retryable: true,
        });
      }
    } finally {
      if (requestGeneration === generation.current) setBusy(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={changeOpen}>
      <AlertDialog.Trigger asChild>
        <button className="secondary-button" type="button">
          <RefreshCw size={14} aria-hidden="true" />重建索引…
        </button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-backdrop resume-dialog-backdrop" />
        <AlertDialog.Content className="alert-dialog rebuild-index-dialog">
          <AlertDialog.Title>要重建本地索引吗？</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="rebuild-index-description">
              <p>只会重建 AgentHist 的搜索索引和对话读取缓存。</p>
              <p>不会删除或修改：</p>
              <ul>
                <li>各 Agent 的原生历史记录</li>
                <li>AgentHist 快照或设置</li>
                <li>经验复盘结果</li>
              </ul>
            </div>
          </AlertDialog.Description>
          <div className="rebuild-index-safety"><ShieldCheck size={14} /><span>源历史记录不会被改动。</span></div>
          {error === undefined ? null : (
            <div className="rebuild-index-error" role="alert">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{error.message}</span>
            </div>
          )}
          <div className="alert-dialog-actions">
            <AlertDialog.Cancel className="secondary-button" disabled={busy}>取消</AlertDialog.Cancel>
            <button className="primary-button" type="button" disabled={busy} onClick={() => void rebuild()}>
              {busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
              {busy ? "正在重建…" : "重建索引"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function publicError(error: DesktopError): DesktopError {
  return { code: error.code, message: error.message, retryable: error.retryable };
}
