import { agentAdapter } from "../agents/registry.js";
import { AGENTS, isAgent } from "../domain/agent.js";
import type { ArchiveManifest } from "../domain/archive.js";
import { normalizeAbsolutePath } from "../domain/host-path.js";
import { validateArchiveManagedResources } from "../infrastructure/managed-resources.js";

export function validateArchiveSemantics(
  manifest: ArchiveManifest,
  extracted?: ReadonlyMap<string, string>,
): void {
  const objects = new Map(manifest.objects.map((object) => [object.id, object]));
  const objectIds = new Set(objects.keys());
  const sessions = new Set<string>();
  for (const entry of manifest.entries) {
    if (sessions.has(entry.sessionRef)) {
      throw new Error(`archive contains a duplicate session: ${entry.sessionRef}`);
    }
    sessions.add(entry.sessionRef);
    if (!isAgent(entry.agent)) {
      throw new Error(`archive contains an unsupported Agent: ${String(entry.agent)}`);
    }
    normalizeAbsolutePath(entry.context, manifest.pathFlavor, `${entry.agent} archive workspace`);
  }
  for (const agent of AGENTS) {
    agentAdapter(agent).archive.validateEntries(
      manifest.entries.filter((entry) => entry.agent === agent),
      objects,
      extracted,
    );
  }
  validateArchiveManagedResources(manifest.entries, objects);
  const nativeObjects = new Set(manifest.entries.flatMap((entry) => entry.objects.map((binding) => binding.id)));
  const resourceObjects = new Set(manifest.entries.flatMap((entry) => entry.resources.map((resource) => resource.id)));
  if ([...nativeObjects].some((id) => resourceObjects.has(id))) {
    throw new Error("archive object cannot be both native history and a managed resource");
  }
  const referenced = new Set(manifest.entries.flatMap((entry) => [
    ...entry.objects.map((binding) => binding.id),
    ...entry.resources.map((resource) => resource.id),
  ]));
  if (referenced.size !== objectIds.size || [...objectIds].some((id) => !referenced.has(id))) {
    throw new Error("archive contains an unreferenced object");
  }
}

export async function validateArchiveObjects(
  manifest: ArchiveManifest,
  extracted: ReadonlyMap<string, string>,
): Promise<void> {
  for (const agent of AGENTS) {
    await agentAdapter(agent).archive.validateObjects(
      manifest.entries.filter((entry) => entry.agent === agent),
      extracted,
    );
  }
}
