import { randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  loadExperienceReviewPack as coreLoadExperienceReviewPack,
  validateExperienceReviewPack,
  type AnalysisProcessRunner,
  type ExperienceDryRunOptions,
  type ExperienceDryRunResult,
  type ExperienceReviewPack,
  type PrepareExperienceReviewOptions,
  type PrepareExperienceReviewProgress,
  type PrepareExperienceReviewResult,
} from "../application/index.js";
import { sessionAgent } from "../domain/history.js";
import { canonicalDigest } from "../domain/history-identity.js";
import type { AnalysisConfiguration } from "../experience/model.js";
import { dryRunSinglePassExperienceReview, prepareSinglePassExperienceReview } from "../experience/single-pass-review.js";
import { OperationError } from "../experience/operation-error.js";
import { applyPosixMode } from "../infrastructure/files.js";
import { ensurePrivateStateDirectory } from "../infrastructure/state.js";
import type {
  CloseExperienceReviewRequest,
  CloseExperienceReviewResultDto,
  ExperienceCandidateDetailDto,
  ExperienceCandidateSummaryDto,
  ExperiencePreviewDto,
  ExperienceProgressDto,
  ExperienceReviewDto,
  ExperienceScopeRequest,
  GetExperienceCandidateRequest,
  LoadExperienceReviewResultDto,
  OpenExperienceOutputRequest,
  OpenExperienceOutputResultDto,
  RunExperienceRequest,
  RunExperienceResultDto,
} from "./contracts.js";

export const MAX_DESKTOP_EXPERIENCE_HANDLES = 8;
export const DEFAULT_DESKTOP_EXPERIENCE_HANDLE_TTL_MS = 30 * 60 * 1000;

const MAX_SCOPE_SESSIONS = 100_000;
const MAX_PATH_BYTES = 64 * 1024;
const HANDLE = /^ahexpreview1_[0-9a-f]{64}$/;
const PREVIEW = /^ahexppreview1_[0-9a-f]{64}$/;
const CANDIDATE = /^ahcongroup2_[0-9a-f]{64}$/;

interface NormalizedScope {
  readonly scope: "all" | "sessions";
  readonly sessionRefs: readonly string[];
}

interface ReviewEntry {
  readonly handle: string;
  readonly pack: ExperienceReviewPack;
  readonly directory: string;
  readonly directoryName: string;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
  busy: boolean;
  expired: boolean;
}

export interface DesktopExperienceService {
  previewExperience(scope: ExperienceScopeRequest): Promise<ExperiencePreviewDto>;
  runExperience(
    request: RunExperienceRequest,
    onProgress?: (progress: ExperienceProgressDto) => void,
  ): Promise<RunExperienceResultDto>;
  loadExperienceReview(): Promise<LoadExperienceReviewResultDto>;
  getExperienceCandidate(request: GetExperienceCandidateRequest): Promise<ExperienceCandidateDetailDto>;
  openExperienceOutput(request: OpenExperienceOutputRequest): Promise<OpenExperienceOutputResultDto>;
  closeExperienceReview(request: CloseExperienceReviewRequest): Promise<CloseExperienceReviewResultDto>;
  dispose(): Promise<void>;
}

export interface DesktopExperienceServiceOptions {
  readonly getAnalysisConfiguration?: () => Promise<AnalysisConfiguration>;
  readonly stateDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly maximumInputTokens?: number;
  readonly maximumDeepInputTokens?: number;
  readonly requestInputTokens?: number;
  readonly fetcher?: typeof fetch;
  readonly processRunner?: AnalysisProcessRunner;
  readonly chooseOutputParent: () => Promise<string | undefined>;
  readonly chooseReviewPath: () => Promise<string | undefined>;
  readonly openPath: (directory: string) => Promise<void | string>;
  readonly dryRunExperienceReview?: (options: ExperienceDryRunOptions) => Promise<ExperienceDryRunResult>;
  readonly prepareExperienceReview?: (options: PrepareExperienceReviewOptions) => Promise<Pick<PrepareExperienceReviewResult, "plan" | "review">>;
  readonly loadExperienceReviewPack?: (pathOrDirectory: string, cwd?: string) => Promise<ExperienceReviewPack>;
  readonly lstat?: typeof lstat;
  readonly randomUUID?: () => string;
  readonly now?: () => number;
  readonly reviewHandleTtlMs?: number;
}

