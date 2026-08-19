import { lstat } from "node:fs/promises";
import path from "node:path";

import type { StoredSession } from "../../../domain/history.js";
import type { ImportEntry } from "../../../domain/import.js";
import { mapAbsolutePath, type PathMappings } from "../../../domain/path-mapping.js";
import { transactionReference } from "../../../domain/transaction.js";
import {
  exclusiveFileMatches,
  observeExclusiveFile,
  type ExclusiveFileImage,
} from "../../../infrastructure/exclusive-file.js";
import { digestFile } from "../../../infrastructure/files.js";
import { loadSnapshot } from "../../../infrastructure/history-store.js";
import {
  newManagedResourceEffects,
  planManagedResources,
  type ManagedResourcePlan,
} from "../../../infrastructure/managed-resources.js";
import { discoverPiSessions } from "../carrier.js";
import { parsePiSession } from "../history/session.js";
import { readPiNativeDescriptor } from "./archive.js";
import { projectPiSessionHeader } from "./rewrite.js";
import { requirePiSource, resolvePiSource, type PiSourceOptions } from "../source.js";
import { piWorkspaceCarrier } from "../session-path.js";
import { scanPi } from "../scan.js";
import {
  executePreparedPiTransaction,
  preparePiTransaction,
  type PiTransactionSession,
  type PreparedPiEffect,
} from "./transaction.js";

export type PiImportClassification = "new" | "already_present" | "conflict";

export interface PiImportItem {
  readonly sessionRef: string;
  readonly nativeId: string;
  readonly classification: PiImportClassification;
  readonly destination: string;
  readonly provider: string;
  readonly cwd: string;
  readonly reason?: string;
}

export interface RestorePiResult {
  readonly targetSessionRoot: string;
  readonly items: readonly PiImportItem[];
  readonly newSessions: number;
  readonly alreadyPresent: number;
  readonly resources: ManagedResourcePlan["items"];
  readonly transactionRef?: string;
}

export interface RestorePiOptions extends PiSourceOptions {
  readonly stateDirectory: string;
  readonly entries: readonly ImportEntry[];
  readonly objects: ReadonlyMap<string, string>;
  readonly pathMappings: PathMappings;
  readonly workspace: string;
}

interface PlannedPiSession {
  readonly entry: ImportEntry;
  readonly projected: string;
  readonly destination: string;
  readonly cwd: string;
  readonly image: ExclusiveFileImage;
  readonly classification: PiImportClassification;
  readonly reason?: string;
}

interface RestorePlan {
  readonly sessionRoot: string;
  readonly sessions: readonly PlannedPiSession[];
  readonly resources: ManagedResourcePlan;
}

export interface PreparedPiRestore {
  readonly result: RestorePiResult;
  readonly apply: () => Promise<RestorePiResult>;
}

async function requireMappedDirectory(directory: string): Promise<void> {
  let info;
  try { info = await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`mapped Pi directory does not exist: ${directory}`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`mapped Pi directory is not a real directory: ${directory}`);
  }
}

async function classifyFile(
  projected: string,
  destination: string,
  mode: number,
): Promise<{ readonly image: ExclusiveFileImage; readonly classification: PiImportClassification; readonly reason?: string }> {
  const image: ExclusiveFileImage = { ...(await digestFile(projected)), mode };
  try {
    const current = await observeExclusiveFile(destination, "Pi target session");
    if (current === null) return { image, classification: "new" };
    return exclusiveFileMatches(image, current)
      ? { image, classification: "already_present" }
      : { image, classification: "conflict", reason: "target session differs from the projected archive" };
  } catch (error) {
    return {
      image,
      classification: "conflict",
      reason: error instanceof Error ? error.message : "target session has an unsupported shape",
    };
  }
}

async function existingPiSessions(sessionRoot: string): Promise<ReadonlyMap<string, string>> {
  const byNativeId = new Map<string, string>();
  for (const carrier of await discoverPiSessions(sessionRoot)) {
    const parsed = await parsePiSession(carrier.sourcePath, carrier.modifiedAt);
    const existing = byNativeId.get(parsed.header.id);
    if (existing !== undefined) throw new Error(`Pi target contains duplicate session ID: ${parsed.header.id}`);
    byNativeId.set(parsed.header.id, path.resolve(carrier.sourcePath));
  }
  return byNativeId;
}

function archiveSource(entry: ImportEntry, objects: ReadonlyMap<string, string>): string {
  const binding = entry.objects[0];
  const source = binding === undefined ? undefined : objects.get(binding.id);
  if (entry.agent !== "pi" || entry.objects.length !== 1 || binding?.role !== "session" || source === undefined) {
    throw new Error(`Pi import entry is invalid: ${entry.sessionRef}`);
  }
  return source;
}

