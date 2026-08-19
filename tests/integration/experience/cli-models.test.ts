import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { codexSessionRef } from "../../../src/agents/codex/identity.js";
import { piSessionRef } from "../../../src/agents/pi/identity.js";
import type { AnalysisProcessRunner } from "../../../src/application/index.js";
import { runCli } from "../../../src/cli/program.js";
import type { AgentSnapshot, ConversationItem, StoredSession } from "../../../src/domain/history.js";
import { createSnapshotWorkspace, publishSnapshot } from "../../../src/infrastructure/history-store.js";

function codexOutput(content: unknown, inputTokens = 19, outputTokens = 5): string {
  return [
    { type: "thread.started", thread_id: "cli-check-thread" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "answer", type: "agent_message", text: JSON.stringify(content) } },
    { type: "turn.completed", usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function openCodeOutput(content: unknown): string {
  return [
    {
      type: "text",
      sessionID: "ses_agenthist_check",
      part: { id: "prt_answer", type: "text", text: JSON.stringify(content) },
    },
    {
      type: "step_finish",
      sessionID: "ses_agenthist_check",
      part: {
        type: "step-finish",
        tokens: { total: 17, input: 9, output: 4, reasoning: 1, cache: { read: 3, write: 0 } },
      },
    },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function piOutput(content: unknown, inputTokens = 13, outputTokens = 5): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(content) }],
      provider: "fixture-provider",
      model: "fixture-model",
      responseId: "pi-check-response",
      usage: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: inputTokens + outputTokens + 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.UTC(2026, 7, 2),
    },
  }) + "\n";
}

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

