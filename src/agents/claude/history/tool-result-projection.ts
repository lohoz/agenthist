import path from "node:path";

import type { HistoricalToolEvidence } from "../../../domain/portable-context.js";
import {
  createManagedResourceObject,
  decodeCanonicalBase64,
  MANAGED_TEXT_MEDIA_TYPE,
  managedResourceReference,
  managedResourceName,
  type ManagedResourceReference,
  type ManagedResourceObject,
} from "../../../domain/resource.js";
import { canonicalClaudeUuid } from "../identity.js";

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((name) => names.has(name));
}

function canonicalRecordUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { return canonicalClaudeUuid(value); } catch { return undefined; }
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function managedTextResource(filePath: string, content: string): ManagedResourceObject | undefined {
  const name = path.basename(filePath);
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) return undefined;
  const bytes = Buffer.from(content, "utf8");
  return createManagedResourceObject({
    bytes,
    mediaType: MANAGED_TEXT_MEDIA_TYPE,
    name,
    sourceReference: filePath,
  });
}

function managedFileResource(
  filePath: string,
  mediaType: string,
  bytes: Buffer,
): ManagedResourceObject | undefined {
  const name = managedResourceName(filePath, mediaType);
  return createManagedResourceObject({
    bytes,
    mediaType,
    name,
    sourceReference: filePath,
  });
}

export interface VerifiedReadResultMirror {
  readonly resource?: ManagedResourceObject;
}

export function verifiedReadResultMirror(
  value: unknown,
  call: HistoricalToolEvidence,
  result: HistoricalToolEvidence,
): VerifiedReadResultMirror | undefined {
  if (call.phase !== "call" || call.name !== "Read" || result.phase !== "result" ||
    typeof result.output !== "string" || result.error !== undefined) return undefined;
  const input = objectValue(call.input);
  if (input === undefined || !hasOnlyFields(input, ["file_path"]) || typeof input.file_path !== "string" ||
    !path.isAbsolute(input.file_path) || path.normalize(input.file_path) !== input.file_path) return undefined;
  const mirror = objectValue(value);
  const file = objectValue(mirror?.file);
  if (mirror === undefined || file === undefined || !hasOnlyFields(mirror, ["type", "file"]) ||
    mirror.type !== "text" ||
    !hasOnlyFields(file, ["filePath", "content", "numLines", "startLine", "totalLines"]) ||
    file.filePath !== input.file_path || typeof file.content !== "string") return undefined;
  const numLines = nonnegativeInteger(file.numLines);
  const startLine = nonnegativeInteger(file.startLine);
  const totalLines = nonnegativeInteger(file.totalLines);
  if (numLines === undefined || numLines === 0 || startLine === undefined || startLine === 0 ||
    totalLines === undefined || totalLines < startLine + numLines - 1) return undefined;
  const lines = file.content.split("\n");
  if (lines.length !== numLines) return undefined;
  const numbered = lines.map((line, index) => `${startLine + index}\t${line}`).join("\n");
  if (result.output !== numbered) return undefined;
  const resource = startLine === 1 && numLines === totalLines
    ? managedTextResource(input.file_path, file.content)
    : undefined;
  return resource === undefined ? {} : { resource };
}

function sameResourceReference(
  resource: ManagedResourceObject,
  reference: ManagedResourceReference,
): boolean {
  const actual = managedResourceReference(resource);
  return actual.sha256 === reference.sha256 && actual.sizeBytes === reference.sizeBytes &&
    actual.mediaType === reference.mediaType && actual.name === reference.name &&
    actual.sourceReference === reference.sourceReference && actual.relativePath === reference.relativePath;
}

