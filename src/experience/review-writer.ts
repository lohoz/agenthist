import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";

import {
  renderExperienceAudit,
  renderExperienceReview,
  type ExperienceReviewPack,
} from "./review.js";
import { syncDirectory } from "../infrastructure/files.js";

export interface ExperienceReviewPublication {
  readonly directory: string;
  readonly reviewFile: string;
  readonly auditFile: string;
}

async function writeExclusive(filePath: string, contents: string): Promise<void> {
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
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
  const directory = path.resolve(cwd, requestedDirectory ?? defaultDirectory(cwd, pack.createdAt));
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
  try {
    await writeExclusive(reviewFile, renderExperienceReview(pack));
    await writeExclusive(auditFile, renderExperienceAudit(pack));
    await syncDirectory(directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, reviewFile, auditFile };
}
