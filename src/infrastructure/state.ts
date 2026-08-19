import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { applyPosixMode } from "./files.js";

const LOCK_FILE = ".state-lock.sqlite";

export async function ensurePrivateStateDirectory(stateDirectory: string): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await applyPosixMode(stateDirectory, 0o700);
  const info = await lstat(stateDirectory);
  if (
    !info.isDirectory() || info.isSymbolicLink() ||
    process.platform !== "win32" && (info.mode & 0o077) !== 0
  ) {
    throw new Error("state directory is not a private real directory");
  }
}

export async function withStateWriteLock<T>(stateDirectory: string, action: () => Promise<T>): Promise<T> {
  await ensurePrivateStateDirectory(stateDirectory);
  const database = new DatabaseSync(path.join(stateDirectory, LOCK_FILE));
  let begun = false;
  try {
    database.exec("PRAGMA busy_timeout = 0");
    try {
      database.exec("BEGIN EXCLUSIVE");
      begun = true;
    } catch {
      throw new Error("another AgentHist state write is running");
    }
    const result = await action();
    database.exec("COMMIT");
    begun = false;
    return result;
  } catch (error) {
    if (begun) {
      try { database.exec("ROLLBACK"); } catch { /* the process lock is released by close */ }
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function withStateReadLock<T>(stateDirectory: string, action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(stateDirectory, LOCK_FILE);
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("AgentHist state lock is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return action();
    throw error;
  }
  const database = new DatabaseSync(lockPath, { readOnly: true });
  let begun = false;
  try {
    database.exec("PRAGMA busy_timeout = 0");
    try {
      database.exec("BEGIN");
      begun = true;
      database.prepare("SELECT count(*) AS count FROM sqlite_schema").get();
    } catch {
      throw new Error("another AgentHist state write is running");
    }
    return await action();
  } finally {
    if (begun) {
      try { database.exec("ROLLBACK"); } catch { /* the read lock is released by close */ }
    }
    database.close();
  }
}
