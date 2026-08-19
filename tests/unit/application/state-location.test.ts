import assert from "node:assert/strict";
import test from "node:test";

import { resolveStateDirectory } from "../../../src/application/state-location.js";

test("state defaults follow Linux, macOS, and Windows conventions", () => {
  assert.equal(resolveStateDirectory({
    platform: "linux",
    cwd: "/work",
    home: "/home/alice",
    environment: {},
  }), "/home/alice/.local/state/agenthist");
  assert.equal(resolveStateDirectory({
    platform: "darwin",
    cwd: "/work",
    home: "/Users/alice",
    environment: {},
  }), "/Users/alice/Library/Application Support/AgentHist");
  assert.equal(resolveStateDirectory({
    platform: "win32",
    cwd: String.raw`C:\work`,
    environment: {
      USERPROFILE: String.raw`C:\Users\Alice`,
      LOCALAPPDATA: String.raw`C:\Users\Alice\AppData\Local`,
    },
  }), String.raw`C:\Users\Alice\AppData\Local\AgentHist`);
});