interface Dependencies {
  readonly dryRun: (options: ExperienceDryRunOptions) => Promise<ExperienceDryRunResult>;
  readonly prepare: (options: PrepareExperienceReviewOptions) => Promise<Pick<PrepareExperienceReviewResult, "plan" | "review">>;
  readonly load: (pathOrDirectory: string, cwd?: string) => Promise<ExperienceReviewPack>;
  readonly lstat: typeof lstat;
  readonly randomUUID: () => string;
  readonly now: () => number;
}

function safePath(value: string, label: string): string {
  if (
    typeof value !== "string" || value === "" || /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || Buffer.from(value, "utf8").toString("utf8") !== value
  ) throw new Error(`${label} is invalid`);
  return value;
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown !== undefined) throw new Error(`${label} has an unknown field: ${unknown}`);
}

function normalizeScope(request: ExperienceScopeRequest): NormalizedScope {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("desktop Experience scope is invalid");
  }
  if (request.scope === "all") {
    exactKeys(request, ["scope"], "desktop Experience scope");
    return { scope: "all", sessionRefs: [] };
  }
  if (request.scope !== "sessions") throw new Error("desktop Experience scope is invalid");
  exactKeys(request, ["scope", "sessionRefs"], "desktop Experience scope");
  if (
    !Array.isArray(request.sessionRefs) || request.sessionRefs.length === 0 ||
    request.sessionRefs.length > MAX_SCOPE_SESSIONS
  ) throw new Error("desktop Experience session scope is invalid");
  const sessionRefs = request.sessionRefs.map((reference) => {
    if (typeof reference !== "string" || sessionAgent(reference) === undefined) {
      throw new Error("desktop Experience session reference is invalid");
    }
    return reference;
  }).sort();
  if (new Set(sessionRefs).size !== sessionRefs.length) {
    throw new Error("desktop Experience session scope contains duplicates");
  }
  return { scope: "sessions", sessionRefs };
}

function dryOptions(
  options: DesktopExperienceServiceOptions,
  cwd: string,
  scope: NormalizedScope,
): ExperienceDryRunOptions {
  return {
    stateDirectory: options.stateDirectory,
    cwd,
    ...(scope.scope === "all" ? { allHistory: true } : { sessionRefs: scope.sessionRefs }),
    ...(options.maximumInputTokens === undefined ? {} : { maximumInputTokens: options.maximumInputTokens }),
    ...(options.maximumDeepInputTokens === undefined
      ? {}
      : { maximumDeepInputTokens: options.maximumDeepInputTokens }),
    ...(options.requestInputTokens === undefined ? {} : { requestInputTokens: options.requestInputTokens }),
  };
}

function previewDto(scope: NormalizedScope, result: ExperienceDryRunResult): ExperiencePreviewDto {
  if (
    scope.scope === "all" && result.selection.mode !== "all" ||
    scope.scope === "sessions" && (
      result.selection.mode !== "session" ||
      result.selection.sessionRefs.length !== scope.sessionRefs.length ||
      result.selection.sessionRefs.some((reference, index) => reference !== scope.sessionRefs[index])
    )
  ) throw new Error("desktop Experience preview does not match its requested scope");
  const identity = {
    singleRequest: result.singleRequest === true,
    scope,
    snapshots: result.corpus.agents.map((agent) => ({ agent: agent.agent, snapshotId: agent.snapshotId })),
    index: { parserVersion: result.index.parserVersion },
    corpus: {
      sessions: result.corpus.sessions,
      lineages: result.corpus.lineages,
      projects: result.corpus.projects,
      cards: result.corpus.cards,
      queuedCards: result.corpus.queuedCards,
    },
    plan: result.plan,
    ...(result.inputPreparation === undefined ? {} : { inputPreparation: result.inputPreparation }),
  };
  return {
    previewRef: `ahexppreview1_${canonicalDigest(identity)}`,
    ...(result.singleRequest === true ? { singleRequest: true as const, inputLimitExceeded: result.plan.remainingCards > 0,
      inputTokenLimit: Math.min(result.plan.maximumInputTokens, result.plan.requestInputTokens) } : {}),
    ...(result.inputPreparation === undefined ? {} : {
      originalInputTokens: result.inputPreparation.originalTokens,
      inputCompacted: result.inputPreparation.compression === "text_dictionary",
      inputBudgetSource: result.inputPreparation.budgetSource,
      ...(result.inputPreparation.contextWindow === undefined ? {} : { modelContextWindow: result.inputPreparation.contextWindow }),
    }),
    scope: scope.scope,
    sessions: result.corpus.sessions,
    lineages: result.corpus.lineages,
    projects: result.corpus.projects,
    cards: result.corpus.cards,
    queuedCards: result.corpus.queuedCards,
    reusedSessions: result.index.reusedSessions,
    rebuiltSessions: result.index.rebuiltSessions,
    estimatedInputTokens: result.plan.estimatedFastInputTokens,
    evidenceRequests: result.plan.fastRequests,
    candidateRequestsUpperBound: result.plan.deepRequestsUpperBound,
  };
}

