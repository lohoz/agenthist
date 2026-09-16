import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, CheckCircle2, GitMerge, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentHistDesktopApi, CodexProviderPlanDto, CodexProvidersDto } from "../../contracts.js";
import { AgentLogo } from "./AgentLogo.js";

export function ProviderUnifySection({ api, onUnified, onNotice }: {
  readonly api: AgentHistDesktopApi;
  readonly onUnified: () => void;
  readonly onNotice: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<CodexProvidersDto>();
  const [choice, setChoice] = useState("current");
  const [custom, setCustom] = useState("");
  const [plan, setPlan] = useState<CodexProviderPlanDto>();
  const [loading, setLoading] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [transaction, setTransaction] = useState<string>();
  const [error, setError] = useState<string>();
  const [replan, setReplan] = useState(false);
  const generation = useRef(0);
  const target = choice === "custom" ? custom.trim() : choice === "current" ? "current" : choice.slice(9);
  const validTarget = /^[A-Za-z0-9._-]{1,128}$/u.test(target);
  const busy = loading || planning || applying;

  const load = async (): Promise<void> => {
    const current = ++generation.current;
    setLoading(true); setError(undefined); setPlan(undefined); setInventory(undefined); setReplan(false);
    try {
      const result = await api.listCodexProviders();
      if (current !== generation.current) return;
      if (result.ok) setInventory(result.value);
      else setError(result.error.message);
    } catch { if (current === generation.current) setError("无法读取 Codex Provider，请重试。"); }
    finally { if (current === generation.current) setLoading(false); }
  };
  useEffect(() => {
    if (open) { setCompleted(false); setTransaction(undefined); void load(); }
    return () => { generation.current++; };
  }, [open, api]);

  const preview = async (): Promise<void> => {
    if (busy || !validTarget) return;
    const current = ++generation.current;
    setPlanning(true); setError(undefined); setPlan(undefined); setReplan(false);
    try {
      const result = await api.previewCodexProviderUnify({ targetProvider: target });
      if (current !== generation.current) return;
      if (result.ok) setPlan(result.value);
      else setError(result.error.message);
    } catch { if (current === generation.current) setError("无法生成 Provider 变更预览，请重试。"); }
    finally { if (current === generation.current) setPlanning(false); }
  };
  const confirm = async (): Promise<void> => {
    if (busy || plan === undefined || plan.changed === 0) return;
    const current = ++generation.current;
    setApplying(true); setError(undefined);
    try {
      const result = await api.confirmCodexProviderUnify({ targetProvider: target, expectedPlanRef: plan.planRef });
      if (result.ok && result.value.status === "completed") onUnified();
      if (current !== generation.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setPlan(result.value.plan);
      if (result.value.status === "replan_required") { setReplan(true); return; }
      setCompleted(true); setTransaction(result.value.transactionRef);
      onNotice(`已将 ${result.value.plan.changed} 条 Codex 历史统一为 ${result.value.plan.targetProvider}`);
    } catch { if (current === generation.current) setError("Provider 统一请求未完成，请在事务恢复中检查状态。"); }
    finally { if (current === generation.current) setApplying(false); }
  };
  const changeTarget = (change: () => void): void => { generation.current++; change(); setPlan(undefined); setError(undefined); setReplan(false); };

  return <section className="settings-block provider-settings" aria-labelledby="provider-heading">
    <div className="provider-settings-copy"><span className="settings-feature-icon"><GitMerge size={21} /></span>
      <div className="settings-copy"><div className="settings-title-with-badge"><h2 id="provider-heading">统一历史 Provider</h2><span className="settings-app-badge"><AgentLogo agent="codex" size={12} />Codex</span></div>
        <p>切换服务商后，将已有对话归到同一个 Provider，方便继续使用历史。</p>
      </div>
    </div>
    <button className="primary-button" type="button" onClick={() => setOpen(true)}><GitMerge size={15} />统一 Provider</button>
    <Dialog.Root open={open} onOpenChange={(next) => { if (!applying) setOpen(next); }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="provider-dialog" aria-describedby="provider-description"
        onEscapeKeyDown={(event) => { if (applying) event.preventDefault(); }} onPointerDownOutside={(event) => { if (applying) event.preventDefault(); }}>
        <header className="provider-dialog-header"><div><p className="eyebrow">CODEX 历史管理</p><Dialog.Title>统一历史 Provider</Dialog.Title>
          <Dialog.Description id="provider-description">更新本地历史的 provider 归属，包含活动和归档记录；API 地址、密钥和聊天正文保持原样。</Dialog.Description></div>
          <Dialog.Close className="dialog-close" disabled={applying} aria-label="关闭 Provider 窗口"><X size={17} /></Dialog.Close></header>
        <div className="provider-dialog-body">
          {error === undefined ? null : <div className="provider-error" role="alert">{error}{inventory === undefined && !busy ? <button type="button" onClick={() => void load()}>重试</button> : null}</div>}
          {loading ? <div className="provider-loading" role="status"><LoaderCircle className="spin" size={20} />正在读取历史 Provider…</div>
            : completed && plan !== undefined ? <div className="provider-success" role="status"><CheckCircle2 size={32} /><h3>Provider 已统一</h3><p>已更新 {plan.changed} 条历史，目标为 <strong>{plan.targetProvider}</strong>。</p><span>历史列表已刷新，可在“事务恢复”中查看和回滚。</span>{transaction === undefined ? null : <code>{transaction}</code>}</div>
              : inventory === undefined ? null : <>
                <div className="provider-inventory-title"><strong>现有历史分布</strong><span>{inventory.totalSessions} 条原生记录</span><button type="button" className="quiet-icon-button" aria-label="刷新 Provider 列表" disabled={busy} onClick={() => void load()}><RefreshCw size={14} /></button></div>
                {inventory.providers.length === 0 ? <p className="provider-empty">还没有可统一的 Codex 历史。</p> : <div className="provider-distribution">
                  {inventory.providers.map((item) => <div key={item.provider}><code>{item.provider}</code>{item.current ? <small>当前配置</small> : null}<strong>{item.sessions}<span> 条</span></strong></div>)}
                </div>}
                <label className="provider-target"><span>目标 Provider</span><select aria-label="目标 Provider" value={choice} disabled={busy} onChange={(event) => changeTarget(() => setChoice(event.target.value))}>
                  <option value="current">当前配置 · {inventory.currentProvider || "未检测到"}</option><option value="provider:openai">openai · 内置默认</option>
                  {inventory.providers.filter((item) => item.provider !== "openai").map((item) => <option key={item.provider} value={`provider:${item.provider}`}>{item.provider}</option>)}
                  <option value="custom">自定义 Provider ID</option></select></label>
                {choice !== "custom" ? null : <label className="provider-target"><span>Provider ID</span><input aria-label="自定义 Provider ID" value={custom} maxLength={128} placeholder="例如 my-provider" disabled={busy} onChange={(event) => changeTarget(() => setCustom(event.target.value))} /></label>}
                {replan ? <div className="provider-replan" role="status">历史或配置已变化，尚未执行。请检查更新后的方案再确认。</div> : null}
                {plan === undefined ? <p className="provider-hint">先预览受影响的记录，确认后通过事务执行，支持回滚。</p> : <section className="provider-plan" aria-label="Provider 变更预览">
                  <div><span>将更新</span><strong>{plan.changed}</strong><small>条历史</small><ArrowRight size={18} /><code>{plan.targetProvider}</code></div>
                  <p>{plan.unchanged} 条已属于目标 Provider。{plan.changed === 0 ? "当前无需修改。" : "执行后会生成可回滚的事务记录。"}</p>
                  {plan.sources.map((source) => <p key={source.provider}><code>{source.provider}</code><ArrowRight size={12} /><code>{plan.targetProvider}</code><span>{source.sessions} 条</span></p>)}
                </section>}
              </>}
        </div>
        <footer className="provider-dialog-footer"><Dialog.Close className="secondary-button" disabled={applying}>{completed ? "完成" : "取消"}</Dialog.Close>
          {completed ? null : plan === undefined ? <button className="primary-button" type="button" disabled={busy || inventory === undefined || inventory.totalSessions === 0 || !validTarget} onClick={() => void preview()}>{planning ? <LoaderCircle className="spin" size={14} /> : <GitMerge size={14} />}{planning ? "正在预览…" : "预览变更"}</button>
            : <button className="primary-button" type="button" disabled={busy || plan.changed === 0} onClick={() => void confirm()}>{applying ? <LoaderCircle className="spin" size={14} /> : <GitMerge size={14} />}{applying ? "正在统一…" : "确认统一"}</button>}
        </footer>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </section>;
}
