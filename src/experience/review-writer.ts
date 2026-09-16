import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm, unlink } from "node:fs/promises";
import path from "node:path";

import {
  renderExperienceAudit,
  renderExperienceReview,
  validateExperienceReviewPack,
  type ExperienceReviewPack,
} from "./review.js";
import { readStableSmallFile, syncDirectory } from "../infrastructure/files.js";

export const MAX_EXPERIENCE_REVIEW_DATA_BYTES = 64 * 1024 * 1024;

export interface ExperienceReviewPublication {
  readonly directory: string;
  readonly reviewFile: string;
  readonly auditFile: string;
  readonly dataFile: string;
}

async function writeExclusiveAtomic(filePath: string, contents: string): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, filePath);
    await unlink(temporary);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function defaultDirectory(cwd: string, createdAt: string): string {
  const timestamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.join(cwd, `agenthist-experience-${timestamp}`);
}

export async function publishExperienceReview(
  cwd: string,
  pack: ExperienceReviewPack,
  requestedDirectory?: string,
): Promise<ExperienceReviewPublication> {
  const validated = validateExperienceReviewPack(pack);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_EXPERIENCE_REVIEW_DATA_BYTES) {
    throw new Error("experience review data exceeds the supported byte limit");
  }
  const directory = path.resolve(cwd, requestedDirectory ?? defaultDirectory(cwd, validated.createdAt));
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`experience output already exists: ${directory}`);
    }
    throw error;
  }
  const reviewFile = path.join(directory, "review.md");
  const auditFile = path.join(directory, "audit.md");
  const dataFile = path.join(directory, "review.json");
  try {
    await writeExclusiveAtomic(reviewFile, renderExperienceReview(validated));
    await writeExclusiveAtomic(auditFile, renderExperienceAudit(validated));
    await writeExclusiveAtomic(dataFile, serialized);
    await syncDirectory(directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, reviewFile, auditFile, dataFile };
}

async function reviewDataFile(pathOrDirectory: string, cwd: string): Promise<string> {
  if (
    pathOrDirectory === "" || pathOrDirectory.includes("\0") ||
    Buffer.byteLength(pathOrDirectory, "utf8") > 64 * 1024
  ) throw new Error("experience review path is invalid");
  const resolved = path.resolve(cwd, pathOrDirectory);
  const info = await lstat(resolved);
  if (info.isSymbolicLink()) throw new Error("experience review path cannot be a symbolic link");
  if (info.isDirectory()) return path.join(resolved, "review.json");
  if (!info.isFile()) throw new Error("experience review path is not a regular file or directory");
  return resolved;
}

export async function loadExperienceReviewPack(
  pathOrDirectory: string,
  cwd = process.cwd(),
): Promise<ExperienceReviewPack> {
  const file = await reviewDataFile(pathOrDirectory, cwd);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`experience review data file was not found: ${file}`);
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("experience review data is not a regular file");
  }
  const bytes = await readStableSmallFile(file, MAX_EXPERIENCE_REVIEW_DATA_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("experience review data is invalid JSON");
  }
  return validateExperienceReviewPack(value);
}
