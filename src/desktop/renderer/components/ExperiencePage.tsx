import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ExternalLink,
  FileSearch,
  FolderOpen,
  History,
  LoaderCircle,
  MessageSquareText,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  Agent,
  AgentSettingDto,
  AgentHistDesktopApi,
  DesktopError,
  ExperienceCandidateDetailDto,
  ExperienceCandidateSummaryDto,
  ExperiencePreviewDto,
  ExperienceProgressDto,
  ExperienceReviewDto,
  ExperienceScopeRequest,
} from "../../contracts.js";
import { AGENT_LABELS, classes, formatAbsoluteTime } from "../lib/display.js";
import { ExperienceAgentPicker } from "./ExperienceAgentPicker.js";
import { ExperienceApiCheck } from "./ExperienceApiCheck.js";

interface ExperiencePageProps {
  readonly agentSettings?: readonly AgentSettingDto[];
  readonly selectedAgent?: Agent | undefined;
  readonly selectedSessionRefs?: ReadonlySet<string>;
  readonly onSelectAgent?: (agent: Agent) => void | Promise<unknown>;
  readonly api: AgentHistDesktopApi;
  readonly onOpenSession: (sessionRef: string) => void;
}

type CandidateCategory = ExperienceCandidateSummaryDto["category"];

const CATEGORIES: ReadonlyArray<{
  readonly id: CandidateCategory;
  readonly title: string;
  readonly description: string;
}> = [
  { id: "requirement", title: "重复要求", description: "在多个独立任务中反复出现的约束。" },
  { id: "preference", title: "偏好", description: "关于风格或交互方式的重复选择。" },
  { id: "working_method", title: "工作方式", description: "反复出现的规划和验证方法。" },
];

