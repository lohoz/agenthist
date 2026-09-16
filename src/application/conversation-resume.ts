import type { AgentLaunchSpec } from "../agents/contracts.js";
import { isAgent, type Agent } from "../domain/agent.js";
import { canonicalDigest } from "../domain/history-identity.js";
import { sessionAgent } from "../domain/history.js";
import { pathFlavorForPlatform, samePath } from "../domain/host-path.js";
import type { ConversionFinding } from "../domain/conversion.js";
import type { ImportClassification, ImportHistoryResult, ImportRouteQuality } from "./history-import.js";
import {
  openHistoryCatalog,
  type HistoryCatalogEntry,
  type HistorySelectionCatalog,
} from "./history-catalog.js";
import {
  findExistingHistoryTransfer,
  transferHistorySession,
  type ExistingHistoryTransfer,
  type FindExistingHistoryTransferOptions,
  type TransferHistorySessionOptions,
} from "./local-transfer.js";
import { prepareResumeLaunch } from "./resume.js";

export type PlanConversationResumeOptions = FindExistingHistoryTransferOptions;

export interface ConfirmConversationResumeOptions extends FindExistingHistoryTransferOptions {
  readonly expectedPlanRef: string;
}

export type ConversationResumeRoute = "native" | "existing" | "conversion";
export type ConversationResumeQuality = ImportRouteQuality;

export interface ConversationResumeWorkspace {
  readonly source: string;
  readonly target: string;
  readonly status: "unchanged" | "mapped";
}

export interface ConversationResumePlan {
  readonly planRef: string;
  readonly source: HistoryCatalogEntry;
  readonly targetAgent: Agent;
  readonly route: ConversationResumeRoute;
  readonly quality: ConversationResumeQuality;
  readonly findings: readonly ConversionFinding[];
  readonly workspace: ConversationResumeWorkspace;
  readonly blocked: boolean;
  readonly needsWrite: boolean;
  readonly targetSessionRef?: string;
  readonly targetNativeId?: string;
  readonly classification?: ImportClassification;
  readonly provider?: string;
  readonly destination?: string;
}

export type ConversationResumeConfirmation =
  | {
      readonly status: "replan_required";
      readonly plan: ConversationResumePlan;
    }
  | {
      readonly status: "blocked";
      readonly plan: ConversationResumePlan;
    }
  | {
      readonly status: "ready";
      readonly plan: ConversationResumePlan;
      readonly launch: AgentLaunchSpec;
      readonly targetAgent: Agent;
      readonly targetSessionRef: string;
      readonly targetNativeId: string;
      readonly workspace: string;
      readonly transactionRefs: readonly string[];
      readonly transferResult?: ImportHistoryResult;
    };

export interface ConversationResumeDependencies {
  readonly openHistoryCatalog: (
    stateDirectory: string,
    agents?: readonly Agent[],
  ) => Promise<HistorySelectionCatalog>;
  readonly findExistingHistoryTransfer: (
    options: FindExistingHistoryTransferOptions,
  ) => Promise<ExistingHistoryTransfer | undefined>;
  readonly transferHistorySession: (
    options: TransferHistorySessionOptions,
  ) => Promise<ImportHistoryResult>;
  readonly prepareResumeLaunch: typeof prepareResumeLaunch;
}

const DEFAULT_DEPENDENCIES: ConversationResumeDependencies = {
  openHistoryCatalog,
  findExistingHistoryTransfer,
  transferHistorySession,
  prepareResumeLaunch,
};

const PLAN_REFERENCE = /^ahresumeplan1_[0-9a-f]{64}$/;
const MAX_PATH_MAPPINGS = 128;
const MAX_OPTION_BYTES = 64 * 1024;

