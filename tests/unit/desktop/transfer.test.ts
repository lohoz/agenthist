import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ExportHistoryOptions,
  ExportHistoryPlan,
  ExportHistoryResult,
  ImportHistoryOptions,
  ImportHistoryResult,
  ImportCatalog,
} from "../../../src/application/index.js";
import type { Agent } from "../../../src/domain/agent.js";
import type { ConversionFinding } from "../../../src/domain/conversion.js";
import { createDesktopTransferService } from "../../../src/desktop/transfer.js";

function sessionRef(agent: Agent, digit: string): string {
  return `ahsr1_${agent}_ck1_${digit.repeat(64)}`;
}

const degradedFinding: ConversionFinding = {
  code: "fixture.reconstructed",
  disposition: "synthesized",
  count: 1,
};

function importResult(
  mode: "dry_run" | "apply",
  options: {
    readonly sourceAgent?: Agent;
    readonly targetAgent?: Agent;
    readonly quality?: "native" | "exact" | "degraded";
    readonly classification?: "new" | "already_present" | "conflict";
    readonly blocked?: boolean;
    readonly sourceWorkspace?: string;
    readonly targetWorkspace?: string;
  } = {},
): ImportHistoryResult {
  const sourceAgent = options.sourceAgent ?? "codex";
  const targetAgent = options.targetAgent ?? sourceAgent;
  const quality = options.quality ?? (sourceAgent === targetAgent ? "native" : "degraded");
  const classification = options.classification ?? "new";
  const sourceWorkspace = options.sourceWorkspace ?? "C:\\源 项目";
  const targetWorkspace = options.targetWorkspace ?? sourceWorkspace;
  const findings = quality === "degraded" ? [degradedFinding] : [];
  if (options.blocked) {
    const blockedFinding: ConversionFinding = {
      code: "fixture.unsupported",
      disposition: "blocked",
      count: 1,
    };
    return {
      mode,
      status: "blocked",
      selectedSessions: 1,
      newSessions: 0,
      written: 0,
      alreadyPresent: 0,
      blocked: 1,
      blockedSessions: [{
        sourceAgent,
        targetAgent,
        sourceSessionRef: sessionRef(sourceAgent, "1"),
        findings: [blockedFinding],
      }],
      routes: [{ sourceAgent, targetAgent, quality: "blocked", sessions: 1, findings: [blockedFinding] }],
      agents: [],
      workspaces: [{
        source: sourceWorkspace,
        target: targetWorkspace,
        status: sourceWorkspace === targetWorkspace ? "unchanged" : "mapped",
        agents: [targetAgent],
        sessions: 1,
      }],
      items: [],
      resources: [],
    };
  }
  const isNew = classification === "new";
  const existing = classification === "already_present";
  return {
    mode,
    status: mode === "dry_run" ? "ready" : "completed",
    selectedSessions: 1,
    newSessions: isNew ? 1 : 0,
    written: mode === "apply" && isNew ? 1 : 0,
    alreadyPresent: existing ? 1 : 0,
    blocked: 0,
    blockedSessions: [],
    routes: [{ sourceAgent, targetAgent, quality, sessions: 1, findings }],
    agents: [{
      agent: targetAgent,
      target: { root: "C:\\agent target" },
      newSessions: isNew ? 1 : 0,
      written: mode === "apply" && isNew ? 1 : 0,
      alreadyPresent: existing ? 1 : 0,
      ...(mode === "apply" && isNew
        ? { transactionRef: "ahtx1_00000000-0000-4000-8000-000000000001" }
        : {}),
    }],
    workspaces: [{
      source: sourceWorkspace,
      target: targetWorkspace,
      status: sourceWorkspace === targetWorkspace ? "unchanged" : "mapped",
      agents: [targetAgent],
      sessions: 1,
    }],
    items: [{
      sourceAgent,
      targetAgent,
      sourceSessionRef: sessionRef(sourceAgent, "1"),
      targetSessionRef: sessionRef(targetAgent, "2"),
      targetNativeId: `${targetAgent}-native-target`,
      quality,
      findings,
      classification,
      destination: "C:\\agent target\\session.jsonl",
      provider: "fixture-provider",
      sourceCwd: sourceWorkspace,
      cwd: targetWorkspace,
      workspaceStatus: sourceWorkspace === targetWorkspace ? "unchanged" : "mapped",
      ...(classification === "conflict" ? { reason: "fixture conflict" } : {}),
    }],
    resources: [],
  };
}

