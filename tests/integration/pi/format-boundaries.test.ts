import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parsePiSession } from "../../../src/agents/pi/history/session.js";

const WORKSPACE = "/source/pi-format";
const IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function assistant(text: string, timestamp: number, provider = "fixture-provider", model = "gpt-5.4") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider,
    model,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function jsonl(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

test("Pi parser covers the current v3 tree, metadata, extension, summary, and message variants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-pi-format-"));
  try {
    const file = path.join(root, "current.jsonl");
    const started = Date.parse("2026-08-18T01:00:00.000Z");
    const at = (seconds: number) => new Date(started + seconds * 1_000).toISOString();
    const records = [{
      type: "session",
      version: 3,
      id: "pi-current-format",
      timestamp: at(0),
      cwd: WORKSPACE,
    }, {
      type: "session_info",
      id: "00000001",
      parentId: null,
      timestamp: at(1),
      name: "Pi current format",
    }, {
      type: "model_change",
      id: "00000002",
      parentId: "00000001",
      timestamp: at(2),
      provider: "fixture-provider",
      modelId: "gpt-5.4",
    }, {
      type: "thinking_level_change",
      id: "00000003",
      parentId: "00000002",
      timestamp: at(3),
      thinkingLevel: "high",
    }, {
      type: "message",
      id: "00000004",
      parentId: "00000003",
      timestamp: at(4),
      message: { role: "user", content: "Pi root user marker", timestamp: started + 4_000 },
    }, {
      type: "message",
      id: "00000005",
      parentId: "00000004",
      timestamp: at(5),
      message: {
        ...assistant("", started + 5_000),
        content: [
          { type: "thinking", thinking: "Pi reasoning marker" },
          { type: "toolCall", id: "call_read", name: "read", arguments: { path: "notes.txt" } },
        ],
      },
    }, {
      type: "message",
      id: "00000006",
      parentId: "00000005",
      timestamp: at(6),
      message: {
        role: "toolResult",
        toolCallId: "call_read",
        toolName: "read",
        content: [
          { type: "text", text: "Pi tool result marker" },
          { type: "image", data: IMAGE_BASE64, mimeType: "image/png" },
        ],
        details: { path: "notes.txt" },
        isError: false,
        timestamp: started + 6_000,
      },
    }, {
      type: "message",
      id: "00000007",
      parentId: "00000004",
      timestamp: at(7),
      message: assistant("Pi inactive branch marker", started + 7_000),
    }, {
      type: "message",
      id: "00000008",
      parentId: "00000006",
      timestamp: at(8),
      message: {
        role: "bashExecution",
        command: "printf current-format",
        output: "Pi bash output marker",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: started + 8_000,
      },
    }, {
      type: "message",
      id: "00000010",
      parentId: "00000008",
      timestamp: at(9),
      message: {
        role: "custom",
        customType: "fixture-message",
        content: "Pi custom message-role marker",
        display: true,
        timestamp: started + 9_000,
      },
    }, {
      type: "message",
      id: "00000011",
      parentId: "00000010",
      timestamp: at(10),
      message: {
        role: "branchSummary",
        summary: "Pi branch-summary message marker",
        fromId: "00000006",
        timestamp: started + 10_000,
      },
    }, {
      type: "message",
      id: "00000012",
      parentId: "00000011",
      timestamp: at(11),
      message: {
        role: "compactionSummary",
        summary: "Pi compaction-summary message marker",
        tokensBefore: 30_000,
        timestamp: started + 11_000,
      },
    }, {
      type: "custom",
      id: "00000009",
      parentId: "00000012",
      timestamp: at(12),
      customType: "fixture-state",
      data: { retained: true },
    }, {
      type: "custom_message",
      id: "0000000a",
      parentId: "00000009",
      timestamp: at(13),
      customType: "fixture-context",
      content: [
        { type: "text", text: "Pi custom context marker" },
        { type: "image", data: IMAGE_BASE64, mimeType: "image/png" },
      ],
      display: false,
    }, {
      type: "label",
      id: "0000000b",
      parentId: "0000000a",
      timestamp: at(14),
      targetId: "00000004",
      label: "checkpoint",
    }, {
      type: "compaction",
      id: "0000000c",
      parentId: "0000000b",
      timestamp: at(15),
      summary: "Pi compaction marker",
      firstKeptEntryId: "00000004",
      tokensBefore: 40_000,
      details: { readFiles: ["notes.txt"] },
    }, {
      type: "branch_summary",
      id: "0000000d",
      parentId: "0000000c",
      timestamp: at(16),
      fromId: "00000006",
      summary: "Pi branch summary marker",
    }, {
      type: "message",
      id: "0000000e",
      parentId: "0000000d",
      timestamp: at(17),
      message: {
        role: "user",
        content: [{ type: "text", text: "Pi final user marker" }, { type: "image", data: IMAGE_BASE64, mimeType: "image/png" }],
        timestamp: started + 17_000,
      },
    }, {
      type: "message",
      id: "0000000f",
      parentId: "0000000e",
      timestamp: at(18),
      message: assistant("Pi final answer marker", started + 18_000, "fixture-provider-2", "gpt-5.5"),
    }];
    await writeFile(file, jsonl(records), { mode: 0o600 });

    const parsed = await parsePiSession(file, at(19));
    assert.equal(parsed.title, "Pi current format");
    assert.equal(parsed.provider, "fixture-provider-2");
    assert.equal(parsed.model, "gpt-5.5");
    assert.equal(parsed.entries.length, 18);
    assert.equal(parsed.activeEntries.length, 17);
    assert.equal(parsed.messageCount, 10);
    assert.equal(parsed.roots, 1);
    assert.equal(parsed.branchPoints, 1);
    assert.equal(parsed.leafId, "0000000f");
    assert.equal(parsed.activeEntries.some((entry) => entry.id === "00000007"), false);
    assert.equal(parsed.searchText.includes("Pi inactive branch marker"), true);
    assert.equal(parsed.searchText.includes("Pi bash output marker"), true);
    assert.equal(parsed.searchText.includes("Pi custom message-role marker"), true);
    assert.equal(parsed.searchText.includes("Pi branch-summary message marker"), true);
    assert.equal(parsed.searchText.includes("Pi compaction-summary message marker"), true);
    assert.equal(parsed.searchText.includes("Pi custom context marker\n[Image: image/png]"), true);
    assert.equal(parsed.conversation.some((item) => item.kind === "message" && item.text.includes("Pi final answer marker")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi parser rejects unsupported records and broken tree relationships", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-pi-invalid-"));
  try {
    const header = {
      type: "session",
      version: 3,
      id: "pi-invalid-format",
      timestamp: "2026-08-18T02:00:00.000Z",
      cwd: WORKSPACE,
    };
    const cases: Array<{
      readonly name: string;
      readonly records: readonly Record<string, unknown>[];
      readonly error: RegExp;
    }> = [{
      name: "future-header",
      records: [{ ...header, version: 4 }],
      error: /header is invalid or unsupported/,
    }, {
      name: "unknown-entry",
      records: [header, {
        type: "future_entry",
        id: "00000001",
        parentId: null,
        timestamp: "2026-08-18T02:00:01.000Z",
      }],
      error: /session entry is invalid/,
    }, {
      name: "orphan-entry",
      records: [header, {
        type: "session_info",
        id: "00000001",
        parentId: "ffffffff",
        timestamp: "2026-08-18T02:00:01.000Z",
        name: "orphan",
      }],
      error: /session entry is invalid/,
    }, {
      name: "duplicate-entry",
      records: [header, {
        type: "session_info",
        id: "00000001",
        parentId: null,
        timestamp: "2026-08-18T02:00:01.000Z",
        name: "first",
      }, {
        type: "session_info",
        id: "00000001",
        parentId: "00000001",
        timestamp: "2026-08-18T02:00:02.000Z",
        name: "duplicate",
      }],
      error: /session entry is invalid/,
    }];

    for (const item of cases) {
      const file = path.join(root, `${item.name}.jsonl`);
      await writeFile(file, jsonl(item.records), { mode: 0o600 });
      await assert.rejects(parsePiSession(file, "2026-08-18T02:00:03.000Z"), item.error);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
