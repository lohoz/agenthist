import assert from "node:assert/strict";
import { access, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OperationError, type ExperienceModelCheckResult } from "../../../src/application/index.js";
import { AnalysisFailure, type AnalysisConfiguration } from "../../../src/experience/model.js";
import {
  checkDesktopExperienceConfiguration,
  experienceConfigurationDirectory,
  experienceConfigurationFile,
  inspectDesktopExperienceConfiguration,
} from "../../../src/desktop/experience-settings.js";

const SECRET = "sk-agenthist-super-secret-value";

function apiConfiguration(): AnalysisConfiguration {
  return {
    fast: {
      tier: "fast",
      backend: "openai-compatible-chat",
      endpoint: "https://api.example.com:8443/v1/chat/completions",
      endpointFingerprint: "endpoint-fast",
      baseUrl: "https://api.example.com:8443/v1",
      requestUrl: "https://api.example.com:8443/v1/chat/completions",
      model: "fast-model",
      modelConfigured: true,
      profileFingerprint: "profile-fast",
      apiKey: SECRET,
      keySource: `credential source containing ${SECRET}`,
    },
    deep: {
      tier: "deep",
      backend: "openai-compatible-chat",
      endpoint: "https://deep.example.net/v1/chat/completions",
      endpointFingerprint: "endpoint-deep",
      baseUrl: "https://deep.example.net/v1",
      requestUrl: "https://deep.example.net/v1/chat/completions",
      model: "deep-model",
      modelConfigured: true,
      profileFingerprint: "profile-deep",
      apiKey: SECRET,
      keySource: `another ${SECRET}`,
    },
    deepBinding: "configured",
  };
}

function cliConfiguration(): AnalysisConfiguration {
  const environment = { PATH: "C:\\tools", API_KEY: SECRET };
  return {
    fast: {
      tier: "fast",
      backend: "codex-cli",
      command: "codex",
      endpoint: `local:${SECRET}`,
      endpointFingerprint: "endpoint-cli",
      model: "agent-default",
      modelConfigured: false,
      profileFingerprint: "profile-cli",
      workingDirectory: "C:\\private",
      environment,
    },
    deep: {
      tier: "deep",
      backend: "codex-cli",
      command: "codex",
      endpoint: `local:${SECRET}`,
      endpointFingerprint: "endpoint-cli",
      model: "agent-default",
      modelConfigured: false,
      profileFingerprint: "profile-cli",
      workingDirectory: "C:\\private",
      environment,
    },
    deepBinding: "fast",
  };
}