function exportPlan(file: string): ExportHistoryPlan {
  return {
    file,
    entries: 1,
    objects: 1,
    resources: 0,
    agents: [{ agent: "codex", sessions: 1 }],
    items: [{
      agent: "codex",
      sessionRef: sessionRef("codex", "1"),
      title: "Fixture",
      workspace: "C:\\项目 空格",
    }],
    skippedSessions: [],
  };
}

function exportResult(file: string): ExportHistoryResult {
  const bytes = Buffer.from("fixture archive", "utf8");
  return {
    file,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    entries: 1,
    objects: 1,
    resources: 0,
    agents: [{ agent: "codex", sessions: 1 }],
    skippedSessions: [],
  };
}

interface CatalogWorkspaceFixture {
  readonly source: string;
  readonly agent?: Agent;
  readonly digit?: string;
  readonly availability?: "available" | "missing" | "unsafe";
}

function catalogDependency(
  fixtures: readonly CatalogWorkspaceFixture[] = [{ source: "C:\\源 项目" }],
  onClose?: () => void,
): (file: string) => Promise<ImportCatalog> {
  return async (file) => {
    const bytes = await readFile(file);
    const info = await lstat(file);
    const entries = fixtures.map((fixture, index) => {
      const agent = fixture.agent ?? "codex";
      const digit = fixture.digit ?? String(index + 1);
      return {
        sessionRef: sessionRef(agent, digit),
        agent,
        nativeId: `${agent}-native-${digit}`,
        title: `Fixture ${digit}`,
        workspace: fixture.source,
        model: "fixture-model",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        nativeArchived: false,
        libraryState: "active" as const,
        tags: [],
        resourceCount: 0,
      };
    });
    return {
      file,
      sizeBytes: info.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      entries,
      closeSelection(references) {
        return entries.filter((entry) => references.includes(entry.sessionRef));
      },
      async inspectWorkspaces(references, destinations, mappings) {
        return entries.filter((entry) => references.includes(entry.sessionRef)).map((entry) => {
          const mapping = mappings.find((value) => value.slice(0, value.indexOf("=")) === entry.workspace);
          const fixture = fixtures.find((value) => value.source === entry.workspace)!;
          return {
            source: entry.workspace,
            target: mapping === undefined ? entry.workspace : mapping.slice(mapping.indexOf("=") + 1),
            status: mapping === undefined ? "unchanged" as const : "mapped" as const,
            availability: mapping === undefined ? fixture.availability ?? "available" : "available" as const,
            agents: [destinations[entry.sessionRef] ?? entry.agent],
            sessionRefs: [entry.sessionRef],
          };
        });
      },
      async preview(reference) {
        const entry = entries.find((candidate) => candidate.sessionRef === reference)!;
        return { ...entry, conversation: [] };
      },
      async close() { onClose?.(); },
    } as ImportCatalog;
  };
}

