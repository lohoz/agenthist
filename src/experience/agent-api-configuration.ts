import type { Agent } from "../domain/agent.js";
import { AgentApiConfigurationError, type AgentApiConfiguration } from "../domain/agent-api.js";
import { canonicalDigest } from "../domain/history-identity.js";
import { readCodexApiConfiguration } from "../agents/codex/api-configuration.js";
import { readClaudeApiConfiguration } from "../agents/claude/api-configuration.js";
import { readOpenCodeApiConfiguration } from "../agents/opencode/api-configuration.js";
import { readPiApiConfiguration } from "../agents/pi/api-configuration.js";
import type { AgentApiReadOptions } from "../agents/api-config-support.js";
import { AnalysisFailure, type AnalysisConfiguration, type OpenAIAnalysisProfile } from "./model.js";

export function agentApiAnalysisConfiguration(config: AgentApiConfiguration): AnalysisConfiguration {
  let url: URL;
  try { url = new URL(config.baseUrl); }
  catch { throw new AgentApiConfigurationError("endpoint", "Agent API 地址无效。"); }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.hash) throw new AgentApiConfigurationError("endpoint", "Agent API 地址无效。");
  const suffix = config.protocol === "openai-responses" ? "responses" : config.protocol === "anthropic-messages" ? "messages" : "chat/completions";
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (!pathname.endsWith(`/${suffix}`)) {
    if (/\/(responses|messages|chat\/completions)$/u.test(pathname)) throw new AgentApiConfigurationError("endpoint", "Agent API 地址与配置协议不一致。");
    url.pathname = `${pathname}${config.protocol === "anthropic-messages" && !pathname.endsWith("/v1") ? "/v1" : ""}/${suffix}`;
  } else url.pathname = pathname;
  const requestUrl = url.toString();
  const endpointFingerprint = `ahepf1_${canonicalDigest({ protocol: config.protocol, requestUrl })}`;
  const fast: OpenAIAnalysisProfile = {
    ...(config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }),
    tier: "fast", backend: config.protocol, baseUrl: config.baseUrl, requestUrl, endpoint: requestUrl,
    endpointFingerprint, model: config.model, modelConfigured: true, apiKey: "", keySource: config.source,
    headers: config.headers, streaming: true,
    profileFingerprint: `ahprofile1_${canonicalDigest({ protocol: config.protocol, requestUrl, model: config.model, headers: config.headers })}`,
  };
  return { fast, deep: { ...fast, tier: "deep" }, deepBinding: "fast" };
}

export async function resolveAgentApiAnalysisConfiguration(agent: Agent, options: AgentApiReadOptions): Promise<AnalysisConfiguration> {
  try {
    const readers = { codex: readCodexApiConfiguration, claude: readClaudeApiConfiguration, opencode: readOpenCodeApiConfiguration, pi: readPiApiConfiguration };
    return agentApiAnalysisConfiguration(await readers[agent](options));
  } catch (error) {
    if (!(error instanceof AgentApiConfigurationError)) throw error;
    throw new AnalysisFailure(error.message, { reason: error.field === "format" ? "configuration_invalid" : "configuration_missing", stage: "configuration", retryable: false, validation: error.field });
  }
}
