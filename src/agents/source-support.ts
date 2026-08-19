import type { Agent } from "../domain/agent.js";
import type {
  HistorySourceInspection,
  HistorySourceLocation,
} from "./contracts.js";

function boundedMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : "history source inspection failed";
  return Buffer.byteLength(value, "utf8") <= 4096 ? value : `${value.slice(0, 4093)}...`;
}

export function failedSourceInspection(
  agent: Agent,
  locations: readonly HistorySourceLocation[],
  status: "blocked" | "error",
  error: unknown,
): HistorySourceInspection {
  return {
    agent,
    status,
    locations,
    findings: [status === "blocked" ? "history.doctor.blocked" : "history.doctor.inspect_failed"],
    detail: boundedMessage(error),
  };
}
