import {
  Database,
  SlidersHorizontal,
  Palette,
  Bot,
  Sparkles,
  GitMerge,
  ExternalLink,
  FolderClock,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Save,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type {
  Agent,
  AgentHistDesktopApi,
  AgentPathKind,
  AgentSettingDto,
  DesktopSettings,
  DesktopTheme,
  TerminalSettingsDto,
} from "../../contracts.js";
import { classes } from "../lib/display.js";
import { ExperienceConfigSection } from "./ExperienceConfigSection.js";
import { RebuildIndexAction } from "./RebuildIndexAction.js";
import { RecoveryActions } from "./RecoveryActions.js";
import { ProviderUnifySection } from "./ProviderUnifySection.js";
import { AgentLogo } from "./AgentLogo.js";

interface SettingsPageProps {
  readonly agentSettings: readonly AgentSettingDto[];
  readonly api: AgentHistDesktopApi;
  readonly settings: DesktopSettings;
  readonly stateDirectory: string;
  readonly version: string;
  readonly refreshing: boolean;
  readonly busyPaths: ReadonlySet<string>;
  readonly onChange: (settings: DesktopSettings) => void | Promise<unknown>;
  readonly onRefresh: () => void;
  readonly onIndexRebuilt: () => void;
  readonly onChoosePath: (agent: Agent, kind: AgentPathKind) => void;
  readonly onClearPath: (agent: Agent, kind: AgentPathKind) => void;
  readonly onNotice: (message: string) => void;
}

const THEMES: readonly DesktopTheme[] = ["system", "light", "dark"];
const THEME_LABELS: Readonly<Record<DesktopTheme, string>> = { system: "跟随系统", light: "浅色", dark: "深色" };

export function SettingsPage({
  agentSettings,
  api,
  settings,
  stateDirectory,
  version,
  refreshing,
  busyPaths,
  onChange,
  onRefresh,
  onIndexRebuilt,
  onChoosePath,
  onClearPath,
  onNotice,
}: SettingsPageProps) {
  return (
    <section className="simple-page settings-page" aria-labelledby="settings-heading">
      <header className="page-heading settings-hero">
        <div>
          <p className="eyebrow">偏好设置</p>
          <h1 id="settings-heading">设置</h1>
          <p>管理 Agent、历史记录与桌面使用偏好。</p>
        </div>
        <div className="settings-hero-meta"><SlidersHorizontal size={19} /><span>{agentSettings.filter((agent) => agent.executable.available).length} 个 Agent 可用</span><small>v{version}</small></div>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {[
            { id: "settings-general", label: "常规", icon: Palette },
            { id: "settings-history", label: "历史 Provider", icon: GitMerge },
            { id: "settings-agents", label: "Agent 路径", icon: Bot },
            { id: "settings-experience", label: "经验模型", icon: Sparkles },
            { id: "settings-terminal", label: "命令行终端", icon: TerminalSquare },
            { id: "settings-data", label: "本地数据", icon: Database },
          ].map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" })}><Icon size={16} />{label}</button>)}
        </nav>
        <div className="settings-panels">
      <div id="settings-general" className="settings-overview-grid">
      <section className="settings-section settings-card" aria-labelledby="appearance-heading">
        <div className="settings-copy">
          <h2 id="appearance-heading">外观</h2>
          <p>跟随系统，或选择固定主题。</p>
        </div>
        <div className="segmented-control" aria-label="主题">
          {THEMES.map((theme) => (
            <button
              key={theme}
              type="button"
              className={classes(settings.theme === theme && "is-selected")}
              aria-pressed={settings.theme === theme}
              onClick={() => onChange({ ...settings, theme })}
            >
              {THEME_LABELS[theme]}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section settings-card" aria-labelledby="refresh-heading">
        <div className="settings-copy">
          <h2 id="refresh-heading">自动刷新</h2>
          <p>开启后在启动、窗口重新聚焦及定时间隔时扫描历史；关闭时仅保留手动刷新。</p>
        </div>
        <button
          className={classes("toggle-button", settings.autoRefresh && "is-selected")}
          type="button"
          role="switch"
          aria-checked={settings.autoRefresh}
          onClick={() => onChange({ ...settings, autoRefresh: !settings.autoRefresh })}
        >
          {settings.autoRefresh ? "已开启" : "已关闭"}
        </button>
      </section>
      </div>

      <div id="settings-history"><ProviderUnifySection api={api} onUnified={onIndexRebuilt} onNotice={onNotice} /></div>

      <section id="settings-agents" className="settings-block agent-path-settings" aria-labelledby="agents-heading">
        <div className="settings-copy">
          <h2 id="agents-heading">Agent</h2>
          <p>使用自动检测的位置，或通过系统选择器覆盖。</p>
        </div>
        <div className="agent-path-list">
          {agentSettings.map((agent) => (
            <section className="agent-path-card" key={agent.agent} aria-labelledby={`agent-setting-${agent.agent}`}>
              <header>
                <span className="settings-agent-logo"><AgentLogo agent={agent.agent} size={23} /></span>
                <div><h3 id={`agent-setting-${agent.agent}`}>{agent.label}</h3><span>历史与启动位置</span></div>
                <span className={classes("agent-path-status", agent.executable.available && "is-ready")}><i />{agent.executable.available ? "CLI 可用" : "CLI 不可用"}</span>
              </header>
              <AgentPathRow
                agent={agent}
                kind="history"
                label="历史目录"
                icon={<FolderClock size={15} />}
                configured={agent.history.configured}
                path={agent.history.path}
                available={agent.history.available}
                expected={agent.history.expected}
                busy={busyPaths.has(pathKey(agent.agent, "history"))}
                onChoose={onChoosePath}
                onClear={onClearPath}
              />
              {agent.database === undefined ? null : (
                <AgentPathRow
                  agent={agent}
                  kind="database"
                  label="数据库"
                  icon={<Database size={15} />}
                  configured={agent.database.configured}
                  path={agent.database.path}
                  available={agent.database.available}
                  expected={agent.database.expected}
                  busy={busyPaths.has(pathKey(agent.agent, "database"))}
                  onChoose={onChoosePath}
                  onClear={onClearPath}
                />
              )}
              <AgentPathRow
                agent={agent}
                kind="executable"
                label="可执行文件"
                icon={<TerminalSquare size={15} />}
                configured={agent.executable.configured}
                path={agent.executable.configuredPath ?? agent.executable.resolvedPath}
                available={agent.executable.available}
                expected="file"
                busy={busyPaths.has(pathKey(agent.agent, "executable"))}
                onChoose={onChoosePath}
                onClear={onClearPath}
              />
            </section>
          ))}
        </div>
      </section>

      <div id="settings-experience"><ExperienceConfigSection api={api} agentSettings={agentSettings} selectedAgent={settings.experienceAgent}
        onSelectAgent={(experienceAgent) => onChange({ ...settings, experienceAgent })} /></div>
      <div id="settings-terminal"><TerminalSettingsSection api={api} onNotice={onNotice} /></div>

      <section id="settings-data" className="settings-section" aria-labelledby="data-heading">
        <div className="settings-copy settings-data-copy">
          <Database size={18} aria-hidden="true" />
          <div>
            <h2 id="data-heading">本地数据</h2>
            <p className="path-value" title={stateDirectory}>{stateDirectory}</p>
          </div>
        </div>
        <div className="settings-data-actions">
          <RecoveryActions api={api} onNotice={onNotice} />
          <RebuildIndexAction api={api} onIndexRebuilt={onIndexRebuilt} onNotice={onNotice} />
          <button className="secondary-button" type="button" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? "spin" : undefined} aria-hidden="true" />
            {refreshing ? "正在刷新…" : "手动刷新"}
          </button>
        </div>
      </section>

      <section className="settings-section about-settings" aria-labelledby="about-heading">
        <div className="settings-copy">
          <h2 id="about-heading">关于</h2>
          <p>AgentHist {version}</p>
        </div>
        <a className="secondary-button" href="https://github.com/lohoz/agenthist" target="_blank" rel="noopener noreferrer">
          <ExternalLink size={14} />GitHub
        </a>
      </section>
        </div>
      </div>
    </section>
  );
}

function TerminalSettingsSection({ api, onNotice }: {
  readonly api: AgentHistDesktopApi;
  readonly onNotice: (message: string) => void;
}) {
  const [terminal, setTerminal] = useState<TerminalSettingsDto>();
  const [argumentText, setArgumentText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const adopt = (value: TerminalSettingsDto): void => {
    setTerminal(value);
    setArgumentText(value.arguments.join("\n"));
  };

  useEffect(() => {
    let active = true;
    void api.getTerminalSettings().then((result) => {
      if (!active) return;
      if (result.ok) adopt(result.value);
      else setError(result.error.message);
    }).catch(() => {
      if (active) setError("无法读取终端设置。");
    });
    return () => { active = false; };
  }, [api]);

  const select = async (candidateId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.selectTerminal({ candidateId });
      if (!result.ok) setError(result.error.message);
      else {
        adopt(result.value);
        onNotice(candidateId === "auto" ? "终端已恢复为自动探测" : `已选择终端：${result.value.effectiveLabel}`);
      }
    } catch {
      setError("无法更新终端设置。");
    } finally {
      setBusy(false);
    }
  };

  const saveArguments = async (): Promise<void> => {
    if (busy) return;
    const args = argumentText.split(/\r?\n/u).map((value) => value.trim()).filter((value) => value !== "");
    if (args.filter((value) => value === "{command}" || value === "{commandLine}").length !== 1) {
      setError("参数中必须有且只能有一行 {command} 或 {commandLine}。");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.updateTerminalArguments({ arguments: args });
      if (!result.ok) setError(result.error.message);
      else {
        adopt(result.value);
        onNotice("终端启动参数已保存");
      }
    } catch {
      setError("无法保存终端启动参数。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-block terminal-settings" aria-labelledby="terminal-heading">
      <div className="terminal-settings-heading">
        <div className="settings-copy">
          <h2 id="terminal-heading">命令行终端</h2>
          <p>自动检测系统终端：Windows Terminal、macOS Terminal，或 Linux 桌面终端；也可使用 WezTerm / Alacritty。</p>
        </div>
        <div className={classes("terminal-current", terminal?.requiresSetup && "is-unavailable")}>
          <TerminalSquare size={15} />
          <span>{terminal?.effectiveLabel ?? "正在探测…"}</span>
        </div>
      </div>
      {terminal?.effectiveExecutablePath === undefined ? null : (
        <code className="terminal-path" title={terminal.effectiveExecutablePath}>{terminal.effectiveExecutablePath}</code>
      )}
      <div className="terminal-candidates" aria-label="检测到的终端">
        {(terminal?.candidates ?? []).map((candidate) => (
          <div key={candidate.id}>
            <div><strong>{candidate.label}</strong><code title={candidate.executablePath}>{candidate.executablePath}</code></div>
            <button type="button" disabled={busy} onClick={() => void select(candidate.id)}>使用</button>
          </div>
        ))}
        {terminal !== undefined && terminal.candidates.length === 0 ? (
          <p>没有探测到受支持的终端。请先安装或选择终端可执行文件并确认参数。</p>
        ) : null}
      </div>
      <div className="terminal-actions">
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void select("custom")}>
          <FolderOpen size={14} />选择其他终端…
        </button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void select("auto")}>
          <RotateCcw size={14} />自动探测
        </button>
      </div>
      <details className="terminal-advanced">
      <summary>启动参数（高级）</summary>
      <label className="terminal-arguments">
        <span>默认启动参数（每行一个参数）</span>
        <textarea
          value={argumentText}
          disabled={busy || terminal?.effectiveExecutablePath === undefined}
          spellCheck={false}
          rows={6}
          aria-label="终端默认启动参数"
          onChange={(event) => setArgumentText(event.target.value)}
        />
        <small><code>{"{cwd}"}</code> 表示工作区；<code>{"{command}"}</code> 按独立参数传递；仅当终端要求完整命令行时使用 <code>{"{commandLine}"}</code>。</small>
      </label>
      <div className="terminal-save-row">
        <span />
        <button className="primary-button" type="button" disabled={busy || terminal?.effectiveExecutablePath === undefined} onClick={() => void saveArguments()}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存参数
        </button>
      </div>
      </details>
      {error === undefined ? null : <p className="inline-error" role="alert">{error}</p>}
    </section>
  );
}

interface AgentPathRowProps {
  readonly agent: AgentSettingDto;
  readonly kind: AgentPathKind;
  readonly label: string;
  readonly icon: ReactNode;
  readonly configured: boolean;
  readonly path: string | undefined;
  readonly available: boolean;
  readonly expected: "directory" | "file";
  readonly busy: boolean;
  readonly onChoose: (agent: Agent, kind: AgentPathKind) => void;
  readonly onClear: (agent: Agent, kind: AgentPathKind) => void;
}

function AgentPathRow({
  agent,
  kind,
  label,
  icon,
  configured,
  path,
  available,
  expected,
  busy,
  onChoose,
  onClear,
}: AgentPathRowProps) {
  return (
    <div className="agent-path-row">
      <span className="agent-path-icon" aria-hidden="true">{icon}</span>
      <div className="agent-path-copy">
        <div><strong>{label}</strong><span className={classes("availability-label", available ? "is-available" : "is-unavailable")}>{available ? "可用" : "未找到"}</span></div>
        <span>{configured ? "已使用自定义位置" : "默认位置"}</span>
        {path === undefined ? null : <code title={path}>{path}</code>}
      </div>
      <div className="agent-path-actions">
        {configured ? (
          <button
            className="path-reset-button"
            type="button"
            disabled={busy}
            aria-label={`重置 ${agent.label} ${label}`}
            onClick={() => onClear(agent.agent, kind)}
          >
            <RotateCcw size={12} />重置
          </button>
        ) : null}
        <button
          className="path-browse-button"
          type="button"
          disabled={busy}
          aria-label={`浏览 ${agent.label} ${label}`}
          title={`选择${expected === "directory" ? "目录" : "文件"}`}
          onClick={() => onChoose(agent.agent, kind)}
        >
          {busy ? <LoaderCircle className="spin" size={13} /> : <FolderOpen size={13} />}
          {busy ? "正在选择…" : "浏览…"}
        </button>
      </div>
    </div>
  );
}

export function pathKey(agent: Agent, kind: AgentPathKind): string {
  return `${agent}:${kind}`;
}
