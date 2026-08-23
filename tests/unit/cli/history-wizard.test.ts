import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import type {
  HistoryCatalogEntry,
  HistorySelectionCatalog,
} from "../../../src/application/index.js";
import { runHistoryWizard } from "../../../src/cli/history-wizard.js";
import { cleanTerminalText } from "../../../src/cli/import-wizard/terminal.js";

function entry(overrides: Partial<HistoryCatalogEntry> = {}): HistoryCatalogEntry {
  return {
    sessionRef: "ahsr1_codex_ck1_" + "a".repeat(64),
    agent: "codex",
    nativeId: "11111111-1111-4111-8111-111111111111",
    title: "Refactor the API boundary",
    workspace: "/work/api",
    model: "gpt-5.4",
    createdAt: "2026-08-20T01:00:00.000Z",
    updatedAt: "2026-08-20T02:00:00.000Z",
    nativeArchived: false,
    libraryState: "active",
    tags: ["old"],
    resourceCount: 0,
    ...overrides,
  };
}

function catalog(session: HistoryCatalogEntry): HistorySelectionCatalog {
  return {
    entries: [session],
    closeSelection(sessionRefs) {
      return sessionRefs.includes(session.sessionRef) ? [session] : [];
    },
    async preview(sessionRef) {
      assert.equal(sessionRef, session.sessionRef);
      return { ...session, conversation: [] };
    },
  };
}

function terminal(): {
  readonly input: PassThrough & { isTTY: boolean };
  readonly output: PassThrough & { isTTY: boolean; columns: number; rows: number };
} {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 110;
  output.rows = 28;
  return { input, output };
}

test("history browser edits one session through the existing library overlay operations", async () => {
  const session = entry();
  const { input, output } = terminal();
  let rendered = "";
  const actions = [
    { cue: "Browse history", keys: "\r" },
    { cue: "Conversation actions", keys: "\u001b[B\u001b[B\r" },
    { cue: "Tags: old", keys: "\u0015research, writing\r" },
  ];
  let action = 0;
  let searchFrom = 0;
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString("utf8");
    const plain = cleanTerminalText(rendered);
    const next = actions[action];
    if (next !== undefined && plain.slice(searchFrom).includes(next.cue)) {
      action++;
      searchFrom = plain.length;
      setImmediate(() => input.write(next.keys));
    }
  });
  try {
    const outcome = await runHistoryWizard({
      catalog: catalog(session),
      input,
      output,
      cwd: session.workspace,
      language: "en",
      color: true,
    });
    assert.deepEqual(outcome, {
      status: "mutate",
      sessionRef: session.sessionRef,
      operation: "tag",
      addTags: ["research", "writing"],
      removeTags: ["old"],
    });
    assert.equal(action, actions.length);
    const plain = cleanTerminalText(rendered);
    assert.match(plain, /AgentHist History/);
    assert.match(plain, /Continue conversation/);
    assert.match(plain, /Edit tags/);
    assert.doesNotMatch(plain, /AgentHist Import/);
  } finally {
    input.destroy();
    output.destroy();
  }
});

test("history browser requires confirmation before deleting from the AgentHist library", async () => {
  const session = entry({ tags: [] });
  const { input, output } = terminal();
  let rendered = "";
  const actions = [
    { cue: "Browse history", keys: "\r" },
    { cue: "Conversation actions", keys: "\u001b[B\u001b[B\u001b[B\u001b[B\r" },
    { cue: "The native Agent conversation will remain unchanged.", keys: "\r" },
  ];
  let action = 0;
  let searchFrom = 0;
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString("utf8");
    const plain = cleanTerminalText(rendered);
    const next = actions[action];
    if (next !== undefined && plain.slice(searchFrom).includes(next.cue)) {
      action++;
      searchFrom = plain.length;
      setImmediate(() => input.write(next.keys));
    }
  });
  try {
    const outcome = await runHistoryWizard({
      catalog: catalog(session),
      input,
      output,
      cwd: session.workspace,
      language: "en",
    });
    assert.deepEqual(outcome, {
      status: "mutate",
      sessionRef: session.sessionRef,
      operation: "delete",
    });
    assert.equal(action, actions.length);
    assert.match(cleanTerminalText(rendered), /Delete from AgentHist/);
  } finally {
    input.destroy();
    output.destroy();
  }
});
