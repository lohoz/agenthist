import path from "node:path";

import type {
  ArchiveEntry,
  ArchiveManifest,
  ArchiveObjectBinding,
} from "../../../domain/archive.js";
import type { AgentSnapshot, JsonValue, StoredSession } from "../../../domain/history.js";
import type { ArchiveObjectSource } from "../../../infrastructure/archive.js";
import { readStableSmallFile } from "../../../infrastructure/files.js";
import { snapshotRawPath } from "../../../infrastructure/history-store.js";
import {
  createOpenCodeFilteredDatabase,
  type OpenCodePendingInputStatus,
  type OpenCodeRevertStatus,
} from "../storage/database.js";
import { openCodeSessionRef } from "../identity.js";
import { OPENCODE_HISTORY_DATABASE_RELATIVE_PATH, readOpenCodeHistory } from "../history/reader.js";
import {
  validateOpenCodeToolOutputDescriptors,
  type OpenCodeToolOutputDescriptor,
} from "../tool-output.js";

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? [...value] : undefined;
}

function toolOutputArray(value: JsonValue | undefined): OpenCodeToolOutputDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: OpenCodeToolOutputDescriptor[] = [];
  for (const item of value) {
    const descriptor = objectValue(item);
    if (
      descriptor === undefined || typeof descriptor.nativePath !== "string" || !path.isAbsolute(descriptor.nativePath) ||
      typeof descriptor.relativePath !== "string" || typeof descriptor.available !== "boolean"
    ) return undefined;
    result.push({
      nativePath: descriptor.nativePath,
      relativePath: descriptor.relativePath,
      available: descriptor.available,
    });
  }
  return result;
}

function nativeDescriptor(session: Pick<StoredSession, "agent" | "native" | "sessionRef">): {
  readonly database: string;
  readonly sidecars: readonly string[];
  readonly plan: string | null;
  readonly toolOutputs: readonly OpenCodeToolOutputDescriptor[];
  readonly component: readonly string[];
  readonly relationStatus: "valid" | "invalid";
  readonly pendingInputStatus: OpenCodePendingInputStatus;
  readonly revertStatus: OpenCodeRevertStatus;
} {
  const native = objectValue(session.native);
  const carrier = objectValue(native?.carrier);
  const database = carrier?.database;
  const sidecars = stringArray(carrier?.sidecars);
  const plan = carrier?.plan;
  const toolOutputs = toolOutputArray(carrier?.toolOutputs);
  const component = stringArray(native?.componentNativeIds);
  const relationStatus = native?.relationStatus;
  const pendingInputStatus = native?.pendingInputStatus;
  const revertStatus = native?.revertStatus;
  if (
    session.agent !== "opencode" || database !== OPENCODE_HISTORY_DATABASE_RELATIVE_PATH || sidecars === undefined ||
    (plan !== null && typeof plan !== "string") ||
    toolOutputs === undefined ||
    component === undefined || component.length === 0 ||
    (relationStatus !== "valid" && relationStatus !== "invalid") ||
    (pendingInputStatus !== "empty" && pendingInputStatus !== "present" && pendingInputStatus !== "unknown") ||
    (revertStatus !== "empty" && revertStatus !== "present" && revertStatus !== "unknown")
  ) {
    throw new Error(`OpenCode captured descriptor is invalid: ${session.sessionRef}`);
  }
  return { database, sidecars, plan, toolOutputs, component, relationStatus, pendingInputStatus, revertStatus };
}

