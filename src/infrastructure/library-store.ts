import path from "node:path";

import {
  readLibraryMetadata,
  sessionAgent,
  type LibraryMetadata,
} from "../domain/history.js";
import { readStableSmallFile, writeJsonAtomic } from "./files.js";

const SCHEMA_VERSION = "agenthist.history.library/v1" as const;
const MAX_LIBRARY_BYTES = 64 * 1024 * 1024;
const MAX_LIBRARY_ENTRIES = 100_000;

export interface LibraryEntry extends LibraryMetadata {
  readonly sessionRef: string;
}

export interface LibraryOverlay {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly entries: readonly LibraryEntry[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function libraryPath(stateDirectory: string): string {
  return path.join(stateDirectory, "history", "library.json");
}

function readEntry(value: unknown): LibraryEntry | undefined {
  const item = objectValue(value);
  if (
    item === undefined ||
    Object.keys(item).sort().join("\0") !== "archived\0deleted\0name\0sessionRef\0tags" ||
    typeof item.sessionRef !== "string" || sessionAgent(item.sessionRef) === undefined
  ) return undefined;
  const metadata = readLibraryMetadata({
    name: item.name,
    tags: item.tags,
    archived: item.archived,
    deleted: item.deleted,
  });
  return metadata === undefined ? undefined : { sessionRef: item.sessionRef, ...metadata };
}

function validateOverlay(value: unknown): LibraryOverlay {
  const item = objectValue(value);
  if (
    item === undefined || Object.keys(item).sort().join("\0") !== "entries\0schemaVersion" ||
    item.schemaVersion !== SCHEMA_VERSION || !Array.isArray(item.entries) ||
    item.entries.length > MAX_LIBRARY_ENTRIES
  ) throw new Error("history library is invalid");
  const entries: LibraryEntry[] = [];
  let previous = "";
  for (const value of item.entries) {
    const entry = readEntry(value);
    if (entry === undefined || (previous !== "" && previous >= entry.sessionRef)) {
      throw new Error("history library is invalid");
    }
    entries.push(entry);
    previous = entry.sessionRef;
  }
  return { schemaVersion: SCHEMA_VERSION, entries };
}

export async function loadLibraryOverlay(stateDirectory: string): Promise<LibraryOverlay> {
  let bytes: Buffer;
  try {
    bytes = await readStableSmallFile(libraryPath(stateDirectory), MAX_LIBRARY_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: SCHEMA_VERSION, entries: [] };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("history library is invalid JSON");
  }
  return validateOverlay(value);
}

export async function saveLibraryOverlay(
  stateDirectory: string,
  entries: readonly LibraryEntry[],
): Promise<void> {
  const sorted = [...entries].sort((left, right) => left.sessionRef < right.sessionRef ? -1 : left.sessionRef > right.sessionRef ? 1 : 0);
  const overlay = validateOverlay({ schemaVersion: SCHEMA_VERSION, entries: sorted });
  await writeJsonAtomic(libraryPath(stateDirectory), overlay);
}
