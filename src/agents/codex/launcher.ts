import type { AgentLaunchSpec, AgentResumeRequest } from "../contracts.js";

export function launchCodexSession(request: AgentResumeRequest): AgentLaunchSpec {
  return { command: "codex", args: ["resume", request.nativeId], cwd: request.cwd };
}
