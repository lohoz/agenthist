import type { HistoricalReferenceEvidence, PortableContextJson } from "../../../domain/portable-context.js";
import type { ManagedResourceObject } from "../../../domain/resource.js";

export type ClaudeStructuredToolResultKind = "content_document" | "search_result" | "tool_reference";

export interface ClaudeStructuredToolContentProjection {
  readonly content: PortableContextJson;
  readonly kind: ClaudeStructuredToolResultKind;
  readonly managedResources: readonly ManagedResourceObject[];
  readonly references: readonly HistoricalReferenceEvidence[];
  readonly notes: readonly string[];
}

type ClaudeProjectedContentImage = {
  readonly content: PortableContextJson;
  readonly notes?: readonly string[];
} & (
  | { readonly resource: ManagedResourceObject }
  | { readonly reference: HistoricalReferenceEvidence }
);

export interface ClaudeClientToolContentOptions {
  readonly projectImage: (value: unknown) => ClaudeProjectedContentImage | undefined;
}

const CACHE_CONTROL_SKIPPED_NOTE = "claude.tool_cache_control.skipped";

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((name) => names.has(name));
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function projectClaudeCacheControl(value: Record<string, unknown>): readonly string[] | undefined {
  if (!Object.hasOwn(value, "cache_control") || value.cache_control === null) return [];
  const cacheControl = objectValue(value.cache_control);
  return cacheControl !== undefined && hasOnlyFields(cacheControl, ["type", "ttl"]) &&
      cacheControl.type === "ephemeral" &&
      (cacheControl.ttl === undefined || cacheControl.ttl === "5m" || cacheControl.ttl === "1h")
    ? [CACHE_CONTROL_SKIPPED_NOTE]
    : undefined;
}

export type ClaudeTextCitationMode = "parameter" | "response";

function portableCitation(value: unknown, mode: ClaudeTextCitationMode): PortableContextJson | undefined {
  const citation = objectValue(value);
  if (citation === undefined) return undefined;
  switch (citation.type) {
    case "char_location": {
      const fields = [
        "type", "cited_text", "document_index", "document_title", "end_char_index", "start_char_index",
        ...(mode === "response" ? ["file_id"] : []),
      ];
      if (
        !hasOnlyFields(citation, fields) || typeof citation.cited_text !== "string" ||
        !safeInteger(citation.document_index) ||
        citation.document_index < 0 || !nullableString(citation.document_title) ||
        !safeInteger(citation.start_char_index) || citation.start_char_index < 0 ||
        !safeInteger(citation.end_char_index) || citation.end_char_index <= citation.start_char_index ||
        (mode === "response" && !nullableString(citation.file_id))
      ) return undefined;
      return {
        type: citation.type,
        cited_text: citation.cited_text,
        document_index: citation.document_index,
        document_title: citation.document_title,
        end_char_index: citation.end_char_index,
        start_char_index: citation.start_char_index,
        ...(mode === "response" ? { file_id: citation.file_id as string | null } : {}),
      };
    }
    case "page_location": {
      const fields = [
        "type", "cited_text", "document_index", "document_title", "end_page_number", "start_page_number",
        ...(mode === "response" ? ["file_id"] : []),
      ];
      if (
        !hasOnlyFields(citation, fields) || typeof citation.cited_text !== "string" ||
        !safeInteger(citation.document_index) ||
        citation.document_index < 0 || !nullableString(citation.document_title) ||
        !safeInteger(citation.start_page_number) || citation.start_page_number < 1 ||
        !safeInteger(citation.end_page_number) || citation.end_page_number < citation.start_page_number ||
        (mode === "response" && !nullableString(citation.file_id))
      ) return undefined;
      return {
        type: citation.type,
        cited_text: citation.cited_text,
        document_index: citation.document_index,
        document_title: citation.document_title,
        end_page_number: citation.end_page_number,
        start_page_number: citation.start_page_number,
        ...(mode === "response" ? { file_id: citation.file_id as string | null } : {}),
      };
    }
    case "content_block_location": {
      const fields = [
        "type", "cited_text", "document_index", "document_title", "end_block_index", "start_block_index",
        ...(mode === "response" ? ["file_id"] : []),
      ];
      if (
        !hasOnlyFields(citation, fields) || typeof citation.cited_text !== "string" ||
        !safeInteger(citation.document_index) ||
        citation.document_index < 0 || !nullableString(citation.document_title) ||
        !safeInteger(citation.start_block_index) || citation.start_block_index < 0 ||
        !safeInteger(citation.end_block_index) || citation.end_block_index <= citation.start_block_index ||
        (mode === "response" && !nullableString(citation.file_id))
      ) return undefined;
      return {
        type: citation.type,
        cited_text: citation.cited_text,
        document_index: citation.document_index,
        document_title: citation.document_title,
        end_block_index: citation.end_block_index,
        start_block_index: citation.start_block_index,
        ...(mode === "response" ? { file_id: citation.file_id as string | null } : {}),
      };
    }
    case "web_search_result_location":
      if (
        !hasOnlyFields(citation, ["type", "cited_text", "encrypted_index", "title", "url"]) ||
        typeof citation.cited_text !== "string" || typeof citation.encrypted_index !== "string" ||
        !nullableString(citation.title) || typeof citation.url !== "string"
      ) return undefined;
      return {
        type: citation.type,
        cited_text: citation.cited_text,
        encrypted_index: citation.encrypted_index,
        title: citation.title,
        url: citation.url,
      };
    case "search_result_location":
      if (
        !hasOnlyFields(citation, [
          "type", "cited_text", "end_block_index", "search_result_index", "source", "start_block_index", "title",
        ]) || typeof citation.cited_text !== "string" ||
        !safeInteger(citation.start_block_index) || citation.start_block_index < 0 ||
        !safeInteger(citation.end_block_index) || citation.end_block_index <= citation.start_block_index ||
        !safeInteger(citation.search_result_index) || citation.search_result_index < 0 ||
        typeof citation.source !== "string" || !nullableString(citation.title)
      ) return undefined;
      return {
        type: citation.type,
        cited_text: citation.cited_text,
        end_block_index: citation.end_block_index,
        search_result_index: citation.search_result_index,
        source: citation.source,
        start_block_index: citation.start_block_index,
        title: citation.title,
      };
    default:
      return undefined;
  }
}

