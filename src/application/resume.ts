import { agentAdapter } from "../agents/registry.js";
import type { AgentLaunchSpec } from "../agents/contracts.js";
import type { Agent } from "../domain/agent.js";

export interface ResumeLaunchOptions {
  readonly agent: Agent;
  readonly nativeId: string;
  readonly cwd: string;
}

export function prepareResumeLaunch(options: ResumeLaunchOptions): AgentLaunchSpec {
  return agentAdapter(options.agent).resume.launch({
    nativeId: options.nativeId,
    cwd: options.cwd,
  });
}
