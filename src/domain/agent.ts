export const AGENT_CATALOG = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi" },
] as const;

export type Agent = (typeof AGENT_CATALOG)[number]["id"];

export const AGENTS: readonly Agent[] = AGENT_CATALOG.map((item) => item.id);

const AGENT_IDS = new Set<Agent>(AGENTS);
const AGENT_LABELS = new Map<Agent, string>(AGENT_CATALOG.map((item) => [item.id, item.label]));

export function isAgent(value: string): value is Agent {
  return AGENT_IDS.has(value as Agent);
}

export function agentLabel(agent: Agent): string {
  return AGENT_LABELS.get(agent)!;
}

export function selectAgents(selected: readonly string[]): readonly Agent[] {
  if (selected.length === 0) {
    return AGENTS;
  }

  const requested = new Set<Agent>();
  for (const value of selected) {
    if (!isAgent(value)) {
      throw new Error(`unsupported Agent: ${value}`);
    }
    requested.add(value);
  }

  return AGENTS.filter((agent) => requested.has(agent));
}
