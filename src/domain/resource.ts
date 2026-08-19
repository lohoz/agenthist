import { createHash } from "node:crypto";
import path from "node:path";

export const MANAGED_TEXT_MEDIA_TYPE = "text/plain; charset=utf-8" as const;
export const MAX_MANAGED_RESOURCE_BYTES = 64 * 1024 * 1024;

export interface ManagedResourceReference {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly name: string;
  readonly sourceReference: string;
  readonly relativePath: string;
}

export interface ManagedResourceObject extends ManagedResourceReference {
  readonly bytes: Uint8Array;
}

export interface ManagedResourceObjectInput {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly name: string;
  readonly sourceReference: string | ((sha256: string) => string);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validMediaType(value: string): boolean {
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:; charset=utf-8)?$/.test(value);
}

export function decodeCanonicalBase64(value: string): Buffer | undefined {
  if (
    value === "" || value.length > Math.ceil(MAX_MANAGED_RESOURCE_BYTES / 3) * 4 ||
    /\s/.test(value)
  ) return undefined;
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength === 0 || bytes.byteLength > MAX_MANAGED_RESOURCE_BYTES ||
    bytes.toString("base64") !== value
  ) return undefined;
  return bytes;
}

export function decodeCanonicalBase64DataUri(
  value: string,
  expectedMediaType?: string,
): { readonly mediaType: string; readonly bytes: Buffer } | undefined {
  if (!value.startsWith("data:")) return undefined;
  const separator = value.indexOf(";base64,");
  if (separator <= "data:".length) return undefined;
  const mediaType = value.slice("data:".length, separator);
  const encoded = value.slice(separator + ";base64,".length);
  if (!validMediaType(mediaType) || (expectedMediaType !== undefined && mediaType !== expectedMediaType)) {
    return undefined;
  }
  const bytes = decodeCanonicalBase64(encoded);
  if (bytes === undefined) return undefined;
  return { mediaType, bytes };
}

export function managedResourceName(filename: string, mediaType: string): string {
  const name = path.posix.basename(filename.replaceAll("\\", "/"));
  if (
    name !== "" && name !== "." && name !== ".." && Buffer.byteLength(name, "utf8") <= 255 &&
    !/[\\/\u0000-\u001f\u007f]/.test(name)
  ) return name;
  const suffix = new Map<string, string>([
    ["image/png", ".png"],
    ["image/jpeg", ".jpg"],
    ["image/gif", ".gif"],
    ["image/webp", ".webp"],
    ["audio/mpeg", ".mp3"],
    ["audio/mp4", ".m4a"],
    ["audio/ogg", ".ogg"],
    ["audio/wav", ".wav"],
    ["audio/webm", ".webm"],
    ["application/pdf", ".pdf"],
    ["text/plain", ".txt"],
    [MANAGED_TEXT_MEDIA_TYPE, ".txt"],
  ]).get(mediaType) ?? ".bin";
  return `attachment${suffix}`;
}

export function createManagedResourceObject(
  input: ManagedResourceObjectInput,
): ManagedResourceObject | undefined {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const sourceReference = typeof input.sourceReference === "string"
    ? input.sourceReference
    : input.sourceReference(sha256);
  const resource: ManagedResourceObject = {
    sha256,
    sizeBytes: input.bytes.byteLength,
    mediaType: input.mediaType,
    name: input.name,
    sourceReference,
    relativePath: `.agenthist/resources/sha256/${sha256}/${input.name}`,
    bytes: input.bytes,
  };
  return validManagedResourceReference(resource) ? resource : undefined;
}

export function managedResourceReference(
  resource: ManagedResourceReference,
): ManagedResourceReference {
  return {
    sha256: resource.sha256,
    sizeBytes: resource.sizeBytes,
    mediaType: resource.mediaType,
    name: resource.name,
    sourceReference: resource.sourceReference,
    relativePath: resource.relativePath,
  };
}

export function validManagedResourceReference(value: unknown): value is ManagedResourceReference {
  const resource = objectValue(value);
  if (resource === undefined || typeof resource.relativePath !== "string") return false;
  const parts = resource.relativePath.split("/");
  return typeof resource.sha256 === "string" && /^[0-9a-f]{64}$/.test(resource.sha256) &&
    typeof resource.sizeBytes === "number" && Number.isSafeInteger(resource.sizeBytes) &&
    resource.sizeBytes >= 0 && resource.sizeBytes <= MAX_MANAGED_RESOURCE_BYTES &&
    typeof resource.mediaType === "string" && validMediaType(resource.mediaType) &&
    typeof resource.name === "string" && resource.name !== "" && resource.name !== "." && resource.name !== ".." &&
    Buffer.byteLength(resource.name, "utf8") <= 255 && !/[\\/\u0000-\u001f\u007f]/.test(resource.name) &&
    typeof resource.sourceReference === "string" && resource.sourceReference !== "" &&
    Buffer.byteLength(resource.sourceReference, "utf8") <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(resource.sourceReference) &&
    parts.length === 5 && parts[0] === ".agenthist" && parts[1] === "resources" &&
    parts[2] === "sha256" && parts[3] === resource.sha256 && parts[4] === resource.name;
}