test("inspection returns sanitized API and CLI profiles from the private Unicode cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-experience-settings-"));
  const stateDirectory = path.join(root, "状态 空格");
  const calls: Array<{ readonly cwd: string; readonly createTemplate: boolean }> = [];
  try {
    let configuration = apiConfiguration();
    const inspect = () => inspectDesktopExperienceConfiguration({
      stateDirectory,
      environment: { AGENTHIST_EXPERIENCE_API_KEY: SECRET },
      async resolveAnalysisConfiguration(options) {
        calls.push({ cwd: options.cwd, createTemplate: options.createTemplate });
        return configuration;
      },
    });
    const api = await inspect();
    assert.equal(api.status, "configured");
    if (api.status !== "configured") return;
    assert.equal(api.backend, "openai-compatible-chat");
    assert.deepEqual(api.fast.endpoint, { kind: "remote", label: "https://api.example.com:8443" });
    assert.deepEqual(api.deep.endpoint, { kind: "remote", label: "https://deep.example.net" });
    assert.equal(api.deepBinding, "configured");
    assert.equal(JSON.stringify(api).includes(SECRET), false);
    assert.equal(JSON.stringify(api).includes("apiKey"), false);
    assert.equal(JSON.stringify(api).includes("keySource"), false);
    assert.equal(JSON.stringify(api).includes("environment"), false);

    configuration = cliConfiguration();
    const cli = await inspect();
    assert.equal(cli.status, "configured");
    if (cli.status !== "configured") return;
    assert.equal(cli.backend, "codex-cli");
    assert.deepEqual(cli.fast.endpoint, { kind: "local", label: "local:codex" });
    assert.equal(cli.fast.modelConfigured, false);
    assert.equal(cli.deepBinding, "fast");
    assert.equal(JSON.stringify(cli).includes(SECRET), false);
    assert.deepEqual(calls, [
      { cwd: experienceConfigurationDirectory(stateDirectory), createTemplate: false },
      { cwd: experienceConfigurationDirectory(stateDirectory), createTemplate: false },
    ]);
    const info = await lstat(experienceConfigurationDirectory(stateDirectory));
    assert.equal(info.isDirectory(), true);
    assert.equal(info.isSymbolicLink(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing and invalid configurations are structured and never leak original errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-experience-settings-errors-"));
  const missingState = path.join(root, "missing-state");
  const invalidState = path.join(root, "invalid-state");
  try {
    const missing = await inspectDesktopExperienceConfiguration({ stateDirectory: missingState, environment: {} });
    assert.equal(missing.status, "not_configured");
    assert.equal(missing.error.code, "configuration_missing");
    await assert.rejects(access(experienceConfigurationFile(missingState)));

    await inspectDesktopExperienceConfiguration({ stateDirectory: invalidState, environment: {} });
    await writeFile(experienceConfigurationFile(invalidState), "AGENTHIST_EXPERIENCE_BACKEND=unknown\n", "utf8");
    const invalid = await inspectDesktopExperienceConfiguration({ stateDirectory: invalidState, environment: {} });
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.error.code, "configuration_invalid");

    const injected = await inspectDesktopExperienceConfiguration({
      stateDirectory: invalidState,
      async resolveAnalysisConfiguration() {
        throw new AnalysisFailure(`do not leak ${SECRET}`, {
          reason: "configuration_invalid",
          stage: "configuration",
          retryable: false,
          source: `secret source ${SECRET}`,
        });
      },
    });
    assert.equal(JSON.stringify(injected).includes(SECRET), false);
    assert.equal(JSON.stringify(injected).includes("source"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit model check maps API and CLI usage and confirms that no history was sent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-experience-settings-check-"));
  const stateDirectory = path.join(root, "state");
  let receivedCwd = "";
  try {
    const result: ExperienceModelCheckResult = {
      profiles: [
        {
          tier: "fast",
          binding: "configured",
          model: "fast-model",
          modelConfigured: true,
          backend: "openai-compatible-chat",
          endpoint: "https://api.example.com/v1/chat/completions",
          endpointFingerprint: "fast-fingerprint",
          requestMade: true,
          usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        },
        {
          tier: "deep",
          binding: "fast",
          model: "agent-default",
          modelConfigured: false,
          backend: "claude-cli",
          endpoint: `local:${SECRET}`,
          endpointFingerprint: "deep-fingerprint",
          requestMade: false,
          usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        },
      ],
      requests: 1,
      historySent: false,
    };
    const checked = await checkDesktopExperienceConfiguration({
      stateDirectory,
      environment: { AGENTHIST_EXPERIENCE_API_KEY: SECRET },
      async checkExperienceModels(options) {
        receivedCwd = options.cwd;
        return result;
      },
    });
    assert.equal(checked.status, "checked");
    if (checked.status !== "checked") return;
    assert.equal(checked.historySent, false);
    assert.equal(checked.requests, 1);
    assert.deepEqual(checked.profiles.map((profile) => profile.endpoint), [
      { kind: "remote", label: "https://api.example.com" },
      { kind: "local", label: "local:claude" },
    ]);
    assert.deepEqual(checked.profiles[0]!.usage, { inputTokens: 5, outputTokens: 1, totalTokens: 6 });
    assert.equal(receivedCwd, experienceConfigurationDirectory(stateDirectory));
    assert.equal(JSON.stringify(checked).includes(SECRET), false);
    assert.equal(checked.historySent, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model check errors expose only allowlisted safe fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-experience-settings-check-error-"));
  try {
    const failed = await checkDesktopExperienceConfiguration({
      stateDirectory: path.join(root, "state"),
      async checkExperienceModels() {
        throw new OperationError(`authentication failed with ${SECRET}`, {
          reason: "authentication_failed",
          stage: "model_check",
          retryable: false,
          status: 401,
          source: `credential ${SECRET}`,
          apiKey: SECRET,
        });
      },
    });
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.error, {
      code: "authentication_failed",
      retryable: false,
      stage: "model_check",
      status: 401,
    });
    assert.equal(failed.historySent, false);
    assert.equal(failed.requests, 0);
    assert.equal(JSON.stringify(failed).includes(SECRET), false);

    const maliciousReason = await checkDesktopExperienceConfiguration({
      stateDirectory: path.join(root, "state-two"),
      async checkExperienceModels() {
        throw new OperationError("hidden", {
          reason: "super_secret_api_key",
          stage: "model_check",
          retryable: false,
        });
      },
    });
    assert.equal(maliciousReason.status, "failed");
    assert.equal(maliciousReason.error.code, "model_check_failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration path helpers reject relative and control-character state paths", () => {
  assert.throws(() => experienceConfigurationDirectory("relative-state"), /absolute valid state directory/);
  assert.throws(() => experienceConfigurationFile(`C:\\bad\nstate`), /absolute valid state directory/);
});
