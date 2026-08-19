import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { canonicalDigest } from "../domain/history-identity.js";
import { readStableSmallFile } from "../infrastructure/files.js";
import {
  CliModelFailure,
  detectCliAnalysisBackend,
  requestCliAnalysis,
  type AnalysisProcessRunner,
} from "./cli-model-runner.js";

const CONFIG_FILE_LIMIT = 1024 * 1024;
const RESPONSE_BYTE_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;

const VARIABLES = [
  "AGENTHIST_EXPERIENCE_BACKEND",
  "AGENTHIST_EXPERIENCE_BASE_URL",
  "AGENTHIST_EXPERIENCE_API_KEY",
  "AGENTHIST_EXPERIENCE_FAST_MODEL",
  "AGENTHIST_EXPERIENCE_DEEP_MODEL",
  "AGENTHIST_EXPERIENCE_DEEP_BASE_URL",
  "AGENTHIST_EXPERIENCE_DEEP_API_KEY",
] as const;

const REQUIRED_API_VARIABLES = [
  "AGENTHIST_EXPERIENCE_BASE_URL",
  "AGENTHIST_EXPERIENCE_API_KEY",
  "AGENTHIST_EXPERIENCE_FAST_MODEL",
] as const;

type ConfigurationVariable = (typeof VARIABLES)[number];
export type AnalysisTier = "fast" | "deep";
export type AnalysisBackend =
  | "openai-compatible-chat"
  | "codex-cli"
  | "claude-cli"
  | "opencode-cli"
  | "pi-cli";
export type AnalysisFailureReason =
  | "configuration_missing"
  | "configuration_invalid"
  | "command_not_found"
  | "dns_failed"
  | "connection_failed"
  | "tls_failed"
  | "timeout"
  | "authentication_failed"
  | "endpoint_or_model_not_found"
  | "model_not_found"
  | "rate_limited"
  | "upstream_failed"
  | "request_rejected"
  | "context_limit_exceeded"
  | "protocol_mismatch"
  | "invalid_model_output";

export interface AnalysisFailureDetails {
  readonly reason: AnalysisFailureReason;
  readonly stage: string;
  readonly retryable: boolean;
  readonly tier?: AnalysisTier;
  readonly endpoint?: string;
  readonly model?: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly source?: string;
  readonly missing?: readonly string[];
  readonly created?: string;
  readonly validation?: string;
}

export class AnalysisFailure extends Error {
  readonly details: AnalysisFailureDetails;

  constructor(message: string, details: AnalysisFailureDetails) {
    super(message);
    this.name = "AnalysisFailure";
    this.details = details;
  }
}

interface ConfiguredValue {
  readonly value: string;
  readonly source: string;
}

interface BaseAnalysisProfile {
  readonly tier: AnalysisTier;
  readonly backend: AnalysisBackend;
  readonly endpoint: string;
  readonly endpointFingerprint: string;
  readonly model: string;
  readonly modelConfigured: boolean;
  readonly profileFingerprint: string;
}

export interface OpenAIAnalysisProfile extends BaseAnalysisProfile {
  readonly backend: "openai-compatible-chat";
  readonly baseUrl: string;
  readonly requestUrl: string;
  readonly apiKey: string;
  readonly keySource: string;
}

export interface CliAnalysisProfile extends BaseAnalysisProfile {
  readonly backend: "codex-cli" | "claude-cli" | "opencode-cli" | "pi-cli";
  readonly command: "codex" | "claude" | "opencode" | "pi";
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}

export type AnalysisProfile = OpenAIAnalysisProfile | CliAnalysisProfile;

export interface AnalysisConfiguration {
  readonly fast: AnalysisProfile;
  readonly deep: AnalysisProfile;
  readonly deepBinding: "configured" | "fast";
}

export interface ResolveAnalysisConfigurationOptions {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly createTemplate: boolean;
  readonly processRunner?: AnalysisProcessRunner;
}

