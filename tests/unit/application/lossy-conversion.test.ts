import assert from "node:assert/strict";
import test from "node:test";

import { buildLossyPortableSession } from "../../../src/application/conversion.js";
import type { StoredSession } from "../../../src/domain/history.js";

const SESSION_REF = `ahsr1_codex_ck1_${"a".repeat(64)}`;

function sourceSession(): StoredSession {
  return {
    sessionRef: SESSION_REF,
    agent: "codex",
    nativeId: "native-lossy-source",
    title: "Lossy fallback",
    context: "C:\\Work\\Project",
    model: "gpt-test",
    provider: "test",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:05.000Z",
    nativeArchived: false,
    library: { name: "Lossy fallback", tags: [], archived: false, deleted: false },
    conversation: [
      { kind: "message", role: "assistant", text: "orphan answer", timestamp: "2026-09-04T00:00:00.000Z" },
      { kind: "message", role: "system", text: "private system context", timestamp: "2026-09-04T00:00:01.000Z" },
      { kind: "message", role: "user", text: "first question", timestamp: "2026-09-04T00:00:02.000Z" },
      { kind: "gap", label: "tool payload", timestamp: "2026-09-04T00:00:03.000Z" },
      { kind: "message", role: "user", text: "follow-up detail", timestamp: "2026-09-04T00:00:04.000Z" },
      { kind: "message", role: "assistant", text: "readable answer", timestamp: "2026-09-04T00:00:05.000Z" },
    ],
    searchText: [],
    rawFiles: [],
    native: {},
  };
}

test("lossy conversion keeps readable dialogue and explicitly reports omitted context", () => {
  const result = buildLossyPortableSession(sourceSession());
  assert.ok(result);
  assert.deepEqual(result.session.messages.map((message) => ({
    role: message.role,
    text: message.blocks[0]?.kind === "text" ? message.blocks[0].text : undefined,
  })), [
    { role: "user", text: "first question\n\nfollow-up detail" },
    { role: "assistant", text: "readable answer" },
  ]);
  assert.deepEqual(result.findings.map((finding) => finding.code), [
    "portable.lossy_text_fallback",
    "portable.lossy_content_omitted",
  ]);
  assert.equal(result.findings[1]?.count, 3);
  assert.equal(JSON.stringify(result.session).includes("private system context"), false);
  assert.equal(JSON.stringify(result.session).includes("tool payload"), false);
  assert.equal(JSON.stringify(result.session).includes("orphan answer"), false);
});

test("lossy conversion refuses to invent a dialogue without a readable user message", () => {
  const source = sourceSession();
  assert.equal(buildLossyPortableSession({
    ...source,
    conversation: source.conversation.filter((item) => item.kind !== "message" || item.role !== "user"),
  }), undefined);
});
