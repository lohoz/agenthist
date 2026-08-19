import { installAgentHistSkill, uninstallAgentHistSkill } from "../skill/install.js";
import { AGENTS, agentLabel, type Agent } from "../domain/agent.js";
import {
  colorizeHuman,
  invalidArguments,
  parseAgent,
  readValue,
  success,
  type CliResult,
  type CliRuntime,
  type GlobalOptions,
} from "./command-support.js";

interface SkillTargetResult {
  readonly agents: readonly Agent[];
  readonly directory: string;
  readonly shared: boolean;
  readonly status: string;
}

function renderTargets(items: readonly SkillTargetResult[], color: boolean): string {
  return items.map((item) => {
    const agentsLabel = item.agents.map((agent) => colorizeHuman(agentLabel(agent), "info", color)).join(" + ");
    const shared = item.shared ? colorizeHuman(" (shared)", "muted", color) : "";
    const tone = item.status === "installed" || item.status === "removed"
      ? "success"
      : item.status === "preserved" ? "warning" : "muted";
    return `  ${colorizeHuman(item.status.padEnd(10), tone, color)} ${agentsLabel}${shared}\n` +
      `             ${colorizeHuman(item.directory, "muted", color)}\n`;
  }).join("");
}

export async function runSkill(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  if (args[0] !== "install" && args[0] !== "uninstall") {
    throw invalidArguments("skill requires the subcommand: install or uninstall");
  }
  const runtimePaths = {
    environment: runtime.environment ?? process.env,
    cwd: runtime.cwd ?? process.cwd(),
    ...(runtime.home === undefined ? {} : { home: runtime.home }),
  };

  if (args[0] === "uninstall") {
    if (args.length !== 1) throw invalidArguments(`unknown skill uninstall flag: ${args[1]}`);
    const result = await uninstallAgentHistSkill(runtimePaths);
    return success("skill", {
      operation: "uninstall",
      targets: result.items,
    }, `${colorizeHuman("AgentHist Skill", "section", globals.color)}\n\n` +
      renderTargets(result.items, globals.color), globals.json);
  }

  const agents = new Set<Agent>();
  let force = false;
  for (let index = 1; index < args.length;) {
    const argument = args[index]!;
    if (argument === "--agent" || argument.startsWith("--agent=")) {
      const [value, next] = readValue(args, index, "--agent");
      agents.add(parseAgent(value));
      index = next;
      continue;
    }
    if (argument === "--force") {
      if (force) throw invalidArguments("skill install accepts --force once");
      force = true;
      index++;
      continue;
    }
    throw invalidArguments(`unknown skill install flag: ${argument}`);
  }

  const selectedAgents = agents.size === 0 ? AGENTS : AGENTS.filter((agent) => agents.has(agent));
  const result = await installAgentHistSkill({
    agents: selectedAgents,
    force,
    ...runtimePaths,
  });
  return success("skill", {
    operation: "install",
    targets: result.items,
  }, `${colorizeHuman("AgentHist Skill", "section", globals.color)}\n\n` +
    renderTargets(result.items, globals.color), globals.json);
}