function category(lens: string): ExperienceCandidateSummaryDto["category"] {
  if (lens === "workflow") return "working_method";
  if (lens === "style" || lens === "scope") return "preference";
  return "requirement";
}

function candidateSummary(
  candidate: ExperienceReviewPack["candidates"][number],
): ExperienceCandidateSummaryDto {
  if (!CANDIDATE.test(candidate.candidateRef)) throw new Error("desktop Experience candidate is invalid");
  return {
    candidateRef: candidate.candidateRef,
    category: category(candidate.lens),
    topic: candidate.topic,
    lens: candidate.lens,
    draft: candidate.draft,
    evidence: candidate.evidence.length,
    sessions: candidate.sessions,
    projects: candidate.projects,
  };
}

function reviewDto(entry: ReviewEntry): ExperienceReviewDto {
  return {
    handle: entry.handle,
    reviewRef: entry.pack.reviewRef,
    createdAt: entry.pack.createdAt,
    directoryName: entry.directoryName,
    sessions: entry.pack.source.sessions,
    lineages: entry.pack.source.lineages,
    projects: entry.pack.source.projects,
    candidates: entry.pack.candidates.map(candidateSummary),
    unroutedEvidence: entry.pack.unrouted.length,
  };
}

async function ensurePrivateExperienceDirectory(stateDirectory: string): Promise<string> {
  await ensurePrivateStateDirectory(stateDirectory);
  const directory = path.join(stateDirectory, "desktop", "experience");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await applyPosixMode(directory, 0o700);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("desktop Experience directory is not a private real directory");
  }
  return directory;
}

async function requireRealDirectory(directory: string, deps: Dependencies, label: string): Promise<string> {
  safePath(directory, label);
  if (!path.isAbsolute(directory)) throw new Error(`${label} must be an absolute path from the system picker`);
  const resolved = path.normalize(directory);
  const info = await deps.lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  return resolved;
}

async function selectedReviewDirectory(selected: string, deps: Dependencies): Promise<string> {
  safePath(selected, "desktop Experience review selection");
  if (!path.isAbsolute(selected)) {
    throw new Error("desktop Experience review selection must come from the system picker");
  }
  const resolved = path.normalize(selected);
  const info = await deps.lstat(resolved);
  if (info.isSymbolicLink()) throw new Error("desktop Experience review selection cannot be a symbolic link");
  if (info.isDirectory()) return resolved;
  if (!info.isFile()) throw new Error("desktop Experience review selection is not a regular file or directory");
  return requireRealDirectory(path.dirname(resolved), deps, "desktop Experience review directory");
}

function handle(deps: Dependencies, existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 4; attempt++) {
    const value = `ahexpreview1_${deps.randomUUID().replaceAll("-", "")}${deps.randomUUID().replaceAll("-", "")}`
      .toLowerCase();
    if (!HANDLE.test(value)) throw new Error("desktop Experience handle generation failed");
    if (!existing.has(value)) return value;
  }
  throw new Error("desktop Experience handle generation collided repeatedly");
}

function validateHandle(value: string): string {
  if (typeof value !== "string" || !HANDLE.test(value)) {
    throw new Error("desktop Experience review handle is invalid or expired");
  }
  return value;
}

