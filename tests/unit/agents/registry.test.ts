import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_REGISTRY, agentAdapter } from "../../../src/agents/registry.js";
import { AGENTS, agentLabel } from "../../../src/domain/agent.js";

test("the built-in Agent registry covers the product catalog", () => {
  assert.deepEqual(Object.keys(AGENT_REGISTRY), AGENTS);
  for (const agent of AGENTS) {
    assert.equal(agentAdapter(agent).id, agent);
    assert.notEqual(agentLabel(agent), "");
  }
});

test("Agent resume launchers use native session selectors without version gates", () => {
  const expected = {
    codex: { command: "codex", args: ["resume", "native-session"] },
    claude: { command: "claude", args: ["--resume", "native-session"] },
    opencode: { command: "opencode", args: ["--session", "native-session"] },
    pi: { command: "pi", args: ["--session", "native-session"] },
  } as const;
  for (const agent of AGENTS) {
    const launch = agentAdapter(agent).resume.launch({ nativeId: "native-session", cwd: "/work/project" });
    assert.deepEqual(launch, { ...expected[agent], cwd: "/work/project" });
  }
});
