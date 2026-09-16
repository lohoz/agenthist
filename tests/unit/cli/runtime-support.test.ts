import assert from "node:assert/strict";
import test from "node:test";

import { MINIMUM_NODE_MAJOR, unsupportedNodeMessage } from "../../../src/cli/runtime-support.js";

test("runtime support accepts Node 24+ and explains unsupported versions", () => {
  assert.equal(MINIMUM_NODE_MAJOR, 24);
  assert.equal(unsupportedNodeMessage("24.0.0"), undefined);
  assert.equal(unsupportedNodeMessage("25.3.1"), undefined);

  const oldRuntime = unsupportedNodeMessage("22.14.0");
  assert.match(oldRuntime ?? "", /requires Node\.js 24 or newer/);
  assert.match(oldRuntime ?? "", /current: 22\.14\.0/);
  assert.match(oldRuntime ?? "", /try again/);

  assert.match(unsupportedNodeMessage("unknown") ?? "", /current: unknown/);
});