function uniqueOutputDirectory(parent: string, deps: Dependencies): Promise<string> {
  const timestamp = new Date(deps.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const attempt = async (remaining: number): Promise<string> => {
    const suffix = deps.randomUUID().replaceAll("-", "").slice(0, 12).toLowerCase();
    if (!/^[0-9a-f]{12}$/.test(suffix)) throw new Error("desktop Experience output identity is invalid");
    const directory = path.join(parent, `agenthist-experience-${timestamp}-${suffix}`);
    try {
      await deps.lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return directory;
      throw error;
    }
    if (remaining <= 1) throw new Error("desktop Experience output name collided repeatedly");
    return attempt(remaining - 1);
  };
  return attempt(4);
}

export function createDesktopExperienceService(
  options: DesktopExperienceServiceOptions,
): DesktopExperienceService {
  safePath(options.stateDirectory, "desktop Experience state directory");
  const ttl = options.reviewHandleTtlMs ?? DEFAULT_DESKTOP_EXPERIENCE_HANDLE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 24 * 60 * 60 * 1000) {
    throw new Error("desktop Experience review handle TTL is invalid");
  }
  const deps: Dependencies = {
    dryRun: options.dryRunExperienceReview ?? dryRunSinglePassExperienceReview,
    prepare: options.prepareExperienceReview ?? prepareSinglePassExperienceReview,
    load: options.loadExperienceReviewPack ?? coreLoadExperienceReviewPack,
    lstat: options.lstat ?? lstat,
    randomUUID: options.randomUUID ?? randomUUID,
    now: options.now ?? Date.now,
  };
  const reviews = new Map<string, ReviewEntry>();
  let pendingReviews = 0;
  let analysisBusy = false;
  let pendingOutput: { readonly previewRef: string; readonly parent: string } | undefined;
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error("desktop Experience service is disposed");
  };

  const closeEntry = (entry: ReviewEntry): void => {
    clearTimeout(entry.timer);
    reviews.delete(entry.handle);
  };

  const expire = (value: string): void => {
    const entry = reviews.get(value);
    if (entry === undefined) return;
    if (entry.busy) {
      entry.expired = true;
      return;
    }
    closeEntry(entry);
  };

  const purge = (): void => {
    const now = deps.now();
    for (const entry of [...reviews.values()]) {
      if (entry.expired || now >= entry.expiresAt) expire(entry.handle);
    }
  };

  const reserve = (): void => {
    assertActive();
    purge();
    if (reviews.size + pendingReviews >= MAX_DESKTOP_EXPERIENCE_HANDLES) {
      throw new Error("too many desktop Experience reviews are open");
    }
    pendingReviews++;
  };

  const register = (packValue: ExperienceReviewPack, directory: string): ReviewEntry => {
    assertActive();
    const pack = validateExperienceReviewPack(packValue);
    const reviewHandle = handle(deps, new Set(reviews.keys()));
    const expiresAt = deps.now() + ttl;
    const timer = setTimeout(() => expire(reviewHandle), ttl);
    timer.unref();
    const entry: ReviewEntry = {
      handle: reviewHandle,
      pack,
      directory,
      directoryName: path.basename(directory),
      expiresAt,
      timer,
      busy: false,
      expired: false,
    };
    reviews.set(reviewHandle, entry);
    return entry;
  };

  const acquire = (raw: string): ReviewEntry => {
    assertActive();
    const value = validateHandle(raw);
    purge();
    const entry = reviews.get(value);
    if (entry === undefined || entry.expired || deps.now() >= entry.expiresAt) {
      if (entry !== undefined) expire(value);
      throw new Error("desktop Experience review handle is invalid or expired");
    }
    if (entry.busy) throw new Error("desktop Experience review already has an operation in progress");
    entry.busy = true;
    return entry;
  };

  const withEntry = async <T>(raw: string, action: (entry: ReviewEntry) => Promise<T> | T): Promise<T> => {
    const entry = acquire(raw);
    try {
      return await action(entry);
    } finally {
      entry.busy = false;
      if (entry.expired && reviews.has(entry.handle)) closeEntry(entry);
    }
  };

  const preview = async (scope: NormalizedScope, cwd: string, configuration?: AnalysisConfiguration, readCapacity = true): Promise<ExperiencePreviewDto> => {
    let capacity = configuration?.fast.contextWindow;
    if (configuration === undefined && readCapacity) {
      try { capacity = (await options.getAnalysisConfiguration?.())?.fast.contextWindow; }
      catch { /* The history preview remains available before API credentials are configured. */ }
    }
    return previewDto(scope, await deps.dryRun({ ...dryOptions(options, cwd, scope),
      ...(capacity === undefined ? {} : { modelContextWindow: capacity }),
    }));
  };

  const withAnalysis = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive();
    if (analysisBusy) throw new Error("another desktop Experience operation is already running");
    analysisBusy = true;
    try {
      return await operation();
    } finally {
      analysisBusy = false;
    }
  };

  return {
    async previewExperience(request) {
      const scope = normalizeScope(request);
      return withAnalysis(async () => preview(scope, await ensurePrivateExperienceDirectory(options.stateDirectory)));
    },

    async runExperience(request, onProgress) {
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("desktop Experience run request is invalid");
      }
      exactKeys(request, ["scope", "expectedPreviewRef"], "desktop Experience run request");
      const scope = normalizeScope(request.scope);
      if (typeof request.expectedPreviewRef !== "string" || !PREVIEW.test(request.expectedPreviewRef)) {
        throw new Error("desktop Experience preview reference is invalid");
      }
      return withAnalysis(async (): Promise<RunExperienceResultDto> => {
        const cwd = await ensurePrivateExperienceDirectory(options.stateDirectory);
        let configuration: AnalysisConfiguration | undefined;
        let configurationError: unknown;
        try { configuration = await options.getAnalysisConfiguration?.(); }
        catch (error) { configurationError = error; }
        const current = await preview(scope, cwd, configuration, false);
        if (current.previewRef !== request.expectedPreviewRef) {
          return { status: "replan_required", preview: current };
        }
        if (current.inputLimitExceeded) throw new OperationError("Single-pass history exceeds the input budget.", { reason: "single_pass_input_too_large", retryable: false, stage: "single_pass" });
        if (configurationError !== undefined) throw configurationError;
        const selectedParent = pendingOutput?.previewRef === current.previewRef
          ? pendingOutput.parent : await options.chooseOutputParent();
        if (selectedParent === undefined) return { status: "cancelled" };
        const parent = await requireRealDirectory(selectedParent, deps, "desktop Experience output parent");
        pendingOutput = { previewRef: current.previewRef, parent };
        const outputDirectory = await uniqueOutputDirectory(parent, deps);
        reserve();
        try {
          const progress = (value: PrepareExperienceReviewProgress): void => {
            onProgress?.(value);
          };
          const result = await deps.prepare({
            ...(configuration === undefined ? {} : { analysisConfiguration: configuration }),
            ...dryOptions(options, cwd, scope),
            cwd,
            environment: options.environment ?? process.env,
            outputDirectory,
            ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
            ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
            onProgress: progress,
          });
          if (result.review === undefined) {
            return { status: "partial", remainingCards: result.plan.remainingCards };
          }
          if (path.normalize(result.review.publication.directory) !== path.normalize(outputDirectory)) {
            throw new Error("desktop Experience published to an unexpected directory");
          }
          const diskPack = await deps.load(result.review.publication.dataFile, cwd);
          if (diskPack.reviewRef !== result.review.pack.reviewRef) {
            throw new Error("desktop Experience published review differs from its result");
          }
          const directory = await requireRealDirectory(
            result.review.publication.directory,
            deps,
            "desktop Experience output directory",
          );
          const entry = register(diskPack, directory);
          pendingOutput = undefined;
          return { status: "completed", review: reviewDto(entry) };
        } finally {
          pendingReviews--;
        }
      });
    },

    async loadExperienceReview() {
      assertActive();
      const selected = await options.chooseReviewPath();
      if (selected === undefined) return { status: "cancelled" };
      reserve();
      try {
        const directory = await selectedReviewDirectory(selected, deps);
        const pack = await deps.load(selected);
        const entry = register(pack, directory);
        return { status: "loaded", review: reviewDto(entry) };
      } finally {
        pendingReviews--;
      }
    },

    async getExperienceCandidate(request) {
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("desktop Experience candidate request is invalid");
      }
      exactKeys(request, ["handle", "candidateRef"], "desktop Experience candidate request");
      if (typeof request.candidateRef !== "string" || !CANDIDATE.test(request.candidateRef)) {
        throw new Error("desktop Experience candidate reference is invalid");
      }
      return withEntry(request.handle, (entry): ExperienceCandidateDetailDto => {
        const candidate = entry.pack.candidates.find((item) => item.candidateRef === request.candidateRef);
        if (candidate === undefined) throw new Error("desktop Experience candidate was not found");
        return {
          ...candidateSummary(candidate),
          relation: candidate.relation,
          evidenceItems: candidate.evidence.map((item) => ({
            occurrenceRef: item.occurrenceRef,
            sessionRef: item.sessionRef,
            agent: item.agent,
            workspace: item.context,
            timestamp: item.timestamp,
            observation: item.observation,
            userText: item.userText,
            assistant: [...item.assistant],
          })),
        };
      });
    },

    async openExperienceOutput(request) {
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("desktop Experience open-output request is invalid");
      }
      exactKeys(request, ["handle"], "desktop Experience open-output request");
      return withEntry(request.handle, async (entry): Promise<OpenExperienceOutputResultDto> => {
        await requireRealDirectory(entry.directory, deps, "desktop Experience output directory");
        const result = await options.openPath(entry.directory);
        if (typeof result === "string" && result !== "") {
          throw new Error("desktop Experience output directory could not be opened");
        }
        return { opened: true };
      });
    },

    async closeExperienceReview(request) {
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("desktop Experience close request is invalid");
      }
      exactKeys(request, ["handle"], "desktop Experience close request");
      const entry = acquire(request.handle);
      closeEntry(entry);
      return { closed: true };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...reviews.values()]) closeEntry(entry);
    },
  };
}
