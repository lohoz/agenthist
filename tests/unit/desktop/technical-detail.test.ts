import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationMessage } from "../../../src/domain/history.js";
import type { PortableContextBlock } from "../../../src/domain/portable-context.js";
import {
  MAX_TECHNICAL_DETAIL_BYTES,
  MAX_TECHNICAL_DETAIL_CHUNK_CHARACTERS,
  TECHNICAL_DETAIL_PREVIEW_CHARACTERS,
  getTechnicalDetailChunk,
  listTechnicalDetails,
} from "../../../src/desktop/technical-detail.js";

const SESSION_REF = `ahsr1_codex_ck1_${"1".repeat(64)}`;

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    kind: "message",
    role: "assistant",
    text: "Visible assistant response",
    timestamp: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

test("technical details keep content kinds, non-text blocks, and notes in stable order", () => {
  const value = message({
    contentKinds: ["function_call", "image"],
    portableBlocks: [
      { kind: "text", text: "visible text must not become technical detail" },
      {
        kind: "historical_tool",
        tool: {
          phase: "exchange",
          callId: "call-1",
          namespace: "functions",
          name: "exec",
          status: "completed",
          input: { command: "build" },
          output: { result: "ok" },
        },
      },
      { kind: "historical_reasoning", summary: ["Checked the result."] },
    ],
    portableNotes: ["first technical note", "second technical note"],
  });
  const details = listTechnicalDetails(SESSION_REF, 7, value);
  assert.deepEqual(details.map((detail) => detail.label), [
    "Content kinds",
    "Tool history",
    "Reasoning summary",
    "Technical note",
    "Technical note",
  ]);
  assert.deepEqual(details.map((detail) => detail.id), details.map((_, index) =>
    `${SESSION_REF}:7:technical:${index}`));
  assert.equal(details[0]!.preview, "function_call\nimage");
  assert.match(details[1]!.summary, /exchange.*functions\/exec/);
  assert.equal(details.every((detail) => detail.available), true);
  assert.equal(details.some((detail) => detail.preview.includes("visible text must not")), false);
});

test("large Unicode tool detail can be reassembled exactly without splitting surrogate pairs", () => {
  const payload = "中文😀tool-input-output\n".repeat(8_000);
  const block: PortableContextBlock = {
    kind: "historical_tool",
    tool: {
      phase: "exchange",
      callId: "large-call",
      name: "large_tool",
      status: "completed",
      input: { prompt: payload },
      output: { content: payload },
    },
  };
  const value = message({ portableBlocks: [block] });
  const expected = JSON.stringify(block, null, 2);
  assert.ok(Buffer.byteLength(expected, "utf8") > 100 * 1024);
  const listed = listTechnicalDetails(SESSION_REF, 9, value);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.truncated, true);
  assert.equal([...listed[0]!.preview].length, TECHNICAL_DETAIL_PREVIEW_CHARACTERS);
  assert.equal(listed[0]!.totalCharacters, [...expected].length);

  const chunks: string[] = [];
  let offset = 0;
  while (true) {
    const chunk = getTechnicalDetailChunk(SESSION_REF, 9, value, 0, offset, 4_097);
    assert.equal(chunk.status, "available");
    if (chunk.status !== "available") break;
    const first = chunk.text.charCodeAt(0);
    const last = chunk.text.charCodeAt(chunk.text.length - 1);
    if (chunk.text !== "") {
      assert.equal(first >= 0xdc00 && first <= 0xdfff, false, "chunk begins with a low surrogate");
      assert.equal(last >= 0xd800 && last <= 0xdbff, false, "chunk ends with a high surrogate");
    }
    chunks.push(chunk.text);
    if (chunk.nextOffset === undefined) break;
    assert.ok(chunk.nextOffset > offset);
    offset = chunk.nextOffset;
  }
  assert.equal(chunks.join(""), expected);
});

