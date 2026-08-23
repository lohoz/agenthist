import spawn from "cross-spawn";

import type { AgentLaunchSpec } from "../agents/contracts.js";

export interface AgentProcessResult {
  readonly exitCode: number;
  readonly signal?: NodeJS.Signals;
}

export type AgentProcessRunner = (
  spec: AgentLaunchSpec,
  environment?: NodeJS.ProcessEnv,
) => Promise<AgentProcessResult>;

export const runAgentProcess: AgentProcessRunner = async (spec, environment) => {
  return await new Promise<AgentProcessResult>((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: environment ?? process.env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      reject(code === "ENOENT"
        ? new Error(`${spec.command} is not installed or is not available on PATH`)
        : error);
    });
    child.once("exit", (code, signal) => {
      resolve({
        exitCode: code ?? (signal === null ? 1 : 128),
        ...(signal === null ? {} : { signal }),
      });
    });
  });
};
