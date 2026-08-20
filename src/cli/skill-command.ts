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
  type HumanTone,
} from "./command-support.js";
import { humanFields, humanSection, humanTitle } from "./human-output.js";
import { displayWidth, padDisplay } from "./terminal-layout.js";

interface SkillTargetResult {
  readonly agents: readonly Agent[];
  readonly directory: string;
  readonly shared: boolean;
  readonly status: string;
}

function renderTargets(items: readonly SkillTargetResult[], color: boolean): string {
  const rows = items.map((item) => {
    const agentsLabel = item.agents.map(agentLabel).join(" + ");
    const shared = item.shared ? " (shared)" : "";
    const tone: HumanTone = item.status === "installed" || item.status === "updated" || item.status === "replaced" ||
      item.status === "removed"
      ? "success"
      : item.status === "preserved" ? "warning" : "muted";
    return { item, label: agentsLabel + shared, tone };
  });
  const width = Math.max(0, ...rows.map((row) => displayWidth(row.label)));
  return rows.map(({ item, label, tone }) =>
    `  ${colorizeHuman(padDisplay(label, width), "strong", color)}  ` +
      `${colorizeHuman(item.status.toUpperCase(), tone, color)}\n` +
      `    ${colorizeHuman(item.directory, "muted", color)}\n`
  ).join("\n");
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
    }, humanTitle("AgentHist Skill removed", globals.color) + "\n" + humanFields([
      { label: "Targets", value: String(result.items.length) },
    ], globals.color) + "\n" + humanSection("Locations", globals.color) +
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
  }, humanTitle("AgentHist Skill installed", globals.color) + "\n" + humanFields([
    { label: "Targets", value: String(result.items.length) },
  ], globals.color) + "\n" + humanSection("Locations", globals.color) +
    renderTargets(result.items, globals.color), globals.json);
}
