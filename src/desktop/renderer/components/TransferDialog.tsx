import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleSlash2,
  FileArchive,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import type {
  Agent,
  ApplyImportResultDto,
  ConversionFinding,
  DesktopError,
  ImportPlanDto,
  ImportRouteDto,
  ImportSessionDto,
} from "../../contracts.js";
import { conversionFindingLabel } from "../lib/conversion-finding-copy.js";
import { AGENT_LABELS, classes } from "../lib/display.js";

export type ImportTargetSelection = "original" | Agent;
export type CompletedImport = Extract<ApplyImportResultDto, { readonly status: "completed" }>;

interface TransferDialogProps {
  readonly open: boolean;
  readonly plan: ImportPlanDto | undefined;
  readonly completed: CompletedImport | undefined;
  readonly target: ImportTargetSelection;
  readonly replanning: boolean;
  readonly applying: boolean;
  readonly mappingSources: ReadonlySet<string>;
  readonly selectedSessionRefs: ReadonlySet<string>;
  readonly allowLossy: boolean;
  readonly error: DesktopError | undefined;
  readonly reviewMessage: string | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onTargetChange: (target: ImportTargetSelection) => void;
  readonly onSelectionChange: (sessionRefs: readonly string[]) => void;
  readonly onAllowLossy: () => void;
  readonly onMapWorkspace: (source: string) => void;
  readonly onApply: () => void;
}

const TARGETS: ReadonlyArray<{ readonly value: ImportTargetSelection; readonly label: string }> = [
  { value: "original", label: "原 Agent" },
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
  { value: "pi", label: "Pi" },
];

