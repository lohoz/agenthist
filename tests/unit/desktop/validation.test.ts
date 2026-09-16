import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopValidationError,
  MAX_DESKTOP_CONVERSATION_LIMIT,
  redactedDesktopError,
  validateApplyImportRequest,
  validateCancelImportRequest,
  validateChooseAgentPathRequest,
  validateClearAgentPathRequest,
  validateConfirmTransactionRequest,
  validateCloseExperienceReviewRequest,
  validateChatMutationRequest,
  validateConversationFindRequest,
  validateConversationRequest,
  validateDesktopSettings,
  validateExportHistoryRequest,
  validateExperienceScopeRequest,
  validateGetExperienceCandidateRequest,
  validateListChatsRequest,
  validateMapImportWorkspaceRequest,
  validateOpenWorkspaceRequest,
  validateOpenExperienceOutputRequest,
  validatePlanTransactionRequest,
  validateTechnicalDetailRequest,
  validateResumeConfirmRequest,
  validateResumePlanRequest,
  validateReplanImportRequest,
  validateRunExperienceRequest,
} from "../../../src/desktop/validation.js";

const SESSION_REF = `ahsr1_codex_ck1_${"a".repeat(64)}`;

test("desktop request validation rejects unknown fields and unsafe values", () => {
  assert.throws(
    () => validateListChatsRequest({ query: "ok", surprise: true }),
    (error: unknown) => error instanceof DesktopValidationError && error.field === undefined,
  );
  assert.throws(() => validateListChatsRequest({ agents: ["codex", "codex"] }));
  assert.throws(() => validateListChatsRequest({ workspace: "bad\0path" }));
  assert.throws(
    () => validateListChatsRequest({ libraryState: "archived" }),
    (error: unknown) => error instanceof DesktopValidationError && error.field === "libraryState",
  );
  assert.throws(() => validateConversationRequest({
    sessionRef: SESSION_REF,
    limit: MAX_DESKTOP_CONVERSATION_LIMIT + 1,
  }));
  assert.throws(() => validateConversationFindRequest({ sessionRef: SESSION_REF, query: "   " }));
  assert.throws(() => validateChatMutationRequest({ sessionRef: SESSION_REF, operation: "destroy" }));
});

test("desktop request validation returns canonical copies", () => {
  assert.deepEqual(validateListChatsRequest({
    query: "",
    agents: ["claude", "codex"],
    libraryState: "deleted",
    offset: 2,
    limit: 25,
  }), {
    agents: ["claude", "codex"],
    libraryState: "deleted",
    offset: 2,
    limit: 25,
  });
  assert.deepEqual(validateConversationRequest({ sessionRef: SESSION_REF }), { sessionRef: SESSION_REF });
  assert.deepEqual(validateTechnicalDetailRequest({
    sessionRef: SESSION_REF,
    itemIndex: 2,
    detailIndex: 1,
  }), {
    sessionRef: SESSION_REF,
    itemIndex: 2,
    detailIndex: 1,
    offset: 0,
    limit: 64 * 1024,
  });
  assert.deepEqual(validateChatMutationRequest({ sessionRef: SESSION_REF, operation: "undelete" }), {
    sessionRef: SESSION_REF,
    operation: "undelete",
  });
});

test("technical detail request bounds prevent unbounded IPC payloads", () => {
  assert.throws(() => validateTechnicalDetailRequest({
    sessionRef: SESSION_REF,
    itemIndex: 0,
    detailIndex: 0,
    limit: 64 * 1024 + 1,
  }));
  assert.throws(() => validateTechnicalDetailRequest({
    sessionRef: SESSION_REF,
    itemIndex: -1,
    detailIndex: 0,
  }));
  assert.throws(() => validateTechnicalDetailRequest({
    sessionRef: SESSION_REF,
    itemIndex: 0,
    detailIndex: 0,
    outputPath: "C:\\private",
  }));
});

test("desktop settings validation is exact", () => {
  const settings = {
    theme: "dark",
    agentFilter: "pi",
    autoRefresh: false,
    showTechnicalDetails: true,
    firstRunComplete: true,
    lastSessionRef: SESSION_REF,
  } as const;
  assert.deepEqual(validateDesktopSettings(settings), settings);
  assert.throws(() => validateDesktopSettings({ ...settings, extra: "no" }));
  assert.throws(() => validateDesktopSettings({ ...settings, theme: "midnight" }));
  assert.throws(() => validateDesktopSettings({ ...settings, lastSessionRef: "native-id" }));
});

