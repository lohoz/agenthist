import { CheckCircle2, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Agent, AgentHistDesktopApi, ExperienceConfigurationCheckDto, ExperienceConfigurationDto } from "../../contracts.js";

export function ExperienceApiCheck({ api, selectedAgent, disabled = false, onBusyChange }: {
  readonly api: AgentHistDesktopApi;
  readonly selectedAgent: Agent | undefined;
  readonly disabled?: boolean;
  readonly onBusyChange?: (busy: boolean) => void;
}) {
  const [configuration, setConfiguration] = useState<ExperienceConfigurationDto>();
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<ExperienceConfigurationCheckDto>();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  useEffect(() => { onBusyChange?.(checking); }, [checking, onBusyChange]);
  const inspect = async (current: number): Promise<void> => {
    try {
      const result = await api.inspectExperienceConfig();
      if (current !== generation.current) return;
      if (result.ok) setConfiguration(result.value);
      else setError(result.error.message);
    } catch { if (current === generation.current) setError("无法读取 Agent 的 API 配置，请重试。"); }
  };
  useEffect(() => {
    const current = ++generation.current;
    setConfiguration(undefined);
    setCheck(undefined);
    setError(undefined);
    setChecking(false);
    void inspect(current);
    return () => { generation.current++; };
  }, [api, selectedAgent]);
  const checkApi = async (): Promise<void> => {
    if (checking || disabled) return;
    const current = ++generation.current;
    setChecking(true);
    setCheck(undefined);
    setError(undefined);
    try {
      await inspect(current);
      const result = await api.checkExperienceConfig();
      if (current !== generation.current) return;
      if (result.ok) setCheck(result.value);
      else setError(result.error.message);
    } catch { if (current === generation.current) setError("无法检查模型，请确认所选 Agent 的 API 配置和网络后重试。"); }
    finally { if (current === generation.current) setChecking(false); }
  };
  const model = configuration?.status === "configured" ? configuration.fast : undefined;
  return <div className="experience-api-check" aria-label="模型 API 检测">
    {model === undefined ? configuration === undefined ? <p>正在读取当前 API 配置…</p>
      : <p className="experience-config-state is-error">未找到完整的 API 地址、模型和密钥。请检查所选 Agent 的现有配置。</p>
      : <dl className="experience-api-summary">
        <div><dt>模型</dt><dd>{model.model}</dd></div>
        <div><dt>协议</dt><dd>{model.backend === "openai-responses" ? "Responses" : model.backend === "anthropic-messages" ? "Messages" : model.backend === "openai-compatible-chat" ? "Chat Completions" : "Agent CLI"}</dd></div>
        <div><dt>地址</dt><dd>{model.endpoint.label}</dd></div>
        {model.contextWindow === undefined ? null : <div><dt>配置上下文</dt><dd>{new Intl.NumberFormat("zh-CN").format(model.contextWindow)} tokens</dd></div>}
      </dl>}
    <div className="experience-config-actions"><div>
      <button className="secondary-button" type="button" disabled={checking || disabled} onClick={() => void checkApi()}>
        {checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{checking ? "正在检查…" : "检查模型"}
      </button><span>直接请求当前 API 验证模型；检测限时 30 秒，不发送对话历史。</span>
    </div></div>
    {error === undefined ? null : <div className="experience-config-state is-error" role="alert"><TriangleAlert size={14} />{error}</div>}
    {check === undefined ? null : <div className={`experience-check-result${check.status === "checked" ? "" : " is-error"}`} role={check.status === "checked" ? "status" : "alert"}>
      {check.status === "checked" ? <CheckCircle2 size={15} /> : <TriangleAlert size={15} />}
      <div><strong>{check.status === "checked" ? "模型可用" : "模型检查未完成"}</strong>
        <span>{check.status === "checked" ? `已完成 ${check.requests} 个实际模型请求，未发送历史内容。` : checkFailure(check.error.code)}
          {check.status !== "checked" && check.error.status !== undefined ? `（HTTP ${check.error.status}）` : ""}
          {check.durationMs === undefined ? "" : ` 耗时 ${(check.durationMs / 1000).toFixed(2)} 秒。`}</span>
      </div>
    </div>}
  </div>;
}

function checkFailure(code: string): string {
  if (code === "content_rejected") return "服务商按内容策略拒绝了请求，不能将此结果视为模型检测成功。";
  if (code === "authentication_failed") return "API 认证失败，请检查所选 Agent 的密钥。";
  if (code === "timeout") return "API 在 30 秒内未完成响应，请检查服务商状态。";
  if (code === "upstream_failed") return "服务商暂时不可用，请检查该模型是否有可用渠道。";
  if (code === "endpoint_or_model_not_found" || code === "model_not_found") return "配置的 API 路径或模型不存在。";
  if (code === "rate_limited") return "API 请求受到速率限制，请稍后重试。";
  if (code === "dns_failed" || code === "connection_failed" || code === "tls_failed") return "API 网络连接失败，请检查地址、网络或证书。";
  if (code === "protocol_mismatch" || code === "invalid_model_output") return "接口没有返回完整、有效的模型结果，请检查协议兼容性。";
  return "请检查所选 Agent 的 API 地址、模型和认证配置。";
}
