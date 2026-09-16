import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  checkExperienceModels,
  OperationError,
  type AnalysisProcessRunner,
  type ExperienceModelCheckOptions,
  type ExperienceModelCheckResult,
} from "../application/index.js";
import {
  AnalysisFailure,
  resolveAnalysisConfiguration,
  type AnalysisBackend,
  type AnalysisConfiguration,
  type AnalysisProfile,
  type ResolveAnalysisConfigurationOptions,
} from "../experience/model.js";
import { applyPosixMode } from "../infrastructure/files.js";
import { ensurePrivateStateDirectory } from "../infrastructure/state.js";

const MAX_STATE_PATH_BYTES = 64 * 1024;
const SAFE_ERROR_CODES = new Set([
  "configuration_missing",
  "configuration_invalid",
  "command_not_found",
  "dns_failed",
  "connection_failed",
  "tls_failed",
  "timeout",
  "authentication_failed",
  "endpoint_or_model_not_found",
  "model_not_found",
  "rate_limited",
  "upstream_failed",
  "request_rejected",
  "content_rejected",
  "context_limit_exceeded",
  "protocol_mismatch",
  "invalid_model_output",
]);
const SAFE_ERROR_STAGES = new Set(["configuration", "model_check"]);

export interface SafeExperienceEndpoint {
  readonly kind: "remote" | "local";
  readonly label: string;
}

export interface DesktopExperienceModelProfile {
  readonly contextWindow?: number;
  readonly tier: "fast" | "deep";
  readonly backend: AnalysisBackend;
  readonly model: string;
  readonly modelConfigured: boolean;
  readonly endpoint: SafeExperienceEndpoint;
}

export interface DesktopExperienceConfigurationError {
  readonly code: string;
  readonly retryable: boolean;
  readonly stage: string;
  readonly status?: number;
}

export type DesktopExperienceConfigurationInspection =
  | {
      readonly status: "configured";
      readonly configFile: string;
      readonly backend: AnalysisBackend;
      readonly deepBinding: "configured" | "fast";
      readonly fast: DesktopExperienceModelProfile;
      readonly deep: DesktopExperienceModelProfile;
    }
  | {
      readonly status: "not_configured" | "invalid";
      readonly configFile: string;
      readonly error: DesktopExperienceConfigurationError;
    };

export interface DesktopExperienceModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface DesktopExperienceCheckedProfile extends DesktopExperienceModelProfile {
  readonly binding: "configured" | "fast";
  readonly requestMade: boolean;
  readonly usage: DesktopExperienceModelUsage;
}

export type DesktopExperienceConfigurationCheck =
  | {
      readonly durationMs?: number;
      readonly status: "checked";
      readonly configFile: string;
      readonly historySent: false;
      readonly requests: number;
      readonly profiles: readonly DesktopExperienceCheckedProfile[];
    }
  | {
      readonly status: "not_configured" | "invalid" | "failed";
      readonly durationMs?: number;
      readonly configFile: string;
      readonly historySent: false;
      readonly requests: 0;
      readonly error: DesktopExperienceConfigurationError;
    };

export interface InspectDesktopExperienceConfigurationOptions {
  readonly getAnalysisConfiguration?: () => Promise<AnalysisConfiguration>;
  readonly analysisConfiguration?: AnalysisConfiguration;
  readonly stateDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly processRunner?: AnalysisProcessRunner;
  readonly resolveAnalysisConfiguration?: (
    options: ResolveAnalysisConfigurationOptions,
  ) => Promise<AnalysisConfiguration>;
}

export interface CheckDesktopExperienceConfigurationOptions {
  readonly getAnalysisConfiguration?: () => Promise<AnalysisConfiguration>;
  readonly analysisConfiguration?: AnalysisConfiguration;
  readonly stateDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
  readonly processRunner?: AnalysisProcessRunner;
  readonly checkExperienceModels?: (
    options: ExperienceModelCheckOptions,
  ) => Promise<ExperienceModelCheckResult>;
}

function validatedStateDirectory(value: string): string {
  if (
    typeof value !== "string" || value === "" || /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_STATE_PATH_BYTES || !path.isAbsolute(value)
  ) throw new Error("desktop Experience configuration requires an absolute valid state directory");
  return path.normalize(value);
}

export function experienceConfigurationDirectory(stateDirectory: string): string {
  return path.join(validatedStateDirectory(stateDirectory), "desktop", "experience");
}

export function experienceConfigurationFile(stateDirectory: string): string {
  return path.join(experienceConfigurationDirectory(stateDirectory), ".env.agenthist");
}

async function ensureConfigurationDirectory(stateDirectory: string): Promise<string> {
  const validated = validatedStateDirectory(stateDirectory);
  await ensurePrivateStateDirectory(validated);
  const directory = experienceConfigurationDirectory(validated);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await applyPosixMode(directory, 0o700);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("desktop Experience configuration directory is not a private real directory");
  }
  return directory;
}

