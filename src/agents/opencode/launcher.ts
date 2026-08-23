import type { AgentLaunchSpec, AgentResumeRequest } from "../contracts.js";

export function launchOpenCodeSession(request: AgentResumeRequest): AgentLaunchSpec {
  return { command: "opencode", args: ["--session", request.nativeId], cwd: request.cwd };
}
