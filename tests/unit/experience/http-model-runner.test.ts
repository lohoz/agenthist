import assert from "node:assert/strict";
import test from "node:test";
import { agentApiAnalysisConfiguration } from "../../../src/experience/agent-api-configuration.js";
import { requestAnalysis, type RequestAnalysisOptions } from "../../../src/experience/model.js";
import type { AgentApiProtocol } from "../../../src/domain/agent-api.js";

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
function options(protocol: AgentApiProtocol): RequestAnalysisOptions {
  return { profile: agentApiAnalysisConfiguration({ protocol, baseUrl: "https://fixture.invalid/v1", model: "fixture-model", headers: { authorization: "Bearer fixture-secret" }, source: "fixture" }).fast,
    stage: "model_check", messages: [{ role: "system", content: "Return JSON." }, { role: "user", content: "Synthetic connectivity check." }], maximumOutputTokens: 128,
    responseFormat: { name: "check", schema } };
}
function sse(events: unknown[]): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
}
test("Responses uses the configured endpoint and schema, and decodes fragmented UTF-8 streaming responses once", async () => {
  const result = await requestAnalysis({ ...options("openai-responses"), fetcher: async (url, init) => {
    assert.equal(url, "https://fixture.invalid/v1/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-secret");
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.instructions, "Return JSON.");
    assert.deepEqual(body.text.format.schema, schema);
    return sse([
      { type: "response.output_text.delta", delta: '{"ok":true,"text":"你好😀"}' },
      { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true,"text":"你好😀"}' }] }], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } },
    ]);
  } });
  assert.equal(result.content, '{"ok":true,"text":"你好😀"}');
  assert.equal(result.usage.totalTokens, 20);
});
test("Messages uses Anthropic parameters and collects message usage", async () => {
  const result = await requestAnalysis({ ...options("anthropic-messages"), fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 128);
    assert.equal(body.system, "Return JSON.");
    assert.equal(body.messages.length, 1);
    assert.deepEqual(body.output_config.format.schema, schema);
    return sse([{ type: "message_start", message: { usage: { input_tokens: 10 } } }, { type: "content_block_delta", delta: { type: "text_delta", text: '{"ok":true}' } },
      { type: "message_delta", usage: { output_tokens: 4 }, delta: { stop_reason: "end_turn" } }, { type: "message_stop" }]);
  } });
  assert.equal(result.content, '{"ok":true}');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
});
test("Chat Completions accepts streaming deltas and usage", async () => {
  const result = await requestAnalysis({ ...options("openai-compatible-chat"), fetcher: async () => sse([
    { choices: [{ delta: { content: '{"ok":true}' }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }, "[DONE]",
  ]) });
  assert.equal(result.content, '{"ok":true}');
  assert.equal(result.usage.totalTokens, 12);
});
test("actual HTTP failures preserve status without exposing response bodies or credentials", async () => {
  for (const [status, reason] of [[401, "authentication_failed"], [404, "endpoint_or_model_not_found"], [429, "rate_limited"], [503, "upstream_failed"]] as const) {
    await assert.rejects(requestAnalysis({ ...options("openai-responses"), fetcher: async () => new Response('fixture-secret upstream-private-body', { status }) }), (error: any) => {
      assert.equal(error.details.reason, reason);
      assert.equal(error.details.status, status);
      assert.ok(!JSON.stringify(error).includes("fixture-secret"));
      return true;
    });
  }
});
test("incomplete streams and truncated output are not reported as usable models", async () => {
  for (const events of [[{ type: "response.output_text.delta", delta: '{"ok":true}' }], [{ type: "response.incomplete", response: {} }]]) {
    await assert.rejects(requestAnalysis({ ...options("openai-responses"), fetcher: async () => sse(events) }));
  }
});

test("provider content rejection is explicit and is not treated as a retryable server outage", async () => {
  await assert.rejects(requestAnalysis({ ...options("openai-responses"), fetcher: async () => sse([
    { type: "response.failed", response: { error: { code: "cyber_policy", message: "provider-private-message" } } },
  ]) }), (error: any) => {
    assert.equal(error.details.reason, "content_rejected");
    assert.equal(error.details.retryable, false);
    assert.ok(!error.message.includes("provider-private-message"));
    return true;
  });
});
test("request timeouts abort the API fetch and report timeout instead of a parse error", async () => {
  await assert.rejects(requestAnalysis({ ...options("openai-responses"), timeoutMs: 15,
    fetcher: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })),
  }), (error: any) => error.details.reason === "timeout");
});