function safeEndpoint(profile: Pick<AnalysisProfile, "backend" | "endpoint">): SafeExperienceEndpoint {
  if (profile.backend.endsWith("-cli")) {
    const label = profile.backend === "codex-cli"
      ? "local:codex"
      : profile.backend === "claude-cli"
        ? "local:claude"
        : profile.backend === "opencode-cli"
          ? "local:opencode"
          : "local:pi";
    return { kind: "local", label };
  }
  let endpoint: URL;
  try {
    endpoint = new URL(profile.endpoint);
  } catch {
    throw new Error("configured Experience endpoint is invalid");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("configured Experience endpoint is invalid");
  }
  return { kind: "remote", label: `${endpoint.protocol}//${endpoint.host}` };
}

function safeProfile(profile: AnalysisProfile): DesktopExperienceModelProfile {
  return {
    ...(profile.contextWindow === undefined ? {} : { contextWindow: profile.contextWindow }),
    tier: profile.tier,
    backend: profile.backend,
    model: profile.model,
    modelConfigured: profile.modelConfigured,
    endpoint: safeEndpoint(profile),
  };
}

function safeError(
  error: unknown,
  fallbackCode: string,
  fallbackStage: string,
): DesktopExperienceConfigurationError {
  const details = error instanceof AnalysisFailure
    ? error.details
    : error instanceof OperationError
      ? error.details
      : undefined;
  const code = typeof details?.reason === "string" && SAFE_ERROR_CODES.has(details.reason)
    ? details.reason
    : fallbackCode;
  const stage = typeof details?.stage === "string" && SAFE_ERROR_STAGES.has(details.stage)
    ? details.stage
    : fallbackStage;
  const retryable = typeof details?.retryable === "boolean" ? details.retryable : false;
  const status = typeof details?.status === "number" && Number.isSafeInteger(details.status) &&
    details.status >= 100 && details.status <= 599
    ? details.status
    : undefined;
  return { code, retryable, stage, ...(status === undefined ? {} : { status }) };
}

function failureStatus(error: DesktopExperienceConfigurationError): "not_configured" | "invalid" | "failed" {
  if (error.code === "configuration_missing") return "not_configured";
  if (error.code === "configuration_invalid") return "invalid";
  return "failed";
}

function safeUsage(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

export async function inspectDesktopExperienceConfiguration(
  options: InspectDesktopExperienceConfigurationOptions,
): Promise<DesktopExperienceConfigurationInspection> {
  const cwd = await ensureConfigurationDirectory(options.stateDirectory);
  const configFile = experienceConfigurationFile(options.stateDirectory);
  try {
    const resolve = options.resolveAnalysisConfiguration ?? resolveAnalysisConfiguration;
    const configuration = options.analysisConfiguration ?? await options.getAnalysisConfiguration?.() ?? await resolve({
      cwd,
      environment: options.environment ?? process.env,
      createTemplate: false,
      ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
    });
    const fast = safeProfile(configuration.fast);
    const deep = safeProfile(configuration.deep);
    return {
      status: "configured",
      configFile,
      backend: fast.backend,
      deepBinding: configuration.deepBinding,
      fast,
      deep,
    };
  } catch (error) {
    const sanitized = safeError(error, "configuration_invalid", "configuration");
    return {
      status: sanitized.code === "configuration_missing" ? "not_configured" : "invalid",
      configFile,
      error: sanitized,
    };
  }
}

export async function checkDesktopExperienceConfiguration(
  options: CheckDesktopExperienceConfigurationOptions,
): Promise<DesktopExperienceConfigurationCheck> {
  const started = Date.now();
  const cwd = await ensureConfigurationDirectory(options.stateDirectory);
  const configFile = experienceConfigurationFile(options.stateDirectory);
  try {
    const check = options.checkExperienceModels ?? checkExperienceModels;
    const configuration = options.analysisConfiguration ?? await options.getAnalysisConfiguration?.();
    const result = await check({
      ...(configuration === undefined ? {} : { analysisConfiguration: configuration }),
      cwd,
      environment: options.environment ?? process.env,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
    });
    if (result.historySent !== false || !Number.isSafeInteger(result.requests) || result.requests < 0 ||
      result.profiles.length < 1 || result.profiles.length > 2) {
      throw new Error("Experience model check returned an invalid result");
    }
    return {
      status: "checked",
      durationMs: Date.now() - started,
      configFile,
      historySent: false,
      requests: result.requests,
      profiles: result.profiles.map((profile): DesktopExperienceCheckedProfile => ({
        tier: profile.tier,
        backend: profile.backend,
        model: profile.model,
        modelConfigured: profile.modelConfigured,
        endpoint: safeEndpoint(profile),
        binding: profile.binding,
        requestMade: profile.requestMade,
        usage: {
          inputTokens: safeUsage(profile.usage.inputTokens, "Experience model-check input usage"),
          outputTokens: safeUsage(profile.usage.outputTokens, "Experience model-check output usage"),
          totalTokens: safeUsage(profile.usage.totalTokens, "Experience model-check total usage"),
        },
      })),
    };
  } catch (error) {
    const sanitized = safeError(error, "model_check_failed", "model_check");
    return {
      status: failureStatus(sanitized),
      durationMs: Date.now() - started,
      configFile,
      historySent: false,
      requests: 0,
      error: sanitized,
    };
  }
}