export function verifiedReadImageResultMirror(
  value: unknown,
  call: HistoricalToolEvidence,
  result: HistoricalToolEvidence,
  resource: ManagedResourceObject,
): boolean {
  if (
    call.phase !== "call" || call.name !== "Read" || result.phase !== "result" ||
    result.error !== undefined || result.resources?.length !== 1 ||
    !sameResourceReference(resource, result.resources[0]!)
  ) return false;
  const input = objectValue(call.input);
  if (
    input === undefined || !hasOnlyFields(input, ["file_path"]) || typeof input.file_path !== "string" ||
    !path.isAbsolute(input.file_path) || path.normalize(input.file_path) !== input.file_path
  ) return false;
  const mirror = objectValue(value);
  const file = objectValue(mirror?.file);
  const dimensions = objectValue(file?.dimensions);
  if (
    mirror === undefined || file === undefined || dimensions === undefined ||
    !hasOnlyFields(mirror, ["type", "file"]) || mirror.type !== "image" ||
    !hasOnlyFields(file, ["base64", "type", "originalSize", "dimensions"]) ||
    typeof file.base64 !== "string" || file.type !== resource.mediaType ||
    !hasOnlyFields(dimensions, ["originalWidth", "originalHeight", "displayWidth", "displayHeight"])
  ) return false;
  const originalSize = nonnegativeInteger(file.originalSize);
  const dimensionValues = [
    dimensions.originalWidth,
    dimensions.originalHeight,
    dimensions.displayWidth,
    dimensions.displayHeight,
  ].map(nonnegativeInteger);
  const bytes = decodeCanonicalBase64(file.base64);
  return originalSize === resource.sizeBytes && originalSize !== 0 &&
    dimensionValues.every((dimension) => dimension !== undefined && dimension > 0) &&
    bytes !== undefined && bytes.equals(Buffer.from(resource.bytes));
}

export function verifiedReadPdfResultMirror(
  value: unknown,
  call: HistoricalToolEvidence,
  result: HistoricalToolEvidence,
): ManagedResourceObject | undefined {
  if (
    call.phase !== "call" || call.name !== "Read" || result.phase !== "result" ||
    typeof result.output !== "string" || result.error !== undefined || result.resources !== undefined
  ) return undefined;
  const input = objectValue(call.input);
  if (
    input === undefined || !hasOnlyFields(input, ["file_path"]) || typeof input.file_path !== "string" ||
    !path.isAbsolute(input.file_path) || path.normalize(input.file_path) !== input.file_path
  ) return undefined;
  const mirror = objectValue(value);
  const file = objectValue(mirror?.file);
  if (
    mirror === undefined || file === undefined || !hasOnlyFields(mirror, ["type", "file"]) ||
    mirror.type !== "pdf" ||
    !hasOnlyFields(file, ["filePath", "base64", "originalSize"]) ||
    file.filePath !== input.file_path || typeof file.base64 !== "string"
  ) return undefined;
  const bytes = decodeCanonicalBase64(file.base64);
  const originalSize = nonnegativeInteger(file.originalSize);
  if (
    bytes === undefined || originalSize === undefined || originalSize === 0 ||
    originalSize !== bytes.byteLength ||
    result.output !== `PDF file read: ${input.file_path} (${originalSize} bytes)`
  ) return undefined;
  return managedFileResource(input.file_path, "application/pdf", bytes);
}

export function verifiedReadPdfMetaCarrier(
  record: Record<string, unknown>,
  resultRecordUuid: string,
  resource: ManagedResourceObject,
): boolean {
  if (
    record.type !== "user" || record.isMeta !== true ||
    canonicalRecordUuid(record.parentUuid) !== resultRecordUuid ||
    record.toolUseResult !== undefined
  ) return false;
  const message = objectValue(record.message);
  if (
    message === undefined || !hasOnlyFields(message, ["role", "content"]) || message.role !== "user" ||
    !Array.isArray(message.content) || message.content.length !== 1
  ) return false;
  const block = objectValue(message.content[0]);
  const source = objectValue(block?.source);
  if (
    block === undefined || source === undefined || !hasOnlyFields(block, ["type", "source"]) ||
    block.type !== "document" || !hasOnlyFields(source, ["type", "media_type", "data"]) ||
    source.type !== "base64" || source.media_type !== "application/pdf" || typeof source.data !== "string"
  ) return false;
  const bytes = decodeCanonicalBase64(source.data);
  return bytes !== undefined && bytes.equals(Buffer.from(resource.bytes));
}