function assertOpenCodeSessionMigratable(
  session: Pick<StoredSession, "nativeId" | "sessionRef">,
  descriptor: ReturnType<typeof nativeDescriptor>,
): void {
  const sessionRef = session.sessionRef;
  if (descriptor.relationStatus !== "valid") {
    throw new Error(`OpenCode session relation closure is invalid: ${sessionRef}`);
  }
  if (descriptor.pendingInputStatus === "present") {
    throw new Error(`OpenCode session has pending input and cannot be migrated: ${sessionRef}`);
  }
  if (descriptor.pendingInputStatus === "unknown") {
    throw new Error(`OpenCode session input state cannot be classified: ${sessionRef}`);
  }
  if (descriptor.revertStatus === "present") {
    throw new Error(`OpenCode session has an active revert and cannot be migrated: ${sessionRef}`);
  }
  if (descriptor.revertStatus === "unknown") {
    throw new Error(`OpenCode session revert state cannot be classified: ${sessionRef}`);
  }
  const expectedSidecar = `opencode/session_diff/${session.nativeId}.json`;
  if (descriptor.sidecars.some((sidecar) => sidecar !== expectedSidecar) || descriptor.sidecars.length > 1) {
    throw new Error(`OpenCode session_diff ownership is not portable: ${sessionRef}`);
  }
  const expectedPlan = `opencode/plan/${session.nativeId}.md`;
  if (descriptor.plan !== null && descriptor.plan !== expectedPlan) {
    throw new Error(`OpenCode session plan ownership is not portable: ${sessionRef}`);
  }
  if (
    new Set(descriptor.toolOutputs.map((item) => item.nativePath)).size !== descriptor.toolOutputs.length ||
    new Set(descriptor.toolOutputs.map((item) => item.relativePath)).size !== descriptor.toolOutputs.length
  ) {
    throw new Error(`OpenCode tool-output ownership is ambiguous within the session: ${sessionRef}`);
  }
}

function assertOpenCodeSelectionMigratable(
  sessions: readonly Pick<StoredSession, "agent" | "native" | "nativeId" | "sessionRef">[],
): void {
  const nativeOwners = new Map<string, string>();
  const availablePathOwners = new Map<string, string>();
  for (const session of sessions) {
    const descriptor = nativeDescriptor(session);
    assertOpenCodeSessionMigratable(session, descriptor);
    for (const output of descriptor.toolOutputs) {
      const nativeOwner = nativeOwners.get(output.nativePath);
      if (nativeOwner !== undefined && nativeOwner !== session.sessionRef) {
        throw new Error(`OpenCode tool-output ownership is ambiguous (${output.relativePath}): ${session.sessionRef}`);
      }
      nativeOwners.set(output.nativePath, session.sessionRef);
      if (!output.available) continue;
      const pathOwner = availablePathOwners.get(output.relativePath);
      if (pathOwner !== undefined && pathOwner !== session.sessionRef) {
        throw new Error(`OpenCode tool-output archive path is ambiguous (${output.relativePath}): ${session.sessionRef}`);
      }
      availablePathOwners.set(output.relativePath, session.sessionRef);
    }
  }
}

export function readOpenCodeNativeDescriptor(
  session: Pick<StoredSession, "agent" | "native" | "sessionRef">,
): ReturnType<typeof nativeDescriptor> {
  return nativeDescriptor(session);
}

export function closeOpenCodeEntrySelection(
  all: readonly ArchiveEntry[],
  selected: ReadonlySet<string>,
): ReadonlySet<string> {
  const byNativeId = new Map(all.filter((entry) => entry.agent === "opencode").map((entry) => [entry.nativeId, entry]));
  const result = new Set(selected);
  for (const entry of all) {
    if (entry.agent !== "opencode" || !selected.has(entry.sessionRef)) continue;
    const descriptor = nativeDescriptor(entry);
    assertOpenCodeSessionMigratable(entry, descriptor);
    for (const nativeId of descriptor.component) {
      const member = byNativeId.get(nativeId);
      if (member === undefined) throw new Error(`OpenCode archive session component is incomplete: ${entry.sessionRef}`);
      result.add(member.sessionRef);
    }
  }
  for (const entry of all) {
    if (entry.agent === "opencode" && result.has(entry.sessionRef)) {
      assertOpenCodeSessionMigratable(entry, nativeDescriptor(entry));
    }
  }
  assertOpenCodeSelectionMigratable(all.filter((entry) =>
    entry.agent === "opencode" && result.has(entry.sessionRef)
  ));
  return result;
}

