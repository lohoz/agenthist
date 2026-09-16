import path from "node:path";

import {
  MAX_HISTORY_OFFSET,
} from "../application/history.js";
import { AGENTS, isAgent, type Agent } from "../domain/agent.js";
import { sessionAgent } from "../domain/history.js";
import { parseTransactionReference } from "../domain/transaction.js";
import {
  MAX_TECHNICAL_DETAIL_CHARACTERS,
  MAX_TECHNICAL_DETAIL_CHUNK_CHARACTERS,
} from "./technical-detail.js";
import type {
  CodexProviderUnifyRequest,
  ConfirmCodexProviderUnifyRequest,
  ApplyImportRequest,
  CancelImportRequest,
  ChatMutationRequest,
  ChooseAgentPathRequest,
  ClearAgentPathRequest,
  ConfirmTransactionRequest,
  ConversationFindRequest,
  ConversationRequest,
  DesktopError,
  DesktopResult,
  DesktopSettings,
  ExperienceScopeRequest,
  ExportHistoryRequest,
  GetExperienceCandidateRequest,
  ListChatsRequest,
  MapImportWorkspaceRequest,
  OpenWorkspaceRequest,
  OpenExperienceOutputRequest,
  ResumeConfirmRequest,
  ResumePlanRequest,
  ReplanImportRequest,
  RunExperienceRequest,
  CloseExperienceReviewRequest,
  PlanTransactionRequest,
  TechnicalDetailRequest,
} from "./contracts.js";

const MAX_QUERY_BYTES = 512;

export function validateCodexProviderUnifyRequest(value: unknown): CodexProviderUnifyRequest {
  const request = recordValue(value, "invalid_request", "The provider request is invalid.");
  requireKnownFields(request, ["targetProvider"], "invalid_request", "The provider request is invalid.");
  if (typeof request.targetProvider !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(request.targetProvider)) {
    validationFailure("invalid_request", "Provider ID 只能使用字母、数字、点、下划线和短横线。", "targetProvider");
  }
  return { targetProvider: request.targetProvider as string };
}

export function validateConfirmCodexProviderUnifyRequest(value: unknown): ConfirmCodexProviderUnifyRequest {
  const request = recordValue(value, "invalid_request", "The provider confirmation is invalid.");
  requireKnownFields(request, ["targetProvider", "expectedPlanRef"], "invalid_request", "The provider confirmation is invalid.");
  const target = validateCodexProviderUnifyRequest({ targetProvider: request.targetProvider });
  if (typeof request.expectedPlanRef !== "string" || !/^ahproviderplan1_[0-9a-f]{64}$/u.test(request.expectedPlanRef)) {
    validationFailure("invalid_request", "请先预览 Provider 变更。", "expectedPlanRef");
  }
  return { ...target, expectedPlanRef: request.expectedPlanRef as string };
}
const MAX_QUERY_TERMS = 32;
const MAX_WORKSPACE_BYTES = 32 * 1024;
const MAX_PATH_MAPPING_BYTES = 64 * 1024;
const MAX_PATH_MAPPINGS = 128;
const RESUME_PLAN_REFERENCE = /^ahresumeplan1_[0-9a-f]{64}$/;
const IMPORT_HANDLE = /^ahimport1_[0-9a-f]{64}$/;
const IMPORT_PLAN_REFERENCE = /^ahimportplan1_[0-9a-f]{64}$/;
const MAX_DESKTOP_TRANSFER_SESSIONS = 100_000;
const EXPERIENCE_HANDLE = /^ahexpreview1_[0-9a-f]{64}$/;
const EXPERIENCE_PREVIEW_REFERENCE = /^ahexppreview1_[0-9a-f]{64}$/;
const EXPERIENCE_CANDIDATE_REFERENCE = /^ahcongroup2_[0-9a-f]{64}$/;
const TRANSACTION_PLAN_REFERENCE = /^ahtxplan1_[0-9a-f]{64}$/;
export const MAX_DESKTOP_CHAT_LIMIT = 500;
export const MAX_DESKTOP_CONVERSATION_LIMIT = 200;
export const DEFAULT_DESKTOP_CONVERSATION_LIMIT = 100;

type ValidationCode = "invalid_request" | "invalid_settings";

export class DesktopValidationError extends Error {
  readonly code: ValidationCode;
  readonly field?: string;

