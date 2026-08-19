import { agentAdapter } from "../agents/registry.js";
import { AGENTS, type Agent } from "../domain/agent.js";
import type { ArchiveEntry } from "../domain/archive.js";

function selectEntries(
  available: readonly ArchiveEntry[],
  requested: readonly string[],
): readonly ArchiveEntry[] {
  if (requested.length === 0) return available;
  const references = new Set(requested);
  const matches = available.filter((entry) => references.has(entry.sessionRef));
  if (matches.length !== references.size) {
    const found = new Set(matches.map((entry) => entry.sessionRef));
    const missing = [...references].find((reference) => !found.has(reference));
    throw new Error(`selected history session was not found: ${missing ?? "unknown"}`);
  }
  return matches;
}

export function selectImportEntries(
  entries: readonly ArchiveEntry[],
  agents: readonly Agent[] | undefined,
  sessions: readonly string[],
): readonly ArchiveEntry[] {
  const available = agents === undefined
    ? entries
    : entries.filter((entry) => agents.includes(entry.agent));
  if (available.length === 0) throw new Error("archive has no history for the selected Agent");
  const selected = selectEntries(available, sessions);
  let selectedRefs: ReadonlySet<string> = new Set(selected.map((entry) => entry.sessionRef));
  for (const agent of AGENTS) {
    selectedRefs = agentAdapter(agent).archive.closeSelection(available, selectedRefs);
  }
  return entries
    .filter((entry) => selectedRefs.has(entry.sessionRef))
    .toSorted((left, right) => {
      const agentOrder = AGENTS.indexOf(left.agent) - AGENTS.indexOf(right.agent);
      return agentOrder === 0 ? left.sessionRef.localeCompare(right.sessionRef) : agentOrder;
    });
}