export interface AnalysisMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface AnalysisUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface AnalysisCompletion {
  readonly content: string;
  readonly usage: AnalysisUsage;
  readonly requestId?: string;
}

export interface AnalysisResponseFormat {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface RequestAnalysisOptions {
  readonly profile: AnalysisProfile;
  readonly stage: string;
  readonly messages: readonly AnalysisMessage[];
  readonly maximumOutputTokens: number;
  readonly responseFormat: AnalysisResponseFormat;
  readonly fetcher?: typeof fetch;
  readonly processRunner?: AnalysisProcessRunner;
}

export type { AnalysisProcessRunner } from "./cli-model-runner.js";

function isVariable(value: string): value is ConfigurationVariable {
  return (VARIABLES as readonly string[]).includes(value);
}

function configurationFailure(message: string, source?: string): AnalysisFailure {
  return new AnalysisFailure(message, {
    reason: "configuration_invalid",
    stage: "configuration",
    retryable: false,
    ...(source === undefined ? {} : { source }),
  });
}

function decodeQuoted(body: string, quote: "'" | "\"", source: string): string {
  if (quote === "'") return body;
  let result = "";
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (character !== "\\") {
      result += character;
      continue;
    }
    const next = body[++index];
    if (next === undefined) throw configurationFailure(`invalid escape in ${source}`, source);
    if (next === "n") result += "\n";
    else if (next === "r") result += "\r";
    else if (next === "t") result += "\t";
    else if (next === "\\" || next === "\"") result += next;
    else throw configurationFailure(`unsupported escape in ${source}`, source);
  }
  return result;
}

function dotenvValue(raw: string, source: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") || trimmed.startsWith("\"")) {
    const quote = trimmed[0] as "'" | "\"";
    let escaped = false;
    let closing = -1;
    for (let index = 1; index < trimmed.length; index++) {
      const character = trimmed[index]!;
      if (quote === "\"" && character === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (character === quote && !escaped) {
        closing = index;
        break;
      }
      escaped = false;
    }
    if (closing < 0) throw configurationFailure(`unterminated quoted value in ${source}`, source);
    const trailing = trimmed.slice(closing + 1).trim();
    if (trailing !== "" && !trailing.startsWith("#")) {
      throw configurationFailure(`unexpected text after quoted value in ${source}`, source);
    }
    return decodeQuoted(trimmed.slice(1, closing), quote, source);
  }
  const comment = /\s#/.exec(trimmed);
  return (comment === null ? trimmed : trimmed.slice(0, comment.index)).trim();
}

