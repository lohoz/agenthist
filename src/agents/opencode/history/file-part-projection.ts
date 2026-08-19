import {
  createManagedResourceObject,
  decodeCanonicalBase64DataUri,
  managedResourceName,
  type ManagedResourceObject,
} from "../../../domain/resource.js";
import {
  validHistoricalReference,
  type HistoricalReferenceEvidence,
} from "../../../domain/portable-context.js";

interface OpenCodePartIdentity {
  readonly id: string;
  readonly messageId: string;
  readonly sessionId: string;
}

interface OpenCodeMessageIdentity {
  readonly messageId: string;
  readonly sessionId: string;
}

interface OpenCodeSessionMessageFileIdentity extends OpenCodeMessageIdentity {
  readonly ordinal: number;
}

interface OpenCodeSessionMessageToolContentFileIdentity extends OpenCodeSessionMessageFileIdentity {
  readonly callId: string;
}

interface OpenCodeSessionMessageToolAttachmentIdentity extends OpenCodeSessionMessageFileIdentity {
  readonly callId: string;
}

export type ProjectedOpenCodeFilePart =
  | {
    readonly kind: "resource";
    readonly resource: ManagedResourceObject;
    readonly notes: readonly string[];
  }
  | {
    readonly kind: "reference";
    readonly reference: HistoricalReferenceEvidence;
    readonly notes: readonly string[];
  };

interface ProjectedOpenCodeSessionMessageResource {
  readonly resource: ManagedResourceObject;
  readonly notes: readonly string[];
}

export type ProjectedOpenCodeSessionMessageFile =
  | ({ readonly kind: "resource" } & ProjectedOpenCodeSessionMessageResource)
  | {
    readonly kind: "reference";
    readonly reference: HistoricalReferenceEvidence;
    readonly notes: readonly string[];
  };

export type ProjectedOpenCodeSessionMessageToolContentFile =
  | { readonly kind: "resource"; readonly resource: ManagedResourceObject }
  | {
    readonly kind: "reference";
    readonly reference: HistoricalReferenceEvidence;
    readonly mediaType: string;
    readonly name: string;
  };

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((name) => names.has(name));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sourceText(value: unknown): Record<string, unknown> | undefined {
  const text = objectValue(value);
  if (
    text === undefined || !hasOnlyFields(text, ["value", "start", "end"]) ||
    typeof text.value !== "string" || !finite(text.start) || !finite(text.end)
  ) return undefined;
  return { value: text.value, start: text.start, end: text.end };
}

function sourceRange(value: unknown): Record<string, unknown> | undefined {
  const range = objectValue(value);
  const start = objectValue(range?.start);
  const end = objectValue(range?.end);
  if (
    range === undefined || !hasOnlyFields(range, ["start", "end"]) ||
    start === undefined || !hasOnlyFields(start, ["line", "character"]) ||
    end === undefined || !hasOnlyFields(end, ["line", "character"]) ||
    !nonNegativeInteger(start.line) || !nonNegativeInteger(start.character) ||
    !nonNegativeInteger(end.line) || !nonNegativeInteger(end.character)
  ) return undefined;
  return {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
  };
}

function persistedFileSource(value: unknown): Record<string, unknown> | undefined {
  const source = objectValue(value);
  const capturedText = sourceText(source?.text);
  if (source === undefined || capturedText === undefined) return undefined;
  if (
    source.type === "file" && hasOnlyFields(source, ["type", "path", "text"]) &&
    typeof source.path === "string"
  ) {
    return { type: "file", path: source.path, text: capturedText };
  }
  const range = sourceRange(source.range);
  if (
    source.type === "symbol" && hasOnlyFields(source, ["type", "path", "range", "name", "kind", "text"]) &&
    typeof source.path === "string" && typeof source.name === "string" &&
    nonNegativeInteger(source.kind) && range !== undefined
  ) {
    return {
      type: "symbol",
      path: source.path,
      range,
      name: source.name,
      kind: source.kind,
      text: capturedText,
    };
  }
  return undefined;
}

function safeSourceReference(value: string): boolean {
  return value !== "" && Buffer.byteLength(value, "utf8") <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}

function promptSource(value: unknown): boolean {
  if (value === undefined) return true;
  const source = objectValue(value);
  return source !== undefined && hasOnlyFields(source, ["start", "end", "text"]) &&
    finite(source.start) && finite(source.end) && typeof source.text === "string";
}

