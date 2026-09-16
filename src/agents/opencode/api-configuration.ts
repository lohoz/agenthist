import path from "node:path";
import { AgentApiConfigurationError, type AgentApiConfiguration } from "../../domain/agent-api.js";
import { apiHeaders, configJson, configValue, contextWindow, object, required, string, type AgentApiReadOptions } from "../api-config-support.js";

export async function readOpenCodeApiConfiguration(options: AgentApiReadOptions): Promise<AgentApiConfiguration> {
  const environment = options.environment;
  const root = options.root ?? environment.OPENCODE_CONFIG_DIR ?? path.join(environment.XDG_CONFIG_HOME ?? path.join(options.home, ".config"), "opencode");
  const files = [path.join(root, "opencode.json"), path.join(root, "opencode.jsonc"), ...(environment.OPENCODE_CONFIG ? [environment.OPENCODE_CONFIG] : [])];
  let config: Record<string, unknown> = {};
  for (const file of files) {
    const next = await configJson(file, true);
    config = { ...config, ...next, provider: { ...object(config.provider), ...object(next.provider) } };
  }
  const selected = required(config.model, "model");
  const slash = selected.indexOf("/");
  if (slash < 1) throw new AgentApiConfigurationError("model", "OpenCode 模型必须包含 provider/model。");
  const providerId = selected.slice(0, slash);
  const provider = object(object(config.provider)[providerId]);
  const transport = string(provider.npm) ?? (providerId === "anthropic" ? "@ai-sdk/anthropic" : providerId === "openai" ? "@ai-sdk/openai" : undefined);
  const protocol = transport === "@ai-sdk/anthropic" ? "anthropic-messages" : transport === "@ai-sdk/openai" ? "openai-responses"
    : transport === "@ai-sdk/openai-compatible" ? "openai-compatible-chat" : undefined;
  if (protocol === undefined) throw new AgentApiConfigurationError("format", "当前 OpenCode 提供商尚未配置受支持的直接 API 协议。");
  const settings = object(provider.options);
  const model = selected.slice(slash + 1);
  const modelSettings = object(object(provider.models)[model]);
  const auth = object((await configJson(path.join(environment.XDG_DATA_HOME ?? path.join(options.home, ".local", "share"), "opencode", "auth.json")))[providerId]);
  const key = await configValue(settings.apiKey, environment) ?? (auth.type === "api" ? string(auth.key) : undefined)
    ?? (providerId === "anthropic" ? environment.ANTHROPIC_API_KEY : providerId === "openai" ? environment.OPENAI_API_KEY : undefined);
  const headers = apiHeaders(settings.headers);
  if (protocol === "anthropic-messages") {
    headers["x-api-key"] ??= required(key, "credentials");
    headers["anthropic-version"] ??= "2023-06-01";
  } else headers.authorization ??= `Bearer ${required(key, "credentials")}`;
  const capacity = contextWindow(object(modelSettings.limit).context);
  return { protocol, source: files.at(-1)!, model: string(modelSettings.id) ?? model,
    ...(capacity === undefined ? {} : { contextWindow: capacity }),
    baseUrl: required(await configValue(settings.baseURL, environment) ?? (providerId === "anthropic" ? "https://api.anthropic.com" : providerId === "openai" ? "https://api.openai.com/v1" : undefined), "endpoint"), headers };
}