test("desktop export uses only the system picker, supports cancellation, and never overwrites", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-export-"));
  const output = path.join(root, "中文 backup.agenthist");
  const existing = path.join(root, "existing.agenthist");
  const picks: Array<string | undefined> = [undefined, output, existing, "relative.agenthist"];
  const plans: ExportHistoryOptions[] = [];
  const exports: ExportHistoryOptions[] = [];
  try {
    await writeFile(existing, "preserve", "utf8");
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      chooseOpenFile: async () => undefined,
      chooseSaveFile: async () => picks.shift(),
      async planExportHistory(options) {
        plans.push(options);
        return exportPlan(options.output!);
      },
      async exportHistory(options) {
        exports.push(options);
        await writeFile(options.output!, "fixture archive", "utf8");
        return exportResult(options.output!);
      },
    });
    assert.deepEqual(await service.exportHistory({ scope: "all" }), { status: "cancelled" });
    const completed = await service.exportHistory({
      scope: "sessions",
      sessionRefs: [sessionRef("codex", "1")],
    });
    assert.equal(completed.status, "completed");
    if (completed.status !== "completed") return;
    assert.equal(completed.file, output);
    assert.equal(plans[0]!.strictSessions, true);
    assert.deepEqual(plans[0]!.sessions, [sessionRef("codex", "1")]);
    assert.equal(exports.length, 1);
    await assert.rejects(service.exportHistory({ scope: "all" }), /never overwrites/);
    assert.equal(await readFile(existing, "utf8"), "preserve");
    await assert.rejects(service.exportHistory({ scope: "all" }), /absolute \.agenthist path/);
    assert.equal(plans.length, 1);
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop import keeps the picker path opaque, replans degraded routes, and applies the frozen bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-import-"));
  const source = path.join(root, "历史 archive 空格.agenthist");
  const calls: ImportHistoryOptions[] = [];
  try {
    await writeFile(source, "stable archive bytes", "utf8");
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      chooseOpenFile: async () => source,
      chooseSaveFile: async () => undefined,
      openImportCatalog: catalogDependency(),
      async importHistoryArchive(options) {
        calls.push(options);
        assert.notEqual(options.file, source);
        assert.equal(path.extname(options.file), ".agenthist");
        assert.equal(await readFile(options.file, "utf8"), "stable archive bytes");
        return options.targetAgent === "claude"
          ? importResult(options.mode, {
              targetAgent: "claude",
              quality: "degraded",
              sourceWorkspace: "C:\\源 项目",
              targetWorkspace: "D:\\目标 项目",
            })
          : importResult(options.mode);
      },
    });
    const opened = await service.openImport();
    assert.equal(opened.status, "planned");
    if (opened.status !== "planned") return;
    assert.equal(opened.plan.fileName, path.basename(source));
    assert.equal(JSON.stringify(opened.plan).includes(root), false);
    assert.equal(opened.plan.routes[0]!.quality, "native");

    const mapped = "C:\\源 项目=D:\\目标 项目";
    const replanned = await service.replanImport({
      handle: opened.plan.handle,
      targetAgent: "claude",
      sessionRefs: [sessionRef("codex", "1")],
      allowLossyConversion: true,
      pathMappings: [mapped],
    });
    assert.equal(replanned.status, "ready");
    assert.equal(replanned.routes[0]!.quality, "degraded");
    assert.deepEqual(replanned.routes[0]!.findings, [degradedFinding]);
    assert.equal(replanned.workspaces[0]!.status, "mapped");
    assert.equal(replanned.transactionRequired, true);

    const applied = await service.applyImport({
      handle: replanned.handle,
      expectedPlanRef: replanned.planRef,
    });
    assert.equal(applied.status, "completed");
    if (applied.status !== "completed") return;
    assert.equal(applied.fileName, path.basename(source));
    assert.equal(applied.written, 1);
    assert.deepEqual(applied.transactionRefs, ["ahtx1_00000000-0000-4000-8000-000000000001"]);
    assert.deepEqual(calls.map((call) => call.mode), ["dry_run", "dry_run", "dry_run", "apply"]);
    assert.equal(calls.at(-1)!.targetAgent, "claude");
    assert.deepEqual(calls.at(-1)!.sessions, [sessionRef("codex", "1")]);
    assert.equal(calls.at(-1)!.allowLossyConversion, true);
    assert.deepEqual(calls.at(-1)!.pathMappings, [mapped]);
    assert.equal(new Set(calls.map((call) => call.file)).size >= 2, true);
    await assert.rejects(
      service.cancelImport({ handle: opened.plan.handle }),
      /invalid or expired/,
    );
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocked and conflicting import plans never call apply", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-blocked-"));
  const blockedFile = path.join(root, "blocked.agenthist");
  const conflictFile = path.join(root, "conflict.agenthist");
  let selected = blockedFile;
  let applyCalls = 0;
  try {
    await writeFile(blockedFile, "blocked bytes", "utf8");
    await writeFile(conflictFile, "conflict bytes", "utf8");
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      chooseOpenFile: async () => selected,
      chooseSaveFile: async () => undefined,
      openImportCatalog: catalogDependency(),
      async importHistoryArchive(options) {
        if (options.mode === "apply") applyCalls++;
        return selected === blockedFile
          ? options.targetAgent === "claude"
            ? importResult(options.mode, { targetAgent: "claude", blocked: true })
            : importResult(options.mode)
          : importResult(options.mode, { classification: "conflict" });
      },
    });
    const openedBlocked = await service.openImport();
    assert.equal(openedBlocked.status, "planned");
    if (openedBlocked.status !== "planned") return;
    const blocked = await service.replanImport({
      handle: openedBlocked.plan.handle,
      targetAgent: "claude",
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked, 1);
    const blockedApply = await service.applyImport({
      handle: blocked.handle,
      expectedPlanRef: blocked.planRef,
    });
    assert.equal(blockedApply.status, "blocked");
    assert.equal(applyCalls, 0);
    await service.cancelImport({ handle: blocked.handle });

    selected = conflictFile;
    const conflict = await service.openImport();
    assert.equal(conflict.status, "planned");
    if (conflict.status !== "planned") return;
    assert.equal(conflict.plan.status, "blocked");
    assert.equal(conflict.plan.conflicts, 1);
    const conflictApply = await service.applyImport({
      handle: conflict.plan.handle,
      expectedPlanRef: conflict.plan.planRef,
    });
    assert.equal(conflictApply.status, "blocked");
    assert.equal(applyCalls, 0);
    await service.cancelImport({ handle: conflict.plan.handle });
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import apply returns replan_required for target-state and selected-file TOCTOU changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-replan-"));
  const source = path.join(root, "changing.agenthist");
  let dryRuns = 0;
  let applyCalls = 0;
  try {
    await writeFile(source, "version one", "utf8");
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      chooseOpenFile: async () => source,
      chooseSaveFile: async () => undefined,
      openImportCatalog: catalogDependency(),
      async importHistoryArchive(options) {
        if (options.mode === "apply") {
          applyCalls++;
          return importResult("apply", { targetAgent: "claude", quality: "degraded" });
        }
        if (options.targetAgent === undefined) return importResult("dry_run");
        dryRuns++;
        return importResult("dry_run", {
          targetAgent: "claude",
          quality: dryRuns === 1 ? "exact" : "degraded",
        });
      },
    });
    const opened = await service.openImport();
    assert.equal(opened.status, "planned");
    if (opened.status !== "planned") return;
    const planned = await service.replanImport({
      handle: opened.plan.handle,
      targetAgent: "claude",
    });
    assert.equal(planned.routes[0]!.quality, "exact");
    const stateChanged = await service.applyImport({
      handle: opened.plan.handle,
      expectedPlanRef: planned.planRef,
    });
    assert.equal(stateChanged.status, "replan_required");
    if (stateChanged.status !== "replan_required") return;
    assert.equal(stateChanged.plan.routes[0]!.quality, "degraded");
    assert.equal(applyCalls, 0);

    await writeFile(source, "version two with different bytes", "utf8");
    const fileChanged = await service.applyImport({
      handle: opened.plan.handle,
      expectedPlanRef: stateChanged.plan.planRef,
    });
    assert.equal(fileChanged.status, "replan_required");
    if (fileChanged.status !== "replan_required") return;
    assert.notEqual(fileChanged.plan.planRef, stateChanged.plan.planRef);
    assert.equal(applyCalls, 0);
    await service.cancelImport({ handle: opened.plan.handle });
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opaque import handles reject forgery, serialize operations, expire, and dispose", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-handles-"));
  const source = path.join(root, "handle.agenthist");
  let now = 100;
  let blockNext = false;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  try {
    await writeFile(source, "handle bytes", "utf8");
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      chooseOpenFile: async () => source,
      chooseSaveFile: async () => undefined,
      openImportCatalog: catalogDependency(),
      now: () => now,
      importHandleTtlMs: 1_000,
      async importHistoryArchive(options) {
        if (blockNext) {
          blockNext = false;
          entered?.();
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return importResult(options.mode);
      },
    });
    await assert.rejects(
      service.cancelImport({ handle: `ahimport1_${"0".repeat(64)}` }),
      /invalid or expired/,
    );
    const opened = await service.openImport();
    assert.equal(opened.status, "planned");
    if (opened.status !== "planned") return;

    const started = new Promise<void>((resolve) => { entered = resolve; });
    blockNext = true;
    const pending = service.replanImport({ handle: opened.plan.handle });
    await started;
    await assert.rejects(
      service.cancelImport({ handle: opened.plan.handle }),
      /operation in progress/,
    );
    release?.();
    await pending;
    await service.cancelImport({ handle: opened.plan.handle });
    await assert.rejects(service.replanImport({ handle: opened.plan.handle }), /invalid or expired/);

    const expiring = await service.openImport();
    assert.equal(expiring.status, "planned");
    if (expiring.status !== "planned") return;
    now = 1_101;
    await assert.rejects(service.replanImport({ handle: expiring.plan.handle }), /invalid or expired/);
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed handle cleanup remains registered for a disposal retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-cleanup-retry-"));
  const source = path.join(root, "cleanup.agenthist");
  let workspace = "";
  let removalCalls = 0;
  try {
    await writeFile(source, "cleanup bytes", "utf8");
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      chooseOpenFile: async () => source,
      chooseSaveFile: async () => undefined,
      openImportCatalog: catalogDependency(),
      async importHistoryArchive(options) { return importResult(options.mode); },
      async makeTempDirectory() {
        workspace = await mkdtemp(path.join(root, "private-workspace-"));
        return workspace;
      },
      async removeDirectory(directory) {
        removalCalls++;
        if (removalCalls === 1) throw new Error("simulated Windows file lock");
        await rm(directory, { recursive: true, force: true });
      },
    });
    const opened = await service.openImport();
    assert.equal(opened.status, "planned");
    if (opened.status !== "planned") return;

    await assert.rejects(
      service.cancelImport({ handle: opened.plan.handle }),
      /simulated Windows file lock/,
    );
    await assert.doesNotReject(access(workspace));
    await service.dispose();
    assert.equal(removalCalls, 2);
    await assert.rejects(access(workspace));
    await assert.rejects(service.openImport(), /closing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup failure cannot turn an authoritative completed import into an apply failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-apply-cleanup-"));
  const source = path.join(root, "apply-cleanup.agenthist");
  let workspace = "";
  let removalCalls = 0;
  try {
    await writeFile(source, "apply cleanup bytes", "utf8");
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      chooseOpenFile: async () => source,
      chooseSaveFile: async () => undefined,
      openImportCatalog: catalogDependency(),
      async importHistoryArchive(options) { return importResult(options.mode); },
      async makeTempDirectory() {
        workspace = await mkdtemp(path.join(root, "private-workspace-"));
        return workspace;
      },
      async removeDirectory(directory) {
        removalCalls++;
        if (removalCalls === 1) throw new Error("simulated cleanup failure after apply");
        await rm(directory, { recursive: true, force: true });
      },
    });
    const opened = await service.openImport();
    assert.equal(opened.status, "planned");
    if (opened.status !== "planned") return;
    const applied = await service.applyImport({
      handle: opened.plan.handle,
      expectedPlanRef: opened.plan.planRef,
    });
    assert.equal(applied.status, "completed");
    assert.equal(removalCalls, 1);
    await assert.doesNotReject(access(workspace));
    await service.dispose();
    assert.equal(removalCalls, 2);
    await assert.rejects(access(workspace));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispose attempts every handle cleanup and can retry only the failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-cleanup-all-"));
  const source = path.join(root, "cleanup-all.agenthist");
  const workspaces: string[] = [];
  const removals = new Map<string, number>();
  let failFirst = true;
  try {
    await writeFile(source, "cleanup all bytes", "utf8");
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      chooseOpenFile: async () => source,
      chooseSaveFile: async () => undefined,
      openImportCatalog: catalogDependency(),
      async importHistoryArchive(options) { return importResult(options.mode); },
      async makeTempDirectory() {
        const workspace = await mkdtemp(path.join(root, "private-workspace-"));
        workspaces.push(workspace);
        return workspace;
      },
      async removeDirectory(directory) {
        removals.set(directory, (removals.get(directory) ?? 0) + 1);
        if (failFirst && directory === workspaces[0]) throw new Error("first cleanup failed");
        await rm(directory, { recursive: true, force: true });
      },
    });
    assert.equal((await service.openImport()).status, "planned");
    assert.equal((await service.openImport()).status, "planned");

    await assert.rejects(
      service.dispose(),
      (error: unknown) => error instanceof AggregateError && error.errors.length === 1,
    );
    assert.equal(removals.get(workspaces[0]!), 1);
    assert.equal(removals.get(workspaces[1]!), 1);
    await assert.doesNotReject(access(workspaces[0]!));
    await assert.rejects(access(workspaces[1]!));

    failFirst = false;
    await service.dispose();
    assert.equal(removals.get(workspaces[0]!), 2);
    assert.equal(removals.get(workspaces[1]!), 1);
    await assert.rejects(access(workspaces[0]!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispose closes admission and drains an import still inside the picker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-open-drain-"));
  const source = path.join(root, "open-drain.agenthist");
  let releasePicker!: () => void;
  const pickerGate = new Promise<void>((resolve) => { releasePicker = resolve; });
  let reportPickerEntered!: () => void;
  const pickerEntered = new Promise<void>((resolve) => { reportPickerEntered = resolve; });
  const workspaces: string[] = [];
  let removalCalls = 0;
  try {
    await writeFile(source, "open drain bytes", "utf8");
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      async chooseOpenFile() {
        reportPickerEntered();
        await pickerGate;
        return source;
      },
      chooseSaveFile: async () => undefined,
      openImportCatalog: catalogDependency(),
      async importHistoryArchive(options) { return importResult(options.mode); },
      async makeTempDirectory() {
        const workspace = await mkdtemp(path.join(root, "private-workspace-"));
        workspaces.push(workspace);
        return workspace;
      },
      async removeDirectory(directory) {
        removalCalls++;
        await rm(directory, { recursive: true, force: true });
      },
    });

    const opening = service.openImport();
    await pickerEntered;
    const disposal = service.dispose();
    assert.equal(removalCalls, 0);
    await assert.rejects(service.openImport(), /closing/);
    releasePicker();
    assert.equal((await opening).status, "planned");
    await disposal;
    assert.equal(removalCalls, 1);
    await assert.rejects(access(workspaces[0]!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import rejects non-picker-safe paths before core planning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-paths-"));
  const wrongExtension = path.join(root, "archive.zip");
  let selected = "relative.agenthist";
  let coreCalls = 0;
  try {
    await writeFile(wrongExtension, "bytes", "utf8");
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      chooseOpenFile: async () => selected,
      chooseSaveFile: async () => undefined,
      openImportCatalog: catalogDependency(),
      async importHistoryArchive(options) {
        coreCalls++;
        return importResult(options.mode);
      },
    });
    await assert.rejects(service.openImport(), /absolute \.agenthist path/);
    selected = wrongExtension;
    await assert.rejects(service.openImport(), /absolute \.agenthist path/);
    assert.equal(coreCalls, 0);
    await service.dispose();
    await assert.doesNotReject(access(wrongExtension));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing workspace still returns an opaque plan and becomes ready only after authoritative mapping", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-map-workspace-"));
  const sourceFile = path.join(root, "需要映射 archive.agenthist");
  const sourceWorkspace = "C:\\missing source 项目";
  const targetWorkspace = path.join(root, "目标 workspace 空格");
  let coreCalls = 0;
  let catalogCloses = 0;
  try {
    await writeFile(sourceFile, "workspace archive bytes", "utf8");
    await mkdir(targetWorkspace);
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      chooseOpenFile: async () => sourceFile,
      chooseSaveFile: async () => undefined,
      openImportCatalog: catalogDependency(
        [{ source: sourceWorkspace, availability: "missing" }],
        () => { catalogCloses++; },
      ),
      async importHistoryArchive(options) {
        coreCalls++;
        return importResult(options.mode, {
          ...(options.targetAgent === undefined ? {} : { targetAgent: options.targetAgent }),
          quality: options.targetAgent === undefined ? "native" : "degraded",
          sourceWorkspace,
          targetWorkspace,
        });
      },
    });
    const opened = await service.openImport();
    assert.equal(opened.status, "planned");
    if (opened.status !== "planned") return;
    assert.equal(opened.plan.status, "blocked");
    assert.equal(opened.plan.workspaces[0]!.status, "missing");
    assert.equal(opened.plan.blocked, 1);
    assert.equal(opened.plan.newSessions, 0);
    assert.equal(opened.plan.transactionRequired, false);
    assert.equal(coreCalls, 0);
    assert.equal(catalogCloses, 1);

    const crossAgent = await service.replanImport({
      handle: opened.plan.handle,
      targetAgent: "claude",
    });
    assert.equal(crossAgent.status, "blocked");
    assert.equal(crossAgent.routes[0]!.quality, "blocked");
    assert.deepEqual(crossAgent.routes[0]!.findings, []);
    assert.equal(coreCalls, 0);

    const mapped = await service.mapImportWorkspace(
      { handle: opened.plan.handle, source: sourceWorkspace },
      targetWorkspace,
    );
    assert.equal(mapped.status, "planned");
    assert.equal(mapped.plan.status, "ready");
    assert.equal(mapped.plan.workspaces[0]!.status, "mapped");
    assert.equal(mapped.plan.routes[0]!.quality, "degraded");
    assert.equal(coreCalls, 1);

    const applied = await service.applyImport({
      handle: mapped.plan.handle,
      expectedPlanRef: mapped.plan.planRef,
    });
    assert.equal(applied.status, "completed");
    assert.equal(coreCalls, 3);
    assert.equal(catalogCloses, 4);
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace mapping handles unsafe and multiple cross-flavor sources without trusting caller paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-desktop-multiple-workspaces-"));
  const sourceFile = path.join(root, "multi.agenthist");
  const firstSource = "/srv/项目 one";
  const secondSource = "C:\\unsafe project";
  const firstTarget = path.join(root, "mapped one");
  const secondTarget = path.join(root, "mapped two");
  const equalsTarget = path.join(root, "mapped=unsupported");
  const linkTarget = path.join(root, "mapped-link");
  const workspaces: string[] = [];
  let coreCalls = 0;
  let catalogCloses = 0;
  try {
    await writeFile(sourceFile, "multiple workspace bytes", "utf8");
    await mkdir(firstTarget);
    await mkdir(secondTarget);
    await mkdir(equalsTarget);
    let linkAvailable = true;
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(firstTarget, linkTarget, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") linkAvailable = false;
      else throw error;
    }
    const service = createDesktopTransferService({
      stateDirectory: path.join(root, "state"),
      chooseOpenFile: async () => sourceFile,
      chooseSaveFile: async () => undefined,
      openImportCatalog: catalogDependency([
        { source: firstSource, digit: "1", availability: "missing" },
        { source: secondSource, digit: "2", availability: "unsafe" },
      ], () => { catalogCloses++; }),
      async makeTempDirectory() {
        const directory = await mkdtemp(path.join(root, "private-import-"));
        workspaces.push(directory);
        return directory;
      },
      async importHistoryArchive(options) {
        coreCalls++;
        const base = importResult(options.mode, { sourceWorkspace: firstSource, targetWorkspace: firstTarget });
        const secondItem = {
          ...base.items[0]!,
          sourceSessionRef: sessionRef("codex", "2"),
          targetSessionRef: sessionRef("codex", "3"),
          sourceCwd: secondSource,
          cwd: secondTarget,
        };
        return {
          ...base,
          selectedSessions: 2,
          newSessions: 2,
          written: options.mode === "apply" ? 2 : 0,
          routes: [{ ...base.routes[0]!, sessions: 2 }],
          workspaces: [
            { source: firstSource, target: firstTarget, status: "mapped", agents: ["codex"], sessions: 1 },
            { source: secondSource, target: secondTarget, status: "mapped", agents: ["codex"], sessions: 1 },
          ],
          items: [base.items[0]!, secondItem],
        };
      },
    });
    const opened = await service.openImport();
    assert.equal(opened.status, "planned");
    if (opened.status !== "planned") return;
    assert.deepEqual(opened.plan.workspaces.map((item) => item.status), ["missing", "unmapped"]);
    assert.equal(opened.plan.blocked, 2);
    assert.equal(coreCalls, 0);

    await assert.rejects(
      service.mapImportWorkspace({ handle: opened.plan.handle, source: `${firstSource}/forged` }, firstTarget),
      /not in the current plan/,
    );
    await assert.rejects(
      service.mapImportWorkspace({ handle: opened.plan.handle, source: firstSource }, "relative-target"),
      /absolute system-picker path/,
    );
    await assert.rejects(
      service.mapImportWorkspace({ handle: opened.plan.handle, source: firstSource }, equalsTarget),
      /containing '=' cannot be represented safely/,
    );
    if (linkAvailable) {
      await assert.rejects(
        service.mapImportWorkspace({ handle: opened.plan.handle, source: firstSource }, linkTarget),
        /not a real directory/,
      );
    } else {
      t.diagnostic("directory symlink creation unavailable; other mapping safety assertions still ran");
    }

    const firstMapped = await service.mapImportWorkspace(
      { handle: opened.plan.handle, source: firstSource },
      firstTarget,
    );
    assert.equal(firstMapped.status, "planned");
    if (firstMapped.status !== "planned") return;
    assert.equal(firstMapped.plan.status, "blocked");
    assert.deepEqual(firstMapped.plan.workspaces.map((item) => item.status), ["mapped", "unmapped"]);
    assert.equal(coreCalls, 0);

    const allMapped = await service.mapImportWorkspace(
      { handle: opened.plan.handle, source: secondSource },
      secondTarget,
    );
    assert.equal(allMapped.status, "planned");
    if (allMapped.status !== "planned") return;
    assert.equal(allMapped.plan.status, "ready");
    assert.deepEqual(allMapped.plan.workspaces.map((item) => item.status), ["mapped", "mapped"]);
    assert.equal(coreCalls, 1);
    assert.equal(catalogCloses, 3);
    await service.cancelImport({ handle: opened.plan.handle });
    for (const directory of workspaces) await assert.rejects(access(directory));
    await service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
