import { lstat } from "node:fs/promises";
import path from "node:path";

import type { ArchiveEntry, ArchiveManifest, ArchiveResourceBinding } from "../domain/archive.js";
import { MAX_MANAGED_RESOURCE_BYTES, validManagedResourceReference } from "../domain/resource.js";
import {
  exclusiveFileMatches,
  observeExclusiveFile,
  publishExclusiveFile,
  requireRealDirectory as requireTransactionRoot,
  requireSafeDirectoryParents as requireTransactionParents,
  type ExclusiveFileImage,
} from "./exclusive-file.js";
import { digestFile } from "./files.js";
import { resolveTransactionObject, type TransactionObjectSource } from "./transaction-store.js";

export const MANAGED_RESOURCE_OBJECT_KIND = "managed.resource" as const;

export function validateArchiveManagedResources(
  entries: readonly ArchiveEntry[],
  objects: ReadonlyMap<string, ArchiveManifest["objects"][number]>,
): void {
  for (const entry of entries) {
    const paths = new Set<string>();
    for (const resource of entry.resources) {
      const descriptor = objects.get(resource.id);
      if (
        !validManagedResourceReference(resource) || paths.has(resource.relativePath) ||
        descriptor?.kind !== MANAGED_RESOURCE_OBJECT_KIND || descriptor.sha256 !== resource.sha256 ||
        descriptor.sizeBytes !== resource.sizeBytes
      ) throw new Error(`managed resource binding is invalid: ${entry.sessionRef}`);
      paths.add(resource.relativePath);
    }
  }
}

export type ManagedResourceClassification = "new" | "already_present" | "conflict";

export interface ManagedResourceItem {
  readonly sessionRefs: readonly string[];
  readonly binding: ArchiveResourceBinding;
  readonly source: string;
  readonly root: string;
  readonly destination: string;
  readonly classification: ManagedResourceClassification;
  readonly reason?: string;
}

export interface ManagedResourcePlan {
  readonly items: readonly ManagedResourceItem[];
  readonly newCount: number;
  readonly alreadyPresent: number;
}

export interface PreparedManagedResourceEffect {
  readonly sessionRefs: readonly string[];
  readonly binding: ArchiveResourceBinding;
  readonly source: string;
  readonly root: string;
  readonly destination: string;
}

interface ManagedResourceFileImage extends ExclusiveFileImage {
  readonly object: string;
}

export interface ManagedResourceTransactionEffect {
  readonly sessionRefs: readonly string[];
  readonly root: string;
  readonly destination: string;
  readonly after: ManagedResourceFileImage;
}

export type ManagedResourceEffectPosition = "before" | "after" | "diverged";

export interface ManagedResourceObservations {
  readonly positions: readonly ManagedResourceEffectPosition[];
  readonly bySession: ReadonlyMap<string, readonly ManagedResourceEffectPosition[]>;
}

const RESOURCE_OBJECT = /^objects\/[0-9]{6}-managed-resource$/;
const DIGEST = /^[0-9a-f]{64}$/;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function requireRealDirectory(directory: string): Promise<void> {
  let info;
  try { info = await lstat(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`managed resource working directory does not exist: ${directory}`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`managed resource working directory is not a real directory: ${directory}`);
  }
}

