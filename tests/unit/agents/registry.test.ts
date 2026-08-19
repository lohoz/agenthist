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