export function closeOpenCodeSelection(
  snapshot: AgentSnapshot,
  selected: readonly StoredSession[],
): StoredSession[] {
  if (snapshot.agent !== "opencode") throw new Error("OpenCode selection received another Agent snapshot");
  const byNativeId = new Map(snapshot.sessions.map((session) => [session.nativeId, session]));
  const included = new Set<string>();
  for (const session of selected) {
    const descriptor = nativeDescriptor(session);
    assertOpenCodeSessionMigratable(session, descriptor);
    for (const nativeId of descriptor.component) {
      if (!byNativeId.has(nativeId)) throw new Error(`OpenCode session component is incomplete: ${session.sessionRef}`);
      included.add(nativeId);
    }
  }
  const sessions = snapshot.sessions
    .filter((session) => included.has(session.nativeId))
    .sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
  assertOpenCodeSelectionMigratable(sessions);
  return sessions;
}

export interface PreparedOpenCodeArchive {
  readonly sessions: readonly StoredSession[];
  readonly sources: readonly ArchiveObjectSource[];
  readonly bindings: ReadonlyMap<string, readonly ArchiveObjectBinding[]>;
}

export function prepareOpenCodeArchive(
  stateDirectory: string,
  snapshot: AgentSnapshot,
  selected: readonly StoredSession[],
  workspace: string,
  allocateObjectId: () => string,
): PreparedOpenCodeArchive {
  const sessions = closeOpenCodeSelection(snapshot, selected);
  if (sessions.length === 0) throw new Error("OpenCode export selection is empty");
  const sourceDatabase = snapshotRawPath(stateDirectory, snapshot, OPENCODE_HISTORY_DATABASE_RELATIVE_PATH);
  const filteredDatabase = path.join(workspace, "opencode-history.sqlite");
  createOpenCodeFilteredDatabase(sourceDatabase, filteredDatabase, new Set(sessions.map((session) => session.nativeId)));
  const databaseId = allocateObjectId();
  const databaseBinding: ArchiveObjectBinding = {
    id: databaseId,
    role: "history-database",
    relativePath: OPENCODE_HISTORY_DATABASE_RELATIVE_PATH,
  };
  const sources: ArchiveObjectSource[] = [{
    id: databaseId,
    kind: "opencode.history-sqlite",
    filePath: filteredDatabase,
  }];
  const toolOutputObjects = new Map<string, string>();
  const bindings = new Map<string, readonly ArchiveObjectBinding[]>();
  for (const session of sessions) {
    const descriptor = nativeDescriptor(session);
    const expectedSidecar = `opencode/session_diff/${session.nativeId}.json`;
    const sessionBindings: ArchiveObjectBinding[] = [databaseBinding];
    if (descriptor.sidecars.length === 1) {
      const sidecarId = allocateObjectId();
      sources.push({
        id: sidecarId,
        kind: "opencode.session-diff",
        filePath: snapshotRawPath(stateDirectory, snapshot, expectedSidecar),
      });
      sessionBindings.push({ id: sidecarId, role: "session-diff", relativePath: expectedSidecar });
    }
    const expectedPlan = `opencode/plan/${session.nativeId}.md`;
    if (descriptor.plan !== null) {
      const planId = allocateObjectId();
      sources.push({
        id: planId,
        kind: "opencode.session-plan",
        filePath: snapshotRawPath(stateDirectory, snapshot, expectedPlan),
      });
      sessionBindings.push({ id: planId, role: "session-plan", relativePath: expectedPlan });
    }
    for (const toolOutput of descriptor.toolOutputs) {
      if (!toolOutput.available) continue;
      let outputId = toolOutputObjects.get(toolOutput.relativePath);
      if (outputId === undefined) {
        outputId = allocateObjectId();
        toolOutputObjects.set(toolOutput.relativePath, outputId);
        sources.push({
          id: outputId,
          kind: "opencode.tool-output",
          filePath: snapshotRawPath(stateDirectory, snapshot, toolOutput.relativePath),
        });
      }
      sessionBindings.push({ id: outputId, role: "tool-output", relativePath: toolOutput.relativePath });
    }
    bindings.set(session.sessionRef, sessionBindings);
  }
  return {
    sessions,
    sources,
    bindings,
  };
}

