import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";

import type { JsonValue } from "../../../domain/history.js";
import { sameFileStat } from "../../../infrastructure/files.js";

const MAX_HEADER_BYTES = 1024 * 1024;

export interface ProjectPiSessionHeaderOptions {
  readonly source: string;
  readonly destination: string;
  readonly cwd: string;
  readonly parentSession?: string;
}

export async function projectPiSessionHeader(options: ProjectPiSessionHeaderOptions): Promise<void> {
  await mkdir(path.dirname(options.destination), { recursive: true, mode: 0o700 });
  const source = await open(options.source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    const before = await source.stat();
    if (!before.isFile()) throw new Error(`Pi session is not a regular file: ${options.source}`);
    const prefix = Buffer.allocUnsafe(Math.min(before.size, MAX_HEADER_BYTES) + 1);
    const { bytesRead } = await source.read(prefix, 0, prefix.byteLength, 0);
    const newline = prefix.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) throw new Error("Pi session header is not newline-terminated or exceeds validation limits");
    const firstLine = prefix.subarray(0, newline).toString("utf8").replace(/\r$/, "");
    let original: unknown;
    try { original = JSON.parse(firstLine); } catch { throw new Error("Pi session header is invalid JSON"); }
    if (
      original === null || typeof original !== "object" || Array.isArray(original) ||
      (original as Record<string, unknown>).type !== "session" ||
      (original as Record<string, unknown>).version !== 3
    ) throw new Error("Pi session header is invalid or unsupported");
    const projected: Record<string, JsonValue> = {
      ...(original as Record<string, JsonValue>),
      cwd: options.cwd,
    };
    if (options.parentSession === undefined) delete projected.parentSession;
    else projected.parentSession = options.parentSession;

    destination = await open(
      options.destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    const header = Buffer.from(`${JSON.stringify(projected)}\n`, "utf8");
    await destination.write(header, 0, header.byteLength, 0);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let sourcePosition = newline + 1;
    let destinationPosition = header.byteLength;
    while (sourcePosition < before.size) {
      const { bytesRead: count } = await source.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - sourcePosition),
        sourcePosition,
      );
      if (count === 0) throw new Error(`Pi session ended while projecting: ${options.source}`);
      let written = 0;
      while (written < count) {
        const result = await destination.write(
          buffer,
          written,
          count - written,
          destinationPosition + written,
        );
        if (result.bytesWritten === 0) throw new Error(`Pi projection made no progress: ${options.destination}`);
        written += result.bytesWritten;
      }
      sourcePosition += count;
      destinationPosition += count;
    }
    await destination.sync();
    const after = await source.stat();
    const current = await lstat(options.source);
    if (!sameFileStat(before, after) || !sameFileStat(before, current)) {
      throw new Error(`Pi session changed while projecting: ${options.source}`);
    }
  } catch (error) {
    await destination?.close();
    destination = undefined;
    if (created) await rm(options.destination, { force: true });
    throw error;
  } finally {
    await destination?.close();
    await source.close();
  }
}
