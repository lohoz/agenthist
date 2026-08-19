import assert from "node:assert/strict";
import test from "node:test";

import { codexSessionRef } from "../../../src/agents/codex/identity.js";
import { AGENTS, selectAgents } from "../../../src/domain/agent.js";

test("an empty selection resolves to every Agent in product order", () => {
  assert.deepEqual(selectAgents([]), AGENTS);
});

test("an explicit selection is validated, deduplicated, and product ordered", () => {
  assert.deepEqual(selectAgents(["claude", "codex", "claude"]), ["codex", "claude"]);
  assert.throws(() => selectAgents(["unknown"]), /unsupported Agent/);
});

test("Codex native identity keeps the established public session reference", () => {
  assert.equal(
    codexSessionRef("ABCDEF01-2345-4ABC-8DEF-0123456789AB"),
    "ahsr1_codex_ck1_11be800e29ddea95b7140441804ad17845532d36f3a3ad3888149ccf6429c7e0",
  );
});