function managedDataUriResource(
  url: string,
  mediaType: string,
  filename: string,
  sourceReference: string,
): ManagedResourceObject | undefined {
  const decoded = decodeCanonicalBase64DataUri(url, mediaType);
  if (decoded === undefined) return undefined;
  const name = managedResourceName(filename, mediaType);
  return createManagedResourceObject({
    bytes: decoded.bytes,
    mediaType,
    name,
    sourceReference,
  });
}

function fileLocatorReference(url: string, mediaType: string): HistoricalReferenceEvidence | undefined {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return undefined;
  }
  if (protocol === "data:") return undefined;
  const reference: HistoricalReferenceEvidence = {
    type: mediaType.startsWith("image/") ? "image" : mediaType === "application/pdf" ? "document" : "file",
    namespace: "opencode.file_url",
    locator: url,
  };
  return validHistoricalReference(reference) ? reference : undefined;
}

export function projectOpenCodeToolAttachments(
  value: unknown,
  identity: OpenCodeMessageIdentity,
): ManagedResourceObject[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const identities = new Set<string>();
  const result: ManagedResourceObject[] = [];
  for (const raw of value) {
    const attachment = objectValue(raw);
    if (attachment === undefined || !hasOnlyFields(
      attachment,
      ["id", "sessionID", "messageID", "type", "mime", "url", "filename"],
    )) return undefined;
    const id = typeof attachment.id === "string" ? attachment.id : undefined;
    const mediaType = typeof attachment.mime === "string" ? attachment.mime : undefined;
    const url = typeof attachment.url === "string" ? attachment.url : undefined;
    if (
      id === undefined || id === "" || identities.has(id) || attachment.type !== "file" ||
      attachment.sessionID !== identity.sessionId || attachment.messageID !== identity.messageId ||
      mediaType === undefined || mediaType === "" || url === undefined ||
      (attachment.filename !== undefined && typeof attachment.filename !== "string")
    ) return undefined;
    identities.add(id);
    const resource = managedDataUriResource(
      url,
      mediaType,
      typeof attachment.filename === "string" ? attachment.filename : "",
      `opencode:tool-attachment:${id}`,
    );
    if (resource === undefined) return undefined;
    result.push(resource);
  }
  return result;
}

export function projectOpenCodeSessionMessageFile(
  value: unknown,
  identity: OpenCodeSessionMessageFileIdentity,
): ProjectedOpenCodeSessionMessageFile | undefined {
  const file = openCodeSessionMessageFile(value, identity);
  if (file === undefined) return undefined;
  const resource = projectOpenCodeSessionMessageFileResource(
    file,
    `opencode:session-message-file:${identity.sessionId}:${identity.messageId}:${identity.ordinal}`,
    "opencode.session_message_file_metadata.skipped",
  );
  if (resource !== undefined) return { kind: "resource", ...resource };
  const reference = fileLocatorReference(file.uri, file.mediaType);
  if (reference === undefined) return undefined;
  return {
    kind: "reference",
    reference,
    notes: [
      "opencode.file_url.reference_preserved",
      ...(file.hasMetadata ? ["opencode.session_message_file_metadata.skipped"] : []),
    ],
  };
}

export function projectOpenCodeSessionMessageToolAttachment(
  value: unknown,
  identity: OpenCodeSessionMessageToolAttachmentIdentity,
): ProjectedOpenCodeSessionMessageFile | undefined {
  const file = openCodeSessionMessageFile(value, identity);
  if (file === undefined) return undefined;
  const resource = projectOpenCodeSessionMessageFileResource(
    file,
    `opencode:session-message-tool-attachment:${identity.sessionId}:${identity.messageId}:${identity.callId}:${identity.ordinal}`,
    "opencode.session_message_tool_attachment_metadata.skipped",
  );
  if (resource !== undefined) return { kind: "resource", ...resource };
  const reference = fileLocatorReference(file.uri, file.mediaType);
  if (reference === undefined) return undefined;
  return {
    kind: "reference",
    reference,
    notes: [
      "opencode.session_message_tool_attachment.reference_preserved",
      ...(file.hasMetadata ? ["opencode.session_message_tool_attachment_metadata.skipped"] : []),
    ],
  };
}

interface OpenCodeSessionMessageFile {
  readonly uri: string;
  readonly mediaType: string;
  readonly name: string;
  readonly hasMetadata: boolean;
}

