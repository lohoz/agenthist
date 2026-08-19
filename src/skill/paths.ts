import { AGENTS, type Agent } from "../domain/agent.js";
import { pathImplementation } from "../domain/host-path.js";
import { runtimePathContext, type RuntimePathOptions } from "../infrastructure/runtime-paths.js";

export interface SkillInstallLocation {
  readonly agents: readonly Agent[];
  readonly directory: string;
  readonly shared: boolean;
}

export interface ResolveSkillInstallLocationsOptions extends RuntimePathOptions {
  readonly agents?: readonly Agent[];
}

function environmentPath(
  value: string | undefined,
  fallback: string,
  cwd: string,
  implementation: typeof import("node:path").posix,
): string {
  const selected = value?.trim() === "" || value === undefined ? fallback : value;
  return implementation.resolve(cwd, selected);
}

export function resolveSkillInstallLocations(
  options: ResolveSkillInstallLocationsOptions = {},
): readonly SkillInstallLocation[] {
  const context = runtimePathContext(options);
  const implementation = pathImplementation(context.flavor);
  const requested = new Set(options.agents ?? AGENTS);
  const locations: SkillInstallLocation[] = [];

  if (requested.has("codex")) {
    const codexHome = environmentPath(
      context.environment.CODEX_HOME,
      implementation.join(context.home, ".codex"),
      context.cwd,
      implementation,
    );
    locations.push({
      agents: ["codex"],
      directory: implementation.join(codexHome, "skills", "agenthist"),
      shared: false,
    });
  }

  const defaultClaudeRoot = implementation.join(context.home, ".claude");
  const claudeRoot = environmentPath(
    context.environment.CLAUDE_CONFIG_DIR,
    defaultClaudeRoot,
    context.cwd,
    implementation,
  );
  const configuredClaudeRoot = context.environment.CLAUDE_CONFIG_DIR?.trim();
  const claudeUsesDefaultRoot = configuredClaudeRoot === undefined || configuredClaudeRoot === "";
  const shareClaudeSkill = requested.has("claude") && requested.has("opencode") &&
    claudeUsesDefaultRoot &&
    context.environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS !== "1";

  if (requested.has("claude")) {
    locations.push({
      agents: shareClaudeSkill ? ["claude", "opencode"] : ["claude"],
      directory: implementation.join(claudeRoot, "skills", "agenthist"),
      shared: shareClaudeSkill,
    });
  }

  if (requested.has("opencode") && !shareClaudeSkill) {
    const xdgConfigHome = environmentPath(
      context.environment.XDG_CONFIG_HOME,
      implementation.join(context.home, ".config"),
      context.cwd,
      implementation,
    );
    const opencodeRoot = environmentPath(
      context.environment.OPENCODE_CONFIG_DIR,
      implementation.join(xdgConfigHome, "opencode"),
      context.cwd,
      implementation,
    );
    locations.push({
      agents: ["opencode"],
      directory: implementation.join(opencodeRoot, "skills", "agenthist"),
      shared: false,
    });
  }

  if (requested.has("pi")) {
    const piRoot = environmentPath(
      context.environment.PI_CODING_AGENT_DIR,
      implementation.join(context.home, ".pi", "agent"),
      context.cwd,
      implementation,
    );
    locations.push({
      agents: ["pi"],
      directory: implementation.join(piRoot, "skills", "agenthist"),
      shared: false,
    });
  }

  return locations;
}

export function resolveSkillRemovalLocations(
  options: RuntimePathOptions = {},
): readonly SkillInstallLocation[] {
  const locations: Array<{ agents: Agent[]; directory: string; shared: boolean }> = [];
  const add = (location: SkillInstallLocation): void => {
    const existing = locations.find((candidate) => candidate.directory === location.directory);
    if (existing === undefined) {
      locations.push({ ...location, agents: [...location.agents] });
      return;
    }
    const agents = new Set([...existing.agents, ...location.agents]);
    existing.agents = AGENTS.filter((agent) => agents.has(agent));
    existing.shared = existing.shared || location.shared || existing.agents.length > 1;
  };

  for (const location of resolveSkillInstallLocations({ ...options, agents: AGENTS })) add(location);
  for (const agent of AGENTS) {
    for (const location of resolveSkillInstallLocations({ ...options, agents: [agent] })) add(location);
  }
  return locations;
}
