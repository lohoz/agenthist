import path from "node:path";
import type { AgentApiConfiguration } from "../../domain/agent-api.js";
import { configJson, object, required, string, type AgentApiReadOptions } from "../api-config-support.js";

export async function readClaudeApiConfiguration(options: AgentApiReadOptions): Promise<AgentApiConfiguration> {
  const root = options.root ?? options.environment.CLAUDE_CONFIG_DIR ?? path.join(options.home, ".claude");
  const source = path.join(root, "settings.json");
  const config = await configJson(source);
  const environment = { ...object(config.env), ...options.environment };
  let model = string(environment.ANTHROPIC_MODEL) ?? string(config.model);
  if (model !== undefined && /^(opus|sonnet|haiku)(\[1m\])?$/u.test(model)) {
    model = string(environment[`ANTHROPIC_DEFAULT_${model.split("[")[0]!.toUpperCase()}_MODEL`]);
  }
  const token = string(environment.ANTHROPIC_AUTH_TOKEN);
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (token !== undefined) headers.authorization = `Bearer ${required(token, "credentials")}`;
  else headers["x-api-key"] = required(environment.ANTHROPIC_API_KEY, "credentials");
  return { protocol: "anthropic-messages", baseUrl: string(environment.ANTHROPIC_BASE_URL) ?? "https://api.anthropic.com",
    model: required(model, "model"), headers, source };
}