test("resume and workspace requests expose no command, cwd, or arbitrary path surface", () => {
  const planRef = `ahresumeplan1_${"b".repeat(64)}`;
  assert.deepEqual(validateResumePlanRequest({
    sessionRef: SESSION_REF,
    targetAgent: "claude",
    allowLossyConversion: true,
    pathMappings: ["C:\\source=D:\\target"],
  }), {
    sessionRef: SESSION_REF,
    targetAgent: "claude",
    allowLossyConversion: true,
    pathMappings: ["C:\\source=D:\\target"],
  });
  assert.deepEqual(validateResumeConfirmRequest({
    sessionRef: SESSION_REF,
    targetAgent: "claude",
    expectedPlanRef: planRef,
  }), {
    sessionRef: SESSION_REF,
    targetAgent: "claude",
    expectedPlanRef: planRef,
  });
  assert.deepEqual(validateOpenWorkspaceRequest({ sessionRef: SESSION_REF }), { sessionRef: SESSION_REF });
  assert.throws(() => validateResumePlanRequest({
    sessionRef: SESSION_REF,
    targetAgent: "claude",
    command: "cmd.exe",
  }));
  assert.throws(() => validateResumeConfirmRequest({
    sessionRef: SESSION_REF,
    targetAgent: "claude",
    expectedPlanRef: "stale",
  }));
  assert.throws(() => validateResumePlanRequest({
    sessionRef: SESSION_REF,
    targetAgent: "claude",
    pathMappings: ["missing-separator"],
  }));
  assert.throws(() => validateResumePlanRequest({
    sessionRef: SESSION_REF,
    targetAgent: "claude",
    allowLossyConversion: "yes",
  }));
  assert.throws(() => validateOpenWorkspaceRequest({
    sessionRef: SESSION_REF,
    path: "C:\\arbitrary",
  }));
});

test("desktop transfer requests retain only opaque handles and selected sessions", () => {
  const handle = `ahimport1_${"c".repeat(64)}`;
  const planRef = `ahimportplan1_${"d".repeat(64)}`;
  assert.deepEqual(validateExportHistoryRequest({ scope: "all" }), { scope: "all" });
  assert.deepEqual(validateExportHistoryRequest({ scope: "sessions", sessionRefs: [SESSION_REF] }), {
    scope: "sessions",
    sessionRefs: [SESSION_REF],
  });
  assert.deepEqual(validateReplanImportRequest({
    handle,
    targetAgent: "pi",
    sessionRefs: [SESSION_REF],
    allowLossyConversion: true,
    pathMappings: ["C:\\source=D:\\target"],
  }), {
    handle,
    targetAgent: "pi",
    sessionRefs: [SESSION_REF],
    allowLossyConversion: true,
    pathMappings: ["C:\\source=D:\\target"],
  });
  assert.deepEqual(validateApplyImportRequest({ handle, expectedPlanRef: planRef }), {
    handle,
    expectedPlanRef: planRef,
  });
  assert.deepEqual(validateCancelImportRequest({ handle }), { handle });
  assert.deepEqual(validateMapImportWorkspaceRequest({ handle, source: "/home/source project" }), {
    handle,
    source: "/home/source project",
  });
  assert.deepEqual(validateMapImportWorkspaceRequest({ handle, source: "C:\\source project" }), {
    handle,
    source: "C:\\source project",
  });
  assert.throws(() => validateExportHistoryRequest({
    scope: "sessions",
    sessionRefs: [SESSION_REF, SESSION_REF],
  }));
  assert.throws(() => validateReplanImportRequest({ handle, sourceFile: "C:\\private.agenthist" }));
  assert.throws(() => validateReplanImportRequest({ handle, allowLossyConversion: "yes" }));
  assert.throws(() => validateApplyImportRequest({ handle, expectedPlanRef: "stale" }));
  assert.throws(() => validateCancelImportRequest({ handle: "forged" }));
  assert.throws(() => validateMapImportWorkspaceRequest({ handle, source: "relative/path" }));
  assert.throws(() => validateMapImportWorkspaceRequest({
    handle,
    source: "/source",
    target: "C:\\renderer-controlled",
  }));
});