async function readEnvironmentFile(filePath: string): Promise<Map<ConfigurationVariable, ConfiguredValue>> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw configurationFailure(`analysis env is not a regular file: ${filePath}`, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const text = (await readStableSmallFile(filePath, CONFIG_FILE_LIMIT)).toString("utf8");
  const values = new Map<ConfigurationVariable, ConfiguredValue>();
  const firstLines = new Map<ConfigurationVariable, number>();
  for (const [offset, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (assignment === null) {
      if (trimmed.startsWith("AGENTHIST_EXPERIENCE_")) {
        throw configurationFailure(`invalid AgentHist analysis assignment at ${filePath}:${offset + 1}`, `${filePath}:${offset + 1}`);
      }
      continue;
    }
    const name = assignment[1]!;
    if (!isVariable(name)) continue;
    const previous = firstLines.get(name);
    if (previous !== undefined) {
      throw configurationFailure(
        `duplicate ${name} in ${filePath} at lines ${previous} and ${offset + 1}`,
        `${filePath}:${offset + 1}`,
      );
    }
    firstLines.set(name, offset + 1);
    values.set(name, {
      value: dotenvValue(assignment[2]!, `${filePath}:${offset + 1}`),
      source: `${filePath}:${offset + 1}`,
    });
  }
  return values;
}

function configuredValues(
  environment: NodeJS.ProcessEnv,
  dedicated: ReadonlyMap<ConfigurationVariable, ConfiguredValue>,
  project: ReadonlyMap<ConfigurationVariable, ConfiguredValue>,
): Map<ConfigurationVariable, ConfiguredValue> {
  const result = new Map<ConfigurationVariable, ConfiguredValue>();
  for (const name of VARIABLES) {
    const processValue = environment[name];
    const dedicatedValue = dedicated.get(name);
    const projectValue = project.get(name);
    const selected = processValue !== undefined && processValue.trim() !== ""
      ? { value: processValue, source: `environment variable ${name}` }
      : dedicatedValue !== undefined && dedicatedValue.value.trim() !== ""
        ? dedicatedValue
        : projectValue !== undefined && projectValue.value.trim() !== ""
          ? projectValue
          : undefined;
    if (selected !== undefined) result.set(name, selected);
  }
  return result;
}

function singleLine(value: ConfiguredValue, name: ConfigurationVariable): string {
  if (value.value.trim() === "" || /[\r\n\u0000]/.test(value.value)) {
    throw configurationFailure(`${name} must be a non-empty single-line value (${value.source})`, value.source);
  }
  return value.value.trim();
}

function serviceRoot(value: ConfiguredValue, name: ConfigurationVariable): { readonly baseUrl: string; readonly requestUrl: string } {
  let parsed: URL;
  try { parsed = new URL(singleLine(value, name)); } catch {
    throw configurationFailure(`${name} must be an absolute HTTP(S) URL (${value.source})`, value.source);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "" ||
    parsed.search !== "" || parsed.hash !== ""
  ) throw configurationFailure(`${name} must be an HTTP(S) service root without credentials, query, or fragment (${value.source})`, value.source);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname.toLowerCase().endsWith("/chat/completions")) {
    throw configurationFailure(`${name} must not include /chat/completions (${value.source})`, value.source);
  }
  const baseUrl = `${parsed.origin}${pathname}`;
  return { baseUrl, requestUrl: `${baseUrl}/chat/completions` };
}

function apiProfile(
  tier: AnalysisTier,
  endpoint: { readonly baseUrl: string; readonly requestUrl: string },
  modelValue: ConfiguredValue,
  keyValue: ConfiguredValue,
): OpenAIAnalysisProfile {
  const model = singleLine(modelValue, tier === "fast" ? "AGENTHIST_EXPERIENCE_FAST_MODEL" : "AGENTHIST_EXPERIENCE_DEEP_MODEL");
  const apiKey = singleLine(keyValue, tier === "fast" ? "AGENTHIST_EXPERIENCE_API_KEY" : "AGENTHIST_EXPERIENCE_DEEP_API_KEY");
  const backend = "openai-compatible-chat" as const;
  const endpointFingerprint = `ahepf1_${canonicalDigest({ backend, baseUrl: endpoint.baseUrl })}`;
  return {
    tier,
    backend,
    endpoint: endpoint.requestUrl,
    ...endpoint,
    endpointFingerprint,
    model,
    modelConfigured: true,
    profileFingerprint: `ahprofile1_${canonicalDigest({ backend, endpointFingerprint, model })}`,
    apiKey,
    keySource: keyValue.source,
  };
}

function cliModel(
  value: ConfiguredValue | undefined,
  name: "AGENTHIST_EXPERIENCE_FAST_MODEL" | "AGENTHIST_EXPERIENCE_DEEP_MODEL",
): { readonly model: string; readonly modelConfigured: boolean } {
  if (value === undefined) return { model: "agent-default", modelConfigured: false };
  const model = singleLine(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u.test(model)) {
    throw configurationFailure(`${name} contains characters that cannot be passed safely to an Agent CLI (${value.source})`, value.source);
  }
  return { model, modelConfigured: true };
}

