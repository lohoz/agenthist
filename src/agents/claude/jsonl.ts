import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export async function forEachClaudeJsonlRecord(
  filePath: string,
  visit: (record: Record<string, unknown>) => void,
): Promise<void> {
  const input = createReadStream(filePath);
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (line === "") continue;
      if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
        throw new Error("Claude transcript record exceeds validation limits");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new Error("Claude transcript contains invalid JSON"); }
      const record = objectValue(parsed);
      if (record === undefined) throw new Error("Claude transcript record is not an object");
      visit(record);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}