test("desktop Experience requests expose only scopes and opaque review identities", () => {
  const handle = `ahexpreview1_${"e".repeat(64)}`;
  const previewRef = `ahexppreview1_${"f".repeat(64)}`;
  const candidateRef = `ahcongroup2_${"1".repeat(64)}`;
  assert.deepEqual(validateExperienceScopeRequest({
    scope: "sessions",
    sessionRefs: [SESSION_REF],
  }), {
    scope: "sessions",
    sessionRefs: [SESSION_REF],
  });
  assert.deepEqual(validateRunExperienceRequest({
    scope: { scope: "all" },
    expectedPreviewRef: previewRef,
  }), {
    scope: { scope: "all" },
    expectedPreviewRef: previewRef,
  });
  assert.deepEqual(validateGetExperienceCandidateRequest({ handle, candidateRef }), {
    handle,
    candidateRef,
  });
  assert.deepEqual(validateOpenExperienceOutputRequest({ handle }), { handle });
  assert.deepEqual(validateCloseExperienceReviewRequest({ handle }), { handle });
  assert.throws(() => validateExperienceScopeRequest({ scope: "all", outputDirectory: "C:\\private" }));
  assert.throws(() => validateRunExperienceRequest({ scope: { scope: "all" }, expectedPreviewRef: "stale" }));
  assert.throws(() => validateGetExperienceCandidateRequest({ handle, candidateRef: "forged" }));
  assert.throws(() => validateOpenExperienceOutputRequest({ handle: "forged" }));
});

test("Agent path requests reject unsupported database and renderer-supplied paths", () => {
  assert.deepEqual(validateChooseAgentPathRequest({ agent: "codex", kind: "database" }), {
    agent: "codex",
    kind: "database",
  });
  assert.deepEqual(validateChooseAgentPathRequest({ agent: "opencode", kind: "executable" }), {
    agent: "opencode",
    kind: "executable",
  });
  assert.deepEqual(validateClearAgentPathRequest({ agent: "pi" }), { agent: "pi" });
  assert.deepEqual(validateClearAgentPathRequest({ agent: "claude", kind: "history" }), {
    agent: "claude",
    kind: "history",
  });
  assert.throws(() => validateChooseAgentPathRequest({ agent: "claude", kind: "database" }));
  assert.throws(() => validateClearAgentPathRequest({ agent: "pi", kind: "database" }));
  assert.throws(() => validateChooseAgentPathRequest({
    agent: "codex",
    kind: "history",
    path: "C:\\renderer-controlled",
  }));
  assert.throws(() => validateChooseAgentPathRequest({ agent: "unknown", kind: "history" }));
});

test("transaction requests accept only opaque references, actions, and plan references", () => {
  const transactionRef = "ahtx1_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const expectedPlanRef = `ahtxplan1_${"b".repeat(64)}`;
  assert.deepEqual(validatePlanTransactionRequest({ transactionRef, action: "rollback" }), {
    transactionRef,
    action: "rollback",
  });
  assert.deepEqual(validateConfirmTransactionRequest({
    transactionRef,
    action: "recover",
    expectedPlanRef,
  }), {
    transactionRef,
    action: "recover",
    expectedPlanRef,
  });
  assert.throws(() => validatePlanTransactionRequest({ transactionRef, action: "delete" }));
  assert.throws(() => validatePlanTransactionRequest({ transactionRef: "forged", action: "recover" }));
  assert.throws(() => validateConfirmTransactionRequest({
    transactionRef,
    action: "recover",
    expectedPlanRef: "stale",
  }));
  assert.throws(() => validatePlanTransactionRequest({ transactionRef, action: "recover", apply: true }));
});

test("desktop errors redact arbitrary exception messages", () => {
  const error = redactedDesktopError(new Error("C:\\private\\history api_key=secret"), "history_unavailable");
  assert.deepEqual(error, {
    code: "history_unavailable",
    message: "操作未能完成。",
    retryable: true,
  });
  assert.equal(JSON.stringify(error).includes("secret"), false);

  assert.equal(
    redactedDesktopError(
      new Error("unfinished native write transaction requires recovery: ahtx1_private"),
      "resume_plan_failed",
    ).code,
    "transaction_recovery_required",
  );
  assert.deepEqual(redactedDesktopError(Object.assign(new Error("private"), {
    details: { reason: "timeout", stage: "fast_discovery", retryable: true, apiKey: "secret" },
  }), "experience_run_failed"), {
    code: "experience_timeout",
    message: "经验模型 API 长时间未返回数据，已停止本次分析。请先运行“检查模型”查看接口状态。",
    retryable: true,
    details: { reason: "timeout", stage: "fast_discovery" },
  });
});
