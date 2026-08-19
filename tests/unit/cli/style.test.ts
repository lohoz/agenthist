import assert from "node:assert/strict";
import test from "node:test";

import { paint } from "../../../src/cli/style.js";

test("terminal roles use the shared portable palette", () => {
  assert.equal(paint("AgentHist", "brand", true), "\u001b[1mAgentHist\u001b[0m");
  assert.equal(paint("> Selected", "focus", true), "\u001b[7;1m> Selected\u001b[0m");
  assert.equal(paint("Selected", "selected", true), "Selected");
  assert.equal(paint("[Enter]", "hint", true), "\u001b[1;36m[Enter]\u001b[0m");
  assert.equal(paint("WITH LOSS", "warning_strong", true), "\u001b[1;33mWITH LOSS\u001b[0m");
  assert.equal(paint("BLOCKED", "error_strong", true), "\u001b[1;31mBLOCKED\u001b[0m");
  assert.equal(paint("plain fallback", "focus", false), "plain fallback");
});
