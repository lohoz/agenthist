import type { Agent } from "../../contracts.js";
import { AGENT_LABELS, classes } from "../lib/display.js";

const LOGOS: Record<Agent, string> = {
  codex: new URL("../assets/agents/codex.svg", import.meta.url).href,
  claude: new URL("../assets/agents/claude.svg", import.meta.url).href,
  opencode: new URL("../assets/agents/opencode.svg", import.meta.url).href,
  pi: new URL("../assets/agents/pi.svg", import.meta.url).href,
};

export function AgentLogo({ agent, size = 16 }: { readonly agent: Agent; readonly size?: number }) {
  return <img src={LOGOS[agent]} width={size} height={size} className={classes("agent-logo", `agent-logo-${agent}`)}
    alt="" aria-hidden="true" title={AGENT_LABELS[agent]} />;
}
