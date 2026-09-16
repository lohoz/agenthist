import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  History,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type {
  AgentHistDesktopApi,
  DesktopError,
  TransactionActionDto,
  TransactionFindingDto,
  TransactionPlanDto,
  TransactionStateDto,
  TransactionSummaryDto,
} from "../../contracts.js";
import { AGENT_LABELS, classes, formatAbsoluteTime } from "../lib/display.js";

interface RecoveryActionsProps {
  readonly api: AgentHistDesktopApi;
  readonly onNotice: (message: string) => void;
}

type ConfirmationState = "idle" | "replan_required" | "blocked" | "completed";

export function RecoveryActions({ api, onNotice }: RecoveryActionsProps) {
  const [open, setOpen] = useState(false);
  const [transactions, setTransactions] = useState<readonly TransactionSummaryDto[]>();
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<DesktopError>();
  const [plan, setPlan] = useState<TransactionPlanDto>();
  const [planning, setPlanning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [planError, setPlanError] = useState<DesktopError>();
  const [confirmationState, setConfirmationState] = useState<ConfirmationState>("idle");
  const [message, setMessage] = useState<string>();
  const generation = useRef(0);

  useEffect(() => () => { generation.current += 1; }, []);

  const ordered = useMemo(() => sortTransactions(transactions ?? []), [transactions]);
  const attentionCount = transactions?.filter((transaction) => isUnfinished(transaction.state)).length;

  const resetDetail = (): void => {
    setPlan(undefined);
    setPlanning(false);
    setConfirming(false);
    setPlanError(undefined);
    setConfirmationState("idle");
    setMessage(undefined);
  };

  const loadTransactions = async (): Promise<void> => {
    const request = ++generation.current;
    setLoadingList(true);
    setListError(undefined);
    resetDetail();
    try {
      const result = await api.listTransactions();
      if (request !== generation.current) return;
      if (!result.ok) setListError(result.error);
      else setTransactions(result.value);
    } catch (caught) {
      if (request === generation.current) setListError(bridgeError(caught, "无法加载事务记录。"));
    } finally {
      if (request === generation.current) setLoadingList(false);
    }
  };

  const showRecovery = (): void => {
    setOpen(true);
    void loadTransactions();
  };

  const changeOpen = (next: boolean): void => {
    if (!next) {
      generation.current += 1;
      setLoadingList(false);
      resetDetail();
    }
    setOpen(next);
  };

  const planAction = async (summary: TransactionSummaryDto, action: TransactionActionDto): Promise<void> => {
    const request = ++generation.current;
    setPlanning(true);
    setPlan(undefined);
    setPlanError(undefined);
    setConfirmationState("idle");
    setMessage(undefined);
    try {
      const result = await api.planTransaction({ transactionRef: summary.transactionRef, action });
      if (request !== generation.current) return;
      if (!result.ok) setPlanError(result.error);
      else setPlan(result.value);
    } catch (caught) {
      if (request === generation.current) setPlanError(bridgeError(caught, "无法生成事务操作预览。"));
    } finally {
      if (request === generation.current) setPlanning(false);
    }
  };

  const confirm = async (): Promise<void> => {
    const current = plan;
    if (current === undefined || !current.ready || confirmationState === "blocked" || confirming) return;
    const request = ++generation.current;
    setConfirming(true);
    setPlanError(undefined);
    setMessage(undefined);
    try {
      const result = await api.confirmTransaction({
        transactionRef: current.summary.transactionRef,
        action: current.action,
        expectedPlanRef: current.planRef,
      });
      if (request !== generation.current) return;
      if (!result.ok) {
        setPlanError(result.error);
        return;
      }
      setPlan(result.value.plan);
      if (result.value.status === "completed") {
        const completed = result.value;
        setConfirmationState("completed");
        setTransactions((items) => replaceTransaction(items ?? [], completed.summary));
        const action = completed.plan.action === "recover" ? "已安全恢复" : "已安全回滚";
        setMessage(`事务${action}。`);
        onNotice(`事务${action} · ${operationLabel(completed.summary.operation)}`);
      } else if (result.value.status === "replan_required") {
        setConfirmationState("replan_required");
        setMessage("目标在预览后发生变化。请检查刷新后的方案，再次确认。");
      } else {
        setConfirmationState("blocked");
        setMessage("刷新后的方案仍被阻止，未修改任何历史记录。");
      }
    } catch (caught) {
      if (request === generation.current) setPlanError(bridgeError(caught, "事务操作未能完成。"));
    } finally {
      if (request === generation.current) setConfirming(false);
    }
  };

  return (
    <>
      <div className="recovery-entry">
        {attentionCount === undefined ? null : (
          <span className={classes("recovery-badge", attentionCount > 0 && "has-attention")}>
            {attentionCount > 0 ? `${attentionCount} 项需要处理` : "没有待恢复事务"}
          </span>
        )}
        <button className="secondary-button" type="button" onClick={showRecovery}>
          <History size={14} />事务恢复…
        </button>
      </div>

      <Dialog.Root open={open} onOpenChange={changeOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-backdrop resume-dialog-backdrop" />
          <Dialog.Content className="recovery-dialog" aria-describedby="recovery-description">
            <header className="resume-dialog-header">
              <div>
                <p className="eyebrow">原生历史安全</p>
                <Dialog.Title>事务恢复</Dialog.Title>
                <Dialog.Description id="recovery-description">
                  确认前会根据 Agent 当前历史记录预览恢复或回滚结果。
                </Dialog.Description>
              </div>
              <Dialog.Close className="dialog-close" aria-label="关闭事务恢复"><X size={16} /></Dialog.Close>
            </header>

            {plan !== undefined || planning || planError !== undefined ? (
              <TransactionDetail
                plan={plan}
                planning={planning}
                confirming={confirming}
                error={planError}
                confirmationState={confirmationState}
                message={message}
                onBack={resetDetail}
                onConfirm={() => void confirm()}
              />
            ) : (
              <TransactionList
                transactions={ordered}
                loading={loadingList}
                error={listError}
                onRetry={() => void loadTransactions()}
                onPlan={(summary, action) => void planAction(summary, action)}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

interface TransactionListProps {
  readonly transactions: readonly TransactionSummaryDto[];
  readonly loading: boolean;
  readonly error: DesktopError | undefined;
  readonly onRetry: () => void;
  readonly onPlan: (summary: TransactionSummaryDto, action: TransactionActionDto) => void;
}

function TransactionList({ transactions, loading, error, onRetry, onPlan }: TransactionListProps) {
  if (loading) return <RecoveryState icon={<LoaderCircle className="spin" size={20} />} text="正在加载事务…" />;
  if (error !== undefined) {
    return (
      <div className="recovery-state" role="alert">
        <AlertTriangle size={20} /><strong>事务记录不可用</strong><span>{error.message}</span>
        {error.retryable ? <button className="secondary-button" type="button" onClick={onRetry}><RefreshCw size={13} />重试</button> : null}
      </div>
    );
  }
  if (transactions.length === 0) return <RecoveryState icon={<ShieldCheck size={21} />} text="暂时没有 AgentHist 写入事务。" />;
  return (
    <div className="transaction-list" aria-label="事务列表">
      <div className="transaction-list-intro">
        <ShieldAlert size={15} />
        <span>未完成的事务优先显示。执行任何写入前都会再次核对目标状态。</span>
      </div>
      {transactions.map((transaction) => {
        const action = preferredAction(transaction.state);
        return (
          <article className="transaction-row" data-testid="transaction-row" key={transaction.transactionRef}>
            <div className="transaction-row-main">
              <div><strong>{operationLabel(transaction.operation)}</strong><StateBadge state={transaction.state} /></div>
              <span>{transaction.agents.map((agent) => AGENT_LABELS[agent]).join("、")} · {transaction.items} 项</span>
              <time dateTime={transaction.updatedAt}>更新于 {formatAbsoluteTime(transaction.updatedAt)}</time>
            </div>
            {action === undefined ? <span className="transaction-finished">无需处理</span> : (
              <button className="secondary-button" type="button" onClick={() => onPlan(transaction, action)}>
                {action === "recover" ? <RefreshCw size={13} /> : <Undo2 size={13} />}
                {action === "recover" ? "恢复" : "回滚"}
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
}

interface TransactionDetailProps {
  readonly plan: TransactionPlanDto | undefined;
  readonly planning: boolean;
  readonly confirming: boolean;
  readonly error: DesktopError | undefined;
  readonly confirmationState: ConfirmationState;
  readonly message: string | undefined;
  readonly onBack: () => void;
  readonly onConfirm: () => void;
}

function TransactionDetail({ plan, planning, confirming, error, confirmationState, message, onBack, onConfirm }: TransactionDetailProps) {
  if (planning) return <RecoveryState icon={<LoaderCircle className="spin" size={20} />} text="正在检查目标当前状态…" />;
  if (error !== undefined && plan === undefined) {
    return <div className="recovery-state" role="alert"><AlertTriangle size={20} /><strong>预览不可用</strong><span>{error.message}</span><button className="secondary-button" type="button" onClick={onBack}>返回</button></div>;
  }
  if (plan === undefined) return null;
  const blocked = !plan.ready || confirmationState === "blocked" || confirmationState === "completed";
  return (
    <div className="transaction-detail">
      <button className="detail-back-button" type="button" disabled={confirming} onClick={onBack}><ArrowLeft size={13} />事务列表</button>
      <div className="transaction-detail-heading">
        <div><p className="eyebrow">{plan.action === "recover" ? "恢复预览" : "回滚预览"}</p><h3>{operationLabel(plan.summary.operation)}</h3></div>
        <span className={classes("readiness-badge", plan.ready && confirmationState !== "blocked" ? "is-ready" : "is-blocked")}>{plan.ready && confirmationState !== "blocked" ? "可以执行" : "已阻止"}</span>
      </div>
      <dl className="transaction-plan-meta">
        <div><dt>操作</dt><dd>{plan.action === "recover" ? "恢复中断的写入" : "回滚原生历史变更"}</dd></div>
        <div><dt>方向</dt><dd>{directionLabel(plan.summary.direction)}</dd></div>
        <div><dt>Agent</dt><dd>{plan.summary.agents.map((agent) => AGENT_LABELS[agent]).join("、")}</dd></div>
        <div><dt>项目数</dt><dd>{plan.summary.items}</dd></div>
      </dl>
      <div className="transaction-safety-note"><ShieldCheck size={15} /><span>AgentHist 会使用事务机制；如果目标历史已经偏离预览状态，确认会被阻止。</span></div>
      {message === undefined ? null : <div className={classes("transaction-plan-message", confirmationState === "completed" && "is-complete")} role="status">{confirmationState === "completed" ? <CheckCircle2 size={14} /> : <RefreshCw size={14} />}{message}</div>}
      {error === undefined ? null : <div className="compact-resume-error" role="alert"><AlertTriangle size={14} />{error.message}</div>}
      <section className="transaction-findings" aria-labelledby="transaction-findings-title">
        <div><h4 id="transaction-findings-title">当前位置</h4><span>{plan.findings.length} 个会话</span></div>
        {plan.findings.length === 0 ? <p>未发现冲突的目标记录。</p> : plan.findings.map((finding) => <TransactionFinding finding={finding} key={finding.sessionRef} />)}
      </section>
      <footer className="resume-dialog-footer">
        <button className="secondary-button" type="button" disabled={confirming} onClick={onBack}>返回</button>
        <button className={plan.action === "rollback" ? "danger-button" : "primary-button"} type="button" disabled={blocked || confirming} onClick={onConfirm}>
          {confirming ? <LoaderCircle className="spin" size={14} /> : plan.action === "recover" ? <RotateCcw size={14} /> : <Undo2 size={14} />}
          {confirming ? "正在确认…" : plan.action === "recover" ? "确认恢复" : "确认回滚"}
        </button>
      </footer>
    </div>
  );
}

function TransactionFinding({ finding }: { readonly finding: TransactionFindingDto }) {
  const positions = (["row", "section", "file", "resources", "goal"] as const).flatMap((kind) => {
    const position = finding[kind];
    return position === undefined ? [] : [{ kind, position }];
  });
  return (
    <div className="transaction-finding">
      <code title={finding.sessionRef}>{shortReference(finding.sessionRef)}</code>
      <div>{positions.map(({ kind, position }) => <span className={classes(`position-${position}`)} key={kind}>{positionKindLabel(kind)} · {positionLabel(position)}</span>)}</div>
    </div>
  );
}

function RecoveryState({ icon, text }: { readonly icon: ReactNode; readonly text: string }) {
  return <div className="recovery-state">{icon}<span>{text}</span></div>;
}

function StateBadge({ state }: { readonly state: TransactionStateDto }) {
  return <span className={classes("transaction-state", `transaction-${state}`)}>{stateLabel(state)}</span>;
}

function preferredAction(state: TransactionStateDto): TransactionActionDto | undefined {
  if (state === "needs_recovery" || state === "running") return "recover";
  if (state === "committed" || state === "failed") return "rollback";
  return undefined;
}

function isUnfinished(state: TransactionStateDto): boolean {
  return state === "needs_recovery" || state === "running" || state === "failed";
}

function sortTransactions(transactions: readonly TransactionSummaryDto[]): TransactionSummaryDto[] {
  return [...transactions].sort((left, right) => {
    const priority = Number(isUnfinished(right.state)) - Number(isUnfinished(left.state));
    if (priority !== 0) return priority;
    const time = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return Number.isFinite(time) && time !== 0 ? time : left.transactionRef.localeCompare(right.transactionRef);
  });
}

function replaceTransaction(transactions: readonly TransactionSummaryDto[], replacement: TransactionSummaryDto): TransactionSummaryDto[] {
  const next = transactions.filter((transaction) => transaction.transactionRef !== replacement.transactionRef);
  next.push(replacement);
  return next;
}

function operationLabel(value: string): string {
  const known: Readonly<Record<string, string>> = {
    import: "导入历史",
    history_import: "历史导入",
    local_transfer: "本地转换",
    old_import: "旧版导入",
    provider_unify: "Provider 统一",
    resume: "继续对话",
  };
  return known[value] ?? (value === "" ? "事务" : value.replaceAll("_", " "));
}

function shortReference(value: string): string {
  return value.length <= 28 ? value : `${value.slice(0, 16)}…${value.slice(-8)}`;
}

function stateLabel(state: TransactionStateDto): string {
  return ({
    planned: "已计划",
    running: "执行中",
    needs_recovery: "需要恢复",
    committed: "已提交",
    failed: "失败",
    rolled_back: "已回滚",
  } satisfies Record<TransactionStateDto, string>)[state];
}

function directionLabel(direction: string): string {
  return ({ import: "导入", export: "导出", transfer: "转换" } as Readonly<Record<string, string>>)[direction] ?? direction;
}

function positionKindLabel(kind: "row" | "section" | "file" | "resources" | "goal"): string {
  return ({ row: "记录", section: "区段", file: "文件", resources: "资源", goal: "目标" } as const)[kind];
}

function positionLabel(position: string): string {
  return ({ before: "写入前", after: "写入后", unchanged: "未变化", diverged: "已偏离", missing: "缺失" } as Readonly<Record<string, string>>)[position] ?? position;
}

function bridgeError(error: unknown, fallback: string): DesktopError {
  return { code: "renderer.bridge_failed", message: error instanceof Error && error.message.trim() !== "" ? error.message : fallback, retryable: true };
}
