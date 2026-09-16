import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AnalysisFailure,
  resolveAnalysisConfiguration,
} from "../../../src/experience/model.js";

function apiEnvironment(baseUrl: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AGENTHIST_EXPERIENCE_BACKEND: "api",
    AGENTHIST_EXPERIENCE_BASE_URL: baseUrl,
    AGENTHIST_EXPERIENCE_API_KEY: "private-test-key",
    AGENTHIST_EXPERIENCE_FAST_MODEL: "fast-test-model",
    ...overrides,
  };
}

test("OpenAI-compatible HTTP endpoints are limited to canonical loopback hosts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-model-loopback-"));
  try {
    const accepted = [
      "https://models.example.test/v1",
      "http://localhost:11434/v1",
      "http://LOCALHOST.:11434/v1",
      "http://127.0.0.42:11434/v1",
      "http://127.1:11434/v1",
      "http://0177.0.0.1:11434/v1",
      "http://0x7f000001:11434/v1",
      "http://2130706433:11434/v1",
      "http://[::1]:11434/v1",
      "http://[0:0:0:0:0:0:0:1]:11434/v1",
    ] as const;
    for (const baseUrl of accepted) {
      const configuration = await resolveAnalysisConfiguration({
        cwd: root,
        environment: apiEnvironment(baseUrl),
        createTemplate: false,
      });
      assert.equal(configuration.fast.backend, "openai-compatible-chat", baseUrl);
    }

    const rejected = [
      "http://models.example.test/v1",
      "http://localhost.example/v1",
      "http://localhost../v1",
      "http://127.example/v1",
      "http://126.255.255.255/v1",
      "http://128.0.0.1/v1",
      "http://0.0.0.0/v1",
      "http://[::]/v1",
      "http://[::ffff:127.0.0.1]/v1",
    ] as const;
    for (const baseUrl of rejected) {
      await assert.rejects(
        resolveAnalysisConfiguration({
          cwd: root,
          environment: apiEnvironment(baseUrl),
          createTemplate: false,
        }),
        (error: unknown) => error instanceof AnalysisFailure &&
          error.details.reason === "configuration_invalid" &&
          /must use HTTPS unless its host is localhost or a loopback IP address/u.test(error.message),
        baseUrl,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a remote HTTP deep endpoint is rejected independently of a secure shared endpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-model-deep-endpoint-"));
  try {
    await assert.rejects(
      resolveAnalysisConfiguration({
        cwd: root,
        environment: apiEnvironment("https://models.example.test/v1", {
          AGENTHIST_EXPERIENCE_DEEP_MODEL: "deep-test-model",
          AGENTHIST_EXPERIENCE_DEEP_BASE_URL: "http://deep.example.test/v1",
          AGENTHIST_EXPERIENCE_DEEP_API_KEY: "private-deep-test-key",
        }),
        createTemplate: false,
      }),
      (error: unknown) => error instanceof AnalysisFailure &&
        error.details.reason === "configuration_invalid" &&
        error.details.source === "environment variable AGENTHIST_EXPERIENCE_DEEP_BASE_URL",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