function openCodeSessionMessageFile(
  value: unknown,
  identity: OpenCodeSessionMessageFileIdentity,
): OpenCodeSessionMessageFile | undefined {
  const file = objectValue(value);
  if (
    file === undefined || !hasOnlyFields(file, ["uri", "mime", "name", "description", "source"]) ||
    typeof file.uri !== "string" || typeof file.mime !== "string" || file.mime === "" ||
    (file.name !== undefined && typeof file.name !== "string") ||
    (file.description !== undefined && typeof file.description !== "string") || !promptSource(file.source) ||
    identity.sessionId === "" || identity.messageId === "" ||
    !Number.isSafeInteger(identity.ordinal) || identity.ordinal < 0
  ) return undefined;
  return {
    uri: file.uri,
    mediaType: file.mime,
    name: typeof file.name === "string" ? file.name : "",
    hasMetadata: file.description !== undefined || file.source !== undefined,
  };
}

function projectOpenCodeSessionMessageFileResource(
  file: OpenCodeSessionMessageFile,
  sourceReference: string,
  metadataNote: string,
): ProjectedOpenCodeSessionMessageResource | undefined {
  const resource = managedDataUriResource(
    file.uri,
    file.mediaType,
    file.name,
    sourceReference,
  );
  if (resource === undefined) return undefined;
  return {
    resource,
    notes: file.hasMetadata ? [metadataNote] : [],
  };
}

export function projectOpenCodeSessionMessageToolContentFile(
  value: unknown,
  identity: OpenCodeSessionMessageToolContentFileIdentity,
): ProjectedOpenCodeSessionMessageToolContentFile | undefined {
  const file = objectValue(value);
  if (
    file === undefined || !hasOnlyFields(file, ["type", "uri", "mime", "name"]) || file.type !== "file" ||
    typeof file.uri !== "string" || typeof file.mime !== "string" || file.mime === "" ||
    (file.name !== undefined && typeof file.name !== "string") ||
    identity.sessionId === "" || identity.messageId === "" || identity.callId === "" ||
    !Number.isSafeInteger(identity.ordinal) || identity.ordinal < 0
  ) return undefined;
  const name = typeof file.name === "string" ? file.name : "";
  const resource = managedDataUriResource(
    file.uri,
    file.mime,
    name,
    `opencode:session-message-tool-content:${identity.sessionId}:${identity.messageId}:${identity.callId}:${identity.ordinal}`,
  );
  if (resource !== undefined) return { kind: "resource", resource };
  const reference = fileLocatorReference(file.uri, file.mime);
  return reference === undefined
    ? undefined
    : { kind: "reference", reference, mediaType: file.mime, name };
}

export function projectOpenCodeFilePart(
  data: Record<string, unknown>,
  identity: OpenCodePartIdentity,
): ProjectedOpenCodeFilePart | undefined {
  if (!hasOnlyFields(data, ["type", "mime", "url", "filename", "synthetic", "source"]) || data.type !== "file") {
    return undefined;
  }
  const mediaType = typeof data.mime === "string" ? data.mime : undefined;
  const url = typeof data.url === "string" ? data.url : undefined;
  if (
    identity.id === "" || identity.messageId === "" || identity.sessionId === "" ||
    mediaType === undefined || mediaType === "" || url === undefined ||
    (data.filename !== undefined && typeof data.filename !== "string") ||
    (data.synthetic !== undefined && typeof data.synthetic !== "boolean")
  ) return undefined;

  const baseReference = `opencode:file-part:${identity.sessionId}:${identity.messageId}:${identity.id}`;
  let sourceReference = baseReference;
  const source = data.source === undefined ? undefined : persistedFileSource(data.source);
  if (data.source !== undefined && source === undefined) return undefined;
  const resourceNotes: string[] = [];
  if (source !== undefined) {
    const candidate = `${baseReference}:source=${JSON.stringify(source)}`;
    if (safeSourceReference(candidate)) {
      sourceReference = candidate;
      resourceNotes.push("opencode.file_source.preserved");
    } else {
      resourceNotes.push("opencode.file_source.skipped");
    }
  }
  const resource = managedDataUriResource(
    url,
    mediaType,
    typeof data.filename === "string" ? data.filename : "",
    sourceReference,
  );
  if (resource !== undefined) return { kind: "resource", resource, notes: resourceNotes };

  const reference = fileLocatorReference(url, mediaType);
  if (reference === undefined) return undefined;
  return {
    kind: "reference",
    reference,
    notes: [
      "opencode.file_url.reference_preserved",
      ...(source === undefined ? [] : ["opencode.file_source.skipped"]),
    ],
  };
}