export type ClaudeTextCitationsProjection = readonly PortableContextJson[] | null;

export function projectClaudeTextCitations(
  value: unknown,
  mode: ClaudeTextCitationMode,
): ClaudeTextCitationsProjection | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const citations: PortableContextJson[] = [];
  for (const raw of value) {
    const citation = portableCitation(raw, mode);
    if (citation === undefined) return undefined;
    citations.push(citation);
  }
  return citations;
}

function portableCitationsConfig(value: unknown): PortableContextJson | undefined {
  const config = objectValue(value);
  if (config === undefined || !hasOnlyFields(config, ["enabled"])) return undefined;
  if (!Object.hasOwn(config, "enabled")) return {};
  return typeof config.enabled === "boolean" ? { enabled: config.enabled } : undefined;
}

function portableSearchResult(value: Record<string, unknown>): ClaudeStructuredToolContentProjection | undefined {
  if (
    !hasOnlyFields(value, ["type", "content", "source", "title", "cache_control", "citations"]) ||
    value.type !== "search_result" || typeof value.source !== "string" || value.source === "" ||
    typeof value.title !== "string" || value.title === "" || !Array.isArray(value.content) ||
    value.content.length === 0
  ) return undefined;
  const cacheControlNotes = projectClaudeCacheControl(value);
  if (cacheControlNotes === undefined) return undefined;
  const citations = Object.hasOwn(value, "citations")
    ? portableCitationsConfig(value.citations)
    : undefined;
  if (Object.hasOwn(value, "citations") && citations === undefined) return undefined;

  const content: PortableContextJson[] = [];
  const notes = [...cacheControlNotes];
  let readable = false;
  for (const raw of value.content) {
    const text = objectValue(raw);
    if (
      text === undefined || !hasOnlyFields(text, ["type", "text", "cache_control", "citations"]) ||
      text.type !== "text" || typeof text.text !== "string"
    ) return undefined;
    const textCacheControlNotes = projectClaudeCacheControl(text);
    if (textCacheControlNotes === undefined) return undefined;
    const textCitations = Object.hasOwn(text, "citations")
      ? projectClaudeTextCitations(text.citations, "parameter")
      : undefined;
    if (Object.hasOwn(text, "citations") && textCitations === undefined) return undefined;
    notes.push(...textCacheControlNotes);
    if (text.text !== "") readable = true;
    content.push({
      type: "text",
      text: text.text,
      ...(Object.hasOwn(text, "citations") ? { citations: textCitations! } : {}),
    });
  }
  return readable
    ? {
        content: {
          type: "search_result",
          source: value.source,
          title: value.title,
          content,
          ...(Object.hasOwn(value, "citations") ? { citations: citations! } : {}),
        },
        kind: "search_result",
        managedResources: [],
        references: [],
        notes,
      }
    : undefined;
}

