import { link, lstat, mkdir, rm, unlink } from "node:fs/promises";
import path from "node:path";

import { applyPosixMode, copyStableFile, digestFile, syncDirectory } from "./files.js";

export interface ExclusiveFileImage {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mode: number;
}

export interface ObservedExclusiveFile extends ExclusiveFileImage {
  readonly device: number;
  readonly inode: number;
  readonly links: number;
}

export async function observeExclusiveFile(
  filePath: string,
  description: string,
): Promise<ObservedExclusiveFile | null> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`${description} is not a regular file: ${filePath}`);
    }
    return {
      ...(await digestFile(filePath)),
      mode: info.mode & 0o777,
      device: info.dev,
      inode: info.ino,
      links: info.nlink,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function exclusiveFileMatches(
  image: ExclusiveFileImage,
  current: ObservedExclusiveFile | null,
): boolean {
  return current !== null && current.sizeBytes === image.sizeBytes && current.sha256 === image.sha256 &&
    (process.platform === "win32" || current.mode === image.mode) && current.links === 1;
}

function contentsMatch(image: ExclusiveFileImage, current: ObservedExclusiveFile | null): boolean {
  return current !== null && current.sizeBytes === image.sizeBytes && current.sha256 === image.sha256 &&
    (process.platform === "win32" || current.mode === image.mode);
}

export async function requireRealDirectory(directory: string, description: string): Promise<void> {
  const resolved = path.resolve(directory);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${description} is not a real directory`);
  }
}

export async function requireSafeDirectoryParents(
  root: string,
  destination: string,
  description: string,
): Promise<void> {
  const relative = path.relative(root, destination);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${description} destination is outside its root`);
  }
  let current = path.resolve(root);
  const parent = path.dirname(relative);
  for (const component of parent === "." ? [] : parent.split(path.sep)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`${description} parent is unsafe: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function sameFile(left: ObservedExclusiveFile, right: ObservedExclusiveFile): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export interface PublishExclusiveFileOptions {
  readonly root: string;
  readonly destination: string;
  readonly source: string;
  readonly temporary: string;
  readonly image: ExclusiveFileImage;
  readonly description: string;
  readonly recovery: boolean;
}

export async function publishExclusiveFile(options: PublishExclusiveFileOptions): Promise<void> {
  await requireSafeDirectoryParents(options.root, options.destination, options.description);
  let target = await observeExclusiveFile(options.destination, options.description);
  let staged = await observeExclusiveFile(options.temporary, `${options.description} staging file`);

  if (target !== null) {
    if (!options.recovery) throw new Error(`${options.description} target already exists`);
    if (exclusiveFileMatches(options.image, target)) {
      if (staged !== null) {
        if (!contentsMatch(options.image, staged)) throw new Error(`${options.description} staging file diverged`);
        await unlink(options.temporary);
        await syncDirectory(path.dirname(options.destination));
      }
      return;
    }
    if (
      staged !== null && contentsMatch(options.image, target) && contentsMatch(options.image, staged) &&
      sameFile(target, staged)
    ) {
      await unlink(options.temporary);
      await syncDirectory(path.dirname(options.destination));
      target = await observeExclusiveFile(options.destination, options.description);
      if (exclusiveFileMatches(options.image, target)) return;
    }
    throw new Error(`${options.description} target diverged`);
  }

  await mkdir(path.dirname(options.destination), { recursive: true, mode: 0o700 });
  await requireSafeDirectoryParents(options.root, options.destination, options.description);
  try {
    staged = await observeExclusiveFile(options.temporary, `${options.description} staging file`);
    if (staged === null) {
      await copyStableFile(options.source, options.temporary);
      await applyPosixMode(options.temporary, options.image.mode);
      staged = await observeExclusiveFile(options.temporary, `${options.description} staging file`);
    }
    if (!exclusiveFileMatches(options.image, staged)) {
      throw new Error(`${options.description} staging file diverged`);
    }
    if (await observeExclusiveFile(options.destination, options.description) !== null) {
      throw new Error(`${options.description} target appeared during publication`);
    }
    await link(options.temporary, options.destination);
    await unlink(options.temporary);
    await syncDirectory(path.dirname(options.destination));
    if (!exclusiveFileMatches(options.image, await observeExclusiveFile(options.destination, options.description))) {
      throw new Error(`${options.description} publication could not be verified`);
    }
  } catch (error) {
    await rm(options.temporary, { force: true });
    throw error;
  }
}

export interface RemoveExclusiveFileOptions {
  readonly destination: string;
  readonly image: ExclusiveFileImage;
  readonly description: string;
  readonly recovery: boolean;
}

export async function removeExclusiveFile(options: RemoveExclusiveFileOptions): Promise<void> {
  const current = await observeExclusiveFile(options.destination, options.description);
  if (current === null && options.recovery) return;
  if (!exclusiveFileMatches(options.image, current)) throw new Error(`${options.description} target diverged`);
  const before = await lstat(options.destination);
  const verified = await observeExclusiveFile(options.destination, options.description);
  const after = await lstat(options.destination);
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
    !exclusiveFileMatches(options.image, verified)
  ) throw new Error(`${options.description} changed while deleting`);
  await unlink(options.destination);
  await syncDirectory(path.dirname(options.destination));
}
