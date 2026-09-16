import path from "node:path";
import { AgentApiConfigurationError, type AgentApiConfiguration } from "../../domain/agent-api.js";
import { apiHeaders, configJson, configValue, contextWindow, object, required, string, type AgentApiReadOptions } from "../api-config-support.js";

export async function readPiApiConfiguration(options: AgentApiReadOptions): Promise<AgentApiConfiguration> {
  const root = options.root ?? options.environment.PI_CODING_AGENT_DIR ?? path.join(options.home, ".pi", "agent");
  const source = path.join(root, "settings.json");
  const settings = await configJson(source);
  const providerId = required(settings.defaultProvider, "model");
  const model = required(settings.defaultModel, "model");
  const provider = object(object((await configJson(path.join(root, "models.json"))).providers)[providerId]);
  const modelSettings = object(Array.isArray(provider.models) ? provider.models.find((entry) => object(entry).id === model) : undefined);
  const api = string(modelSettings.api) ?? string(provider.api) ?? (providerId === "anthropic" ? "anthropic-messages" : providerId === "openai" ? "openai-responses" : undefined);
  const protocol = api === "openai-completions" ? "openai-compatible-chat" : api === "anthropic-messages" || api === "openai-responses" ? api : undefined;
  if (protocol === undefined) throw new AgentApiConfigurationError("format", "当前 Pi 提供商尚未配置受支持的直接 API 协议。");
  const auth = object((await configJson(path.join(root, "auth.json")))[providerId]);
  const configuredKey = await configValue(provider.apiKey, options.environment);
  const key = configuredKey === undefined ? (auth.type === "api_key" ? string(auth.key) : undefined)
    ?? (providerId === "anthropic" ? options.environment.ANTHROPIC_API_KEY : providerId === "openai" ? options.environment.OPENAI_API_KEY : undefined)
    : options.environment[configuredKey] ?? configuredKey;
  const headers = apiHeaders({ ...object(provider.headers), ...object(modelSettings.headers) });
  if (protocol === "anthropic-messages") {
    headers["x-api-key"] ??= required(key, "credentials");
    headers["anthropic-version"] ??= "2023-06-01";
  } else if (provider.authHeader !== false) headers.authorization ??= `Bearer ${required(key, "credentials")}`;
  const capacity = contextWindow(modelSettings.contextWindow ?? provider.contextWindow);
  return { protocol, model, headers, source,
    ...(capacity === undefined ? {} : { contextWindow: capacity }),
    baseUrl: required(modelSettings.baseUrl ?? provider.baseUrl ?? (providerId === "anthropic" ? "https://api.anthropic.com" : providerId === "openai" ? "https://api.openai.com/v1" : undefined), "endpoint") };
}
