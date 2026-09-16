import type { Agent, AgentSettingDto } from "../../contracts.js";
import { AGENT_LABELS, classes } from "../lib/display.js";
import { AgentLogo } from "./AgentLogo.js";

export function ExperienceAgentPicker({ agents, selectedAgent, disabled = false, onChange }: {
  readonly agents: readonly AgentSettingDto[];
  readonly selectedAgent: Agent | undefined;
  readonly disabled?: boolean;
  readonly onChange: (agent: Agent) => void;
}) {
  const selected = selectedAgent ?? agents.find((agent) => agent.executable.available)?.agent;
  return <div className="experience-agent-picker">
    <div className="experience-agent-options" role="radiogroup" aria-label="经验分析使用的 Agent">
      {(["codex", "claude", "opencode", "pi"] as const).map((agent) => {
        const available = agents.some((item) => item.agent === agent && (item.executable.available || item.history.available));
        return <button key={agent} type="button" role="radio" aria-checked={selected === agent}
          aria-label={`${AGENT_LABELS[agent]} 当前配置`} disabled={disabled || !available}
          className={classes("experience-agent-option", selected === agent && "is-selected")}
          onClick={() => onChange(agent)}>
          <AgentLogo agent={agent} size={20} /><strong>{AGENT_LABELS[agent]}</strong><span>{available ? "当前模型配置" : "未安装"}</span>
        </button>;
      })}
    </div>
    <p>读取所选 Agent 当前的 API 地址、模型和密钥，直接请求模型。修改 Agent 配置后，下次检测和分析会重新读取。</p>
  </div>;
}
