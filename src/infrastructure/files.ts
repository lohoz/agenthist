import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export function sameFileStat(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export async function applyPosixMode(filePath: string, mode: number): Promise<void> {
  if (process.platform !== "win32") await chmod(filePath, mode);
}

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectoryTree(root: string): Promise<void> {
  const directories = [root];
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index]!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) directories.push(path.join(directory, entry.name));
    }
  }
  for (let index = directories.length - 1; index >= 0; index--) {
    await syncDirectory(directories[index]!);
  }
}

export async function readStableSmallFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      throw new Error(`unsupported file shape: ${filePath}`);
    }
    const contents = await readFile(handle);
    const after = await handle.stat();
    const current = await lstat(filePath);
    if (!sameFileStat(before, after) || !sameFileStat(before, current) || contents.byteLength !== before.size) {
      throw new Error(`file changed while reading: ${filePath}`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

export async function copyStableFile(sourcePath: string, destinationPath: string): Promise<number> {
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await source.stat();
    if (!before.isFile()) {
      throw new Error(`source is not a regular file: ${sourcePath}`);
    }
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) {
        break;
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) {
          throw new Error(`destination made no progress while copying: ${destinationPath}`);
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destination.sync();
    const after = await source.stat();
    const current = await lstat(sourcePath);
    if (!sameFileStat(before, after) || !sameFileStat(before, current) || position !== before.size) {
      throw new Error(`source changed while copying: ${sourcePath}`);
    }
    return position;
  } finally {
    await destination?.close();
    await source.close();
  }
}

export async function digestFile(filePath: string): Promise<{ readonly sizeBytes: number; readonly sha256: string }> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error(`file is not regular: ${filePath}`);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - position), position);
      if (bytesRead === 0) throw new Error(`file ended while hashing: ${filePath}`);
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(filePath);
    if (!sameFileStat(before, after) || !sameFileStat(before, current)) {
      throw new Error(`file changed while hashing: ${filePath}`);
    }
    return { sizeBytes: before.size, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let temporaryCreated = false;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    temporaryCreated = false;
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (temporaryCreated) {
      try { await rm(temporary, { force: true }); } catch { /* preserve the publication error */ }
    }
    throw error;
  }
}
