import type { CodexProviderHistoryUnifyResult } from "../application/provider-history.js";
import type { CodexProviderPlanDto } from "./contracts.js";

export function codexProviderPlanDto(result: CodexProviderHistoryUnifyResult): CodexProviderPlanDto {
  const sources = new Map<string, number>();
  for (const change of result.changes) sources.set(change.before, (sources.get(change.before) ?? 0) + 1);
  return { planRef: result.planRef, targetProvider: result.targetProvider, changed: result.changed, unchanged: result.unchanged,
    sources: [...sources].map(([provider, sessions]) => ({ provider, sessions })).sort((left, right) => left.provider.localeCompare(right.provider)),
  };
}
