import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../../../src/cli/program.js";

function completion(content = "{\"ok\":true}"): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 },
  }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-test" } });
}

test("model check creates a private dedicated template when required configuration is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-model-missing-"));
  let requests = 0;
  const probes: string[] = [];
  try {
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: { HOME: root },
      fetcher: async () => { requests++; return completion(); },
      analysisProcessRunner: async (request) => {
        probes.push(`${request.command} ${request.args.join(" ")}`);
        assert.match(request.stdin, /contains no Agent history/);
        return { exitCode: 1, stdout: "", stderr: "not configured" };
      },
    });
    assert.equal(result.exitCode, 3);
    assert.equal(requests, 0);
    const output = JSON.parse(result.stdout) as {
      readonly error: { readonly details: { readonly reason: string; readonly missing: readonly string[] } };
    };
    assert.equal(output.error.details.reason, "configuration_missing");
    assert.equal(output.error.details.missing.length, 3);
    const template = path.join(root, ".env.agenthist");
    if (process.platform !== "win32") assert.equal((await lstat(template)).mode & 0o777, 0o600);
    const templateText = await readFile(template, "utf8");
    assert.match(templateText, /^# AgentHist experience extraction models/m);
    assert.match(templateText, /^AGENTHIST_EXPERIENCE_BACKEND=api$/m);
    assert.match(templateText, /Leave empty to use the fast model for both stages/);
    assert.match(templateText, /^AGENTHIST_EXPERIENCE_DEEP_MODEL=$/m);
    assert.match(templateText, /Leave empty to reuse AGENTHIST_EXPERIENCE_BASE_URL/);
    assert.match(templateText, /^# AGENTHIST_EXPERIENCE_DEEP_BASE_URL=$/m);
    assert.match(templateText, /Leave empty to reuse AGENTHIST_EXPERIENCE_API_KEY/);
    assert.match(templateText, /^# AGENTHIST_EXPERIENCE_DEEP_API_KEY=$/m);
    assert.equal(probes.length, 4);
    assert.match(probes[0]!, /^codex .* exec /);
    assert.match(probes[1]!, /^claude --print /);
    assert.match(probes[2]!, /^opencode run /);
    assert.match(probes[3]!, /^pi --print /);

    const original = templateText;
    const repeated = await runCli(["experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: { HOME: root },
      fetcher: async () => { requests++; return completion(); },
    });
    assert.equal(repeated.exitCode, 3);
    assert.equal(await readFile(template, "utf8"), original, "existing template must not be overwritten");
    assert.equal(requests, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model check validates each distinct fast/deep profile without history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-model-ok-"));
  const secret = "test-secret-that-must-not-appear";
  const requests: Array<{ readonly url: string; readonly model: string; readonly authorization: string | null }> = [];
  try {
    await writeFile(path.join(root, ".env"), [
      "AGENTHIST_EXPERIENCE_BASE_URL=https://models.example.test/v1",
      `AGENTHIST_EXPERIENCE_API_KEY=${secret}`,
      "AGENTHIST_EXPERIENCE_FAST_MODEL=gpt-5.4-mini",
      "AGENTHIST_EXPERIENCE_DEEP_MODEL=gpt-5.4",
      "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(path.join(root, ".env.agenthist"), [
      "# Empty values do not hide lower-priority values.",
      "AGENTHIST_EXPERIENCE_API_KEY=",
      "AGENTHIST_EXPERIENCE_FAST_MODEL=\"gpt-5.4-mini\" # inline comment",
      "",
    ].join("\n"), { mode: 0o600 });
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: { HOME: root },
      fetcher: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          readonly model: string;
          readonly messages: readonly { readonly content: string }[];
          readonly response_format: {
            readonly type: string;
            readonly json_schema: { readonly name: string; readonly strict: boolean };
          };
        };
        requests.push({
          url: String(input),
          model: body.model,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        assert.ok(body.messages.every((message) => !/conversation|session content/i.test(message.content)));
        assert.equal(body.response_format.type, "json_schema");
        assert.equal(body.response_format.json_schema.strict, true);
        assert.equal(body.response_format.json_schema.name, "agenthist_model_check");
        return completion();
      },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(secret), false);
    assert.deepEqual(requests.map((request) => request.model), ["gpt-5.4-mini", "gpt-5.4"]);
    assert.ok(requests.every((request) => request.url === "https://models.example.test/v1/chat/completions"));
    assert.ok(requests.every((request) => request.authorization === `Bearer ${secret}`));
    const data = (JSON.parse(result.stdout) as {
      readonly data: {
        readonly requests: number;
        readonly history_sent: boolean;
        readonly profiles: readonly { readonly request_made: boolean }[];
      };
    }).data;
    assert.equal(data.requests, 2);
    assert.equal(data.history_sent, false);
    assert.deepEqual(data.profiles.map((profile) => profile.request_made), [true, true]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model check returns a structured authentication failure without exposing credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-model-auth-"));
  const secret = "secret-from-provider-error";
  try {
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: {
        HOME: root,
        AGENTHIST_EXPERIENCE_BASE_URL: "https://models.example.test/v1",
        AGENTHIST_EXPERIENCE_API_KEY: secret,
        AGENTHIST_EXPERIENCE_FAST_MODEL: "gpt-5.4",
      },
      fetcher: async () => new Response(JSON.stringify({
        error: { code: "invalid_api_key", message: `bad Bearer ${secret}; supplied ${secret}` },
      }), { status: 401, headers: { "content-type": "application/json", "x-request-id": "req-auth" } }),
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(secret), false);
    const error = (JSON.parse(result.stdout) as {
      readonly error: {
        readonly code: string;
        readonly details: Readonly<Record<string, unknown>>;
      };
    }).error;
    assert.equal(error.code, "operation_failed");
    assert.deepEqual(error.details, {
      reason: "authentication_failed",
      stage: "model_check",
      retryable: false,
      tier: "fast",
      endpoint: "https://models.example.test/v1/chat/completions",
      model: "gpt-5.4",
      status: 401,
      requestId: "req-auth",
      source: "environment variable AGENTHIST_EXPERIENCE_API_KEY",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model check reports an unsupported completion field after one request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-model-protocol-"));
  let requests = 0;
  try {
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: {
        HOME: root,
        AGENTHIST_EXPERIENCE_BASE_URL: "https://models.example.test/v1",
        AGENTHIST_EXPERIENCE_API_KEY: "fixture-key",
        AGENTHIST_EXPERIENCE_FAST_MODEL: "basic-chat-model",
      },
      fetcher: async (_input, init) => {
        requests++;
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(request.max_completion_tokens, 128);
        assert.equal((request.response_format as { type: string }).type, "json_schema");
        return new Response(JSON.stringify({
          error: {
            code: "unsupported_parameter",
            message: "max_completion_tokens is not supported; use max_tokens instead",
          },
        }), { status: 400, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(result.exitCode, 3);
    assert.equal(requests, 1);
    const error = (JSON.parse(result.stdout) as {
      readonly error: { readonly details: Readonly<Record<string, unknown>> };
    }).error;
    assert.equal(error.details.reason, "protocol_mismatch");
    assert.equal(error.details.retryable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