test("Codex CLI model check isolates execution and passes distinct fast/deep models", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-codex-model-"));
  const calls: Array<{ readonly model?: string; readonly args: readonly string[] }> = [];
  try {
    const processRunner: AnalysisProcessRunner = async (request) => {
      const schemaPath = argumentValue(request.args, "--output-schema");
      assert.ok(schemaPath);
      assert.deepEqual(JSON.parse(await readFile(schemaPath, "utf8")), {
        type: "object",
        properties: { ok: { type: "boolean", const: true } },
        required: ["ok"],
        additionalProperties: false,
      });
      assert.equal(request.command, "codex");
      assert.equal(request.args.includes("--ephemeral"), true);
      assert.equal(request.args.includes("--ignore-user-config"), false);
      assert.equal(request.args.includes("--ignore-rules"), true);
      assert.equal(request.args.includes("hooks"), true);
      assert.equal(request.args.includes("shell_tool"), true);
      assert.equal(argumentValue(request.args, "--sandbox"), "read-only");
      assert.equal(request.environment.AGENTHIST_EXPERIENCE_API_KEY, undefined);
      assert.match(request.stdin, /contains no Agent history/);
      const model = argumentValue(request.args, "--model");
      calls.push({ ...(model === undefined ? {} : { model }), args: request.args });
      return { exitCode: 0, stdout: codexOutput({ ok: true }), stderr: "" };
    };
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: {
        HOME: root,
        AGENTHIST_EXPERIENCE_BACKEND: "codex",
        AGENTHIST_EXPERIENCE_API_KEY: "unused-agenthist-secret",
        AGENTHIST_EXPERIENCE_FAST_MODEL: "gpt-5.6-terra",
        AGENTHIST_EXPERIENCE_DEEP_MODEL: "gpt-5.6-sol",
      },
      analysisProcessRunner: processRunner,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(calls.map((call) => call.model), ["gpt-5.6-terra", "gpt-5.6-sol"]);
    const data = (JSON.parse(result.stdout) as {
      readonly data: {
        readonly requests: number;
        readonly profiles: readonly { readonly backend: string; readonly endpoint: string }[];
      };
    }).data;
    assert.equal(data.requests, 2);
    assert.deepEqual(data.profiles.map((profile) => profile.backend), ["codex-cli", "codex-cli"]);
    assert.deepEqual(data.profiles.map((profile) => profile.endpoint), ["local:codex", "local:codex"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Code model check uses its default model without persisting a session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-claude-model-"));
  let calls = 0;
  try {
    const processRunner: AnalysisProcessRunner = async (request) => {
      calls++;
      assert.equal(request.command, "claude");
      assert.equal(request.args.includes("--safe-mode"), true);
      assert.equal(request.args.includes("--model"), false);
      assert.deepEqual(JSON.parse(argumentValue(request.args, "--json-schema")!), {
        type: "object",
        properties: { ok: { type: "boolean", const: true } },
        required: ["ok"],
        additionalProperties: false,
      });
      assert.equal(request.args.includes("--no-session-persistence"), true);
      assert.equal(argumentValue(request.args, "--output-format"), "json");
      assert.equal(argumentValue(request.args, "--tools"), "");
      assert.equal(request.args.includes("--setting-sources"), false);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: { ok: true },
          usage: { input_tokens: 11, output_tokens: 3 },
          session_id: "ephemeral-check",
        }),
        stderr: "",
      };
    };
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: { HOME: root, AGENTHIST_EXPERIENCE_BACKEND: "claude" },
      analysisProcessRunner: processRunner,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(calls, 1);
    const data = (JSON.parse(result.stdout) as {
      readonly data: {
        readonly profiles: readonly { readonly model: string; readonly backend: string }[];
      };
    }).data;
    assert.deepEqual(data.profiles.map((profile) => profile.model), ["agent-default", "agent-default"]);
    assert.deepEqual(data.profiles.map((profile) => profile.backend), ["claude-cli", "claude-cli"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi CLI model check disables persistence and passes distinct fast/deep models", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-pi-model-"));
  const models: string[] = [];
  try {
    const processRunner: AnalysisProcessRunner = async (request) => {
      assert.equal(request.command, "pi");
      assert.equal(request.args[0], "--print");
      assert.equal(argumentValue(request.args, "--mode"), "json");
      assert.equal(request.args.includes("--no-session"), true);
      assert.equal(request.args.includes("--no-tools"), true);
      assert.equal(request.args.includes("--no-extensions"), true);
      assert.equal(request.args.includes("--no-skills"), true);
      assert.equal(request.args.includes("--no-prompt-templates"), true);
      assert.equal(request.args.includes("--no-context-files"), true);
      assert.equal(request.args.includes("--no-approve"), true);
      assert.equal(request.environment.PI_CODING_AGENT_DIR, "/configured/pi-agent");
      assert.notEqual(path.dirname(request.environment.PI_CODING_AGENT_SESSION_DIR!), request.cwd);
      assert.equal(request.environment.PI_TELEMETRY, "0");
      assert.equal(request.environment.AGENTHIST_EXPERIENCE_API_KEY, undefined);
      assert.match(request.stdin, /contains no Agent history/);
      models.push(argumentValue(request.args, "--model")!);
      return { exitCode: 0, stdout: piOutput({ ok: true }), stderr: "" };
    };
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: {
        HOME: root,
        PI_CODING_AGENT_DIR: "/configured/pi-agent",
        AGENTHIST_EXPERIENCE_BACKEND: "pi",
        AGENTHIST_EXPERIENCE_API_KEY: "unused-agenthist-secret",
        AGENTHIST_EXPERIENCE_FAST_MODEL: "provider/fast-model",
        AGENTHIST_EXPERIENCE_DEEP_MODEL: "provider/deep-model:high",
      },
      analysisProcessRunner: processRunner,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(models, ["provider/fast-model", "provider/deep-model:high"]);
    const data = (JSON.parse(result.stdout) as {
      readonly data: {
        readonly profiles: readonly { readonly backend: string; readonly endpoint: string }[];
      };
    }).data;
    assert.deepEqual(data.profiles.map((profile) => profile.backend), ["pi-cli", "pi-cli"]);
    assert.deepEqual(data.profiles.map((profile) => profile.endpoint), ["local:pi", "local:pi"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first-run model configuration selects a working Codex CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-detect-codex-"));
  const calls: string[] = [];
  try {
    const processRunner: AnalysisProcessRunner = async (request) => {
      calls.push(`${request.command} ${request.args.join(" ")}`);
      return { exitCode: 0, stdout: codexOutput({ ok: true }), stderr: "" };
    };
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: { HOME: root },
      analysisProcessRunner: processRunner,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(calls.length, 2);
    assert.match(calls[0]!, /^codex .* exec /);
    assert.match(calls[1]!, /^codex .* exec /);
    const template = await readFile(path.join(root, ".env.agenthist"), "utf8");
    assert.match(template, /^AGENTHIST_EXPERIENCE_BACKEND=codex$/m);
    assert.match(template, /^# AGENTHIST_EXPERIENCE_FAST_MODEL=$/m);
    assert.match(template, /^# AGENTHIST_EXPERIENCE_DEEP_MODEL=$/m);
    assert.equal(template.includes("AGENTHIST_EXPERIENCE_API_KEY"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first-run model configuration falls through to a working Claude Code CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-detect-claude-"));
  const calls: string[] = [];
  try {
    const processRunner: AnalysisProcessRunner = async (request) => {
      calls.push(`${request.command} ${request.args.join(" ")}`);
      if (request.command === "codex") return { exitCode: 1, stdout: "", stderr: "Not logged in" };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: { ok: true },
          usage: { input_tokens: 7, output_tokens: 2 },
        }),
        stderr: "",
      };
    };
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: { HOME: root },
      analysisProcessRunner: processRunner,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(calls.length, 3);
    assert.match(calls[0]!, /^codex .* exec /);
    assert.match(calls[1]!, /^claude --print /);
    assert.match(calls[2]!, /^claude --print /);
    assert.match(
      await readFile(path.join(root, ".env.agenthist"), "utf8"),
      /^AGENTHIST_EXPERIENCE_BACKEND=claude$/m,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first-run model configuration falls through to working OpenCode and isolates its session database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-detect-opencode-"));
  const calls: string[] = [];
  try {
    const processRunner: AnalysisProcessRunner = async (request) => {
      calls.push(`${request.command} ${request.args.join(" ")}`);
      if (request.command === "codex" || request.command === "claude") {
        return { exitCode: 1, stdout: "", stderr: "not configured" };
      }
      assert.equal(request.args[0], "run");
      assert.equal(request.args.includes("--pure"), true);
      assert.equal(argumentValue(request.args, "--format"), "json");
      assert.equal(argumentValue(request.args, "--agent"), "agenthist");
      assert.equal(request.cwd, root);
      assert.notEqual(path.dirname(request.environment.OPENCODE_DB!), request.cwd);
      assert.notEqual(request.environment.OPENCODE_DB, "/native/opencode.db");
      const inline = JSON.parse(request.environment.OPENCODE_CONFIG_CONTENT!) as {
        readonly agent: Readonly<Record<string, { readonly permission: Readonly<Record<string, string>> }>>;
      };
      assert.equal(inline.agent.agenthist?.permission["*"], "deny");
      assert.match(request.stdin, /contains no Agent history/);
      return { exitCode: 0, stdout: openCodeOutput({ ok: true }), stderr: "" };
    };
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: { HOME: root, OPENCODE_DB: "/native/opencode.db" },
      analysisProcessRunner: processRunner,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(calls.length, 4);
    assert.match(calls[0]!, /^codex .* exec /);
    assert.match(calls[1]!, /^claude --print /);
    assert.match(calls[2]!, /^opencode run /);
    assert.match(calls[3]!, /^opencode run /);
    const data = (JSON.parse(result.stdout) as {
      readonly data: { readonly profiles: readonly { readonly backend: string }[] };
    }).data;
    assert.deepEqual(data.profiles.map((profile) => profile.backend), ["opencode-cli", "opencode-cli"]);
    assert.match(
      await readFile(path.join(root, ".env.agenthist"), "utf8"),
      /^AGENTHIST_EXPERIENCE_BACKEND=opencode$/m,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first-run model configuration falls through to a working Pi CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-detect-pi-"));
  const calls: string[] = [];
  try {
    const processRunner: AnalysisProcessRunner = async (request) => {
      calls.push(`${request.command} ${request.args.join(" ")}`);
      if (request.command !== "pi") {
        return { exitCode: 1, stdout: "", stderr: "not configured" };
      }
      assert.equal(request.args.includes("--no-session"), true);
      assert.equal(request.args.includes("--no-tools"), true);
      assert.equal(argumentValue(request.args, "--mode"), "json");
      return { exitCode: 0, stdout: piOutput({ ok: true }), stderr: "" };
    };
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: { HOME: root },
      analysisProcessRunner: processRunner,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(calls.length, 5);
    assert.match(calls[0]!, /^codex .* exec /);
    assert.match(calls[1]!, /^claude --print /);
    assert.match(calls[2]!, /^opencode run /);
    assert.match(calls[3]!, /^pi --print /);
    assert.match(calls[4]!, /^pi --print /);
    const data = (JSON.parse(result.stdout) as {
      readonly data: { readonly profiles: readonly { readonly backend: string }[] };
    }).data;
    assert.deepEqual(data.profiles.map((profile) => profile.backend), ["pi-cli", "pi-cli"]);
    const template = await readFile(path.join(root, ".env.agenthist"), "utf8");
    assert.match(template, /Detected a configured local Pi CLI/);
    assert.match(template, /^AGENTHIST_EXPERIENCE_BACKEND=pi$/m);
    assert.equal(template.includes("AGENTHIST_EXPERIENCE_API_KEY"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI model check reports a missing Agent command clearly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-cli-missing-"));
  try {
    const result = await runCli(["--json", "experience", "model", "check"], {
      cwd: root,
      home: root,
      environment: {
        HOME: root,
        PATH: "",
        AGENTHIST_EXPERIENCE_BACKEND: "codex",
      },
    });
    assert.equal(result.exitCode, 3);
    const error = (JSON.parse(result.stdout) as {
      readonly error: { readonly details: Readonly<Record<string, unknown>> };
    }).error;
    assert.equal(error.details.reason, "command_not_found");
    assert.equal(error.details.stage, "model_check");
    assert.equal(error.details.endpoint, "local:codex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function message(role: "user" | "assistant", text: string, minute: number): ConversationItem {
  return {
    kind: "message",
    role,
    text,
    timestamp: new Date(Date.UTC(2026, 7, 2, 0, minute)).toISOString(),
  };
}

function session(agent: "codex" | "pi", index: number, text: string, minute: number): StoredSession {
  const nativeId = uuid(index);
  const conversation = [message("user", text, minute), message("assistant", "Understood.", minute + 1)];
  return {
    sessionRef: agent === "codex" ? codexSessionRef(nativeId) : piSessionRef(nativeId),
    agent,
    nativeId,
    title: `CLI experience fixture ${index}`,
    context: "/work/research",
    model: "fixture-model",
    provider: "fixture-provider",
    createdAt: conversation[0]!.timestamp,
    updatedAt: conversation[1]!.timestamp,
    nativeArchived: false,
    library: { name: "", tags: [], archived: false, deleted: false },
    conversation,
    searchText: [],
    rawFiles: [],
    native: {},
  };
}

function userPayload(stdin: string): Record<string, unknown> {
  const match = /--- USER MESSAGE \d+ ---\n([\s\S]*?)\n--- END USER MESSAGE \d+ ---/u.exec(stdin);
  assert.ok(match);
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

test("Codex and Pi Agent CLIs complete both experience extraction stages", async () => {
  const fixtures = [
    {
      agent: "codex",
      backend: "codex",
      profileBackend: "codex-cli",
      fastModel: "fast-cli-model",
      deepModel: "deep-cli-model",
      output: codexOutput,
    },
    {
      agent: "pi",
      backend: "pi",
      profileBackend: "pi-cli",
      fastModel: "fixture-provider/fast-cli-model",
      deepModel: "fixture-provider/deep-cli-model:high",
      output: piOutput,
    },
  ] as const;

  for (const fixture of fixtures) {
    const root = await mkdtemp(path.join(os.tmpdir(), `agenthist-${fixture.agent}-review-`));
    const stateDirectory = path.join(root, "state");
    const outputDirectory = path.join(root, "review");
    try {
      const workspace = await createSnapshotWorkspace(stateDirectory, fixture.agent);
      const snapshot: AgentSnapshot = {
        schemaVersion: "agenthist.history-snapshot/v2",
        snapshotId: workspace.id,
        agent: fixture.agent,
        scannedAt: "2026-08-02T01:00:00.000Z",
        sessions: [
          session(fixture.agent, 80, "科研写作中避免使用刻意的对立句式。", 0),
          session(fixture.agent, 81, "请再次把刻意的对立表达改得自然、克制。", 10),
        ],
        auxiliaryFiles: [],
        warnings: [],
      };
      await publishSnapshot(stateDirectory, workspace, snapshot);

      const stages: string[] = [];
      const processRunner: AnalysisProcessRunner = async (request) => {
        assert.equal(request.command, fixture.backend);
        const payload = userPayload(request.stdin);
        const task = String(payload.task);
        stages.push(task);
        if (task === "agenthist_fast_discovery") {
          const discoveries = payload.discoveries as Array<{
            readonly discovery_key: string;
            readonly user_evidence: readonly { readonly quote_id: string }[];
          }>;
          return {
            exitCode: 0,
            stdout: fixture.output({
              discoveries: Object.fromEntries(discoveries.map((item) => [item.discovery_key, {
                task_anchor: "revise research prose",
                episode_summary: "The user requests restrained research prose.",
                events: [{
                  topic: "research_writing",
                  basis: "explicit_preference",
                  lenses: ["style", "correction"],
                  observation: "用户要求避免刻意的对立表达。",
                  behavior_signature: {
                    situation: "when revising research prose",
                    behavior: "avoid forced contrast",
                    target: "research writing style",
                  },
                  user_quote_ids: [item.user_evidence[0]!.quote_id],
                }],
              }])),
            }),
            stderr: "",
          };
        }
        if (task === "agenthist_candidate_organization") {
          const consolidation = payload.consolidation as {
            readonly request_id: string;
            readonly events: readonly { readonly event_id: string }[];
          };
          return {
            exitCode: 0,
            stdout: fixture.output({
              request_id: consolidation.request_id,
              groups: [{
                lens: "style",
                hypothesis: "科研写作中避免刻意的对立表达。",
                topic: "research_writing",
                relation: "correction_pattern",
                event_ids: consolidation.events.map((event) => event.event_id),
              }],
            }),
            stderr: "",
          };
        }
        throw new Error(`unexpected CLI analysis task: ${task}`);
      };

      const result = await runCli([
        "--json", "--state-dir", stateDirectory,
        "experience", "--all", "--output", outputDirectory,
      ], {
        cwd: root,
        home: root,
        environment: {
          HOME: root,
          AGENTHIST_EXPERIENCE_BACKEND: fixture.backend,
          AGENTHIST_EXPERIENCE_FAST_MODEL: fixture.fastModel,
          AGENTHIST_EXPERIENCE_DEEP_MODEL: fixture.deepModel,
        },
        analysisProcessRunner: processRunner,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(stages, ["agenthist_fast_discovery", "agenthist_candidate_organization"]);
      assert.match(await readFile(path.join(outputDirectory, "review.md"), "utf8"), /避免刻意的对立表达/);
      const data = (JSON.parse(result.stdout) as {
        readonly data: {
          readonly fast: { readonly backend: string };
          readonly consolidation: { readonly backend: string };
        };
      }).data;
      assert.equal(data.fast.backend, fixture.profileBackend);
      assert.equal(data.consolidation.backend, fixture.profileBackend);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
