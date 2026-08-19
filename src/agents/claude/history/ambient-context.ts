import path from "node:path";

import { decodeCanonicalBase64 } from "../../../domain/resource.js";

const CLAUDE_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const RECORD_FIELDS = [
  "parentUuid", "isSidechain", "attachment", "type", "uuid", "timestamp", "userType",
  "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug",
] as const;
const OPTIONAL_STRING_RECORD_FIELDS = ["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"];

export interface ClaudeAmbientUserContext {
  readonly text: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((name) => names.has(name));
}

function attachmentRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!hasOnlyFields(record, RECORD_FIELDS)) return undefined;
  const attachment = objectValue(record.attachment);
  if (
    record.type !== "attachment" || record.isSidechain !== false || attachment === undefined ||
    typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
    !OPTIONAL_STRING_RECORD_FIELDS.every((field) =>
      record[field] === undefined || typeof record[field] === "string")
  ) return undefined;
  return attachment;
}

function validOpaqueIdentity(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !/[\u0000-\u001f\u007f]/.test(value);
}

function truncateClaudeAmbientText(value: string): string {
  if (value.length <= 2_000) return value;
  let truncated = value.slice(0, 2_000);
  const trailingCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (trailingCodeUnit >= 0xD800 && trailingCodeUnit <= 0xDBFF) {
    truncated = truncated.slice(0, -1);
  }
  const normalized = Buffer.from(truncated, "utf16le").toString("utf16le");
  return `${normalized}\n... (truncated)`;
}

export function claudeAmbientUserContextRecord(
  record: Record<string, unknown>,
): ClaudeAmbientUserContext | undefined {
  const attachment = attachmentRecord(record);
  if (attachment === undefined) return undefined;

  if (attachment.type === "selected_lines_in_diff") {
    if (
      !hasOnlyFields(attachment, ["type", "lineCount", "content", "filePath"]) ||
      typeof attachment.lineCount !== "number" || !Number.isSafeInteger(attachment.lineCount) ||
      attachment.lineCount <= 0 || typeof attachment.content !== "string" || attachment.content === "" ||
      attachment.filePath !== undefined && (
        typeof attachment.filePath !== "string" || attachment.filePath === "" ||
        /[\u0000-\u001f\u007f]/.test(attachment.filePath)
      )
    ) return undefined;
    const location = attachment.filePath === undefined ? "" : ` (in ${attachment.filePath})`;
    return {
      text: `The user selected the following ${attachment.lineCount} ` +
        `${attachment.lineCount === 1 ? "line" : "lines"} from the diff view${location}:\n` +
        `${truncateClaudeAmbientText(attachment.content)}\n` +
        "This may or may not be related to the current task.",
    };
  }

  if (attachment.type === "selected_lines_in_ide") {
    if (
      typeof record.cwd !== "string" || !path.isAbsolute(record.cwd) || path.normalize(record.cwd) !== record.cwd ||
      !hasOnlyFields(attachment, [
        "type", "ideName", "lineStart", "lineEnd", "filename", "content", "displayPath",
      ]) ||
      !validOpaqueIdentity(attachment.ideName) ||
      typeof attachment.lineStart !== "number" || !Number.isSafeInteger(attachment.lineStart) ||
      attachment.lineStart <= 0 ||
      typeof attachment.lineEnd !== "number" || !Number.isSafeInteger(attachment.lineEnd) ||
      attachment.lineEnd < attachment.lineStart ||
      typeof attachment.filename !== "string" || !path.isAbsolute(attachment.filename) ||
      path.normalize(attachment.filename) !== attachment.filename ||
      typeof attachment.content !== "string" || attachment.content === "" ||
      typeof attachment.displayPath !== "string" || attachment.displayPath === "" ||
      attachment.displayPath !== path.relative(record.cwd, attachment.filename)
    ) return undefined;
    return {
      text: `The user selected the lines ${attachment.lineStart} to ${attachment.lineEnd} ` +
        `from ${attachment.filename}:\n${truncateClaudeAmbientText(attachment.content)}\n` +
        "This may or may not be related to the current task.",
    };
  }

  if (attachment.type === "opened_file_in_ide") {
    if (
      !hasOnlyFields(attachment, ["type", "filename"]) ||
      typeof attachment.filename !== "string" || !path.isAbsolute(attachment.filename) ||
      path.normalize(attachment.filename) !== attachment.filename
    ) return undefined;
    return {
      text: `The user opened the file ${attachment.filename} in the IDE. ` +
        "This may or may not be related to the current task.",
    };
  }

  if (attachment.type === "edited_text_file") {
    if (
      !hasOnlyFields(attachment, ["type", "filename", "snippet"]) ||
      typeof attachment.filename !== "string" || !path.isAbsolute(attachment.filename) ||
      path.normalize(attachment.filename) !== attachment.filename ||
      typeof attachment.snippet !== "string"
    ) return undefined;
    const prefix = `Note: ${attachment.filename} was modified, either by the user or by a linter. ` +
      "This change was intentional, so make sure to take it into account as you proceed " +
      "(ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware. ";
    return {
      text: attachment.snippet === ""
        ? `${prefix}The diff was omitted because other modified files in this turn already exceeded the ` +
          "snippet budget; use the Read tool if you need the current content."
        : `${prefix}Here are the relevant changes (shown with line numbers):\n${attachment.snippet}`,
    };
  }

  return undefined;
}

export function skippableClaudeEditedImageRecord(record: Record<string, unknown>): boolean {
  const attachment = attachmentRecord(record);
  const content = objectValue(attachment?.content);
  const file = objectValue(content?.file);
  const dimensions = objectValue(file?.dimensions);
  if (
    attachment === undefined || !hasOnlyFields(attachment, ["type", "filename", "content"]) ||
    attachment.type !== "edited_image_file" ||
    typeof attachment.filename !== "string" || !path.isAbsolute(attachment.filename) ||
    path.normalize(attachment.filename) !== attachment.filename || content === undefined ||
    !hasOnlyFields(content, ["type", "file"]) || content.type !== "image" || file === undefined ||
    !hasOnlyFields(file, ["base64", "type", "originalSize", "dimensions"]) ||
    typeof file.base64 !== "string" || decodeCanonicalBase64(file.base64) === undefined ||
    typeof file.type !== "string" || !CLAUDE_IMAGE_MEDIA_TYPES.has(file.type) ||
    typeof file.originalSize !== "number" || !Number.isSafeInteger(file.originalSize) ||
    file.originalSize <= 0 ||
    dimensions !== undefined && (
      !hasOnlyFields(dimensions, ["originalWidth", "originalHeight", "displayWidth", "displayHeight"]) ||
      !["originalWidth", "originalHeight", "displayWidth", "displayHeight"].every((field) =>
        typeof dimensions[field] === "number" && Number.isSafeInteger(dimensions[field]) &&
        (dimensions[field] as number) > 0)
    )
  ) return false;
  return true;
}