function cliProfile(
  tier: AnalysisTier,
  backend: "codex-cli" | "claude-cli" | "opencode-cli" | "pi-cli",
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
  modelValue: ConfiguredValue | undefined,
): CliAnalysisProfile {
  const command = backend === "codex-cli"
    ? "codex"
    : backend === "claude-cli"
      ? "claude"
      : backend === "opencode-cli"
        ? "opencode"
        : "pi";
  const configured = cliModel(
    modelValue,
    tier === "fast" ? "AGENTHIST_EXPERIENCE_FAST_MODEL" : "AGENTHIST_EXPERIENCE_DEEP_MODEL",
  );
  const endpoint = `local:${command}`;
  const endpointFingerprint = `ahepf1_${canonicalDigest({ backend, command })}`;
  return {
    tier,
    backend,
    command,
    endpoint,
    endpointFingerprint,
    ...configured,
    profileFingerprint: `ahprofile1_${canonicalDigest({
      backend,
      endpointFingerprint,
      model: configured.modelConfigured ? configured.model : null,
      workingDirectory,
    })}`,
    workingDirectory,
    environment: { ...environment },
  };
}

async function createConfigurationTemplate(
  cwd: string,
  values: ReadonlyMap<ConfigurationVariable, ConfiguredValue>,
  backend: "api" | "codex" | "claude" | "opencode" | "pi",
  missing: readonly ConfigurationVariable[],
): Promise<string | undefined> {
  const filePath = path.join(cwd, ".env.agenthist");
  try {
    const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const header = "# AgentHist experience extraction models. Do not commit this file.\n";
      if (backend === "api") {
        const backendLine = values.has("AGENTHIST_EXPERIENCE_BACKEND")
          ? `# AGENTHIST_EXPERIENCE_BACKEND is already supplied by ${values.get("AGENTHIST_EXPERIENCE_BACKEND")!.source}.`
          : "AGENTHIST_EXPERIENCE_BACKEND=api";
        const required = REQUIRED_API_VARIABLES.map((name) => values.has(name)
          ? `# ${name} is already supplied by ${values.get(name)!.source}.`
          : `${name}=`).join("\n");
        await handle.writeFile(
          header +
          `${backendLine}\n\n` +
          `${required}\n\n` +
          "# Optional. Leave empty to use the fast model for both stages.\n" +
          "AGENTHIST_EXPERIENCE_DEEP_MODEL=\n" +
          "# Leave empty to reuse AGENTHIST_EXPERIENCE_BASE_URL.\n" +
          "# AGENTHIST_EXPERIENCE_DEEP_BASE_URL=\n" +
          "# Leave empty to reuse AGENTHIST_EXPERIENCE_API_KEY. Required when the deep Base URL has another origin.\n" +
          "# AGENTHIST_EXPERIENCE_DEEP_API_KEY=\n",
          "utf8",
        );
      } else {
        const label = backend === "codex"
          ? "Codex"
          : backend === "claude"
            ? "Claude Code"
            : backend === "opencode"
              ? "OpenCode"
              : "Pi";
        await handle.writeFile(
          header +
          `# Detected a configured local ${label} CLI.\n` +
          `AGENTHIST_EXPERIENCE_BACKEND=${backend}\n\n` +
          "# Optional. Omit both to use the Agent CLI's default model.\n" +
          "# AGENTHIST_EXPERIENCE_FAST_MODEL=\n" +
          "# AGENTHIST_EXPERIENCE_DEEP_MODEL=\n",
          "utf8",
        );
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return filePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw new AnalysisFailure(
      `cannot create AgentHist analysis template: ${filePath}\n` +
      (backend === "api"
        ? `alternative: set ${REQUIRED_API_VARIABLES.join(", ")} as environment variables`
        : `alternative: set AGENTHIST_EXPERIENCE_BACKEND=${backend} in the process environment`), {
      reason: "configuration_missing",
      stage: "configuration",
      retryable: false,
      missing,
    });
  }
}

export async function resolveAnalysisConfiguration(
  options: ResolveAnalysisConfigurationOptions,
): Promise<AnalysisConfiguration> {
  const cwd = path.resolve(options.cwd);
  const projectPath = path.join(cwd, ".env");
  const dedicatedPath = path.join(cwd, ".env.agenthist");
  const [project, dedicated] = await Promise.all([
    readEnvironmentFile(projectPath),
    readEnvironmentFile(dedicatedPath),
  ]);
  const values = configuredValues(options.environment, dedicated, project);
  let backendValue = values.get("AGENTHIST_EXPERIENCE_BACKEND");
  if (backendValue === undefined && values.size === 0 && options.createTemplate) {
    const detected = await detectCliAnalysisBackend({
      cwd,
      environment: options.environment,
      ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
    });
    if (detected !== undefined) {
      const created = await createConfigurationTemplate(cwd, values, detected, []);
      if (created !== undefined) {
        backendValue = { value: detected, source: created };
        values.set("AGENTHIST_EXPERIENCE_BACKEND", backendValue);
      }
    }
  }
  const configuredBackend = backendValue === undefined
    ? "api"
    : singleLine(backendValue, "AGENTHIST_EXPERIENCE_BACKEND");
  if (
    configuredBackend !== "api" && configuredBackend !== "codex" && configuredBackend !== "claude" &&
    configuredBackend !== "opencode" && configuredBackend !== "pi"
  ) {
    throw configurationFailure(
      `unsupported AGENTHIST_EXPERIENCE_BACKEND: ${configuredBackend}; expected api, codex, claude, opencode, or pi`,
      backendValue?.source,
    );
  }
  const missing = configuredBackend === "api"
    ? REQUIRED_API_VARIABLES.filter((name) => !values.has(name))
    : [];
  if (missing.length !== 0) {
    const created = options.createTemplate ? await createConfigurationTemplate(cwd, values, "api", missing) : undefined;
    const location = created ?? dedicatedPath;
    const message = "experience model is not configured\n" +
      `${created === undefined ? "config" : "created"}: ${location}\n` +
      `missing: ${missing.join(", ")}\n` +
      "next: fill the file, then run 'agenthist experience model check'\n" +
      "no history was sent";
    throw new AnalysisFailure(message, {
      reason: "configuration_missing",
      stage: "configuration",
      retryable: false,
      missing,
      ...(created === undefined ? {} : { created }),
    });
  }
  const deepModel = values.get("AGENTHIST_EXPERIENCE_DEEP_MODEL");
  if (configuredBackend !== "api") {
    const backend = configuredBackend === "codex"
      ? "codex-cli"
      : configuredBackend === "claude"
        ? "claude-cli"
        : configuredBackend === "opencode"
          ? "opencode-cli"
          : "pi-cli";
    const fast = cliProfile(
      "fast",
      backend,
      cwd,
      options.environment,
      values.get("AGENTHIST_EXPERIENCE_FAST_MODEL"),
    );
    if (deepModel === undefined) return { fast, deep: { ...fast, tier: "deep" }, deepBinding: "fast" };
    return {
      fast,
      deep: cliProfile("deep", backend, cwd, options.environment, deepModel),
      deepBinding: "configured",
    };
  }
  const sharedEndpoint = serviceRoot(values.get("AGENTHIST_EXPERIENCE_BASE_URL")!, "AGENTHIST_EXPERIENCE_BASE_URL");
  const fast = apiProfile(
    "fast",
    sharedEndpoint,
    values.get("AGENTHIST_EXPERIENCE_FAST_MODEL")!,
    values.get("AGENTHIST_EXPERIENCE_API_KEY")!,
  );
  const deepUrl = values.get("AGENTHIST_EXPERIENCE_DEEP_BASE_URL");
  const deepKey = values.get("AGENTHIST_EXPERIENCE_DEEP_API_KEY");
  if (deepModel === undefined && (deepUrl !== undefined || deepKey !== undefined)) {
    throw configurationFailure("deep endpoint/key overrides require AGENTHIST_EXPERIENCE_DEEP_MODEL", deepUrl?.source ?? deepKey?.source);
  }
  if (deepModel === undefined) return { fast, deep: { ...fast, tier: "deep" }, deepBinding: "fast" };
  const effectiveDeepEndpoint = deepUrl === undefined
    ? sharedEndpoint
    : serviceRoot(deepUrl, "AGENTHIST_EXPERIENCE_DEEP_BASE_URL");
  if (
    new URL(effectiveDeepEndpoint.baseUrl).origin !== new URL(sharedEndpoint.baseUrl).origin && deepKey === undefined
  ) throw configurationFailure("AGENTHIST_EXPERIENCE_DEEP_API_KEY is required when the deep endpoint uses another origin", deepUrl?.source);
  const deep = apiProfile(
    "deep",
    effectiveDeepEndpoint,
    deepModel,
    deepKey ?? values.get("AGENTHIST_EXPERIENCE_API_KEY")!,
  );
  return { fast, deep, deepBinding: "configured" };
}

function sanitizedMessage(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  let result = value.replace(/Bearer\s+[^\s"']+/giu, "Bearer [redacted]");
  for (const secret of secrets) {
    if (secret !== "") result = result.replaceAll(secret, "[redacted]");
  }
  return result.slice(0, 512);
}

function responseRequestId(response: Response): string | undefined {
  return response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
}

async function boundedResponseText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_BYTE_LIMIT) throw new Error("analysis response exceeds the byte limit");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function providerError(value: unknown, secrets: readonly string[]): { readonly code?: string; readonly message?: string } {
  const root = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const error = root?.error !== null && typeof root?.error === "object" && !Array.isArray(root.error)
    ? root.error as Record<string, unknown>
    : undefined;
  const code = sanitizedMessage(error?.code, secrets);
  const message = sanitizedMessage(error?.message, secrets);
  return {
    ...(code === undefined ? {} : { code: code.slice(0, 128) }),
    ...(message === undefined ? {} : { message }),
  };
}

function responseFailure(
  response: Response,
  body: unknown,
  profile: OpenAIAnalysisProfile,
  stage: string,
): AnalysisFailure {
  const error = providerError(body, [profile.apiKey]);
  const joined = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  let reason: AnalysisFailureReason;
  let retryable = false;
  if (response.status === 401 || response.status === 403) reason = "authentication_failed";
  else if (response.status === 404 && /model/.test(joined)) reason = "model_not_found";
  else if (response.status === 404) reason = "endpoint_or_model_not_found";
  else if (response.status === 429) { reason = "rate_limited"; retryable = true; }
  else if (response.status >= 500) { reason = "upstream_failed"; retryable = true; }
  else if (/context|token.{0,20}limit|maximum context/.test(joined)) reason = "context_limit_exceeded";
  else if (
    /(?:response.?format|json.?schema|structured.?output|max[_ .-]?completion[_ .-]?tokens|stream)/.test(joined) &&
    /(?:unsupported|not support|invalid|unknown|unrecognized|not allowed|only)/.test(joined)
  ) reason = "protocol_mismatch";
  else if (/model.{0,30}(?:not found|does not exist|access)|unknown model/.test(joined)) reason = "model_not_found";
  else reason = "request_rejected";
  const requestId = responseRequestId(response);
  const suffix = error.message === undefined ? "" : `: ${error.message}`;
  const requirement = reason === "protocol_mismatch"
    ? "\nrequired: OpenAI-compatible Chat Completions with strict json_schema and max_completion_tokens"
    : "";
  return new AnalysisFailure(`analysis ${profile.tier} request failed (${reason}, HTTP ${response.status})${suffix}${requirement}`, {
    reason,
    stage,
    retryable,
    tier: profile.tier,
    endpoint: profile.requestUrl,
    model: profile.model,
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
    source: profile.keySource,
  });
}

function networkFailure(error: unknown, profile: OpenAIAnalysisProfile, stage: string): AnalysisFailure {
  const candidate = error as { readonly name?: unknown; readonly cause?: { readonly code?: unknown } };
  const code = typeof candidate.cause?.code === "string" ? candidate.cause.code : "";
  let reason: AnalysisFailureReason = "connection_failed";
  let retryable = true;
  if (candidate.name === "TimeoutError" || candidate.name === "AbortError") reason = "timeout";
  else if (code === "ENOTFOUND" || code === "EAI_AGAIN") reason = "dns_failed";
  else if (/CERT|TLS|SSL/.test(code)) { reason = "tls_failed"; retryable = false; }
  return new AnalysisFailure(`analysis ${profile.tier} request failed (${reason})`, {
    reason,
    stage,
    retryable,
    tier: profile.tier,
    endpoint: profile.requestUrl,
    model: profile.model,
  });
}

function usageValue(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function requestOpenAIAnalysis(
  options: RequestAnalysisOptions & { readonly profile: OpenAIAnalysisProfile },
): Promise<AnalysisCompletion> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(options.profile.requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.profile.apiKey}`,
      },
      body: JSON.stringify({
        model: options.profile.model,
        messages: options.messages,
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: options.responseFormat.name,
            strict: true,
            schema: options.responseFormat.schema,
          },
        },
        max_completion_tokens: options.maximumOutputTokens,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkFailure(error, options.profile, options.stage);
  }
  let text: string;
  try { text = await boundedResponseText(response); } catch {
    const requestId = responseRequestId(response);
    throw new AnalysisFailure(`analysis ${options.profile.tier} response exceeds the supported byte limit`, {
      reason: "protocol_mismatch",
      stage: options.stage,
      retryable: false,
      tier: options.profile.tier,
      endpoint: options.profile.requestUrl,
      model: options.profile.model,
      status: response.status,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch {
    if (!response.ok) body = {};
    else {
      const requestId = responseRequestId(response);
      throw new AnalysisFailure(`analysis ${options.profile.tier} response is not valid JSON`, {
        reason: "protocol_mismatch",
        stage: options.stage,
        retryable: false,
        tier: options.profile.tier,
        endpoint: options.profile.requestUrl,
        model: options.profile.model,
        status: response.status,
        ...(requestId === undefined ? {} : { requestId }),
      });
    }
  }
  if (!response.ok) throw responseFailure(response, body, options.profile, options.stage);
  const root = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  const choices = root?.choices;
  const first = Array.isArray(choices) && choices.length > 0 && choices[0] !== null && typeof choices[0] === "object"
    ? choices[0] as Record<string, unknown>
    : undefined;
  const message = first?.message !== null && typeof first?.message === "object"
    ? first.message as Record<string, unknown>
    : undefined;
  if (typeof message?.content !== "string") {
    const requestId = responseRequestId(response);
    throw new AnalysisFailure(`analysis ${options.profile.tier} response does not match Chat Completions`, {
      reason: "protocol_mismatch",
      stage: options.stage,
      retryable: false,
      tier: options.profile.tier,
      endpoint: options.profile.requestUrl,
      model: options.profile.model,
      status: response.status,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  const usage = root?.usage !== null && typeof root?.usage === "object" ? root.usage as Record<string, unknown> : {};
  return {
    content: message.content,
    usage: {
      inputTokens: usageValue(usage.prompt_tokens),
      outputTokens: usageValue(usage.completion_tokens),
      totalTokens: usageValue(usage.total_tokens),
    },
    ...(responseRequestId(response) === undefined ? {} : { requestId: responseRequestId(response)! }),
  };
}

export async function requestAnalysis(options: RequestAnalysisOptions): Promise<AnalysisCompletion> {
  if (options.profile.backend === "openai-compatible-chat") {
    return requestOpenAIAnalysis({ ...options, profile: options.profile });
  }
  try {
    return await requestCliAnalysis({
      profile: options.profile,
      stage: options.stage,
      messages: options.messages,
      maximumOutputTokens: options.maximumOutputTokens,
      responseFormat: options.responseFormat,
      ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
    });
  } catch (error) {
    if (!(error instanceof CliModelFailure)) throw error;
    throw new AnalysisFailure(error.message, {
      reason: error.reason,
      stage: options.stage,
      retryable: error.retryable,
      tier: options.profile.tier,
      endpoint: options.profile.endpoint,
      model: options.profile.model,
    });
  }
}