test("chunk boundaries and indexes are strict and an end offset returns an empty final chunk", () => {
  const value = message({ portableNotes: ["A😀B中文C"] });
  const summary = listTechnicalDetails(SESSION_REF, 0, value)[0]!;
  const final = getTechnicalDetailChunk(SESSION_REF, 0, value, 0, summary.totalCharacters, 10);
  assert.equal(final.status, "available");
  if (final.status === "available") {
    assert.equal(final.text, "");
    assert.equal(final.returnedCharacters, 0);
    assert.equal(final.nextOffset, undefined);
  }
  assert.throws(
    () => getTechnicalDetailChunk(SESSION_REF, 0, value, 0, summary.totalCharacters + 1, 1),
    /offset exceeds/,
  );
  assert.throws(() => getTechnicalDetailChunk(SESSION_REF, 0, value, 1, 0, 1), /index is invalid/);
  assert.throws(() => getTechnicalDetailChunk(SESSION_REF, 0, value, 0, -1, 1), /offset is outside/);
  assert.throws(
    () => getTechnicalDetailChunk(
      SESSION_REF,
      0,
      value,
      0,
      0,
      MAX_TECHNICAL_DETAIL_CHUNK_CHARACTERS + 1,
    ),
    /chunk limit/,
  );
  assert.throws(() => listTechnicalDetails("not-a-session", 0, value), /session reference/);
  assert.throws(() => listTechnicalDetails(SESSION_REF, -1, value), /conversation ordinal/);
});

test("serialization failures and oversized values produce explicit unavailable details", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const brokenBlock = {
    kind: "historical_tool",
    tool: {
      phase: "exchange",
      callId: "broken",
      name: "broken_tool",
      status: "completed",
      input: circular,
      output: { ok: true },
    },
  } as unknown as PortableContextBlock;
  const brokenMessage = message({ portableBlocks: [brokenBlock] });
  const broken = listTechnicalDetails(SESSION_REF, 1, brokenMessage)[0]!;
  assert.equal(broken.available, false);
  assert.equal(broken.unavailableReason, "Technical detail is unavailable.");
  const brokenChunk = getTechnicalDetailChunk(SESSION_REF, 1, brokenMessage, 0, 0, 100);
  assert.deepEqual(brokenChunk, {
    status: "unavailable",
    id: `${SESSION_REF}:1:technical:0`,
    detailIndex: 0,
    label: "Tool history",
    reason: "Technical detail is unavailable.",
  });

  const oversizedMessage = message({ portableNotes: ["x".repeat(MAX_TECHNICAL_DETAIL_BYTES + 1)] });
  const oversized = listTechnicalDetails(SESSION_REF, 2, oversizedMessage)[0]!;
  assert.equal(oversized.available, false);
  assert.match(oversized.unavailableReason!, /64 MiB/);
});

test("portable blocks are pretty-serialized only once per list or chunk call", () => {
  let serializations = 0;
  const tracked = {
    value: "tracked",
    toJSON() {
      serializations++;
      return { value: this.value };
    },
  };
  const block = {
    kind: "historical_tool",
    tool: {
      phase: "exchange",
      callId: "tracked",
      name: "tracked_tool",
      status: "completed",
      input: tracked,
      output: { ok: true },
    },
  } as unknown as PortableContextBlock;
  const value = message({ portableBlocks: [block] });
  listTechnicalDetails(SESSION_REF, 3, value);
  assert.equal(serializations, 1);
  getTechnicalDetailChunk(SESSION_REF, 3, value, 0, 0, 100);
  assert.equal(serializations, 2);
});

test("unknown message fields and portable block kinds are rejected", () => {
  assert.throws(
    () => listTechnicalDetails(SESSION_REF, 0, { ...message(), unknown: true } as never),
    /unknown field/,
  );
  assert.throws(
    () => listTechnicalDetails(SESSION_REF, 0, message({
      portableBlocks: [{ kind: "future_block", payload: true } as never],
    })),
    /unknown portable block kind/,
  );
});
