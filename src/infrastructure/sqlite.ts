import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { JsonValue } from "../domain/history.js";

export function encodeSQLiteValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return { type: "integer", value: value.toString() };
  if (value instanceof Uint8Array) return { type: "blob", base64: Buffer.from(value).toString("base64") };
  throw new Error("SQLite returned an unsupported value");
}

export function decodeSQLiteValue(value: JsonValue): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (!Array.isArray(value)) {
    if (value.type === "integer" && typeof value.value === "string") return BigInt(value.value);
    if (value.type === "blob" && typeof value.base64 === "string") return Buffer.from(value.base64, "base64");
  }
  throw new Error("persisted SQLite value is invalid");
}

export function quoteSQLiteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`unsupported SQLite identifier: ${value}`);
  }
  return `"${value}"`;
}

export async function backupSQLiteDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await rm(destinationPath, { force: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
  try {
    source.prepare("VACUUM INTO ?").run(destinationPath);
  } finally {
    source.close();
  }
}