export function ExperiencePage({ api, onOpenSession, agentSettings, selectedAgent, selectedSessionRefs, onSelectAgent }: ExperiencePageProps) {
  const [scope, setScope] = useState<"all" | "sessions">((selectedSessionRefs?.size ?? 0) > 0 ? "sessions" : "all");
  const [savingAgent, setSavingAgent] = useState(false);
  const [checkingApi, setCheckingApi] = useState(false);
  const [partial, setPartial] = useState(false);
  const previewScope = useRef<ExperienceScopeRequest>({ scope: "all" });
  const scopeKey = scope === "all" ? "all" : [...(selectedSessionRefs ?? [])].sort().join("\n");
  const modelAgent = selectedAgent ?? agentSettings?.find((agent) => agent.executable.available)?.agent;
  const modelAvailable = agentSettings === undefined || agentSettings.some((agent) => agent.agent === modelAgent && (agent.executable.available || agent.history.available));
  const [preview, setPreview] = useState<ExperiencePreviewDto>();
  const [review, setReview] = useState<ExperienceReviewDto>();
  const [detail, setDetail] = useState<ExperienceCandidateDetailDto>();
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadingReview, setLoadingReview] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [openingOutput, setOpeningOutput] = useState(false);
  const [progress, setProgress] = useState<ExperienceProgressDto>();
  const [error, setError] = useState<DesktopError>();
  const [detailError, setDetailError] = useState<DesktopError>();
  const [message, setMessage] = useState<string>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const activeHandle = useRef<string | undefined>(undefined);
  const operationGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const closeReviewRef = useRef<(handle: string, reportFailure: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    setPreview(undefined);
    setPartial(false);
  }, [scopeKey, selectedAgent]);

  const closeReviewHandle = useCallback(async (handle: string, reportFailure: boolean): Promise<void> => {
    try {
      const result = await api.closeExperienceReview({ handle });
      if (reportFailure && !result.ok) setError(result.error);
    } catch (caught) {
      if (reportFailure) setError(bridgeError(caught, "无法安全关闭审阅。"));
    }
  }, [api]);
  closeReviewRef.current = closeReviewHandle;

  useEffect(() => api.onExperienceProgress((next) => setProgress(next)), [api]);

  useEffect(() => {
    if (!running) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const update = (): void => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => () => {
    operationGeneration.current += 1;
    detailGeneration.current += 1;
    const handle = activeHandle.current;
    activeHandle.current = undefined;
    if (handle !== undefined) void closeReviewRef.current(handle, false);
  }, []);

  const clearReviewState = (): void => {
    detailGeneration.current += 1;
    setReview(undefined);
    setDetail(undefined);
    setDetailError(undefined);
    setLoadingDetail(false);
    setOpeningOutput(false);
  };

  const releaseCurrentReview = (reportFailure: boolean): void => {
    const handle = activeHandle.current;
    activeHandle.current = undefined;
    clearReviewState();
    if (handle !== undefined) void closeReviewHandle(handle, reportFailure);
  };

  const closeDisplayedReview = (): void => {
    operationGeneration.current += 1;
    setPreviewing(false);
    setRunning(false);
    setLoadingReview(false);
    setProgress(undefined);
    releaseCurrentReview(true);
  };

  const adoptReview = async (next: ExperienceReviewDto, generation: number): Promise<void> => {
    if (generation !== operationGeneration.current) {
      await closeReviewHandle(next.handle, false);
      return;
    }
    const previous = activeHandle.current;
    activeHandle.current = next.handle;
    detailGeneration.current += 1;
    setReview(next);
    setPreview(undefined);
    setDetail(undefined);
    setDetailError(undefined);
    setOpeningOutput(false);
    setMessage(undefined);
    if (previous !== undefined && previous !== next.handle) void closeReviewHandle(previous, false);
  };

  const previewHistory = async (): Promise<void> => {
    if (previewing || running || loadingReview || savingAgent || (scope === "sessions" && !selectedSessionRefs?.size)) return;
    const generation = ++operationGeneration.current;
    setPreviewing(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const requestedScope: ExperienceScopeRequest = scope === "all" ? { scope: "all" } : { scope: "sessions", sessionRefs: [...selectedSessionRefs!] };
      const result = await api.previewExperience(requestedScope);
      if (generation !== operationGeneration.current) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      releaseCurrentReview(false);
      previewScope.current = requestedScope;
      setPartial(false);
      setPreview(result.value);
    } catch (caught) {
      if (generation === operationGeneration.current) setError(bridgeError(caught, "无法预览历史分析。"));
    } finally {
      if (generation === operationGeneration.current) setPreviewing(false);
    }
  };

  const runAnalysis = async (): Promise<void> => {
    const current = preview;
    if (current === undefined || running || savingAgent || checkingApi || !modelAvailable || current.inputLimitExceeded || current.sessions === 0 || current.queuedCards === 0) return;
    const generation = ++operationGeneration.current;
    setRunning(true);
    setProgress({ phase: "indexing" });
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await api.runExperience({ scope: previewScope.current, expectedPreviewRef: current.previewRef });
      if (generation !== operationGeneration.current) {
        if (result.ok && result.value.status === "completed") await closeReviewHandle(result.value.review.handle, false);
        return;
      }
      if (!result.ok) {
        setError(result.error);
      } else if (result.value.status === "cancelled") {
        setMessage("已取消分析，没有创建审阅。" );
      } else if (result.value.status === "replan_required") {
        setPreview(result.value.preview);
        setMessage("预览后历史发生变化，请检查更新后的范围再运行。" );
      } else if (result.value.status === "partial") {
        setPartial(true);
        setMessage(result.value.remainingCards > 0
          ? `本批次已保存，仍有 ${result.value.remainingCards} 张证据卡未处理。点击继续分析将复用已完成结果。`
          : "证据提取已完成，候选整理尚未完成。点击继续分析将复用已完成结果。");
      } else {
        await adoptReview(result.value.review, generation);
      }
    } catch (caught) {
      if (generation === operationGeneration.current) setError(bridgeError(caught, "历史分析未完成。"));
    } finally {
      if (generation === operationGeneration.current) {
        setRunning(false);
        setProgress(undefined);
      }
    }
  };

  const openReview = async (): Promise<void> => {
    if (loadingReview || previewing || running) return;
    const generation = ++operationGeneration.current;
    setLoadingReview(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await api.loadExperienceReview();
      if (generation !== operationGeneration.current) {
        if (result.ok && result.value.status === "loaded") await closeReviewHandle(result.value.review.handle, false);
        return;
      }
      if (!result.ok) setError(result.error);
      else if (result.value.status === "cancelled") setMessage("已取消打开审阅。" );
      else await adoptReview(result.value.review, generation);
    } catch (caught) {
      if (generation === operationGeneration.current) setError(bridgeError(caught, "无法打开所选审阅。"));
    } finally {
      if (generation === operationGeneration.current) setLoadingReview(false);
    }
  };

  const selectCandidate = async (candidateRef: string): Promise<void> => {
    const handle = activeHandle.current;
    if (handle === undefined) return;
    const generation = ++detailGeneration.current;
    setLoadingDetail(true);
    setDetail(undefined);
    setDetailError(undefined);
    try {
      const result = await api.getExperienceCandidate({ handle, candidateRef });
      if (generation !== detailGeneration.current || handle !== activeHandle.current) return;
      if (!result.ok) setDetailError(result.error);
      else setDetail(result.value);
    } catch (caught) {
      if (generation === detailGeneration.current && handle === activeHandle.current) {
        setDetailError(bridgeError(caught, "无法加载候选证据。"));
      }
    } finally {
      if (generation === detailGeneration.current && handle === activeHandle.current) setLoadingDetail(false);
    }
  };

  const openOutput = async (): Promise<void> => {
    const handle = activeHandle.current;
    if (handle === undefined || openingOutput) return;
    setOpeningOutput(true);
    setError(undefined);
    try {
      const result = await api.openExperienceOutput({ handle });
      if (handle !== activeHandle.current) return;
      if (!result.ok) setError(result.error);
      else setMessage("已打开审阅输出目录。" );
    } catch (caught) {
      if (handle === activeHandle.current) setError(bridgeError(caught, "无法打开输出目录。"));
    } finally {
      if (handle === activeHandle.current) setOpeningOutput(false);
    }
  };

  const busy = previewing || running || loadingReview || savingAgent || checkingApi;
  return (
    <section className="experience-page" aria-labelledby="experience-heading">
      <header className="experience-header">
        <div>
          <p className="eyebrow">证据优先的审阅</p>
          <h1 id="experience-heading">经验</h1>
          <p>从多个独立对话中发现反复出现的要求、偏好和工作方式。</p>
        </div>
        <div className="experience-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void openReview()}>
            {loadingReview ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}
            {loadingReview ? "正在打开…" : "打开审阅"}
          </button>
          <button className="primary-button" type="button" disabled={busy || (scope === "sessions" && !selectedSessionRefs?.size)} onClick={() => void previewHistory()}>
            {previewing ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
            {previewing ? "正在分析…" : preview === undefined ? "分析历史" : "刷新预览"}
          </button>
        </div>
      </header>

      <div className="experience-setup">
        {agentSettings === undefined ? null : <ExperienceAgentPicker agents={agentSettings} selectedAgent={selectedAgent} disabled={busy}
          onChange={(agent) => {
            setSavingAgent(true);
            void Promise.resolve(onSelectAgent?.(agent)).catch(() => setError(bridgeError(undefined, "无法保存 Agent 选择。"))).finally(() => setSavingAgent(false));
          }} />}
        {agentSettings === undefined ? null : <ExperienceApiCheck api={api} selectedAgent={selectedAgent} disabled={previewing || running || loadingReview || savingAgent} onBusyChange={setCheckingApi} />}
        <fieldset className="experience-scope" disabled={busy}>
          <legend>分析范围</legend>
          <label><input type="radio" name="experience-scope" checked={scope === "all"} onChange={() => setScope("all")} />全部历史</label>
          <label><input type="radio" name="experience-scope" checked={scope === "sessions"} onChange={() => setScope("sessions")} />已勾选对话（{selectedSessionRefs?.size ?? 0}）</label>
          {scope === "sessions" && !selectedSessionRefs?.size ? <span>请先在左侧历史中勾选文件夹或对话。</span> : null}
        </fieldset>
        {modelAvailable ? null : <p role="status">请先安装一个支持的 Agent，并在该 Agent 中配置模型或登录。</p>}
      </div>

      {error === undefined ? null : <ExperienceError error={error} />}
      {message === undefined ? null : <div className="experience-message" role="status"><CheckCircle2 size={15} />{message}</div>}
      {running ? <ExperienceProgress progress={progress} elapsedSeconds={elapsedSeconds} /> : null}
      {review !== undefined ? (
        <ReviewWorkspace
          review={review}
          detail={detail}
          detailError={detailError}
          loadingDetail={loadingDetail}
          openingOutput={openingOutput}
          onSelectCandidate={(candidateRef) => void selectCandidate(candidateRef)}
          onOpenOutput={() => void openOutput()}
          onClose={closeDisplayedReview}
          onOpenSession={onOpenSession}
        />
      ) : preview !== undefined ? (
        <ExperiencePreview preview={preview} running={running} disabled={savingAgent || checkingApi || !modelAvailable} partial={partial} onRun={() => void runAnalysis()} />
      ) : !running ? <ExperienceIntro /> : null}
    </section>
  );
}

