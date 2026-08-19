import type { Agent } from "../domain/agent.js";
import { claudeAdapter } from "./claude/adapter.js";
import { codexAdapter } from "./codex/adapter.js";
import type { AgentAdapter } from "./contracts.js";
import { openCodeAdapter } from "./opencode/adapter.js";
import { piAdapter } from "./pi/adapter.js";

export const AGENT_REGISTRY = {
  codex: codexAdapter,
  claude: claudeAdapter,
  opencode: openCodeAdapter,
  pi: piAdapter,
} as const satisfies { readonly [A in Agent]: AgentAdapter<A> };

export function agentAdapter(agent: Agent): AgentAdapter {
  return AGENT_REGISTRY[agent];
}
