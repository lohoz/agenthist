import type { AgentLaunchSpec, AgentResumeRequest } from "../contracts.js";

export function launchPiSession(request: AgentResumeRequest): AgentLaunchSpec {
  return { command: "pi", args: ["--session", request.nativeId], cwd: request.cwd };
}