function ExperienceIntro() {
  return (
    <div className="experience-intro-card">
      <div className="experience-symbol"><FileSearch size={23} /></div>
      <div>
        <h2>结合证据审阅重复模式</h2>
        <p>AgentHist 会先展示范围和预计模型工作量。只有确认运行后才会发送内容。</p>
        <div className="evidence-boundary"><ShieldCheck size={14} />候选项只是待审阅材料，不会自动成为指令。</div>
      </div>
    </div>
  );
}

function ExperiencePreview({ preview, running, disabled, partial, onRun }: {
  readonly preview: ExperiencePreviewDto;
  readonly running: boolean;
  readonly disabled: boolean;
  readonly partial: boolean;
  readonly onRun: () => void;
}) {
  const requests = preview.evidenceRequests + preview.candidateRequestsUpperBound;
  const empty = preview.sessions === 0 || preview.queuedCards === 0;
  return (
    <section className="experience-preview" aria-labelledby="preview-heading">
      <div className="experience-section-heading">
        <div><p className="eyebrow">模型访问前</p><h2 id="preview-heading">分析预览</h2></div>
        <span>尚未发送任何内容</span>
      </div>
      <div className="preview-metrics">
        <Metric label="对话" value={preview.sessions} />
        <Metric label="项目" value={preview.projects} />
        <Metric label="证据卡" value={preview.cards} />
        <Metric label="可分析" value={preview.queuedCards} />
        <Metric label="预计 tokens" value={formatNumber(preview.estimatedInputTokens)} />
        <Metric label="模型请求" value={requests} />
      </div>
      <div className="preview-index-note">
        <History size={15} />
        <span>复用 {preview.reusedSessions} 个已索引对话，重建 {preview.rebuiltSessions} 个。{preview.singleRequest
          ? "只请求模型一次，直接生成最终经验；不分批、不再整理、不自动重试。"
          : "工作量为估算上限，已完成的分析结果会从缓存复用。"}</span>
      </div>
      {preview.singleRequest ? <div className="preview-index-note">
        <FileSearch size={15} />
        <span>包含{preview.scope === "all" ? "全部" : "所选"} {preview.sessions} 个对话、{preview.queuedCards} 条证据。
          {preview.inputCompacted ? `重复文本在本地合并存储，内容和来源全部保留；输入从约 ${formatNumber(preview.originalInputTokens ?? preview.estimatedInputTokens)} 压缩到 ${formatNumber(preview.estimatedInputTokens)} tokens。` : ""}
          {preview.modelContextWindow === undefined ? "" : `使用 Agent 配置的 ${formatNumber(preview.modelContextWindow)} 上下文容量，已预留输出和安全余量。`}
          {preview.inputTokenLimit === undefined ? "" : `本次输入预算 ${formatNumber(preview.inputTokenLimit)} tokens。`}
        </span>
      </div> : null}
      {preview.inputLimitExceeded ? (
        <div className="experience-empty" role="status"><strong>当前模型的单次上下文不足</strong><span>全部历史在本地去重后约 {formatNumber(preview.estimatedInputTokens)} tokens。请使用更大上下文的模型，或校正 Agent 中的上下文配置；将保留全部对话，不会跳过历史或自动分批。</span></div>
      ) : empty ? (
        <div className="experience-empty" role="status"><Search size={20} /><strong>当前范围没有可复用证据</strong><span>暂时没有可运行的内容。</span></div>
      ) : (
        <div className="preview-confirm">
          <div><strong>开始分析？</strong><span>确认后才会访问模型。</span></div>
          <button className="primary-button" type="button" disabled={running || disabled} onClick={onRun}>
            {running ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
            {running ? "正在运行…" : partial ? "继续分析" : "运行分析"}
          </button>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string | number }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function ExperienceProgress({ progress, elapsedSeconds }: {
  readonly progress: ExperienceProgressDto | undefined;
  readonly elapsedSeconds: number;
}) {
  const label = progressLabel(progress);
  const ratio = progress?.phase === "extracting" && progress.totalBatches > 0
    ? Math.min(1, progress.currentBatch / progress.totalBatches)
    : progress?.phase === "organizing" && progress.currentRequest !== undefined &&
        progress.totalRequests !== undefined && progress.totalRequests > 0
      ? Math.min(1, progress.currentRequest / progress.totalRequests)
      : undefined;
  return (
    <div className="experience-progress" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={17} />
      <div>
        <strong>{label}</strong>
        <span>已运行 {formatElapsed(elapsedSeconds)}；API 连续 90 秒没有返回数据会停止并显示原因。可以切换页面，分析会继续运行。</span>
      </div>
      {ratio === undefined ? null : <progress max={1} value={ratio}>{Math.round(ratio * 100)}%</progress>}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes === 0 ? `${remaining} 秒` : `${minutes} 分 ${remaining} 秒`;
}

interface ReviewWorkspaceProps {
  readonly review: ExperienceReviewDto;
  readonly detail: ExperienceCandidateDetailDto | undefined;
  readonly detailError: DesktopError | undefined;
  readonly loadingDetail: boolean;
  readonly openingOutput: boolean;
  readonly onSelectCandidate: (candidateRef: string) => void;
  readonly onOpenOutput: () => void;
  readonly onClose: () => void;
  readonly onOpenSession: (sessionRef: string) => void;
}

function ReviewWorkspace({ review, detail, detailError, loadingDetail, openingOutput, onSelectCandidate, onOpenOutput, onClose, onOpenSession }: ReviewWorkspaceProps) {
  return (
    <div className="review-workspace">
      <header className="review-summary-header">
        <div>
          <p className="eyebrow">证据包</p>
          <h2>{review.directoryName}</h2>
          <span>{formatAbsoluteTime(review.createdAt)} · {review.sessions} 个对话 · {review.projects} 个项目 · {review.lineages} 条脉络</span>
        </div>
        <div>
          <button className="secondary-button" type="button" disabled={openingOutput} onClick={onOpenOutput}>
            {openingOutput ? <LoaderCircle className="spin" size={14} /> : <ExternalLink size={14} />}
            打开输出目录
          </button>
          <button className="quiet-icon-button" type="button" aria-label="关闭审阅" onClick={onClose}><X size={16} /></button>
        </div>
      </header>
      <div className="review-boundary" role="note">
        这些内容只是待审阅证据，AgentHist 尚未把候选项接受、编辑、合并或保存为偏好。
        {review.unroutedEvidence > 0 ? ` 审计中仍有 ${review.unroutedEvidence} 条未归类证据。` : ""}
      </div>
      <div className="review-columns">
        <div className="candidate-groups">
          {review.candidates.length === 0 ? (
            <div className="experience-empty"><MessageSquareText size={20} /><strong>此审阅没有候选项</strong><span>证据审计中仍可能包含未分组材料。</span></div>
          ) : CATEGORIES.map((category) => {
            const candidates = review.candidates.filter((candidate) => candidate.category === category.id);
            if (candidates.length === 0) return null;
            return (
              <section className="candidate-group" key={category.id} aria-labelledby={`candidate-${category.id}`}>
                <div><h3 id={`candidate-${category.id}`}>{category.title}</h3><span>{category.description}</span></div>
                {candidates.map((candidate) => (
                  <button
                    type="button"
                    className={classes("candidate-card", detail?.candidateRef === candidate.candidateRef && "is-selected")}
                    key={candidate.candidateRef}
                    onClick={() => onSelectCandidate(candidate.candidateRef)}
                  >
                    <strong>{candidate.draft}</strong>
                    <span>{candidate.topic} · {candidate.lens}</span>
                    <small>{candidate.evidence} 条证据 · {candidate.sessions} 个对话 · {candidate.projects} 个项目</small>
                  </button>
                ))}
              </section>
            );
          })}
        </div>
        <CandidateDetail detail={detail} error={detailError} loading={loadingDetail} onOpenSession={onOpenSession} />
      </div>
    </div>
  );
}

function CandidateDetail({ detail, error, loading, onOpenSession }: {
  readonly detail: ExperienceCandidateDetailDto | undefined;
  readonly error: DesktopError | undefined;
  readonly loading: boolean;
  readonly onOpenSession: (sessionRef: string) => void;
}) {
  if (loading) return <aside className="candidate-detail candidate-detail-state"><LoaderCircle className="spin" size={19} /><span>正在加载来源证据…</span></aside>;
  if (error !== undefined) return <aside className="candidate-detail candidate-detail-state" role="alert"><AlertTriangle size={19} /><strong>证据不可用</strong><span>{error.message}</span></aside>;
  if (detail === undefined) return <aside className="candidate-detail candidate-detail-state"><Bot size={21} /><strong>请选择候选项</strong><span>得出结论前先检查准确的用户证据。</span></aside>;
  return (
    <aside className="candidate-detail" aria-label="候选证据">
      <header>
        <p className="eyebrow">候选详情</p>
        <h3>{detail.draft}</h3>
        <div className="candidate-taxonomy"><span>{detail.topic}</span><span>{detail.lens}</span><span>{detail.relation}</span></div>
      </header>
      <div className="evidence-list">
        {detail.evidenceItems.map((evidence) => (
          <article className="evidence-item" key={evidence.occurrenceRef}>
            <div className="evidence-source"><span>{AGENT_LABELS[evidence.agent]} · {evidence.workspace}</span><time dateTime={evidence.timestamp}>{formatAbsoluteTime(evidence.timestamp)}</time></div>
            <p>{evidence.observation}</p>
            <blockquote>{evidence.userText}</blockquote>
            {evidence.assistant.length === 0 ? null : (
              <details><summary>助手回复 <span>不是直接证据</span></summary>{evidence.assistant.map((text, index) => <p key={index}>{text}</p>)}</details>
            )}
            <button className="source-session-button" type="button" onClick={() => onOpenSession(evidence.sessionRef)}><MessageSquareText size={13} />来源对话</button>
          </article>
        ))}
      </div>
    </aside>
  );
}

function ExperienceError({ error }: { readonly error: DesktopError }) {
  return <div className="experience-error" role="alert"><AlertTriangle size={16} /><div><strong>经验操作失败</strong><span>{error.message}</span></div></div>;
}

function progressLabel(progress: ExperienceProgressDto | undefined): string {
  if (progress === undefined) return "正在开始分析…";
    if (progress.phase === "extracting") return progress.totalBatches === 1 ? "正在一次生成经验 · 1/1" : `正在提取证据 · 批次 ${progress.currentBatch}/${progress.totalBatches}`;
  switch (progress.phase) {
    case "indexing": return "正在索引所选历史…";
    case "configuring": return "正在检查模型配置…";
    case "organizing": return progress.currentRequest === undefined || progress.totalRequests === undefined
      ? "正在整理重复候选项…"
      : `正在整理重复候选项 · 请求 ${progress.currentRequest}/${progress.totalRequests}`;
    case "publishing": return "正在写入证据包…";
    case "finalizing": return "正在完成审阅…";
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function bridgeError(error: unknown, fallback: string): DesktopError {
  return { code: "renderer.bridge_failed", message: error instanceof Error && error.message.trim() !== "" ? error.message : fallback, retryable: true };
}
