import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm, unlink } from "node:fs/promises";
import path from "node:path";

import type {
  ArchiveManifest,
  ArchiveObjectDescriptor,
  ProjectedArchiveEntry,
} from "../domain/archive.js";
import { isAgent } from "../domain/agent.js";
import { readLibraryMetadata } from "../domain/history.js";
import { sameFileStat, syncDirectory } from "./files.js";

const MAGIC = Buffer.from("AGENTHIST\0V1\n", "ascii");
const RECORD_BYTES = 13;
const RECORD_OBJECT = 1;
const RECORD_MANIFEST = 2;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_OBJECTS = 100_000;
const MAX_OBJECT_KIND_BYTES = 256;
const OBJECT_ID = /^o[0-9]{6}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface ArchiveObjectSource {
  readonly id: string;
  readonly kind: string;
  readonly filePath: string;
}

export interface PreparedArchiveEntries {
  readonly sources: readonly ArchiveObjectSource[];
  readonly entries: readonly ProjectedArchiveEntry[];
}

export interface ArchiveWriteResult {
  readonly file: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly manifest: ArchiveManifest;
}

export interface ArchiveReadResult {
  readonly file: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly manifest: ArchiveManifest;
  readonly extractedObjects: ReadonlyMap<string, string>;
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  data: Uint8Array,
  position: number,
  digest: ReturnType<typeof createHash>,
): Promise<number> {
  digest.update(data);
  let offset = 0;
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, position + offset);
    if (bytesWritten === 0) {
      throw new Error("archive write made no progress");
    }
    offset += bytesWritten;
  }
  return position + data.byteLength;
}

function recordHeader(kind: number, metadataBytes: number, payloadBytes: number): Buffer {
  if (metadataBytes < 1 || metadataBytes > MAX_HEADER_BYTES || payloadBytes < 0 || payloadBytes > MAX_OBJECT_BYTES) {
    throw new Error("archive record exceeds limits");
  }
  const header = Buffer.alloc(RECORD_BYTES);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(metadataBytes, 1);
  header.writeBigUInt64BE(BigInt(payloadBytes), 5);
  return header;
}

async function writeObject(
  output: Awaited<ReturnType<typeof open>>,
  source: ArchiveObjectSource,
  position: number,
  fileDigest: ReturnType<typeof createHash>,
): Promise<{ position: number; descriptor: ArchiveObjectDescriptor }> {
  if (!OBJECT_ID.test(source.id) || source.kind === "" || Buffer.byteLength(source.kind) > MAX_OBJECT_KIND_BYTES) {
    throw new Error("invalid archive object source");
  }
  const input = await open(source.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size < 0 || before.size > MAX_OBJECT_BYTES) {
      throw new Error(`archive object is not a supported regular file: ${source.filePath}`);
    }
    const metadata = Buffer.from(JSON.stringify({ id: source.id, kind: source.kind }), "utf8");
    position = await writeAll(output, recordHeader(RECORD_OBJECT, metadata.byteLength, before.size), position, fileDigest);
    position = await writeAll(output, metadata, position, fileDigest);
    const objectDigest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let sourcePosition = 0;
    while (sourcePosition < before.size) {
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - sourcePosition),
        sourcePosition,
      );
      if (bytesRead === 0) {
        throw new Error(`archive object ended early: ${source.filePath}`);
      }
      const chunk = buffer.subarray(0, bytesRead);
      objectDigest.update(chunk);
      position = await writeAll(output, chunk, position, fileDigest);
      sourcePosition += bytesRead;
    }
    const after = await input.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`archive object changed while exporting: ${source.filePath}`);
    }
    return {
      position,
      descriptor: {
        id: source.id,
        kind: source.kind,
        sizeBytes: before.size,
        sha256: objectDigest.digest("hex"),
      },
    };
  } finally {
    await input.close();
  }
}

