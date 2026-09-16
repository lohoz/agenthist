import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeAgentAnalysisConfiguration } from "../../../src/experience/model.js";
import { checkDesktopExperienceConfiguration, experienceConfigurationDirectory, experienceConfigurationFile, inspectDesktopExperienceConfiguration } from "../../../src/desktop/experience-settings.js";

test("native Agent models inherit user configuration and ignore AgentHist API overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-native-model-"));
  try {
    const cwd = experienceConfigurationDirectory(root);
    await mkdir(cwd, { recursive: true });
    const staleFile = experienceConfigurationFile(root);
    await writeFile(staleFile, "AGENTHIST_EXPERIENCE_BACKEND=api\nAGENTHIST_EXPERIENCE_BASE_URL=broken\n");
    for (const agent of ["codex", "claude", "opencode", "pi"] as const) {
      const environment = { CODEX_HOME: "C:\\profiles\\codex", CLAUDE_CONFIG_DIR: "C:\\profiles\\claude", AGENTHIST_EXPERIENCE_FAST_MODEL: "stale-model" };
      const command = `C:\\custom tools\\${agent}.cmd`;
      const configuration = nativeAgentAnalysisConfiguration({ agent, cwd, environment, command });
      assert.equal(configuration.fast.backend, `${agent}-cli`);
      assert.equal(configuration.fast.modelConfigured, false);
      if (!("command" in configuration.fast)) throw new Error("unexpected API backend");
      assert.equal(configuration.fast.command, command);
      assert.deepEqual(configuration.fast.environment, environment);
      assert.equal(configuration.fast.profileFingerprint, configuration.deep.profileFingerprint);
      const inspected = await inspectDesktopExperienceConfiguration({ stateDirectory: root, analysisConfiguration: configuration });
      assert.equal(inspected.status, "configured");
      const checked = await checkDesktopExperienceConfiguration({ stateDirectory: root, analysisConfiguration: configuration,
        checkExperienceModels: async (options) => {
          assert.equal(options.analysisConfiguration, configuration);
          return { historySent: false, requests: 1, profiles: [
            { ...configuration.fast, binding: "configured", requestMade: true, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ] };
        },
      });
      assert.equal(checked.status, "checked");
    }
    await access(staleFile);
  } finally { await rm(root, { recursive: true, force: true }); }
});
