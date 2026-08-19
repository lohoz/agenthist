import assert from "node:assert/strict";
import test from "node:test";

import { renderHistoryConversation } from "../../../src/cli/history-command.js";
import type { ConversationItem } from "../../../src/domain/history.js";

test("history show collapses repeated technical records without hiding messages", () => {
  const conversation: ConversationItem[] = [
    {
      kind: "message",
      role: "user",
      text: "Keep this request visible.",
      timestamp: "2026-08-19T00:00:00.000Z",
      portableNotes: ["note.alpha", "note.alpha", "note.beta"],
    },
    { kind: "gap", code: "gap.start", label: "started", timestamp: "2026-08-19T00:00:01.000Z" },
    { kind: "gap", code: "gap.tool", label: "tool detail", timestamp: "2026-08-19T00:00:02.000Z" },
    { kind: "gap", code: "gap.tool", label: "tool detail", timestamp: "2026-08-19T00:00:03.000Z" },
    { kind: "gap", code: "gap.finish", label: "finished", timestamp: "2026-08-19T00:00:04.000Z" },
    {
      kind: "message",
      role: "assistant",
      text: "Keep this response visible.",
      timestamp: "2026-08-19T00:00:05.000Z",
    },
    { kind: "gap", code: "gap.single", label: "one important gap", timestamp: "2026-08-19T00:00:06.000Z" },
  ];

  const rendered = renderHistoryConversation(conversation, false, 60);
  assert.match(rendered, /Keep this request visible\./);
  assert.match(rendered, /Keep this response visible\./);
  assert.match(rendered, /\[4 history gaps collapsed\]/);
  assert.match(rendered, /gap\.tool\s+×2/);
  assert.match(rendered, /\[gap gap\.single\] one important gap/);
  assert.match(rendered, /Technical notes/);
  assert.match(rendered, /note\.alpha\s+×2/);
  assert.match(rendered, /3 annotations collapsed across 2 types/);
  assert.doesNotMatch(rendered, /\[note\]/);
});