function portableToolReference(value: Record<string, unknown>): ClaudeStructuredToolContentProjection | undefined {
  if (
    !hasOnlyFields(value, ["type", "tool_name", "cache_control"]) || value.type !== "tool_reference" ||
    typeof value.tool_name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.tool_name)
  ) return undefined;
  const cacheControlNotes = projectClaudeCacheControl(value);
  return cacheControlNotes === undefined
    ? undefined
    : {
        content: { type: "tool_reference", tool_name: value.tool_name },
        kind: "tool_reference",
        managedResources: [],
        references: [],
        notes: cacheControlNotes,
      };
}

function portableContentDocument(
  value: Record<string, unknown>,
  options: ClaudeClientToolContentOptions,
): ClaudeStructuredToolContentProjection | undefined {
  const source = objectValue(value.source);
  if (
    source === undefined ||
    !hasOnlyFields(value, ["type", "source", "cache_control", "citations", "context", "title"]) ||
    value.type !== "document" ||
    !hasOnlyFields(source, ["type", "content"]) || source.type !== "content"
  ) return undefined;
  const cacheControlNotes = projectClaudeCacheControl(value);
  if (cacheControlNotes === undefined ||
    (Object.hasOwn(value, "context") && !nullableString(value.context)) ||
    (Object.hasOwn(value, "title") && !nullableString(value.title))) return undefined;
  const notes = [...cacheControlNotes];
  const citations = Object.hasOwn(value, "citations")
    ? value.citations === null ? null : portableCitationsConfig(value.citations)
    : undefined;
  if (Object.hasOwn(value, "citations") && citations === undefined) return undefined;
  let content: PortableContextJson | undefined;
  const managedResources: ManagedResourceObject[] = [];
  const references: HistoricalReferenceEvidence[] = [];
  if (typeof source.content === "string" && source.content !== "") {
    content = source.content;
  } else if (Array.isArray(source.content) && source.content.length !== 0) {
    const contentBlocks: PortableContextJson[] = [];
    let portable = false;
    for (const raw of source.content) {
      const text = objectValue(raw);
      if (text?.type === "image") {
        if (!hasOnlyFields(text, ["type", "source", "cache_control"])) return undefined;
        const imageCacheControlNotes = projectClaudeCacheControl(text);
        if (imageCacheControlNotes === undefined) return undefined;
        const image = options.projectImage({ type: "image", source: text.source });
        if (image === undefined) return undefined;
        if ("resource" in image) {
          if (managedResources.some((resource) => resource.relativePath === image.resource.relativePath)) {
            return undefined;
          }
          managedResources.push(image.resource);
        } else {
          references.push(image.reference);
        }
        notes.push(...imageCacheControlNotes, ...(image.notes ?? []));
        contentBlocks.push(image.content);
        portable = true;
        continue;
      }
      if (
        text === undefined || !hasOnlyFields(text, ["type", "text", "cache_control", "citations"]) ||
        text.type !== "text" || typeof text.text !== "string"
      ) return undefined;
      const textCacheControlNotes = projectClaudeCacheControl(text);
      if (textCacheControlNotes === undefined) return undefined;
      const textCitations = Object.hasOwn(text, "citations")
        ? projectClaudeTextCitations(text.citations, "parameter")
        : undefined;
      if (Object.hasOwn(text, "citations") && textCitations === undefined) return undefined;
      notes.push(...textCacheControlNotes);
      if (text.text !== "") portable = true;
      contentBlocks.push({
        type: "text",
        text: text.text,
        ...(Object.hasOwn(text, "citations") ? { citations: textCitations! } : {}),
      });
    }
    if (portable) content = contentBlocks;
  }
  return content === undefined
    ? undefined
    : {
        content: {
          type: "document",
          source: { type: "content", content },
          ...(Object.hasOwn(value, "citations") ? { citations: citations! } : {}),
          ...(Object.hasOwn(value, "context") ? { context: value.context as string | null } : {}),
          ...(Object.hasOwn(value, "title") ? { title: value.title as string | null } : {}),
        },
        kind: "content_document",
        managedResources,
        references,
        notes,
      };
}

export function projectClaudeClientToolContent(
  value: unknown,
  options: ClaudeClientToolContentOptions,
): ClaudeStructuredToolContentProjection | undefined {
  const block = objectValue(value);
  if (block === undefined) return undefined;
  if (block.type === "search_result") return portableSearchResult(block);
  if (block.type === "tool_reference") return portableToolReference(block);
  if (block.type === "document" && objectValue(block.source)?.type === "content") {
    return portableContentDocument(block, options);
  }
  return undefined;
}