async function buildRestorePlan(options: RestorePiOptions): Promise<RestorePlan> {
  if (options.entries.length === 0) throw new Error("Pi import selection is empty");
  const target = resolvePiSource(options);
  await requirePiSource(target);
  const existing = await existingPiSessions(target.sessionRoot);
  const cwdBySession = new Map<string, string>();
  const destinationBySession = new Map<string, string>();
  const destinations = new Set<string>();

  for (const entry of options.entries) {
    const descriptor = readPiNativeDescriptor(entry);
    const cwd = mapAbsolutePath(entry.context, options.pathMappings, "Pi history cwd");
    await requireMappedDirectory(cwd);
    const destination = path.resolve(
      target.sessionRoot,
      ...(target.sessionRootSource === "agent" ? [piWorkspaceCarrier(cwd)] : []),
      descriptor.fileName,
    );
    if (destinations.has(destination)) throw new Error(`Pi import destination is duplicated: ${destination}`);
    destinations.add(destination);
    cwdBySession.set(entry.sessionRef, cwd);
    destinationBySession.set(entry.sessionRef, destination);
  }

  const sessions: PlannedPiSession[] = [];
  for (const [index, entry] of options.entries.entries()) {
    const descriptor = readPiNativeDescriptor(entry);
    const source = archiveSource(entry, options.objects);
    const cwd = cwdBySession.get(entry.sessionRef)!;
    const destination = destinationBySession.get(entry.sessionRef)!;
    const parentSession = descriptor.parentSessionRef === null
      ? undefined
      : destinationBySession.get(descriptor.parentSessionRef);
    if (descriptor.parentSessionRef !== null && parentSession === undefined) {
      throw new Error(`Pi parent session closure is incomplete: ${entry.sessionRef}`);
    }
    const projected = path.join(options.workspace, `pi-projected-${index.toString().padStart(6, "0")}.jsonl`);
    await projectPiSessionHeader({ source, destination: projected, cwd, ...(parentSession === undefined ? {} : { parentSession }) });
    const parsed = await parsePiSession(projected, entry.updatedAt);
    if (
      parsed.header.id !== entry.nativeId || parsed.header.cwd !== cwd || parsed.header.parentSession !== parentSession ||
      parsed.title !== entry.title || parsed.model !== entry.model || parsed.provider !== entry.provider ||
      parsed.createdAt !== entry.createdAt || parsed.updatedAt !== entry.updatedAt ||
      parsed.leafId !== descriptor.leafId || parsed.roots !== descriptor.roots ||
      parsed.branchPoints !== descriptor.branchPoints || parsed.entries.length !== descriptor.entries ||
      parsed.messageCount !== descriptor.messages
    ) throw new Error(`Pi path projection changed native history: ${entry.sessionRef}`);
    const duplicate = existing.get(entry.nativeId);
    const classification = duplicate !== undefined && duplicate !== destination
      ? {
          image: { ...(await digestFile(projected)), mode: descriptor.mode },
          classification: "conflict" as const,
          reason: `target already stores this Pi session at ${duplicate}`,
        }
      : await classifyFile(projected, destination, descriptor.mode);
    sessions.push({ entry, projected, destination, cwd, ...classification });
  }
  const resources = await planManagedResources(options.entries, options.objects, cwdBySession);
  return { sessionRoot: target.sessionRoot, sessions, resources };
}

function resultFromPlan(plan: RestorePlan, reference?: string): RestorePiResult {
  const items = plan.sessions.map((session): PiImportItem => ({
    sessionRef: session.entry.sessionRef,
    nativeId: session.entry.nativeId,
    classification: session.classification,
    destination: session.destination,
    provider: "",
    cwd: session.cwd,
    ...(session.reason === undefined ? {} : { reason: session.reason }),
  }));
  return {
    targetSessionRoot: plan.sessionRoot,
    items,
    newSessions: items.filter((item) => item.classification === "new").length,
    alreadyPresent: items.filter((item) => item.classification === "already_present").length,
    resources: plan.resources.items,
    ...(reference === undefined ? {} : { transactionRef: reference }),
  };
}

function importedLibrary(entries: readonly ImportEntry[]): Map<string, StoredSession["library"]> {
  return new Map(entries.map((entry) => [entry.sessionRef, entry.library]));
}

async function reconcileWithoutNativeWrite(options: RestorePiOptions, plan: RestorePlan): Promise<void> {
  const snapshot = await loadSnapshot(options.stateDirectory, "pi");
  if (snapshot !== undefined && options.entries.every((entry) =>
    snapshot.sessions.some((session) => session.sessionRef === entry.sessionRef)
  )) return;
  await scanPi({
    stateDirectory: options.stateDirectory,
    sessionRoot: plan.sessionRoot,
    importedLibrary: importedLibrary(options.entries),
  });
}

export async function preparePiRestore(options: RestorePiOptions): Promise<PreparedPiRestore> {
  const plan = await buildRestorePlan(options);
  return {
    result: resultFromPlan(plan),
    apply: async () => {
      const conflict = plan.sessions.find((session) => session.classification === "conflict");
      if (conflict !== undefined) {
        throw new Error(`Pi import conflict for ${conflict.entry.sessionRef}: ${conflict.reason ?? "target differs"}`);
      }
      const resources = newManagedResourceEffects(plan.resources);
      const pending = plan.sessions.filter((session) => session.classification === "new");
      if (pending.length === 0 && resources.length === 0) {
        await reconcileWithoutNativeWrite(options, plan);
        return resultFromPlan(plan);
      }
      const effects: PreparedPiEffect[] = pending.map((session) => ({
        sessionRef: session.entry.sessionRef,
        nativeId: session.entry.nativeId,
        destination: session.destination,
        filePath: session.projected,
        mode: session.image.mode,
      }));
      const transactionSessions: PiTransactionSession[] = plan.sessions.map((session) => ({
        sessionRef: session.entry.sessionRef,
        nativeId: session.entry.nativeId,
        destination: session.destination,
        image: session.image,
      }));
      const journal = await preparePiTransaction({
        stateDirectory: options.stateDirectory,
        sessionRoot: plan.sessionRoot,
        effects,
        resources,
        sessions: transactionSessions,
        importedLibrary: importedLibrary(options.entries),
      });
      const committed = await executePreparedPiTransaction(options.stateDirectory, journal);
      return resultFromPlan(plan, transactionReference(committed.id));
    },
  };
}
