import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAgentApiAnalysisConfiguration } from "../../../src/experience/agent-api-configuration.js";

test("reads the active native API routes for all four Agents without rewriting credentials", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agenthist-api-config-"));
  const put = async (relative: string, contents: unknown) => {
    const file = path.join(home, relative);
    await mkdir(path.dirname(file), { recursive: true });
    const text = typeof contents === "string" ? contents : JSON.stringify(contents);
    await writeFile(file, text);
    return { file, text };
  };
  try {
    const files = await Promise.all([
      put(".codex/config.toml", 'model="default-model"\nmodel_provider="custom"\nmodel_context_window=1000000\nprofile="work"\n[profiles.work]\nmodel="work-model"\nmodel_context_window=200000\n[model_providers.custom]\nbase_url="https://codex.example/api/v1"\nwire_api="responses"\nenv_key="CODEX_TEST_KEY"\n'),
      put(".codex/auth.json", { OPENAI_API_KEY: "do-not-use-this-key" }),
      put(".claude/settings.json", { model: "opus", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-fixture", ANTHROPIC_BASE_URL: "https://claude.example/proxy", ANTHROPIC_AUTH_TOKEN: "claude-secret" } }),
      put(".config/opencode/opencode.jsonc", '{// fixture\n"model":"vendor/model/with-slash", "provider":{"vendor":{"npm":"@ai-sdk/openai-compatible", "models":{"model/with-slash":{"limit":{"context":131072}}},"options":{"baseURL":"https://opencode.example/v1", "apiKey":"{env:OPENCODE_TEST_KEY}",},}},}'),
      put(".pi/agent/settings.json", { defaultProvider: "custom", defaultModel: "pi-fixture" }),
      put(".pi/agent/models.json", { providers: { custom: { api: "anthropic-messages", baseUrl: "https://pi.example/v1", apiKey: "PI_TEST_KEY", models: [{ id: "pi-fixture", contextWindow: 200000 }] } } }),
    ]);
    const options = { home, environment: { CODEX_TEST_KEY: "codex-secret", OPENCODE_TEST_KEY: "opencode-secret", PI_TEST_KEY: "pi-secret" } };
    const [codex, claude, opencode, pi] = await Promise.all((["codex", "claude", "opencode", "pi"] as const).map((agent) => resolveAgentApiAnalysisConfiguration(agent, options)));
    assert.ok(codex && claude && opencode && pi);
    for (const result of [codex, claude, opencode, pi]) assert.ok(!("command" in result.fast));
    if ("command" in codex.fast || "command" in claude.fast || "command" in opencode.fast || "command" in pi.fast) throw new Error("unexpected CLI profile");
    assert.equal(codex.fast.requestUrl, "https://codex.example/api/v1/responses");
    assert.equal(codex.fast.model, "work-model");
    assert.equal(codex.fast.contextWindow, 200000);
    assert.equal(codex.fast.headers?.authorization, "Bearer codex-secret");
    assert.equal(claude.fast.requestUrl, "https://claude.example/proxy/v1/messages");
    assert.equal(claude.fast.model, "claude-opus-fixture");
    assert.equal(claude.fast.headers?.authorization, "Bearer claude-secret");
    assert.equal(opencode.fast.requestUrl, "https://opencode.example/v1/chat/completions");
    assert.equal(opencode.fast.model, "model/with-slash");
    assert.equal(opencode.fast.contextWindow, 131072);
    assert.equal(pi.fast.requestUrl, "https://pi.example/v1/messages");
    assert.equal(pi.fast.headers?.["x-api-key"], "pi-secret");
    assert.equal(pi.fast.contextWindow, 200000);
    for (const file of files) assert.equal(await readFile(file.file, "utf8"), file.text);
    await assert.rejects(resolveAgentApiAnalysisConfiguration("codex", { home, environment: {} }), (error: any) => error.details?.reason === "configuration_missing");
    await assert.rejects(resolveAgentApiAnalysisConfiguration("opencode", { home, environment: { OPENAI_API_KEY: "unrelated-provider-key" } }),
      (error: any) => error.details?.reason === "configuration_missing");
    const previousFingerprint = codex.fast.profileFingerprint;
    const changed = await resolveAgentApiAnalysisConfiguration("codex", { home, environment: { CODEX_TEST_KEY: "changed-secret" } });
    assert.notEqual(changed.fast.profileFingerprint, previousFingerprint);
    assert.ok(!changed.fast.profileFingerprint.includes("changed-secret"));
  } finally { await rm(home, { recursive: true, force: true }); }
});