export function validateOpenCodeArchiveEntries(
  entries: readonly ArchiveEntry[],
  objects: ReadonlyMap<string, ArchiveManifest["objects"][number]>,
  extracted?: ReadonlyMap<string, string>,
): void {
  if (entries.length === 0) return;
  let sharedObject: string | undefined;
  const references = new Set<string>();
  const sidecarObjects = new Set<string>();
  const sidecarPaths: string[] = [];
  const planObjects = new Set<string>();
  const planPaths = new Set<string>();
  const plansBySession = new Map<string, string>();
  const toolOutputObjects = new Set<string>();
  const toolOutputPaths = new Set<string>();
  const toolOutputOwners = new Map<string, string>();
  const toolOutputsBySession = new Map<string, readonly OpenCodeToolOutputDescriptor[]>();
  for (const entry of entries) {
    const binding = entry.objects[0];
    const sidecars = entry.objects.slice(1).filter((item) => item.role === "session-diff");
    const plans = entry.objects.slice(1).filter((item) => item.role === "session-plan");
    const toolOutputs = entry.objects.slice(1).filter((item) => item.role === "tool-output");
    const unknown = entry.objects.slice(1).some((item) =>
      item.role !== "session-diff" && item.role !== "session-plan" && item.role !== "tool-output"
    );
    const sidecar = sidecars[0];
    const plan = plans[0];
    const expectedSidecar = `opencode/session_diff/${entry.nativeId}.json`;
    const expectedPlan = `opencode/plan/${entry.nativeId}.md`;
    const descriptor = nativeDescriptor(entry);
    const expectedToolOutputs = new Map(
      descriptor.toolOutputs.filter((item) => item.available).map((item) => [item.relativePath, item]),
    );
    assertOpenCodeSessionMigratable(entry, descriptor);
    if (
      entry.agent !== "opencode" || openCodeSessionRef(entry.nativeId) !== entry.sessionRef ||
      unknown || sidecars.length > 1 || plans.length > 1 || toolOutputs.length !== expectedToolOutputs.size ||
      new Set(descriptor.toolOutputs.map((item) => item.nativePath)).size !== descriptor.toolOutputs.length ||
      new Set(descriptor.toolOutputs.map((item) => item.relativePath)).size !== descriptor.toolOutputs.length ||
      binding === undefined || binding.role !== "history-database" ||
      binding.relativePath !== OPENCODE_HISTORY_DATABASE_RELATIVE_PATH ||
      objects.get(binding.id)?.kind !== "opencode.history-sqlite" ||
      (sidecar === undefined
        ? descriptor.sidecars.length !== 0
        : sidecar.role !== "session-diff" || sidecar.relativePath !== expectedSidecar ||
          objects.get(sidecar.id)?.kind !== "opencode.session-diff" ||
          descriptor.sidecars.length !== 1 || descriptor.sidecars[0] !== expectedSidecar ||
          sidecarObjects.has(sidecar.id)) ||
      (plan === undefined
        ? descriptor.plan !== null
        : plan.relativePath !== expectedPlan || descriptor.plan !== expectedPlan ||
          objects.get(plan.id)?.kind !== "opencode.session-plan" ||
          planObjects.has(plan.id) || planPaths.has(plan.relativePath))
    ) {
      throw new Error(`OpenCode archive entry is invalid: ${entry.sessionRef}`);
    }
    if (sidecar !== undefined) {
      sidecarObjects.add(sidecar.id);
      sidecarPaths.push(expectedSidecar);
    }
    if (plan !== undefined) {
      planObjects.add(plan.id);
      planPaths.add(plan.relativePath);
      plansBySession.set(entry.nativeId, expectedPlan);
    }
    for (const toolOutput of descriptor.toolOutputs) {
      const owner = toolOutputOwners.get(toolOutput.nativePath);
      if (owner !== undefined && owner !== entry.sessionRef) {
        throw new Error(`OpenCode archive tool-output ownership is ambiguous: ${entry.sessionRef}`);
      }
      toolOutputOwners.set(toolOutput.nativePath, entry.sessionRef);
    }
    for (const toolOutput of toolOutputs) {
      if (
        !expectedToolOutputs.has(toolOutput.relativePath) ||
        objects.get(toolOutput.id)?.kind !== "opencode.tool-output" || toolOutputObjects.has(toolOutput.id) ||
        toolOutputPaths.has(toolOutput.relativePath)
      ) throw new Error(`OpenCode archive tool-output binding is invalid: ${entry.sessionRef}`);
      toolOutputObjects.add(toolOutput.id);
      toolOutputPaths.add(toolOutput.relativePath);
    }
    toolOutputsBySession.set(entry.nativeId, descriptor.toolOutputs);
    if (sharedObject !== undefined && binding.id !== sharedObject) {
      throw new Error("OpenCode archive entries do not share one selected history closure");
    }
    sharedObject = binding.id;
    if (references.has(entry.sessionRef)) throw new Error(`OpenCode archive contains a duplicate session: ${entry.sessionRef}`);
    references.add(entry.sessionRef);
  }
  if (extracted === undefined || sharedObject === undefined) return;
  const database = extracted.get(sharedObject);
  if (database === undefined) throw new Error("OpenCode archive history database is missing");
  validateOpenCodeToolOutputDescriptors(database, toolOutputsBySession);
  const captured = readOpenCodeHistory({
    databasePath: database,
    databaseRelativePath: OPENCODE_HISTORY_DATABASE_RELATIVE_PATH,
    sidecarFiles: sidecarPaths,
    planFiles: plansBySession,
    toolOutputs: toolOutputsBySession,
  });
  const actual = new Map(captured.sessions.map((session) => [session.sessionRef, session]));
  if (actual.size !== references.size || [...references].some((reference) => !actual.has(reference))) {
    throw new Error("OpenCode archive manifest disagrees with its history closure");
  }
  for (const entry of entries) {
    const capturedSession = actual.get(entry.sessionRef);
    if (capturedSession?.nativeId !== entry.nativeId ||
      nativeDescriptor(entry).component.join("\0") !== nativeDescriptor(capturedSession).component.join("\0") ||
      nativeDescriptor(entry).relationStatus !== nativeDescriptor(capturedSession).relationStatus ||
      nativeDescriptor(entry).pendingInputStatus !== nativeDescriptor(capturedSession).pendingInputStatus ||
      nativeDescriptor(entry).revertStatus !== nativeDescriptor(capturedSession).revertStatus ||
      nativeDescriptor(entry).sidecars.join("\0") !== nativeDescriptor(capturedSession).sidecars.join("\0") ||
      nativeDescriptor(entry).plan !== nativeDescriptor(capturedSession).plan ||
      JSON.stringify(nativeDescriptor(entry).toolOutputs) !== JSON.stringify(nativeDescriptor(capturedSession).toolOutputs)) {
      throw new Error(`OpenCode archive session identity disagrees: ${entry.sessionRef}`);
    }
  }
}

export async function validateOpenCodeArchiveObjects(
  entries: readonly ArchiveEntry[],
  extracted: ReadonlyMap<string, string>,
): Promise<void> {
  for (const entry of entries) {
    for (const binding of entry.objects.filter((item) => item.role === "tool-output" || item.role === "session-plan")) {
      if (!extracted.has(binding.id)) {
        throw new Error(`OpenCode archive ${binding.role} is missing: ${entry.sessionRef}`);
      }
    }
    const binding = entry.objects.find((item) => item.role === "session-diff");
    if (binding === undefined) continue;
    const file = extracted.get(binding.id);
    if (file === undefined) throw new Error(`OpenCode archive session_diff is missing: ${entry.sessionRef}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readStableSmallFile(file, 64 * 1024 * 1024)).toString("utf8"));
    } catch {
      throw new Error(`OpenCode archive session_diff is invalid JSON: ${entry.sessionRef}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`OpenCode archive session_diff is not an array: ${entry.sessionRef}`);
    }
  }
}
