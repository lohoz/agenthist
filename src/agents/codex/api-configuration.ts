import path from "node:path";
import { parse } from "smol-toml";
import { AgentApiConfigurationError, type AgentApiConfiguration } from "../../domain/agent-api.js";
import { apiHeaders, configJson, configText, contextWindow, object, required, string, type AgentApiReadOptions } from "../api-config-support.js";

export async function readCodexApiConfiguration(options: AgentApiReadOptions): Promise<AgentApiConfiguration> {
  const root = options.root ?? options.environment.CODEX_HOME ?? path.join(options.home, ".codex");
  const source = path.join(root, "config.toml");
  let config: Record<string, unknown>;
  try { config = object(parse(await configText(source) ?? "")); }
  catch { throw new AgentApiConfigurationError("format", "Codex config.toml 格式无效。"); }
  const profile = object(object(config.profiles)[options.profile ?? string(config.profile) ?? ""]);
  const effective = { ...config, ...profile };
  const providerId = string(effective.model_provider) ?? "openai";
  const provider = object(object(config.model_providers)[providerId]);
  const wire = string(provider.wire_api) ?? "responses";
  if (wire !== "responses" && wire !== "chat") throw new AgentApiConfigurationError("format", "Codex API 协议不受支持。");
  const auth = await configJson(path.join(root, "auth.json"));
  const envKey = string(provider.env_key);
  const key = envKey === undefined ? string(provider.experimental_bearer_token) ?? string(auth.OPENAI_API_KEY) ?? options.environment.OPENAI_API_KEY : options.environment[envKey];
  const headers = apiHeaders(provider.http_headers);
  for (const [name, variable] of Object.entries(object(provider.env_http_headers))) {
    Object.assign(headers, apiHeaders({ [name]: required(options.environment[required(variable, "credentials")], "credentials") }));
  }
  headers.authorization ??= `Bearer ${required(key, "credentials")}`;
  const capacity = contextWindow(effective.model_context_window);
  return {
    ...(capacity === undefined ? {} : { contextWindow: capacity }),
    protocol: wire === "responses" ? "openai-responses" : "openai-compatible-chat",
    baseUrl: required(provider.base_url ?? (providerId === "openai" ? "https://api.openai.com/v1" : undefined), "endpoint"),
    model: required(effective.model, "model"), headers, source,
  };
}