function verifiedBashResultMirror(
  value: unknown,
  call: HistoricalToolEvidence,
  result: HistoricalToolEvidence,
): boolean {
  if (
    call.phase !== "call" || call.name !== "Bash" || result.phase !== "result" ||
    typeof result.output !== "string" || result.error !== undefined || result.resources !== undefined
  ) return false;
  const input = objectValue(call.input);
  if (
    input === undefined ||
    !hasOnlyFields(input, [
      "command", "description", "timeout", "run_in_background", "dangerouslyDisableSandbox",
    ]) ||
    typeof input.command !== "string" || input.command === "" ||
    (input.description !== undefined && typeof input.description !== "string") ||
    (input.timeout !== undefined && (
      typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0
    )) ||
    (input.run_in_background !== undefined && input.run_in_background !== false) ||
    (input.dangerouslyDisableSandbox !== undefined && typeof input.dangerouslyDisableSandbox !== "boolean")
  ) return false;
  const mirror = objectValue(value);
  return mirror !== undefined &&
    hasOnlyFields(mirror, ["stdout", "stderr", "interrupted", "isImage", "noOutputExpected"]) &&
    typeof mirror.stdout === "string" && mirror.stdout === result.output &&
    mirror.stderr === "" && mirror.interrupted === false && mirror.isImage === false &&
    (mirror.noOutputExpected === undefined || mirror.noOutputExpected === false);
}

function verifiedGlobResultMirror(
  value: unknown,
  call: HistoricalToolEvidence,
  result: HistoricalToolEvidence,
): boolean {
  if (
    call.phase !== "call" || call.name !== "Glob" || result.phase !== "result" ||
    typeof result.output !== "string" || result.error !== undefined || result.resources !== undefined
  ) return false;
  const input = objectValue(call.input);
  if (
    input === undefined || !hasOnlyFields(input, ["pattern", "path"]) ||
    typeof input.pattern !== "string" || input.pattern === "" || typeof input.path !== "string" ||
    !path.isAbsolute(input.path) || path.normalize(input.path) !== input.path
  ) return false;
  const mirror = objectValue(value);
  if (
    mirror === undefined ||
    !hasOnlyFields(mirror, [
      "countIsComplete", "durationMs", "filenames", "numFiles", "totalMatches", "truncated",
    ]) ||
    mirror.countIsComplete !== true || mirror.truncated !== false ||
    typeof mirror.durationMs !== "number" || !Number.isFinite(mirror.durationMs) || mirror.durationMs < 0 ||
    !Array.isArray(mirror.filenames) || mirror.filenames.length === 0 ||
    mirror.filenames.some((name) =>
      typeof name !== "string" || name === "" || /[\u0000-\u001f\u007f]/.test(name))
  ) return false;
  const filenames = mirror.filenames as string[];
  const numFiles = nonnegativeInteger(mirror.numFiles);
  const totalMatches = nonnegativeInteger(mirror.totalMatches);
  return new Set(filenames).size === filenames.length && numFiles === filenames.length &&
    totalMatches === filenames.length && result.output === filenames.join("\n");
}

function verifiedToolErrorMirror(
  value: unknown,
  call: HistoricalToolEvidence,
  result: HistoricalToolEvidence,
): boolean {
  if (
    call.phase !== "call" || typeof call.name !== "string" || call.name === "" ||
    result.phase !== "result" || result.output !== undefined || typeof result.error !== "string" ||
    result.resources !== undefined || typeof value !== "string"
  ) return false;
  const visible = result.error.match(/^<tool_use_error>([A-Za-z][A-Za-z0-9]*): ([^\n<]+)[\s\S]*<\/tool_use_error>$/);
  const mirror = value.match(/^([A-Za-z][A-Za-z0-9]*):/);
  return visible !== null && mirror !== null && visible[1] === mirror[1] &&
    visible[2]!.startsWith(`${call.name} failed`);
}

export function verifiedPreToolUseBlockingMirror(
  value: unknown,
  call: HistoricalToolEvidence,
  result: HistoricalToolEvidence,
): boolean {
  if (
    call.phase !== "call" || typeof call.name !== "string" || call.name === "" ||
    result.phase !== "result" || typeof result.error !== "string" || result.error.trim() === "" ||
    result.output !== undefined || result.resources !== undefined || typeof value !== "string"
  ) return false;
  const prefix = `PreToolUse:${call.name} hook error: [`;
  const reasonSeparator = result.error.indexOf("]: ", prefix.length);
  return result.error.startsWith(prefix) && reasonSeparator > prefix.length &&
    result.error.slice(reasonSeparator + 3).trim() !== "" && value === `Error: ${result.error}`;
}

export function verifiedSupplementalToolResultMirror(
  value: unknown,
  call: HistoricalToolEvidence,
  result: HistoricalToolEvidence,
): boolean {
  return verifiedBashResultMirror(value, call, result) ||
    verifiedGlobResultMirror(value, call, result) ||
    verifiedToolErrorMirror(value, call, result);
}