async function requireSafeParents(root: string, destination: string): Promise<void> {
  let current = root;
  const relative = path.relative(root, path.dirname(destination));
  for (const component of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`managed resource parent is unsafe: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function classifyResource(
  binding: ArchiveResourceBinding,
  destination: string,
): Promise<{ readonly classification: ManagedResourceClassification; readonly reason?: string }> {
  let info;
  try { info = await lstat(destination); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { classification: "new" };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return { classification: "conflict", reason: "receiver path is not a regular file" };
  }
  const digest = await digestFile(destination);
  return digest.sizeBytes === binding.sizeBytes && digest.sha256 === binding.sha256
    ? { classification: "already_present" }
    : { classification: "conflict", reason: "receiver path contains different bytes" };
}

export async function planManagedResources(
  entries: readonly ArchiveEntry[],
  objects: ReadonlyMap<string, string>,
  workingDirectories: ReadonlyMap<string, string>,
): Promise<ManagedResourcePlan> {
  const byDestination = new Map<string, {
    binding: ArchiveResourceBinding;
    source: string;
    root: string;
    sessionRefs: Set<string>;
  }>();
  const checkedRoots = new Set<string>();
  for (const entry of entries) {
    if (entry.resources.length === 0) continue;
    const root = workingDirectories.get(entry.sessionRef);
    if (root === undefined || !path.isAbsolute(root)) {
      throw new Error(`managed resource target cwd is unavailable: ${entry.sessionRef}`);
    }
    const resolvedRoot = path.resolve(root);
    if (!checkedRoots.has(resolvedRoot)) {
      await requireRealDirectory(resolvedRoot);
      checkedRoots.add(resolvedRoot);
    }
    for (const binding of entry.resources) {
      if (!validManagedResourceReference(binding)) {
        throw new Error(`managed resource binding is invalid: ${entry.sessionRef}`);
      }
      const source = objects.get(binding.id);
      if (source === undefined) throw new Error(`managed resource object is missing: ${entry.sessionRef}`);
      const destination = path.join(resolvedRoot, ...binding.relativePath.split("/"));
      const relative = path.relative(resolvedRoot, destination);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`managed resource destination escapes its working directory: ${entry.sessionRef}`);
      }
      const existing = byDestination.get(destination);
      if (existing !== undefined) {
        if (
          existing.binding.sha256 !== binding.sha256 || existing.binding.sizeBytes !== binding.sizeBytes ||
          existing.source !== source
        ) throw new Error(`managed resource destination collides: ${destination}`);
        existing.sessionRefs.add(entry.sessionRef);
        continue;
      }
      byDestination.set(destination, { binding, source, root: resolvedRoot, sessionRefs: new Set([entry.sessionRef]) });
    }
  }

  const items: ManagedResourceItem[] = [];
  for (const [destination, resource] of [...byDestination].sort(([left], [right]) => left.localeCompare(right))) {
    await requireSafeParents(resource.root, destination);
    const classification = await classifyResource(resource.binding, destination);
    items.push({
      sessionRefs: [...resource.sessionRefs].sort(),
      binding: resource.binding,
      source: resource.source,
      root: resource.root,
      destination,
      ...classification,
    });
  }
  return {
    items,
    newCount: items.filter((item) => item.classification === "new").length,
    alreadyPresent: items.filter((item) => item.classification === "already_present").length,
  };
}

export function newManagedResourceEffects(plan: ManagedResourcePlan): readonly PreparedManagedResourceEffect[] {
  const conflict = plan.items.find((item) => item.classification === "conflict");
  if (conflict !== undefined) {
    throw new Error(`managed resource import conflict at ${conflict.destination}: ${conflict.reason ?? "target differs"}`);
  }
  return plan.items
    .filter((item) => item.classification === "new")
    .map((item) => ({
      sessionRefs: item.sessionRefs,
      binding: item.binding,
      source: item.source,
      root: item.root,
      destination: item.destination,
    }));
}

export async function prepareManagedResourceTransactionEffects(
  prepared: readonly PreparedManagedResourceEffect[],
): Promise<{
  readonly effects: readonly ManagedResourceTransactionEffect[];
  readonly sources: readonly TransactionObjectSource[];
}> {
  const effects: ManagedResourceTransactionEffect[] = [];
  const sources: TransactionObjectSource[] = [];
  for (const [index, item] of [...prepared].sort((left, right) =>
    left.destination.localeCompare(right.destination)).entries()) {
    const digest = await digestFile(item.source);
    if (digest.sizeBytes !== item.binding.sizeBytes || digest.sha256 !== item.binding.sha256) {
      throw new Error(`managed resource transaction source differs: ${item.destination}`);
    }
    const object = `objects/${index.toString().padStart(6, "0")}-managed-resource`;
    effects.push({
      sessionRefs: [...item.sessionRefs].sort(),
      root: path.resolve(item.root),
      destination: path.resolve(item.destination),
      after: { object, ...digest, mode: 0o600 },
    });
    sources.push({ relativePath: object, filePath: item.source, ...digest });
  }
  return { effects, sources };
}

function readResourceImage(value: unknown): ManagedResourceFileImage | undefined {
  const image = objectValue(value);
  if (
    image === undefined || typeof image.object !== "string" || !RESOURCE_OBJECT.test(image.object) ||
    typeof image.sizeBytes !== "number" || !Number.isSafeInteger(image.sizeBytes) ||
    image.sizeBytes < 0 || image.sizeBytes > MAX_MANAGED_RESOURCE_BYTES ||
    typeof image.sha256 !== "string" || !DIGEST.test(image.sha256) || image.mode !== 0o600
  ) return undefined;
  return image as unknown as ManagedResourceFileImage;
}

function validResourceDestination(
  root: string,
  destination: string,
  image: ManagedResourceFileImage,
): boolean {
  if (
    !path.isAbsolute(root) || path.resolve(root) !== root ||
    !path.isAbsolute(destination) || path.resolve(destination) !== destination
  ) return false;
  const relative = path.relative(root, destination);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  const name = parts[4] ?? "";
  return parts.length === 5 && parts[0] === ".agenthist" && parts[1] === "resources" &&
    parts[2] === "sha256" && parts[3] === image.sha256 && name !== "" && name !== "." && name !== ".." &&
    Buffer.byteLength(name, "utf8") <= 255 && !/[\\/\u0000-\u001f\u007f]/.test(name);
}

export function readManagedResourceTransactionEffects(
  value: unknown,
  allowedSessionRefs: ReadonlySet<string>,
): readonly ManagedResourceTransactionEffect[] {
  if (!Array.isArray(value)) throw new Error("managed resource transaction effects are invalid");
  const destinations = new Set<string>();
  const objects = new Set<string>();
  const effects: ManagedResourceTransactionEffect[] = [];
  for (const raw of value) {
    const item = objectValue(raw);
    const after = readResourceImage(item?.after);
    const root = typeof item?.root === "string" ? item.root : "";
    const destination = typeof item?.destination === "string" ? item.destination : "";
    const sessionRefs = Array.isArray(item?.sessionRefs) && item.sessionRefs.every((entry) => typeof entry === "string")
      ? item.sessionRefs as string[]
      : [];
    const unique = new Set(sessionRefs);
    if (
      item === undefined || after === undefined || sessionRefs.length === 0 || unique.size !== sessionRefs.length ||
      sessionRefs.some((reference) => !allowedSessionRefs.has(reference)) ||
      !validResourceDestination(root, destination, after) || destinations.has(destination) || objects.has(after.object)
    ) throw new Error("managed resource transaction effect is invalid");
    destinations.add(destination);
    objects.add(after.object);
    effects.push({ sessionRefs: [...sessionRefs], root, destination, after });
  }
  return effects;
}

export async function observeManagedResourceEffects(
  stateDirectory: string,
  transactionId: string,
  effects: readonly ManagedResourceTransactionEffect[],
): Promise<ManagedResourceObservations> {
  const checkedRoots = new Set<string>();
  const positions: ManagedResourceEffectPosition[] = [];
  const bySession = new Map<string, ManagedResourceEffectPosition[]>();
  for (const effect of effects) {
    if (!checkedRoots.has(effect.root)) {
      await requireTransactionRoot(effect.root, "managed resource transaction root");
      checkedRoots.add(effect.root);
    }
    await requireTransactionParents(effect.root, effect.destination, "managed resource");
    const object = resolveTransactionObject(stateDirectory, transactionId, effect.after.object);
    const digest = await digestFile(object);
    if (digest.sizeBytes !== effect.after.sizeBytes || digest.sha256 !== effect.after.sha256) {
      throw new Error("managed resource transaction object differs");
    }
    const current = await observeExclusiveFile(effect.destination, "managed resource");
    const position: ManagedResourceEffectPosition = current === null
      ? "before"
      : exclusiveFileMatches(effect.after, current)
        ? "after"
        : "diverged";
    positions.push(position);
    for (const sessionRef of effect.sessionRefs) {
      const owned = bySession.get(sessionRef) ?? [];
      owned.push(position);
      bySession.set(sessionRef, owned);
    }
  }
  return { positions, bySession };
}

export async function publishManagedResourceEffects(
  stateDirectory: string,
  transactionId: string,
  effects: readonly ManagedResourceTransactionEffect[],
  recovery: boolean,
): Promise<void> {
  const checkedRoots = new Set<string>();
  for (const [index, effect] of effects.entries()) {
    if (!checkedRoots.has(effect.root)) {
      await requireTransactionRoot(effect.root, "managed resource transaction root");
      checkedRoots.add(effect.root);
    }
    await publishExclusiveFile({
      root: effect.root,
      destination: effect.destination,
      source: resolveTransactionObject(stateDirectory, transactionId, effect.after.object),
      temporary: path.join(
        path.dirname(effect.destination),
        `.agenthist-${transactionId}-${index.toString().padStart(6, "0")}-managed-resource.tmp`,
      ),
      image: effect.after,
      description: `managed resource for ${effect.sessionRefs.join(", ")}`,
      recovery,
    });
  }
}
