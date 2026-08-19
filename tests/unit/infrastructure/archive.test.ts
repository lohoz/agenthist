import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readArchive } from "../../../src/infrastructure/archive.js";

test("archive reader rejects oversized object-kind metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-archive-limit-"));
  try {
    const metadata = Buffer.from(JSON.stringify({ id: "o000000", kind: "x".repeat(257) }), "utf8");
    const record = Buffer.alloc(13);
    record.writeUInt8(1, 0);
    record.writeUInt32BE(metadata.byteLength, 1);
    record.writeBigUInt64BE(0n, 5);
    const archive = path.join(root, "oversized-kind.agenthist");
    await writeFile(archive, Buffer.concat([
      Buffer.from("AGENTHIST\0V1\n", "ascii"),
      record,
      metadata,
    ]));

    await assert.rejects(readArchive(archive), {
      message: "archive object record is invalid",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