function sameManagedResourceContent(
  value: unknown,
  kind: "image" | "document",
  resource: ManagedResourceObject,
): boolean {
  const block = objectValue(value);
  const source = objectValue(block?.source);
  return block !== undefined && source !== undefined &&
    hasOnlyFields(block, ["type", "source"]) && block.type === kind &&
    hasOnlyFields(source, ["type", "resource_relative_path", "media_type"]) &&
    source.type === "managed_resource" && source.resource_relative_path === resource.relativePath &&
    source.media_type === resource.mediaType;
}

// Claude's REPL writer mirrors media returned by inner Read calls in both the
// model-visible tool_result content and toolUseResult. Accept the capability
// only when the strict input/output carriers and every decoded byte agree.
export function verifiedReplResourceResultMirror(
  value: unknown,
  call: HistoricalToolEvidence,
  result: HistoricalToolEvidence,
  resources: readonly ManagedResourceObject[],
): boolean {
  if (
    call.phase !== "call" || call.name !== "REPL" || result.phase !== "result" ||
    result.error !== undefined || !Array.isArray(result.output) ||
    result.resources?.length !== resources.length || resources.length === 0 ||
    resources.some((resource, index) => !sameResourceReference(resource, result.resources![index]!))
  ) return false;
  const input = objectValue(call.input);
  if (
    input === undefined || !hasOnlyFields(input, ["code", "description", "timeout"]) ||
    typeof input.code !== "string" || input.code === "" ||
    (input.description !== undefined && typeof input.description !== "string") ||
    (input.timeout !== undefined && (typeof input.timeout !== "number" || !Number.isFinite(input.timeout)))
  ) return false;
  const mirror = objectValue(value);
  if (
    mirror === undefined ||
    !hasOnlyFields(mirror, [
      "code", "result", "stdout", "stderr", "error", "registeredTools", "images", "documents",
    ]) ||
    mirror.code !== input.code || typeof mirror.stdout !== "string" || typeof mirror.stderr !== "string" ||
    (mirror.error !== undefined && typeof mirror.error !== "string") ||
    (mirror.registeredTools !== undefined && (
      !Array.isArray(mirror.registeredTools) || mirror.registeredTools.length === 0 ||
      mirror.registeredTools.some((name) => typeof name !== "string" || name === "")
    ))
  ) return false;
  const imageMirrors = mirror.images === undefined ? [] : mirror.images;
  const documentMirrors = mirror.documents === undefined ? [] : mirror.documents;
  if (
    !Array.isArray(imageMirrors) || !Array.isArray(documentMirrors) ||
    (mirror.images !== undefined && imageMirrors.length === 0) ||
    (mirror.documents !== undefined && documentMirrors.length === 0) ||
    imageMirrors.length + documentMirrors.length !== resources.length ||
    result.output.length !== resources.length + 1
  ) return false;
  const textBlock = objectValue(result.output[0]);
  if (
    textBlock === undefined || !hasOnlyFields(textBlock, ["type", "text"]) ||
    textBlock.type !== "text" || typeof textBlock.text !== "string" || textBlock.text === ""
  ) return false;
  for (let index = 0; index < imageMirrors.length; index++) {
    const mirrorImage = objectValue(imageMirrors[index]);
    const resource = resources[index]!;
    if (
      mirrorImage === undefined || !hasOnlyFields(mirrorImage, ["base64", "mediaType"]) ||
      typeof mirrorImage.base64 !== "string" || mirrorImage.mediaType !== resource.mediaType ||
      !sameManagedResourceContent(result.output[index + 1], "image", resource)
    ) return false;
    const bytes = decodeCanonicalBase64(mirrorImage.base64);
    if (bytes === undefined || !bytes.equals(Buffer.from(resource.bytes))) return false;
  }
  for (let index = 0; index < documentMirrors.length; index++) {
    const mirrorDocument = objectValue(documentMirrors[index]);
    const resourceIndex = imageMirrors.length + index;
    const resource = resources[resourceIndex]!;
    if (
      mirrorDocument === undefined || !hasOnlyFields(mirrorDocument, ["base64"]) ||
      typeof mirrorDocument.base64 !== "string" || resource.mediaType !== "application/pdf" ||
      !sameManagedResourceContent(result.output[resourceIndex + 1], "document", resource)
    ) return false;
    const bytes = decodeCanonicalBase64(mirrorDocument.base64);
    if (bytes === undefined || !bytes.equals(Buffer.from(resource.bytes))) return false;
  }
  return true;
}