async function requireMissingOutput(outputPath: string): Promise<void> {
  try {
    await lstat(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`archive output already exists: ${outputPath}`);
}

export async function writeArchive(
  outputPath: string,
  objects: readonly ArchiveObjectSource[],
  manifestFactory: (descriptors: readonly ArchiveObjectDescriptor[]) => ArchiveManifest,
): Promise<ArchiveWriteResult> {
  if (!outputPath.endsWith(".agenthist") || objects.length > MAX_OBJECTS) {
    throw new Error("archive output must be a .agenthist file within object limits");
  }
  const directory = path.dirname(outputPath);
  await mkdir(directory, { recursive: true });
  await requireMissingOutput(outputPath);
  const stagingPath = path.join(directory, `.agenthist-write-${randomUUID()}.tmp`);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  const fileDigest = createHash("sha256");
  let position = 0;
  try {
    output = await open(stagingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    position = await writeAll(output, MAGIC, position, fileDigest);
    const descriptors: ArchiveObjectDescriptor[] = [];
    for (const object of objects) {
      const written = await writeObject(output, object, position, fileDigest);
      position = written.position;
      descriptors.push(written.descriptor);
    }
    const manifest = manifestFactory(descriptors);
    const payload = Buffer.from(JSON.stringify(manifest), "utf8");
    if (payload.byteLength > MAX_MANIFEST_BYTES) {
      throw new Error("archive manifest exceeds limits");
    }
    const metadata = Buffer.from(JSON.stringify({ schemaVersion: "agenthist.manifest-record/v1" }), "utf8");
    position = await writeAll(output, recordHeader(RECORD_MANIFEST, metadata.byteLength, payload.byteLength), position, fileDigest);
    position = await writeAll(output, metadata, position, fileDigest);
    position = await writeAll(output, payload, position, fileDigest);
    await output.sync();
    await output.close();
    output = undefined;
    await link(stagingPath, outputPath);
    await unlink(stagingPath);
    await syncDirectory(directory);
    return { file: outputPath, sizeBytes: position, sha256: fileDigest.digest("hex"), manifest };
  } catch (error) {
    try { await output?.close(); } catch { /* preserve the archive failure */ }
    try { await rm(stagingPath, { force: true }); } catch { /* preserve the archive failure */ }
    throw error;
  }
}

async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
  digest: ReturnType<typeof createHash>,
): Promise<Buffer> {
  const result = Buffer.allocUnsafe(length);
  return readExactInto(handle, result, length, position, digest);
}

async function readExactInto(
  handle: Awaited<ReturnType<typeof open>>,
  result: Buffer,
  length: number,
  position: number,
  digest: ReturnType<typeof createHash>,
): Promise<Buffer> {
  if (length > result.byteLength) throw new Error("archive read buffer is too small");
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(result, offset, length - offset, position + offset);
    if (bytesRead === 0) {
      throw new Error("archive ended unexpectedly");
    }
    offset += bytesRead;
  }
  const bytes = result.subarray(0, length);
  digest.update(bytes);
  return bytes;
}

function parseRecordMetadata(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("archive record metadata is invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("archive record metadata is invalid");
  }
  return value as Record<string, unknown>;
}

function validateManifest(
  value: unknown,
  observed: ReadonlyMap<string, ArchiveObjectDescriptor>,
): ArchiveManifest {
  const manifest = value as Partial<ArchiveManifest> | null;
  if (
    manifest === null || typeof manifest !== "object" || Array.isArray(manifest) ||
    Object.keys(manifest).sort().join("\0") !== "createdAt\0entries\0objects\0pathFlavor\0schemaVersion" ||
    manifest.schemaVersion !== "agenthist.archive/v1" ||
    typeof manifest.createdAt !== "string" ||
    (manifest.pathFlavor !== "posix" && manifest.pathFlavor !== "windows") ||
    !Array.isArray(manifest.entries) || !Array.isArray(manifest.objects)
  ) {
    throw new Error("archive manifest is invalid");
  }
  if (manifest.objects.length !== observed.size) {
    throw new Error("archive object closure is incomplete");
  }
  const declared = new Set<string>();
  for (const descriptor of manifest.objects) {
    if (
      descriptor === null || typeof descriptor !== "object" || !OBJECT_ID.test(descriptor.id) ||
      typeof descriptor.kind !== "string" || descriptor.kind === "" ||
      Buffer.byteLength(descriptor.kind) > MAX_OBJECT_KIND_BYTES || typeof descriptor.sizeBytes !== "number" ||
      !DIGEST.test(descriptor.sha256) || declared.has(descriptor.id)
    ) {
      throw new Error("archive object descriptor is invalid");
    }
    declared.add(descriptor.id);
    const actual = observed.get(descriptor.id);
    if (
      actual === undefined || actual.kind !== descriptor.kind || actual.sizeBytes !== descriptor.sizeBytes ||
      actual.sha256 !== descriptor.sha256
    ) {
      throw new Error(`archive object verification failed: ${descriptor.id}`);
    }
  }
  for (const entry of manifest.entries) {
    if (
      entry === null || typeof entry !== "object" || entry.kind !== "history" ||
      Object.keys(entry).sort().join("\0") !==
        "agent\0context\0createdAt\0kind\0library\0model\0native\0nativeArchived\0nativeId\0objects\0provider\0resources\0sessionRef\0title\0updatedAt" ||
      (typeof entry.agent !== "string" || !isAgent(entry.agent)) ||
      typeof entry.sessionRef !== "string" || readLibraryMetadata(entry.library) === undefined ||
      !Array.isArray(entry.objects) || !Array.isArray(entry.resources)
    ) {
      throw new Error("archive entry is invalid");
    }
    for (const binding of entry.objects) {
      if (binding === null || typeof binding !== "object" || !declared.has(binding.id)) {
        throw new Error("archive entry references a missing object");
      }
    }
    for (const resource of entry.resources) {
      if (resource === null || typeof resource !== "object" || !declared.has(resource.id)) {
        throw new Error("archive entry references a missing resource object");
      }
    }
  }
  return manifest as ArchiveManifest;
}

