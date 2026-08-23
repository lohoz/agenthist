import type { AgentLaunchSpec, AgentResumeRequest } from "../contracts.js";

export function launchClaudeSession(request: AgentResumeRequest): AgentLaunchSpec {
  return { command: "claude", args: ["--resume", request.nativeId], cwd: request.cwd };
}
