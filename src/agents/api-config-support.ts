import { AgentApiConfigurationError } from "../domain/agent-api.js";
import { readStableSmallFile } from "../infrastructure/files.js";

export interface AgentApiReadOptions {
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly root?: string;
  readonly profile?: string;
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function contextWindow(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AgentApiConfigurationError("format", "Agent 配置的模型上下文容量无效。");
  }
  return value;
}

export async function configText(file: string): Promise<string | undefined> {
  try { return (await readStableSmallFile(file, 1024 * 1024)).toString("utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new AgentApiConfigurationError("format", "无法读取 Agent 配置文件。");
  }
}

export async function configJson(file: string, jsonc = false): Promise<Record<string, unknown>> {
  const text = await configText(file);
  if (text === undefined) return {};
  try {
    const content = jsonc ? text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|,\s*(?=[}\]])/gu,
      (match) => match.startsWith('"') ? match : " ") : text;
    return object(JSON.parse(content));
  }
  catch { throw new AgentApiConfigurationError("format", "Agent 配置文件不是有效的 JSON。"); }
}

export function required(value: unknown, field: "model" | "endpoint" | "credentials"): string {
  const result = string(value);
  if (result === undefined || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new AgentApiConfigurationError(field, field === "model" ? "Agent 尚未设置可直接调用的完整模型名称。"
      : field === "endpoint" ? "Agent 尚未设置 API 地址。" : "没有找到可直接调用 API 的凭据，请检查 Agent 的 API 配置。");
  }
  return result;
}

export function apiHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(object(value))) {
    const text = string(raw);
    if (text === undefined || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/iu.test(name) || /[\r\n]/u.test(text) || /^(host|content-length|connection)$/iu.test(name)) {
      throw new AgentApiConfigurationError("format", "Agent 自定义 API 请求头无效。");
    }
    headers[name.toLowerCase()] = text;
  }
  return headers;
}

export async function configValue(value: unknown, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const raw = string(value);
  if (raw === undefined) return undefined;
  const env = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(raw);
  if (env !== null) return string(environment[env[1]!]);
  // Configured command credentials are intentionally left for their owning Agent.
  if (raw.startsWith("!")) throw new AgentApiConfigurationError("credentials", "此 Agent 使用命令生成凭据，尚不能直接读取 API 密钥。");
  if (raw.startsWith("{file:")) throw new AgentApiConfigurationError("credentials", "此 Agent 使用文件引用凭据，尚不能直接解析该 API 密钥。");
  return raw;
}
