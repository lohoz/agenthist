import assert from "node:assert/strict";
import test from "node:test";

import { piWorkspaceCarrier } from "../../../src/agents/pi/session-path.js";

test("Pi workspace carriers follow the native encoding on POSIX and Windows paths", () => {
  assert.equal(piWorkspaceCarrier("/home/alice/project"), "--home-alice-project--");
  assert.equal(piWorkspaceCarrier("/"), "----");
  assert.equal(piWorkspaceCarrier("C:\\Users\\Alice\\project"), "--C--Users-Alice-project--");
  assert.equal(piWorkspaceCarrier("C:\\"), "--C----");
});
