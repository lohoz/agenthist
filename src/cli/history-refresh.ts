import {
  detectHistorySources,
  scanHistory,
  type Agent,
} from "../application/index.js";
import type { CliRuntime, GlobalOptions } from "./command-support.js";
import { historySourceOptions } from "./source-options.js";

export async function refreshDetectedHistory(
  globals: GlobalOptions,
  runtime: CliRuntime,
  requestedAgents?: readonly Agent[],
): Promise<void> {
  const sources = historySourceOptions(globals, runtime, requestedAgents);
  if (requestedAgents === undefined) {
    await scanHistory({ ...sources, stateDirectory: globals.stateDirectory });
    return;
  }
  const detected = await detectHistorySources(sources);
  const agents = detected.agents
    .filter((item) => item.status === "ready")
    .map((item) => item.agent);
  if (agents.length === 0) return;
  await scanHistory({ ...sources, agents, stateDirectory: globals.stateDirectory });
}