export function TransferDialog({
  open,
  plan,
  completed,
  target,
  replanning,
  applying,
  mappingSources,
  selectedSessionRefs,
  allowLossy,
  error,
  reviewMessage,
  onOpenChange,
  onTargetChange,
  onSelectionChange,
  onAllowLossy,
  onMapWorkspace,
  onApply,
}: TransferDialogProps) {
  const unresolvedWorkspace = plan?.workspaces.some((workspace) =>
    workspace.status === "missing" || workspace.status === "unmapped") ?? false;
  const applyBlocked = plan === undefined || plan.status === "blocked" || plan.blocked > 0 ||
    plan.conflicts > 0 || unresolvedWorkspace || replanning || applying || mappingSources.size > 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop resume-dialog-backdrop" />
        <Dialog.Content
          className="transfer-dialog"
          aria-describedby="transfer-description"
          onEscapeKeyDown={(event) => { if (applying) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (applying) event.preventDefault(); }}
        >
          <header className="resume-dialog-header">
            <div>
              <p className="eyebrow">导入 AgentHist 归档</p>
              <Dialog.Title>{completed === undefined ? (plan?.fileName ?? "正在准备导入…") : "导入完成"}</Dialog.Title>
              <Dialog.Description id="transfer-description">
                {completed === undefined
                  ? "写入前请检查选择范围、转换损失和工作区状态。"
                  : `${completed.fileName} 已写入本地 Agent 历史。`}
              </Dialog.Description>
            </div>
            <Dialog.Close className="dialog-close" aria-label="关闭导入窗口" disabled={applying}><X size={16} /></Dialog.Close>
          </header>

          {completed !== undefined ? (
            <ImportCompletedView completed={completed} onDone={() => onOpenChange(false)} />
          ) : plan === undefined ? (
            <div className="resume-loading" aria-label="正在准备导入">
              <LoaderCircle className="spin" size={20} />
              <span>正在读取并校验所选归档…</span>
            </div>
          ) : (
            <>
              <div className="transfer-toolbar">
                <div>
                  <span>将所选对话导入到</span>
                  <Select.Root
                    value={target}
                    disabled={replanning || applying || mappingSources.size > 0}
                    onValueChange={(value) => onTargetChange(value as ImportTargetSelection)}
                  >
                    <Select.Trigger className="target-select" aria-label="目标 Agent">
                      <Select.Value />
                      <Select.Icon><ChevronDown size={14} /></Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content className="target-select-content" position="popper" sideOffset={5}>
                        <Select.Viewport>
                          {TARGETS.map((item) => (
                            <Select.Item className="target-select-item" value={item.value} key={item.value}>
                              <Select.ItemText>{item.label}</Select.ItemText>
                              <Select.ItemIndicator><Check size={13} /></Select.ItemIndicator>
                            </Select.Item>
                          ))}
                        </Select.Viewport>
                      </Select.Content>
                    </Select.Portal>
                  </Select.Root>
                </div>
                {replanning ? <span className="replan-busy"><LoaderCircle className="spin" size={14} />正在重新检查…</span> : null}
              </div>

              {reviewMessage === undefined ? null : (
                <div className="resume-replan" role="status"><RefreshCw size={14} />{reviewMessage}</div>
              )}
              {error === undefined ? null : (
                <div className="compact-resume-error" role="alert"><AlertTriangle size={14} />{error.message}</div>
              )}

              <ImportSelectionTree
                sessions={plan.sessions}
                selected={selectedSessionRefs}
                disabled={replanning || applying || mappingSources.size > 0}
                onChange={onSelectionChange}
              />
              <ImportSummary plan={plan} />
              <section className="transfer-section" aria-labelledby="routes-title">
                <div className="transfer-section-heading">
                  <div><h3 id="routes-title">转换路线</h3><span>对话将以何种方式写入</span></div>
                  <small>{plan.routes.length}</small>
                </div>
                <div className="import-routes">
                  {plan.routes.map((route) => <ImportRoute route={route} key={`${route.sourceAgent}:${route.targetAgent}`} />)}
                </div>
              </section>

              <section className="transfer-section" aria-labelledby="workspaces-title">
                <div className="transfer-section-heading">
                  <div><h3 id="workspaces-title">工作区</h3><span>目标文件夹必须已经存在</span></div>
                  <small>{plan.workspaces.length}</small>
                </div>
                <div className="import-workspaces">
                  {plan.workspaces.map((workspace) => (
                    <div
                      className="workspace-route"
                      key={workspace.source}
                      role="group"
                      aria-label={`工作区 ${workspace.source}`}
                    >
                      <span className={classes("workspace-status", `workspace-${workspace.status}`)}>{workspaceStatusLabel(workspace.status)}</span>
                      <div>
                        <code title={workspace.source}>{workspace.source}</code>
                        {workspace.status === "mapped" ? (
                          <span><ArrowRight size={12} /><code title={workspace.target}>{workspace.target}</code></span>
                        ) : null}
                        {workspace.status === "missing" || workspace.status === "unmapped" ? (
                          <button
                            className="workspace-map-button"
                            type="button"
                            disabled={mappingSources.size > 0 || replanning || applying}
                            onClick={() => onMapWorkspace(workspace.source)}
                          >
                            {mappingSources.has(workspace.source)
                              ? <LoaderCircle className="spin" size={12} aria-hidden="true" />
                              : <FolderOpen size={12} aria-hidden="true" />}
                            {mappingSources.has(workspace.source) ? "正在选择…" : "选择文件夹…"}
                          </button>
                        ) : null}
                      </div>
                      <small>{workspace.sessions} 个对话</small>
                    </div>
                  ))}
                </div>
              </section>

              {plan.conflicts > 0 ? (
                <TransferBlocker text={`导入前必须先处理 ${plan.conflicts} 个内容冲突。`} />
              ) : null}
              {plan.blocked > 0 || plan.status === "blocked" ? (
                <div className="transfer-lossy-block">
                  <TransferBlocker text={plan.blocked === 0
                    ? "导入计划被兼容性检查阻止。"
                    : `${plan.blocked} 个所选对话被兼容性检查阻止。`} />
                  <button className="secondary-button" type="button" disabled={allowLossy || replanning} onClick={onAllowLossy}>
                    {allowLossy ? "已尝试有损转换" : "仅保留可读文本后重试"}
                  </button>
                </div>
              ) : null}
              {unresolvedWorkspace ? (
                <TransferBlocker text="一个或多个目标工作区缺失或尚未映射，请先选择有效目录。" />
              ) : null}

              {plan.transactionRequired ? (
                <div className="transaction-note"><ShieldCheck size={15} /><span>原生写入会记录为可恢复的 AgentHist 事务。</span></div>
              ) : null}

              <footer className="resume-dialog-footer">
                <Dialog.Close className="secondary-button" type="button" disabled={applying}>取消</Dialog.Close>
                <button className="primary-button" type="button" disabled={applyBlocked} onClick={onApply}>
                  {applying ? <LoaderCircle className="spin" size={15} /> : <FileArchive size={15} />}
                  {applying ? "正在导入…" : "确认导入"}
                </button>
              </footer>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ImportSelectionTree({ sessions, selected, disabled, onChange }: {
  readonly sessions: readonly ImportSessionDto[];
  readonly selected: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onChange: (sessionRefs: readonly string[]) => void;
}) {
  const selectedLogicalSessions = sessions.filter((session) =>
    session.memberSessionRefs.every((reference) => selected.has(reference))).length;
  const workspaces = useMemo(() => {
    const groups = new Map<string, ImportSessionDto[]>();
    for (const session of sessions) {
      const values = groups.get(session.workspace) ?? [];
      values.push(session);
      groups.set(session.workspace, values);
    }
    return [...groups].map(([workspace, values]) => ({
      workspace,
      name: workspace.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || workspace,
      sessions: [...values].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    })).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }, [sessions]);
  const toggle = (references: readonly string[], checked: boolean): void => {
    const next = new Set(selected);
    for (const reference of references) {
      if (checked) next.add(reference);
      else next.delete(reference);
    }
    if (next.size > 0) onChange([...next]);
  };
  return (
    <section className="transfer-section import-selection" aria-labelledby="import-selection-title">
      <div className="transfer-section-heading">
        <div><h3 id="import-selection-title">选择对话</h3><span>可按工作区、Agent 文件夹或单条对话勾选</span></div>
        <small>{selectedLogicalSessions}/{sessions.length}</small>
      </div>
      <div className="import-selection-tree">
        {workspaces.map((workspace, workspaceIndex) => {
          const workspaceRefs = workspace.sessions.flatMap((session) => session.memberSessionRefs);
          return (
            <details key={workspace.workspace} open={workspaceIndex === 0}>
              <summary>
                <SelectionCheckbox
                  references={workspaceRefs}
                  selected={selected}
                  disabled={disabled || workspaceRefs.every((reference) => selected.has(reference)) && selected.size === workspaceRefs.length}
                  label={`选择工作区 ${workspace.name}`}
                  onChange={(checked) => toggle(workspaceRefs, checked)}
                />
                <FolderOpen size={14} /><strong>{workspace.name}</strong><span>{workspace.sessions.length}</span>
              </summary>
              {AGENT_LABELS_ORDER.map((agent) => {
                const agentSessions = workspace.sessions.filter((session) => session.sourceAgent === agent);
                if (agentSessions.length === 0) return null;
                const agentRefs = agentSessions.flatMap((session) => session.memberSessionRefs);
                return (
                  <div className="import-agent-folder" key={agent}>
                    <div>
                      <SelectionCheckbox
                        references={agentRefs}
                        selected={selected}
                        disabled={disabled || agentRefs.every((reference) => selected.has(reference)) && selected.size === agentRefs.length}
                        label={`选择 ${AGENT_LABELS[agent]} 文件夹`}
                        onChange={(checked) => toggle(agentRefs, checked)}
                      />
                      <strong>{AGENT_LABELS[agent]}</strong><span>{agentSessions.length}</span>
                    </div>
                    {agentSessions.map((session) => (
                      <label className="import-session-option" key={session.sessionRef}>
                        <SelectionCheckbox
                          references={session.memberSessionRefs}
                          selected={selected}
                          disabled={disabled || session.memberSessionRefs.every((reference) => selected.has(reference)) &&
                            selected.size === session.memberSessionRefs.length}
                          label={`选择对话 ${session.title || "未命名对话"}`}
                          onChange={(checked) => toggle(session.memberSessionRefs, checked)}
                        />
                        <span><strong>{session.title || "未命名对话"}</strong><small>{new Date(session.updatedAt).toLocaleString("zh-CN")}</small></span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </details>
          );
        })}
      </div>
    </section>
  );
}

const AGENT_LABELS_ORDER = ["codex", "claude", "opencode", "pi"] as const;

function SelectionCheckbox({ references, selected, disabled, label, onChange }: {
  readonly references: readonly string[];
  readonly selected: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  const checked = references.length > 0 && references.every((reference) => selected.has(reference));
  const partial = !checked && references.some((reference) => selected.has(reference));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = partial;
  }, [partial]);
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onClick={(event) => event.stopPropagation()} onChange={(event) => onChange(event.currentTarget.checked)} />;
}

function ImportSummary({ plan }: { readonly plan: ImportPlanDto }) {
  const values = [
    ["已选择", plan.selectedSessions],
    ["新增", plan.newSessions],
    ["已存在", plan.alreadyPresent],
    ["受阻", plan.blocked],
    ["冲突", plan.conflicts],
  ] as const;
  return (
    <section className="import-summary" aria-label="导入摘要">
      {values.map(([label, value]) => (
        <div key={label} className={(label === "受阻" || label === "冲突") && value > 0 ? "has-problem" : undefined}>
          <strong>{value}</strong><span>{label}</span>
        </div>
      ))}
    </section>
  );
}

function ImportRoute({ route }: { readonly route: ImportRouteDto }) {
  const groups = findingGroups(route.findings);
  return (
    <article className="import-route-card">
      <div className="import-route-title">
        <strong>{AGENT_LABELS[route.sourceAgent]}</strong>
        <ArrowRight size={14} />
        <strong>{AGENT_LABELS[route.targetAgent]}</strong>
        <span>{route.sessions} 个对话</span>
        <span className={classes("quality-badge", `quality-${route.quality}`)}>{qualityLabel(route.quality)}</span>
      </div>
      {groups.length === 0 ? (
        <p>{route.quality === "native" ? "保留原始原生记录。" : "没有已知内容变化。"}</p>
      ) : (
        <div className="route-findings">
          {groups.map((group) => {
            const Icon = group.icon;
            return (
              <div className={classes("route-finding-group", `finding-${group.id}`)} key={group.id}>
                <h4><Icon size={13} />{group.title}</h4>
                <ul>
                  {group.findings.map((finding) => (
                    <li key={`${finding.disposition}:${finding.code}`} title={`技术标识：${finding.code}`}>
                      {conversionFindingLabel(finding)}{finding.count === 1 ? "" : ` ×${finding.count}`}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function findingGroups(findings: readonly ConversionFinding[]) {
  const definitions = [
    { id: "preserved", title: "保留", values: ["exact"], icon: Check },
    { id: "reconstructed", title: "重建", values: ["synthesized", "degraded"], icon: WandSparkles },
    { id: "omitted", title: "省略", values: ["skipped"], icon: AlertTriangle },
    { id: "blocked", title: "阻止", values: ["blocked"], icon: CircleSlash2 },
  ] as const;
  return definitions.flatMap((definition) => {
    const matching = findings.filter((finding) => definition.values.includes(finding.disposition as never));
    return matching.length === 0 ? [] : [{ ...definition, findings: matching }];
  });
}

function TransferBlocker({ text }: { readonly text: string }) {
  return <div className="resume-blocker transfer-blocker" role="alert"><CircleSlash2 size={16} /><span>{text}</span></div>;
}

function ImportCompletedView({ completed, onDone }: { readonly completed: CompletedImport; readonly onDone: () => void }) {
  return (
    <div className="resume-outcome import-outcome" role="status">
      <div className="resume-success-icon"><CheckCircle2 size={24} /></div>
      <h3>导入完成</h3>
      <p>{completed.fileName}</p>
      <dl>
        <div><dt>已写入</dt><dd>{completed.written} 个对话</dd></div>
        <div><dt>已存在</dt><dd>目标中已有 {completed.alreadyPresent} 个</dd></div>
        <div><dt>安全</dt><dd>{completed.transactionRefs.length === 0 ? "不需要原生修改" : `${completed.transactionRefs.length} 个可恢复事务`}</dd></div>
      </dl>
      <button className="primary-button" type="button" onClick={onDone}>完成</button>
    </div>
  );
}

function qualityLabel(value: ImportRouteDto["quality"]): string {
  if (value === "native") return "原生";
  if (value === "exact") return "完整";
  if (value === "degraded") return "有损";
  return "受阻";
}

function workspaceStatusLabel(value: ImportPlanDto["workspaces"][number]["status"]): string {
  if (value === "unchanged") return "原路径";
  if (value === "mapped") return "已映射";
  if (value === "missing") return "缺失";
  return "未映射";
}
