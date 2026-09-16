import { useState } from "react";
import type { Agent, AgentHistDesktopApi, AgentSettingDto } from "../../contracts.js";
import { ExperienceAgentPicker } from "./ExperienceAgentPicker.js";
import { ExperienceApiCheck } from "./ExperienceApiCheck.js";

export function ExperienceConfigSection({ api, agentSettings, selectedAgent, onSelectAgent }: {
  readonly api: AgentHistDesktopApi;
  readonly agentSettings: readonly AgentSettingDto[];
  readonly selectedAgent: Agent | undefined;
  readonly onSelectAgent: (agent: Agent) => void | Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  return <section className="settings-block experience-config-settings" aria-labelledby="experience-config-heading">
    <div className="settings-copy"><h2 id="experience-config-heading">经验模型</h2><p>读取所选 Agent 的现有 API 配置，直接提取和整理经验。</p></div>
    <ExperienceAgentPicker agents={agentSettings} selectedAgent={selectedAgent} disabled={saving || checking}
      onChange={(agent) => {
        setSaving(true);
        void Promise.resolve(onSelectAgent(agent)).finally(() => setSaving(false));
      }} />
    <ExperienceApiCheck api={api} selectedAgent={selectedAgent} disabled={saving} onBusyChange={setChecking} />
  </section>;
}
