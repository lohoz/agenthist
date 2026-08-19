import type { Agent } from "../../src/domain/agent.js";

export interface ScanAgentMetrics {
  readonly agent: Agent;
  readonly sessions: number;
  readonly reusedSessions: number;
  readonly rebuiltSessions: number;
  readonly removedSessions: number;
}

export interface ScanResult {
  readonly sessions: number;
  readonly warnings: readonly string[];
  readonly agent: ScanAgentMetrics;
}

export function readScanResult(stdout: string, expectedAgent: Agent): ScanResult {
  const parsed = JSON.parse(stdout) as {
    data?: {
      sessions?: unknown;
      warnings?: unknown;
      agents?: Array<{
        agent?: unknown;
        sessions?: unknown;
        reused_sessions?: unknown;
        rebuilt_sessions?: unknown;
        removed_sessions?: unknown;
      }>;
    };
  };
  const data = parsed.data;
  const agent = data?.agents?.find((item) => item.agent === expectedAgent);
  if (
    typeof data?.sessions !== "number" || !Array.isArray(data.warnings) ||
    data.warnings.some((warning) => typeof warning !== "string") || agent === undefined ||
    typeof agent.sessions !== "number" || typeof agent.reused_sessions !== "number" ||
    typeof agent.rebuilt_sessions !== "number" || typeof agent.removed_sessions !== "number"
  ) throw new Error(`scan result for ${expectedAgent} is invalid`);
  return {
    sessions: data.sessions,
    warnings: data.warnings as string[],
    agent: {
      agent: expectedAgent,
      sessions: agent.sessions,
      reusedSessions: agent.reused_sessions,
      rebuiltSessions: agent.rebuilt_sessions,
      removedSessions: agent.removed_sessions,
    },
  };
}
