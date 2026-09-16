import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleSlash2,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Route,
  WandSparkles,
  X,
} from "lucide-react";

import type {
  Agent,
  DesktopError,
  ResumeConfirmResultDto,
  ResumePlanDto,
} from "../../contracts.js";
import { AGENT_LABELS, classes } from "../lib/display.js";
import { conversionFindingLabel } from "../lib/conversion-finding-copy.js";

type LaunchedResume = Extract<ResumeConfirmResultDto, { readonly status: "launched" }>;

interface ResumeDialogProps {
  readonly open: boolean;
  readonly targetAgent: Agent;
  readonly plan: ResumePlanDto | undefined;
  readonly outcome: LaunchedResume | undefined;
  readonly loading: boolean;
  readonly confirming: boolean;
  readonly error: DesktopError | undefined;
  readonly replanMessage: string | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
  readonly onRetry: () => void;
  readonly onAllowLossy: () => void;
}

export function ResumeDialog({
  open,
  targetAgent,
  plan,
  outcome,
  loading,
  confirming,
  error,
  replanMessage,
  onOpenChange,
  onConfirm,
  onRetry,
  onAllowLossy,
}: ResumeDialogProps) {
  const confirmDisabled = plan === undefined || !plan.targetAvailable || plan.quality === "blocked" || loading || confirming;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop resume-dialog-backdrop" />
        <Dialog.Content className="resume-dialog" aria-describedby="resume-description">
          <header className="resume-dialog-header">
            <div>
              <p className="eyebrow">继续对话</p>
              <Dialog.Title>{outcome === undefined ? `使用 ${AGENT_LABELS[targetAgent]} 继续` : "对话已启动"}</Dialog.Title>
              <Dialog.Description id="resume-description">
                {outcome === undefined
                  ? "AgentHist 打开或创建原生对话前，请检查转换路线。"
                  : `${AGENT_LABELS[outcome.targetAgent]} 已在所选工作区准备就绪。`}
              </Dialog.Description>
            </div>
            <Dialog.Close className="dialog-close" aria-label="关闭继续对话窗口"><X size={16} /></Dialog.Close>
          </header>

          {outcome !== undefined ? (
            <ResumeOutcome outcome={outcome} onDone={() => onOpenChange(false)} />
          ) : loading && plan === undefined ? (
            <div className="resume-loading" aria-label="正在规划继续对话">
              <LoaderCircle className="spin" size={20} />
              <span>正在检查最安全的路线…</span>
            </div>
          ) : error !== undefined && plan === undefined ? (
            <div className="resume-error" role="alert">
              <AlertTriangle size={21} />
              <strong>无法准备继续对话</strong>
              <p>{error.message}</p>
              {error.retryable ? (
                <button className="secondary-button" type="button" onClick={onRetry}><RefreshCw size={14} />重试</button>
              ) : null}
            </div>
          ) : plan !== undefined ? (
            <>
              {replanMessage === undefined ? null : (
                <div className="resume-replan" role="status"><RefreshCw size={14} />{replanMessage}</div>
              )}
              {error === undefined ? null : (
                <div className="compact-resume-error" role="alert"><AlertTriangle size={14} />{error.message}</div>
              )}
              <ResumeRouteSummary plan={plan} />
              <ResumeFindings plan={plan} />
              {!plan.targetAvailable ? (
                <div className="resume-blocker" role="alert">
                  <CircleSlash2 size={16} />
                  <span><strong>{AGENT_LABELS[plan.targetAgent]} 不可用。</strong>请先安装，或在设置中指定可执行文件。</span>
                </div>
              ) : plan.quality === "blocked" ? (
                <div className="resume-blocker" role="alert">
                  <CircleSlash2 size={16} />
                  <span><strong>当前转换被阻止。</strong>可以尝试仅保留 User/Assistant 可读文本；工具、系统上下文、资源和无法识别的内容会被省略。</span>
                  <button className="secondary-button" type="button" onClick={onAllowLossy}>尝试有损转换</button>
                </div>
              ) : null}
              {plan.findings.some((finding) => finding.code === "portable.lossy_text_fallback") ? (
                <div className="resume-blocker is-warning" role="alert">
                  <AlertTriangle size={16} />
                  <span><strong>这是有损转换。</strong>确认后只会写入可读对话文本，预览中列出的其他内容不会进入目标 Agent。</span>
                </div>
              ) : null}
              <footer className="resume-dialog-footer">
                <Dialog.Close className="secondary-button" type="button">取消</Dialog.Close>
                <button className="primary-button" type="button" disabled={confirmDisabled} onClick={onConfirm}>
                  {confirming ? <LoaderCircle className="spin" size={15} /> : <ExternalLink size={15} />}
                  {confirming ? "正在确认…" : confirmLabel(plan)}
                </button>
              </footer>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ResumeRouteSummary({ plan }: { readonly plan: ResumePlanDto }) {
  return (
    <section className="resume-route-card" aria-label="继续对话路径">
      <div className="resume-route-agents">
        <div><span>来源</span><strong>{AGENT_LABELS[plan.source.agent]}</strong></div>
        <ArrowRight size={17} aria-hidden="true" />
        <div><span>目标</span><strong>{AGENT_LABELS[plan.targetAgent]}</strong></div>
        <span className={classes("quality-badge", `quality-${plan.quality}`)}>{qualityLabel(plan.quality)}</span>
      </div>
      <div className="resume-route-line"><Route size={14} /><span>路线</span><strong>{routeLabel(plan.route)}</strong></div>
      <div className="resume-workspace-line">
        <span>工作区</span>
        <code title={plan.sourceWorkspace}>{plan.sourceWorkspace}</code>
        {plan.workspaceStatus === "mapped" ? (
          <><ArrowRight size={13} /><code title={plan.targetWorkspace}>{plan.targetWorkspace}</code></>
        ) : null}
      </div>
      {plan.needsWrite ? <p className="resume-write-note">打开 Agent 前会通过事务创建目标对话。</p> : null}
    </section>
  );
}

function ResumeFindings({ plan }: { readonly plan: ResumePlanDto }) {
  if (plan.route === "native" && plan.findings.length === 0) {
    return (
      <section className="finding-group finding-preserved">
        <h3><Check size={15} />完整保留</h3>
        <p>不做转换，直接打开原生对话和工作区。</p>
      </section>
    );
  }
  if (plan.quality === "exact" && plan.findings.length === 0) {
    return (
      <section className="finding-group finding-preserved resume-single-finding">
        <h3><Check size={15} />完整保留</h3>
        <p>可移植对话内容全部保留，没有已知损失。</p>
      </section>
    );
  }
  const groups = [
    {
      id: "preserved",
      title: "保留",
      dispositions: ["exact"],
      icon: Check,
    },
    {
      id: "reconstructed",
      title: "重建",
      dispositions: ["synthesized", "degraded"],
      icon: WandSparkles,
    },
    {
      id: "omitted",
      title: "省略",
      dispositions: ["skipped"],
      icon: AlertTriangle,
    },
    {
      id: "blocked",
      title: "阻止",
      dispositions: ["blocked"],
      icon: CircleSlash2,
    },
  ] as const;
  const visible = groups.flatMap((group) => {
    const findings = plan.findings.filter((finding) => group.dispositions.includes(finding.disposition as never));
    return findings.length === 0 ? [] : [{ ...group, findings }];
  });
  if (visible.length === 0) return null;
  return (
    <div className="resume-findings" aria-label="转换影响">
      {visible.map((group) => {
        const Icon = group.icon;
        return (
          <section className={classes("finding-group", `finding-${group.id}`)} key={group.id}>
            <h3><Icon size={15} />{group.title}</h3>
            <ul>
              {group.findings.map((finding) => (
                <li key={`${finding.disposition}:${finding.code}`} title={`技术标识：${finding.code}`}>
                  <span>{conversionFindingLabel(finding)}</span>
                  {finding.count === 1 ? null : <small>×{finding.count}</small>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ResumeOutcome({ outcome, onDone }: { readonly outcome: LaunchedResume; readonly onDone: () => void }) {
  return (
    <div className="resume-outcome" role="status">
      <div className="resume-success-icon"><Check size={24} /></div>
      <h3>{AGENT_LABELS[outcome.targetAgent]} 已启动</h3>
      <p>Agent 进程已成功启动。</p>
      <dl>
        <div><dt>工作区</dt><dd title={outcome.workspace}>{outcome.workspace}</dd></div>
        <div><dt>进程</dt><dd>PID {outcome.pid}</dd></div>
        <div><dt>结果</dt><dd>{outcome.plan.route === "existing" ? "已打开现有延续对话" : outcome.plan.route === "native" ? "已打开原生对话" : "已打开转换后的对话"}</dd></div>
      </dl>
      <button className="primary-button" type="button" onClick={onDone}>完成</button>
    </div>
  );
}

function qualityLabel(quality: ResumePlanDto["quality"]): string {
  switch (quality) {
    case "native": return "原生";
    case "exact": return "完整";
    case "degraded": return "有变更";
    case "blocked": return "已阻止";
  }
}

function routeLabel(route: ResumePlanDto["route"]): string {
  switch (route) {
    case "native": return "原始对话";
    case "existing": return "现有延续对话";
    case "conversion": return "新建转换对话";
  }
}

function confirmLabel(plan: ResumePlanDto): string {
  if (plan.route === "native") return "继续";
  if (plan.route === "existing") return "打开延续对话";
  return "转换并继续";
}
