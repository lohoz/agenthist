import {
  AnalysisFailure,
  requestAnalysis,
  resolveAnalysisConfiguration,
  type AnalysisProfile,
  type AnalysisBackend,
  type AnalysisProcessRunner,
  type AnalysisUsage,
} from "./model.js";
import { OperationError } from "./operation-error.js";

export interface ExperienceModelCheckOptions {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
  readonly processRunner?: AnalysisProcessRunner;
}

export interface ExperienceModelProfileCheck {
  readonly tier: "fast" | "deep";
  readonly binding: "configured" | "fast";
  readonly model: string;
  readonly modelConfigured: boolean;
  readonly backend: AnalysisBackend;
  readonly endpoint: string;
  readonly endpointFingerprint: string;
  readonly requestMade: boolean;
  readonly usage: AnalysisUsage;
}

export interface ExperienceModelCheckResult {
  readonly profiles: readonly ExperienceModelProfileCheck[];
  readonly requests: number;
  readonly historySent: false;
}

export function analysisOperationError(
  error: AnalysisFailure,
  extra: Readonly<Record<string, unknown>> = {},
): OperationError {
  const details = { ...error.details, ...extra };
  const context = [
    error.details.tier === undefined ? undefined : `tier: ${error.details.tier}`,
    error.details.stage === "configuration" ? undefined : `stage: ${error.details.stage}`,
    error.details.endpoint === undefined ? undefined : `endpoint: ${error.details.endpoint}`,
    error.details.model === undefined ? undefined : `model: ${error.details.model}`,
    error.details.source === undefined ? undefined : `credential source: ${error.details.source}`,
  ].filter((line): line is string => line !== undefined);
  return new OperationError(
    context.length === 0 ? error.message : `${error.message}\n${context.join("\n")}`,
    details,
  );
}

function checkedPayload(content: string, profile: AnalysisProfile): void {
  let value: unknown;
  try { value = JSON.parse(content); } catch {
    throw new AnalysisFailure(`analysis ${profile.tier} model check returned invalid JSON content`, {
      reason: "invalid_model_output",
      stage: "model_check",
      retryable: false,
      tier: profile.tier,
      endpoint: profile.endpoint,
      model: profile.model,
      validation: "expected exactly {\"ok\":true}",
    });
  }
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 1 || (value as Record<string, unknown>).ok !== true
  ) {
    throw new AnalysisFailure(`analysis ${profile.tier} model check returned an unexpected JSON object`, {
      reason: "invalid_model_output",
      stage: "model_check",
      retryable: false,
      tier: profile.tier,
      endpoint: profile.endpoint,
      model: profile.model,
      validation: "expected exactly {\"ok\":true}",
    });
  }
}

async function checkProfile(
  profile: AnalysisProfile,
  fetcher: typeof fetch | undefined,
  processRunner: AnalysisProcessRunner | undefined,
): Promise<AnalysisUsage> {
  const completion = await requestAnalysis({
    profile,
    stage: "model_check",
    messages: [
      {
        role: "system",
        content: "This is a connectivity check. Return exactly the JSON object {\"ok\":true}. Do not add keys or prose.",
      },
      {
        role: "user",
        content: "Return the required JSON object. This request contains no Agent history.",
      },
    ],
    maximumOutputTokens: 128,
    responseFormat: {
      name: "agenthist_model_check",
      schema: {
        type: "object",
        properties: { ok: { type: "boolean", const: true } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    ...(fetcher === undefined ? {} : { fetcher }),
    ...(processRunner === undefined ? {} : { processRunner }),
  });
  checkedPayload(completion.content, profile);
  return completion.usage;
}

export async function checkExperienceModels(
  options: ExperienceModelCheckOptions,
): Promise<ExperienceModelCheckResult> {
  try {
    const configuration = await resolveAnalysisConfiguration({
      cwd: options.cwd,
      environment: options.environment,
      createTemplate: true,
      ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
    });
    const fastUsage = await checkProfile(configuration.fast, options.fetcher, options.processRunner);
    const sameEffectiveProfile =
      configuration.deep.profileFingerprint === configuration.fast.profileFingerprint &&
      (configuration.fast.backend !== "openai-compatible-chat" ||
        (configuration.deep.backend === "openai-compatible-chat" &&
          configuration.deep.apiKey === configuration.fast.apiKey));
    const deepUsage = sameEffectiveProfile
      ? fastUsage
      : await checkProfile(configuration.deep, options.fetcher, options.processRunner);
    return {
      profiles: [
        {
          tier: "fast",
          binding: "configured",
          model: configuration.fast.model,
          modelConfigured: configuration.fast.modelConfigured,
          backend: configuration.fast.backend,
          endpoint: configuration.fast.endpoint,
          endpointFingerprint: configuration.fast.endpointFingerprint,
          requestMade: true,
          usage: fastUsage,
        },
        {
          tier: "deep",
          binding: configuration.deepBinding,
          model: configuration.deep.model,
          modelConfigured: configuration.deep.modelConfigured,
          backend: configuration.deep.backend,
          endpoint: configuration.deep.endpoint,
          endpointFingerprint: configuration.deep.endpointFingerprint,
          requestMade: !sameEffectiveProfile,
          usage: deepUsage,
        },
      ],
      requests: sameEffectiveProfile ? 1 : 2,
      historySent: false,
    };
  } catch (error) {
    if (error instanceof AnalysisFailure) throw analysisOperationError(error);
    throw error;
  }
}