export async function readArchive(filePath: string, extractDirectory?: string): Promise<ArchiveReadResult> {
  if (!filePath.endsWith(".agenthist")) {
    throw new Error("archive input must use the .agenthist extension");
  }
  if (extractDirectory !== undefined) {
    await mkdir(extractDirectory, { recursive: true, mode: 0o700 });
  }
  const input = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const fileDigest = createHash("sha256");
  const observed = new Map<string, ArchiveObjectDescriptor>();
  const extracted = new Map<string, string>();
  const objectBuffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    const stat = await input.stat();
    if (!stat.isFile()) throw new Error("archive input is not a regular file");
    const magic = await readExact(input, MAGIC.byteLength, position, fileDigest);
    position += magic.byteLength;
    if (!magic.equals(MAGIC)) {
      throw new Error("archive magic is unsupported");
    }
    let manifestValue: unknown;
    while (position < stat.size) {
      const fixed = await readExact(input, RECORD_BYTES, position, fileDigest);
      position += fixed.byteLength;
      const kind = fixed.readUInt8(0);
      const metadataLength = fixed.readUInt32BE(1);
      const payloadBig = fixed.readBigUInt64BE(5);
      if (metadataLength < 1 || metadataLength > MAX_HEADER_BYTES || payloadBig > BigInt(MAX_OBJECT_BYTES)) {
        throw new Error("archive record exceeds limits");
      }
      const payloadLength = Number(payloadBig);
      const metadataBytes = await readExact(input, metadataLength, position, fileDigest);
      position += metadataLength;
      const metadata = parseRecordMetadata(metadataBytes);
      if (kind === RECORD_MANIFEST) {
        if (
          manifestValue !== undefined || metadata.schemaVersion !== "agenthist.manifest-record/v1" ||
          payloadLength > MAX_MANIFEST_BYTES || position + payloadLength !== stat.size
        ) {
          throw new Error("archive manifest record is invalid");
        }
        const payload = await readExact(input, payloadLength, position, fileDigest);
        position += payloadLength;
        try {
          manifestValue = JSON.parse(payload.toString("utf8"));
        } catch {
          throw new Error("archive manifest JSON is invalid");
        }
        break;
      }
      if (kind !== RECORD_OBJECT || manifestValue !== undefined || observed.size === MAX_OBJECTS) {
        throw new Error("archive record kind is invalid");
      }
      const id = metadata.id;
      const objectKind = metadata.kind;
      if (
        typeof id !== "string" || !OBJECT_ID.test(id) || typeof objectKind !== "string" || objectKind === "" ||
        Buffer.byteLength(objectKind) > MAX_OBJECT_KIND_BYTES || observed.has(id)
      ) {
        throw new Error("archive object record is invalid");
      }
      const objectDigest = createHash("sha256");
      let destination: Awaited<ReturnType<typeof open>> | undefined;
      let destinationPath: string | undefined;
      if (extractDirectory !== undefined) {
        destinationPath = path.join(extractDirectory, id);
        destination = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      }
      try {
        let remaining = payloadLength;
        while (remaining > 0) {
          const chunkLength = Math.min(1024 * 1024, remaining);
          const chunk = await readExactInto(input, objectBuffer, chunkLength, position, fileDigest);
          position += chunkLength;
          remaining -= chunkLength;
          objectDigest.update(chunk);
          if (destination !== undefined) {
            let written = 0;
            while (written < chunk.byteLength) {
              const result = await destination.write(chunk, written, chunk.byteLength - written, null);
              if (result.bytesWritten === 0) throw new Error("archive extraction made no progress");
              written += result.bytesWritten;
            }
          }
        }
        await destination?.sync();
      } finally {
        await destination?.close();
      }
      observed.set(id, { id, kind: objectKind, sizeBytes: payloadLength, sha256: objectDigest.digest("hex") });
      if (destinationPath !== undefined) extracted.set(id, destinationPath);
    }
    if (manifestValue === undefined || position !== stat.size) {
      throw new Error("archive manifest is missing or trailing bytes are present");
    }
    const after = await input.stat();
    const current = await lstat(filePath);
    if (!sameFileStat(stat, after) || !sameFileStat(stat, current)) {
      throw new Error("archive changed while reading");
    }
    const manifest = validateManifest(manifestValue, observed);
    return {
      file: filePath,
      sizeBytes: stat.size,
      sha256: fileDigest.digest("hex"),
      manifest,
      extractedObjects: extracted,
    };
  } finally {
    await input.close();
  }
}