  constructor(code: ValidationCode, message: string, field?: string) {
    super(message);
    this.name = "DesktopValidationError";
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

function validationFailure(code: ValidationCode, message: string, field?: string): never {
  throw new DesktopValidationError(code, message, field);
}

function recordValue(
  value: unknown,
  code: ValidationCode,
  message: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    validationFailure(code, message);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) validationFailure(code, message);
  return value as Record<string, unknown>;
}

function requireKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: ValidationCode,
  message: string,
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).find((field) => !known.has(field));
  // Unknown property names are attacker-controlled IPC data. Do not echo
  // them into the structured error details.
  if (unknown !== undefined) validationFailure(code, message);
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    validationFailure("invalid_request", "The request contains an invalid integer.", field);
  }
  return value as number;
}

function boundedString(
  value: unknown,
  field: string,
  maximumBytes: number,
  options: { readonly allowBlank?: boolean; readonly code?: ValidationCode } = {},
): string {
  const code = options.code ?? "invalid_request";
  if (
    typeof value !== "string" || value.includes("\0") ||
    (!options.allowBlank && value.trim() === "") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    validationFailure(code, code === "invalid_settings"
      ? "Desktop settings are invalid."
      : "The request contains invalid text.", field);
  }
  return value;
}

function validSessionReference(value: unknown, code: ValidationCode, field: string): string {
  if (typeof value !== "string" || sessionAgent(value) === undefined) {
    validationFailure(
      code,
      code === "invalid_settings" ? "Desktop settings are invalid." : "The session reference is invalid.",
      field,
    );
  }
  return value as string;
}

function agentArray(value: unknown): readonly Agent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > AGENTS.length) {
    validationFailure("invalid_request", "The Agent filter is invalid.", "agents");
  }
  const agents: Agent[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isAgent(item) || agents.includes(item)) {
      validationFailure("invalid_request", "The Agent filter is invalid.", "agents");
    }
    agents.push(item);
  }
  return agents.length === 0 ? undefined : agents;
}