function dependencies(
  overrides: Partial<ConversationResumeDependencies> | undefined,
): ConversationResumeDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function validateText(value: string, label: string, maximumBytes = MAX_OPTION_BYTES): void {
  if (value === "" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${label} is invalid`);
  }
}

function validateOptions(options: PlanConversationResumeOptions): Agent {
  validateText(options.stateDirectory, "conversation resume state directory");
  validateText(options.sessionRef, "conversation resume session reference", 256);
  const sourceAgent = sessionAgent(options.sessionRef);
  if (sourceAgent === undefined) throw new Error("conversation resume session reference is invalid");
  if (!isAgent(options.targetAgent)) throw new Error("conversation resume target Agent is invalid");
  if ((options.pathMappings?.length ?? 0) > MAX_PATH_MAPPINGS) {
    throw new Error("conversation resume has too many path mappings");
  }
  for (const mapping of options.pathMappings ?? []) validateText(mapping, "conversation resume path mapping");
  for (const [label, value] of [
    ["Codex home", options.codexHome],
    ["Codex SQLite home", options.sqliteHome],
    ["Codex profile", options.profile],
    ["OpenCode data root", options.opencodeDataRoot],
    ["OpenCode database", options.opencodeDatabase],
    ["Claude config root", options.claudeConfigRoot],
    ["Pi session root", options.piSessionRoot],
    ["provider policy", options.providerPolicy],
    ["working directory", options.cwd],
    ["home directory", options.home],
  ] as const) {
    if (value !== undefined) validateText(value, `conversation resume ${label}`);
  }
  return sourceAgent;
}

function transferOptions(
  options: PlanConversationResumeOptions,
  mode: "dry_run" | "apply",
): TransferHistorySessionOptions {
  return {
    stateDirectory: options.stateDirectory,
    sessionRef: options.sessionRef,
    targetAgent: options.targetAgent,
    mode,
    ...(options.allowLossyConversion === undefined
      ? {}
      : { allowLossyConversion: options.allowLossyConversion }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.sqliteHome === undefined ? {} : { sqliteHome: options.sqliteHome }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.opencodeDataRoot === undefined ? {} : { opencodeDataRoot: options.opencodeDataRoot }),
    ...(options.opencodeDatabase === undefined ? {} : { opencodeDatabase: options.opencodeDatabase }),
    ...(options.claudeConfigRoot === undefined ? {} : { claudeConfigRoot: options.claudeConfigRoot }),
    ...(options.piSessionRoot === undefined ? {} : { piSessionRoot: options.piSessionRoot }),
    ...(options.providerPolicy === undefined ? {} : { providerPolicy: options.providerPolicy }),
    ...(options.pathMappings === undefined ? {} : { pathMappings: options.pathMappings }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
  };
}

function existingTransferOptions(
  options: PlanConversationResumeOptions,
): FindExistingHistoryTransferOptions {
  const { mode: _mode, ...existing } = transferOptions(options, "dry_run");
  return existing;
}

function selectedSession(catalog: HistorySelectionCatalog, sessionRef: string): HistoryCatalogEntry {
  const selected = catalog.closeSelection([sessionRef]);
  const session = selected.find((entry) => entry.sessionRef === sessionRef);
  if (session === undefined) throw new Error(`conversation resume session was not found: ${sessionRef}`);
  return session;
}

function completePlan(
  value: Omit<ConversationResumePlan, "planRef" | "blocked">,
): ConversationResumePlan {
  const planRef = `ahresumeplan1_${canonicalDigest({
    source: {
      sessionRef: value.source.sessionRef,
      agent: value.source.agent,
      nativeId: value.source.nativeId,
      workspace: value.source.workspace,
      updatedAt: value.source.updatedAt,
    },
    targetAgent: value.targetAgent,
    route: value.route,
    quality: value.quality,
    findings: value.findings,
    workspace: value.workspace,
    needsWrite: value.needsWrite,
    targetSessionRef: value.targetSessionRef ?? null,
    targetNativeId: value.targetNativeId ?? null,
    classification: value.classification ?? null,
    provider: value.provider ?? null,
    destination: value.destination ?? null,
  })}`;
  return { planRef, ...value, blocked: value.quality === "blocked" };
}

function nativePlan(source: HistoryCatalogEntry): ConversationResumePlan {
  return completePlan({
    source,
    targetAgent: source.agent,
    route: "native",
    quality: "native",
    findings: [],
    workspace: { source: source.workspace, target: source.workspace, status: "unchanged" },
    needsWrite: false,
    targetSessionRef: source.sessionRef,
    targetNativeId: source.nativeId,
    classification: "already_present",
  });
}

function existingPlan(
  source: HistoryCatalogEntry,
  existing: ExistingHistoryTransfer,
  target: HistoryCatalogEntry,
): ConversationResumePlan {
  if (
    existing.sourceSessionRef !== source.sessionRef || existing.targetAgent !== target.agent ||
    existing.targetSessionRef !== target.sessionRef || existing.targetNativeId !== target.nativeId
  ) throw new Error("existing conversation resume target is inconsistent");
  return completePlan({
    source,
    targetAgent: existing.targetAgent,
    route: "existing",
    quality: existing.quality,
    findings: existing.findings,
    workspace: {
      source: source.workspace,
      target: target.workspace,
      status: samePath(source.workspace, target.workspace, pathFlavorForPlatform()) ? "unchanged" : "mapped",
    },
    needsWrite: false,
    targetSessionRef: target.sessionRef,
    targetNativeId: target.nativeId,
    classification: "already_present",
  });
}

function routeFor(
  result: ImportHistoryResult,
  source: HistoryCatalogEntry,
  targetAgent: Agent,
): ImportHistoryResult["routes"][number] | undefined {
  return result.routes.find((route) => route.sourceAgent === source.agent && route.targetAgent === targetAgent);
}

function blockedPlan(
  result: ImportHistoryResult,
  source: HistoryCatalogEntry,
  targetAgent: Agent,
): ConversationResumePlan {
  const blocked = result.blockedSessions.find((item) =>
    item.sourceSessionRef === source.sessionRef && item.targetAgent === targetAgent);
  const route = routeFor(result, source, targetAgent);
  const workspace = result.workspaces.find((item) => item.source === source.workspace) ?? result.workspaces[0];
  return completePlan({
    source,
    targetAgent,
    route: "conversion",
    quality: "blocked",
    findings: blocked?.findings ?? route?.findings ?? [],
    workspace: workspace === undefined
      ? { source: source.workspace, target: source.workspace, status: "unchanged" }
      : { source: workspace.source, target: workspace.target, status: workspace.status },
    needsWrite: false,
  });
}

function convertedPlan(
  result: ImportHistoryResult,
  source: HistoryCatalogEntry,
  targetAgent: Agent,
): ConversationResumePlan {
  const item = result.items.find((candidate) =>
    candidate.sourceSessionRef === source.sessionRef && candidate.targetAgent === targetAgent);
  if (item === undefined || item.quality === "native") {
    throw new Error("conversation resume dry-run omitted its selected conversion");
  }
  return completePlan({
    source,
    targetAgent,
    route: item.classification === "already_present" ? "existing" : "conversion",
    quality: item.quality,
    findings: item.findings,
    workspace: { source: item.sourceCwd, target: item.cwd, status: item.workspaceStatus },
    needsWrite: item.classification === "new",
    targetSessionRef: item.targetSessionRef,
    targetNativeId: item.targetNativeId,
    classification: item.classification,
    provider: item.provider,
    destination: item.destination,
  });
}

function planFromDryRun(
  result: ImportHistoryResult,
  source: HistoryCatalogEntry,
  targetAgent: Agent,
): ConversationResumePlan {
  if (result.mode !== "dry_run") throw new Error("conversation resume planning did not perform a dry-run");
  if (result.status === "blocked") return blockedPlan(result, source, targetAgent);
  if (result.status !== "ready") throw new Error("conversation resume dry-run returned an invalid status");
  return convertedPlan(result, source, targetAgent);
}

export async function planConversationResume(
  options: PlanConversationResumeOptions,
  overrides?: Partial<ConversationResumeDependencies>,
): Promise<ConversationResumePlan> {
  const sourceAgent = validateOptions(options);
  const deps = dependencies(overrides);
  const sourceCatalog = await deps.openHistoryCatalog(options.stateDirectory, [sourceAgent]);
  const source = selectedSession(sourceCatalog, options.sessionRef);
  if (source.agent === options.targetAgent) return nativePlan(source);

  const existing = await deps.findExistingHistoryTransfer(existingTransferOptions(options));
  if (existing !== undefined) {
    const targetCatalog = await deps.openHistoryCatalog(options.stateDirectory, [options.targetAgent]);
    const target = selectedSession(targetCatalog, existing.targetSessionRef);
    return existingPlan(source, existing, target);
  }
  const dryRun = await deps.transferHistorySession(transferOptions(options, "dry_run"));
  return planFromDryRun(dryRun, source, options.targetAgent);
}

function transactionReferences(result: ImportHistoryResult): string[] {
  return result.agents.flatMap((agent) => agent.transactionRef === undefined ? [] : [agent.transactionRef]);
}

export async function confirmConversationResume(
  options: ConfirmConversationResumeOptions,
  overrides?: Partial<ConversationResumeDependencies>,
): Promise<ConversationResumeConfirmation> {
  if (!PLAN_REFERENCE.test(options.expectedPlanRef)) {
    throw new Error("conversation resume confirmation reference is invalid");
  }
  const deps = dependencies(overrides);
  const current = await planConversationResume(options, deps);
  if (current.planRef !== options.expectedPlanRef) return { status: "replan_required", plan: current };
  if (current.quality === "blocked") return { status: "blocked", plan: current };

  let targetSessionRef = current.targetSessionRef;
  let targetNativeId = current.targetNativeId;
  let workspace = current.workspace.target;
  let transferResult: ImportHistoryResult | undefined;
  if (current.needsWrite) {
    transferResult = await deps.transferHistorySession(transferOptions(options, "apply"));
    if (transferResult.mode !== "apply") {
      throw new Error("conversation resume apply returned an invalid mode");
    }
    if (transferResult.status === "blocked") {
      const plan = blockedPlan(transferResult, current.source, current.targetAgent);
      return { status: "replan_required", plan };
    }
    if (transferResult.status !== "completed") {
      throw new Error("conversation resume apply returned an invalid status");
    }
    const imported = transferResult.items.find((item) =>
      item.sourceSessionRef === current.source.sessionRef && item.targetAgent === current.targetAgent);
    if (imported === undefined || imported.quality === "native") {
      throw new Error("conversation resume apply omitted its selected conversion");
    }
    targetSessionRef = imported.targetSessionRef;
    targetNativeId = imported.targetNativeId;
    workspace = imported.cwd;
  }
  if (targetSessionRef === undefined || targetNativeId === undefined) {
    throw new Error("conversation resume target identity is unavailable");
  }
  const launch = deps.prepareResumeLaunch({
    agent: current.targetAgent,
    nativeId: targetNativeId,
    cwd: workspace,
  });
  return {
    status: "ready",
    plan: current,
    launch,
    targetAgent: current.targetAgent,
    targetSessionRef,
    targetNativeId,
    workspace,
    transactionRefs: transferResult === undefined ? [] : transactionReferences(transferResult),
    ...(transferResult === undefined ? {} : { transferResult }),
  };
}