export function validateListChatsRequest(value: unknown): ListChatsRequest {
  const request = recordValue(value, "invalid_request", "The chat list request is invalid.");
  requireKnownFields(
    request,
    ["query", "agents", "workspace", "workspaceDescendants", "libraryState", "offset", "limit"],
    "invalid_request",
    "The chat list request is invalid.",
  );
  const rawQuery = request.query === undefined
    ? undefined
    : boundedString(request.query, "query", MAX_QUERY_BYTES, { allowBlank: true });
  const normalizedQuery = rawQuery?.normalize("NFKC").trim();
  const query = normalizedQuery === "" ? undefined : normalizedQuery;
  if (query !== undefined && query.split(/\s+/u).length > MAX_QUERY_TERMS) {
    validationFailure("invalid_request", "The search query contains too many terms.", "query");
  }
  const workspace = request.workspace === undefined
    ? undefined
    : boundedString(request.workspace, "workspace", MAX_WORKSPACE_BYTES);
  const libraryState = request.libraryState;
  const workspaceDescendants = request.workspaceDescendants;
  if (workspaceDescendants !== undefined && (typeof workspaceDescendants !== "boolean" || workspace === undefined)) {
    validationFailure("invalid_request", "The workspace subtree filter is invalid.", "workspaceDescendants");
  }
  if (libraryState !== undefined && libraryState !== "active" && libraryState !== "deleted") {
    validationFailure("invalid_request", "The library-state filter is invalid.", "libraryState");
  }
  const agents = agentArray(request.agents);
  const offset = optionalInteger(request.offset, "offset", 0, MAX_HISTORY_OFFSET);
  const limit = optionalInteger(request.limit, "limit", 1, MAX_DESKTOP_CHAT_LIMIT);
  return {
    ...(query === undefined ? {} : { query }),
    ...(agents === undefined ? {} : { agents }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(workspaceDescendants === undefined ? {} : { workspaceDescendants: workspaceDescendants as boolean }),
    ...(libraryState === undefined ? {} : { libraryState }),
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function validateConversationRequest(value: unknown): ConversationRequest {
  const request = recordValue(value, "invalid_request", "The conversation request is invalid.");
  requireKnownFields(
    request,
    ["sessionRef", "offset", "limit"],
    "invalid_request",
    "The conversation request is invalid.",
  );
  const sessionRef = validSessionReference(request.sessionRef, "invalid_request", "sessionRef");
  const offset = optionalInteger(request.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
  const limit = optionalInteger(request.limit, "limit", 1, MAX_DESKTOP_CONVERSATION_LIMIT);
  return {
    sessionRef,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function validateTechnicalDetailRequest(value: unknown): TechnicalDetailRequest {
  const request = recordValue(value, "invalid_request", "The technical detail request is invalid.");
  requireKnownFields(
    request,
    ["sessionRef", "itemIndex", "detailIndex", "offset", "limit"],
    "invalid_request",
    "The technical detail request is invalid.",
  );
  const itemIndex = optionalInteger(request.itemIndex, "itemIndex", 0, 1_000_000);
  const detailIndex = optionalInteger(request.detailIndex, "detailIndex", 0, 1_000_000);
  if (itemIndex === undefined || detailIndex === undefined) {
    validationFailure("invalid_request", "The technical detail indexes are required.");
  }
  return {
    sessionRef: validSessionReference(request.sessionRef, "invalid_request", "sessionRef"),
    itemIndex,
    detailIndex,
    offset: optionalInteger(request.offset, "offset", 0, MAX_TECHNICAL_DETAIL_CHARACTERS) ?? 0,
    limit: optionalInteger(request.limit, "limit", 1, MAX_TECHNICAL_DETAIL_CHUNK_CHARACTERS) ??
      MAX_TECHNICAL_DETAIL_CHUNK_CHARACTERS,
  };
}

export function validateConversationFindRequest(value: unknown): ConversationFindRequest {
  const request = recordValue(value, "invalid_request", "The conversation search request is invalid.");
  requireKnownFields(
    request,
    ["sessionRef", "query"],
    "invalid_request",
    "The conversation search request is invalid.",
  );
  const query = boundedString(request.query, "query", MAX_QUERY_BYTES).normalize("NFKC").trim();
  if (query.split(/\s+/u).length > MAX_QUERY_TERMS) {
    validationFailure("invalid_request", "The search query contains too many terms.", "query");
  }
  return {
    sessionRef: validSessionReference(request.sessionRef, "invalid_request", "sessionRef"),
    query,
  };
}

export function validateChatMutationRequest(value: unknown): ChatMutationRequest {
  const request = recordValue(value, "invalid_request", "The chat update request is invalid.");
  requireKnownFields(
    request,
    ["sessionRef", "operation"],
    "invalid_request",
    "The chat update request is invalid.",
  );
  const operations = new Set(["archive", "unarchive", "delete", "undelete"]);
  if (typeof request.operation !== "string" || !operations.has(request.operation)) {
    validationFailure("invalid_request", "The chat operation is invalid.", "operation");
  }
  return {
    sessionRef: validSessionReference(request.sessionRef, "invalid_request", "sessionRef"),
    operation: request.operation as ChatMutationRequest["operation"],
  };
}

function resumePathMappings(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PATH_MAPPINGS) {
    validationFailure("invalid_request", "The workspace mappings are invalid.", "pathMappings");
  }
  const mappings: string[] = [];
  for (const raw of value) {
    const mapping = boundedString(raw, "pathMappings", MAX_PATH_MAPPING_BYTES);
    const separator = mapping.indexOf("=");
    if (separator <= 0 || separator === mapping.length - 1 || /[\u0000-\u001f\u007f]/u.test(mapping)) {
      validationFailure("invalid_request", "The workspace mappings are invalid.", "pathMappings");
    }
    mappings.push(mapping);
  }
  return mappings.length === 0 ? undefined : mappings;
}

export function validateResumePlanRequest(value: unknown): ResumePlanRequest {
  const request = recordValue(value, "invalid_request", "The resume plan request is invalid.");
  requireKnownFields(
    request,
    ["sessionRef", "targetAgent", "allowLossyConversion", "pathMappings"],
    "invalid_request",
    "The resume plan request is invalid.",
  );
  if (typeof request.targetAgent !== "string" || !isAgent(request.targetAgent)) {
    validationFailure("invalid_request", "The resume target Agent is invalid.", "targetAgent");
  }
  const pathMappings = resumePathMappings(request.pathMappings);
  if (request.allowLossyConversion !== undefined && typeof request.allowLossyConversion !== "boolean") {
    validationFailure("invalid_request", "The lossy conversion option is invalid.", "allowLossyConversion");
  }
  return {
    sessionRef: validSessionReference(request.sessionRef, "invalid_request", "sessionRef"),
    targetAgent: request.targetAgent,
    ...(request.allowLossyConversion === undefined ? {} : { allowLossyConversion: request.allowLossyConversion }),
    ...(pathMappings === undefined ? {} : { pathMappings }),
  };
}

export function validateResumeConfirmRequest(value: unknown): ResumeConfirmRequest {
  const request = recordValue(value, "invalid_request", "The resume confirmation request is invalid.");
  requireKnownFields(
    request,
    ["sessionRef", "targetAgent", "allowLossyConversion", "pathMappings", "expectedPlanRef"],
    "invalid_request",
    "The resume confirmation request is invalid.",
  );
  const plan = validateResumePlanRequest({
    sessionRef: request.sessionRef,
    targetAgent: request.targetAgent,
    ...(request.allowLossyConversion === undefined ? {} : { allowLossyConversion: request.allowLossyConversion }),
    ...(request.pathMappings === undefined ? {} : { pathMappings: request.pathMappings }),
  });
  if (typeof request.expectedPlanRef !== "string" || !RESUME_PLAN_REFERENCE.test(request.expectedPlanRef)) {
    validationFailure("invalid_request", "The resume plan reference is invalid.", "expectedPlanRef");
  }
  return { ...plan, expectedPlanRef: request.expectedPlanRef };
}

export function validateOpenWorkspaceRequest(value: unknown): OpenWorkspaceRequest {
  const request = recordValue(value, "invalid_request", "The workspace request is invalid.");
  requireKnownFields(
    request,
    ["sessionRef"],
    "invalid_request",
    "The workspace request is invalid.",
  );
  return { sessionRef: validSessionReference(request.sessionRef, "invalid_request", "sessionRef") };
}

function importHandle(value: unknown): string {
  if (typeof value !== "string" || !IMPORT_HANDLE.test(value)) {
    validationFailure("invalid_request", "The import handle is invalid or expired.", "handle");
  }
  return value as string;
}

export function validateExportHistoryRequest(value: unknown): ExportHistoryRequest {
  const request = recordValue(value, "invalid_request", "The export request is invalid.");
  if (request.scope === "all") {
    requireKnownFields(request, ["scope"], "invalid_request", "The export request is invalid.");
    return { scope: "all" };
  }
  if (request.scope !== "sessions") {
    validationFailure("invalid_request", "The export scope is invalid.", "scope");
  }
  requireKnownFields(
    request,
    ["scope", "sessionRefs"],
    "invalid_request",
    "The export request is invalid.",
  );
  if (!Array.isArray(request.sessionRefs) || request.sessionRefs.length === 0 ||
    request.sessionRefs.length > MAX_DESKTOP_TRANSFER_SESSIONS) {
    validationFailure("invalid_request", "The export session selection is invalid.", "sessionRefs");
  }
  const sessionRefs = request.sessionRefs.map((reference) =>
    validSessionReference(reference, "invalid_request", "sessionRefs"));
  if (new Set(sessionRefs).size !== sessionRefs.length) {
    validationFailure("invalid_request", "The export session selection contains duplicates.", "sessionRefs");
  }
  return { scope: "sessions", sessionRefs };
}

export function validateReplanImportRequest(value: unknown): ReplanImportRequest {
  const request = recordValue(value, "invalid_request", "The import replan request is invalid.");
  requireKnownFields(
    request,
    ["handle", "targetAgent", "sessionRefs", "allowLossyConversion", "pathMappings"],
    "invalid_request",
    "The import replan request is invalid.",
  );
  if (request.targetAgent !== undefined &&
    (typeof request.targetAgent !== "string" || !isAgent(request.targetAgent))) {
    validationFailure("invalid_request", "The import target Agent is invalid.", "targetAgent");
  }
  if (request.allowLossyConversion !== undefined && typeof request.allowLossyConversion !== "boolean") {
    validationFailure("invalid_request", "The import lossy option is invalid.", "allowLossyConversion");
  }
  let sessionRefs: readonly string[] | undefined;
  if (request.sessionRefs !== undefined) {
    if (!Array.isArray(request.sessionRefs) || request.sessionRefs.length === 0 ||
      request.sessionRefs.length > MAX_DESKTOP_TRANSFER_SESSIONS) {
      validationFailure("invalid_request", "The import session selection is invalid.", "sessionRefs");
    }
    const validated = (request.sessionRefs as unknown[]).map((reference) =>
      validSessionReference(reference, "invalid_request", "sessionRefs"));
    if (new Set(validated).size !== validated.length) {
      validationFailure("invalid_request", "The import session selection contains duplicates.", "sessionRefs");
    }
    sessionRefs = validated;
  }
  const pathMappings = resumePathMappings(request.pathMappings);
  return {
    handle: importHandle(request.handle),
    ...(request.targetAgent === undefined ? {} : { targetAgent: request.targetAgent }),
    ...(sessionRefs === undefined ? {} : { sessionRefs }),
    ...(request.allowLossyConversion === undefined
      ? {}
      : { allowLossyConversion: request.allowLossyConversion }),
    ...(pathMappings === undefined ? {} : { pathMappings }),
  };
}

export function validateMapImportWorkspaceRequest(value: unknown): MapImportWorkspaceRequest {
  const request = recordValue(value, "invalid_request", "The workspace mapping request is invalid.");
  requireKnownFields(
    request,
    ["handle", "source"],
    "invalid_request",
    "The workspace mapping request is invalid.",
  );
  const source = boundedString(request.source, "source", MAX_PATH_MAPPING_BYTES);
  if (
    /[\u0000-\u001f\u007f=]/u.test(source) ||
    !path.win32.isAbsolute(source) && !path.posix.isAbsolute(source)
  ) validationFailure("invalid_request", "The source workspace is invalid.", "source");
  return { handle: importHandle(request.handle), source };
}

export function validateApplyImportRequest(value: unknown): ApplyImportRequest {
  const request = recordValue(value, "invalid_request", "The import apply request is invalid.");
  requireKnownFields(
    request,
    ["handle", "expectedPlanRef"],
    "invalid_request",
    "The import apply request is invalid.",
  );
  if (typeof request.expectedPlanRef !== "string" || !IMPORT_PLAN_REFERENCE.test(request.expectedPlanRef)) {
    validationFailure("invalid_request", "The import plan reference is invalid.", "expectedPlanRef");
  }
  return { handle: importHandle(request.handle), expectedPlanRef: request.expectedPlanRef };
}

export function validateCancelImportRequest(value: unknown): CancelImportRequest {
  const request = recordValue(value, "invalid_request", "The import cancellation request is invalid.");
  requireKnownFields(
    request,
    ["handle"],
    "invalid_request",
    "The import cancellation request is invalid.",
  );
  return { handle: importHandle(request.handle) };
}

export function validateExperienceScopeRequest(value: unknown): ExperienceScopeRequest {
  const request = recordValue(value, "invalid_request", "The Experience scope is invalid.");
  if (request.scope === "all") {
    requireKnownFields(request, ["scope"], "invalid_request", "The Experience scope is invalid.");
    return { scope: "all" };
  }
  if (request.scope !== "sessions") {
    validationFailure("invalid_request", "The Experience scope is invalid.", "scope");
  }
  requireKnownFields(
    request,
    ["scope", "sessionRefs"],
    "invalid_request",
    "The Experience scope is invalid.",
  );
  if (!Array.isArray(request.sessionRefs) || request.sessionRefs.length === 0 ||
    request.sessionRefs.length > MAX_DESKTOP_TRANSFER_SESSIONS) {
    validationFailure("invalid_request", "The Experience session scope is invalid.", "sessionRefs");
  }
  const sessionRefs = request.sessionRefs.map((reference) =>
    validSessionReference(reference, "invalid_request", "sessionRefs")).sort();
  if (new Set(sessionRefs).size !== sessionRefs.length) {
    validationFailure("invalid_request", "The Experience session scope contains duplicates.", "sessionRefs");
  }
  return { scope: "sessions", sessionRefs };
}

export function validateRunExperienceRequest(value: unknown): RunExperienceRequest {
  const request = recordValue(value, "invalid_request", "The Experience run request is invalid.");
  requireKnownFields(
    request,
    ["scope", "expectedPreviewRef"],
    "invalid_request",
    "The Experience run request is invalid.",
  );
  if (typeof request.expectedPreviewRef !== "string" ||
    !EXPERIENCE_PREVIEW_REFERENCE.test(request.expectedPreviewRef)) {
    validationFailure("invalid_request", "The Experience preview reference is invalid.", "expectedPreviewRef");
  }
  return {
    scope: validateExperienceScopeRequest(request.scope),
    expectedPreviewRef: request.expectedPreviewRef,
  };
}

function experienceHandle(value: unknown): string {
  if (typeof value !== "string" || !EXPERIENCE_HANDLE.test(value)) {
    validationFailure("invalid_request", "The Experience review handle is invalid or expired.", "handle");
  }
  return value as string;
}

export function validateGetExperienceCandidateRequest(value: unknown): GetExperienceCandidateRequest {
  const request = recordValue(value, "invalid_request", "The Experience candidate request is invalid.");
  requireKnownFields(
    request,
    ["handle", "candidateRef"],
    "invalid_request",
    "The Experience candidate request is invalid.",
  );
  if (typeof request.candidateRef !== "string" ||
    !EXPERIENCE_CANDIDATE_REFERENCE.test(request.candidateRef)) {
    validationFailure("invalid_request", "The Experience candidate reference is invalid.", "candidateRef");
  }
  return { handle: experienceHandle(request.handle), candidateRef: request.candidateRef };
}

export function validateOpenExperienceOutputRequest(value: unknown): OpenExperienceOutputRequest {
  const request = recordValue(value, "invalid_request", "The Experience output request is invalid.");
  requireKnownFields(
    request,
    ["handle"],
    "invalid_request",
    "The Experience output request is invalid.",
  );
  return { handle: experienceHandle(request.handle) };
}

export function validateCloseExperienceReviewRequest(value: unknown): CloseExperienceReviewRequest {
  const request = recordValue(value, "invalid_request", "The Experience close request is invalid.");
  requireKnownFields(
    request,
    ["handle"],
    "invalid_request",
    "The Experience close request is invalid.",
  );
  return { handle: experienceHandle(request.handle) };
}

function agentPathKind(value: unknown, optional: boolean): "history" | "database" | "executable" | undefined {
  if (optional && value === undefined) return undefined;
  if (value !== "history" && value !== "database" && value !== "executable") {
    validationFailure("invalid_request", "The Agent path kind is invalid.", "kind");
  }
  return value;
}

function agentPathTarget(agentValue: unknown, kindValue: unknown, optionalKind: boolean): {
  readonly agent: Agent;
  readonly kind?: "history" | "database" | "executable";
} {
  if (typeof agentValue !== "string" || !isAgent(agentValue)) {
    validationFailure("invalid_request", "The Agent setting target is invalid.", "agent");
  }
  const kind = agentPathKind(kindValue, optionalKind);
  if (kind === "database" && agentValue !== "codex" && agentValue !== "opencode") {
    validationFailure("invalid_request", "This Agent has no database path setting.", "kind");
  }
  return { agent: agentValue, ...(kind === undefined ? {} : { kind }) };
}

export function validateChooseAgentPathRequest(value: unknown): ChooseAgentPathRequest {
  const request = recordValue(value, "invalid_request", "The Agent path request is invalid.");
  requireKnownFields(
    request,
    ["agent", "kind"],
    "invalid_request",
    "The Agent path request is invalid.",
  );
  const target = agentPathTarget(request.agent, request.kind, false);
  return { agent: target.agent, kind: target.kind! };
}

export function validateClearAgentPathRequest(value: unknown): ClearAgentPathRequest {
  const request = recordValue(value, "invalid_request", "The Agent path clear request is invalid.");
  requireKnownFields(
    request,
    ["agent", "kind"],
    "invalid_request",
    "The Agent path clear request is invalid.",
  );
  return agentPathTarget(request.agent, request.kind, true);
}

function transactionReference(value: unknown): string {
  if (typeof value !== "string") {
    validationFailure("invalid_request", "The transaction reference is invalid.", "transactionRef");
  }
  try { parseTransactionReference(value as string); }
  catch { validationFailure("invalid_request", "The transaction reference is invalid.", "transactionRef"); }
  return value as string;
}

function transactionAction(value: unknown): "rollback" | "recover" {
  if (value !== "rollback" && value !== "recover") {
    validationFailure("invalid_request", "The transaction action is invalid.", "action");
  }
  return value;
}

export function validatePlanTransactionRequest(value: unknown): PlanTransactionRequest {
  const request = recordValue(value, "invalid_request", "The transaction plan request is invalid.");
  requireKnownFields(
    request,
    ["transactionRef", "action"],
    "invalid_request",
    "The transaction plan request is invalid.",
  );
  return {
    transactionRef: transactionReference(request.transactionRef),
    action: transactionAction(request.action),
  };
}

export function validateConfirmTransactionRequest(value: unknown): ConfirmTransactionRequest {
  const request = recordValue(value, "invalid_request", "The transaction confirmation request is invalid.");
  requireKnownFields(
    request,
    ["transactionRef", "action", "expectedPlanRef"],
    "invalid_request",
    "The transaction confirmation request is invalid.",
  );
  if (typeof request.expectedPlanRef !== "string" ||
    !TRANSACTION_PLAN_REFERENCE.test(request.expectedPlanRef)) {
    validationFailure("invalid_request", "The transaction plan reference is invalid.", "expectedPlanRef");
  }
  return {
    transactionRef: transactionReference(request.transactionRef),
    action: transactionAction(request.action),
    expectedPlanRef: request.expectedPlanRef,
  };
}

export function validateDesktopSettings(value: unknown): DesktopSettings {
  const settings = recordValue(value, "invalid_settings", "Desktop settings are invalid.");
  requireKnownFields(
    settings,
    ["theme", "agentFilter", "autoRefresh", "showTechnicalDetails", "firstRunComplete", "lastSessionRef", "experienceAgent"],
    "invalid_settings",
    "Desktop settings are invalid.",
  );
  if (settings.theme !== "system" && settings.theme !== "light" && settings.theme !== "dark") {
    validationFailure("invalid_settings", "Desktop settings are invalid.", "theme");
  }
  if (settings.agentFilter !== "all" &&
    (typeof settings.agentFilter !== "string" || !isAgent(settings.agentFilter))) {
    validationFailure("invalid_settings", "Desktop settings are invalid.", "agentFilter");
  }
  if (typeof settings.autoRefresh !== "boolean") {
    validationFailure("invalid_settings", "Desktop settings are invalid.", "autoRefresh");
  }
  if (typeof settings.showTechnicalDetails !== "boolean") {
    validationFailure("invalid_settings", "Desktop settings are invalid.", "showTechnicalDetails");
  }
  if (typeof settings.firstRunComplete !== "boolean") {
    validationFailure("invalid_settings", "Desktop settings are invalid.", "firstRunComplete");
  }
  if (settings.experienceAgent !== undefined && (typeof settings.experienceAgent !== "string" || !isAgent(settings.experienceAgent))) {
    validationFailure("invalid_settings", "Desktop settings are invalid.", "experienceAgent");
  }
  const lastSessionRef = settings.lastSessionRef === undefined
    ? undefined
    : validSessionReference(settings.lastSessionRef, "invalid_settings", "lastSessionRef");
  return {
    theme: settings.theme,
    agentFilter: settings.agentFilter,
    autoRefresh: settings.autoRefresh,
    showTechnicalDetails: settings.showTechnicalDetails,
    firstRunComplete: settings.firstRunComplete,
    ...(settings.experienceAgent === undefined ? {} : { experienceAgent: settings.experienceAgent as Agent }),
    ...(lastSessionRef === undefined ? {} : { lastSessionRef }),
  };
}

export function redactedDesktopError(
  error: unknown,
  code = "operation_failed",
  retryable = true,
): DesktopError {
  if (error instanceof DesktopValidationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
      ...(error.field === undefined ? {} : { details: { field: error.field } }),
    };
  }
  const rawMessage = error instanceof Error ? error.message : "";
  if (rawMessage.startsWith("Codex rollout contains invalid JSONL: ")) {
    const file = path.basename(rawMessage.slice("Codex rollout contains invalid JSONL: ".length)).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 220);
    return { code: "codex_history_invalid", message: `Codex 历史记录无法解析：${file}。请先检查这条记录，再预览统一操作。`, retryable: true };
  }
  if (/unfinished native write transaction requires recovery|transaction (?:still )?requires recovery/iu.test(rawMessage)) {
    return {
      code: "transaction_recovery_required",
      message: "存在未完成的历史写入事务。请到“设置 → 本地数据 → 事务恢复”完成恢复后重试。",
      retryable: true,
    };
  }
  if (/is not installed or is not available on trusted PATH|configured Agent executable is unavailable/iu.test(rawMessage)) {
    return {
      code: "agent_executable_unavailable",
      message: "目标 Agent 的可执行文件不可用。请在设置中重新选择可执行文件。",
      retryable: true,
    };
  }
  if (/terminal executable is unavailable|terminal launch template is invalid|configured terminal did not start the Coding Agent/iu.test(rawMessage)) {
    return {
      code: "terminal_unavailable",
      message: "命令行终端不可用或启动参数不正确。请先在设置中选择终端并检查默认参数。",
      retryable: true,
    };
  }
  if (/workspace (?:does not exist|is not a real directory)/iu.test(rawMessage)) {
    return {
      code: "workspace_unavailable",
      message: "对话工作区不存在或不可访问。请恢复该目录后重试。",
      retryable: true,
    };
  }
  const operationDetails = error !== null && typeof error === "object" && "details" in error &&
    error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
  const reason = typeof operationDetails?.reason === "string" ? operationDetails.reason : undefined;
  const stage = typeof operationDetails?.stage === "string" ? operationDetails.stage : undefined;
  const knownReasonMessages: Readonly<Record<string, string>> = {
    configuration_missing: "未能从所选 Agent 读取完整的 API 地址、模型或密钥。请检查该 Agent 的现有 API 配置。",
    configuration_invalid: "所选 Agent 的 API 配置格式或协议不受支持。请检查其现有配置。",
    command_not_found: "经验模型 CLI 未找到。请重新配置可执行文件或模型 backend。",
    authentication_failed: "经验模型认证失败。请先在设置中运行“检查模型”。",
    model_not_found: "配置的经验模型不可用。请更换模型后重试。",
    rate_limited: "经验模型请求受到速率限制，请稍后重试。",
    context_limit_exceeded: "经验内容超过模型上下文限制，请缩小分析范围后重试。",
    timeout: "经验模型 API 长时间未返回数据，已停止本次分析。请先运行“检查模型”查看接口状态。",
    dns_failed: "模型 API 域名解析失败。请检查 Agent 中配置的服务地址。",
    connection_failed: "无法连接模型 API。请检查服务地址和网络连接。",
    tls_failed: "模型 API 的 TLS 证书验证失败。",
    upstream_failed: "模型服务商暂时无法处理请求，请检查该模型的渠道状态或稍后重试。",
    endpoint_or_model_not_found: "服务商没有找到配置的 API 路径或模型。",
    request_rejected: "经验模型拒绝了请求。请先在设置中运行“检查模型”。",
    content_rejected: "模型服务商按内容策略拒绝处理这份历史（cyber_policy / content_filter）。此次未生成经验结果，需要服务商侧确认处理权限。",
    protocol_mismatch: "模型 API 未返回完整的预期响应。请检查服务商的协议兼容性。",
    invalid_model_output: "经验模型没有返回有效的结构化结果。请重试或更换模型。",
    response_validation_failed: "经验模型返回内容未通过结构校验。请重试或更换模型。",
    fast_budget_too_small: "经验分析预算过小，无法处理下一批证据。",
    single_pass_input_too_large: "全部历史超过当前模型的单次上下文预算。请选择更大上下文的模型或校正 Agent 的上下文配置；全部对话会保留。",
    single_pass_empty: "所选范围没有可分析的对话。",
  };
  if (reason !== undefined && knownReasonMessages[reason] !== undefined) {
    const retryable = typeof operationDetails?.retryable === "boolean" ? operationDetails.retryable : true;
    return {
      code: `experience_${reason}`,
      message: knownReasonMessages[reason] + (typeof operationDetails?.status === "number" && operationDetails.status >= 400 ? `（HTTP ${operationDetails.status}）` : ""),
      retryable,
      details: {
        reason,
        ...(stage === undefined ? {} : { stage }),
      },
    };
  }
  const fallbackMessages: Readonly<Record<string, string>> = {
    provider_list_failed: "无法读取 Codex 历史 Provider。请检查 Codex 历史目录和数据库路径。",
    provider_preview_failed: "无法预览 Provider 变更。请检查 Codex 历史完整性及是否有待恢复的事务。",
    provider_unify_failed: "Provider 统一未完成。请在事务恢复中检查执行状态后重试。",
    resume_plan_failed: "无法准备对话转换。请先刷新历史，并检查事务恢复与目标 Agent 设置。",
    resume_confirm_failed: "转换写入或 Agent 启动失败。请检查事务恢复、目标 Agent 可执行文件和工作区权限。",
    experience_run_failed: "经验提取未能完成。请先在设置中运行“检查模型”后重试。",
    experience_configuration_check_failed: "经验模型检查未能完成。请检查 CLI 登录状态和模型配置。",
  };
  return {
    code,
    message: fallbackMessages[code] ?? "操作未能完成。",
    retryable,
  };
}

export function desktopFailure<T>(
  error: unknown,
  code?: string,
  retryable?: boolean,
): DesktopResult<T> {
  return {
    ok: false,
    error: redactedDesktopError(error, code, retryable),
  };
}

export function desktopSuccess<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

export function invalidIpcArguments(): DesktopResult<never> {
  return desktopFailure(new DesktopValidationError(
    "invalid_request",
    "The IPC request has an invalid argument count.",
    "arguments",
  ));
}
