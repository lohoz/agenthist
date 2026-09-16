import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectPortableContextToClaude } from "../../../src/agents/claude/conversion/portable-projector.js";
import { UnsupportedClaudeTranscriptError } from "../../../src/agents/claude/history/transcript.js";
import { claudeProjectCarrier } from "../../../src/agents/claude/project.js";
import {
  isClaudeTranscriptIsolationError,
  scanClaude,
} from "../../../src/agents/claude/scan.js";
import type { PortableContextSession } from "../../../src/domain/portable-context.js";

const CONVERSION_KEY = `ahcv1_${"a".repeat(64)}`;
const INVALID_NATIVE_ID = "11111111-1111-4111-8111-111111111111";

function portableSession(workspace: string): PortableContextSession {
  return {
    schemaVersion: "agenthist.portable-context/v1",
    sourceAgent: "codex",
    sourceSessionRef: `ahsr1_codex_ck1_${"b".repeat(64)}`,
    sourceNativeId: "source-native",
    workingDirectory: workspace,
    defaultModel: "fixture-model",
    title: "Valid projected conversation",
    messages: [
      {
        ordinal: 0,
        role: "user",
        blocks: [{ kind: "text", text: "hello" }],
        timestamp: "2026-09-04T00:00:00.000Z",
        model: "fixture-model",
      },
      {
        ordinal: 1,
        role: "assistant",
        blocks: [{ kind: "text", text: "world" }],
        timestamp: "2026-09-04T00:00:01.000Z",
        model: "fixture-model",
      },
    ],
  };
}

test("Claude scan isolates an unrelated damaged transcript while requiring transaction sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-claude-isolation-"));
  const configRoot = path.join(root, ".claude");
  const stateDirectory = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  const projection = projectPortableContextToClaude(portableSession(workspace), CONVERSION_KEY);
  const carrier = path.join(configRoot, "projects", claudeProjectCarrier(workspace));
  const invalidTranscript = [
    {
      parentUuid: "22222222-2222-4222-8222-222222222222",
      isSidechain: false,
      type: "user",
      uuid: "33333333-3333-4333-8333-333333333333",
      timestamp: "2026-09-04T00:00:00.000Z",
      cwd: workspace,
      sessionId: INVALID_NATIVE_ID,
      userType: "external",
      message: { role: "user", content: "damaged" },
    },
  ];
  try {
    await mkdir(carrier, { recursive: true });
    await writeFile(path.join(carrier, `${projection.nativeId}.jsonl`), projection.transcript);
    await writeFile(
      path.join(carrier, `${INVALID_NATIVE_ID}.jsonl`),
      `${invalidTranscript.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const result = await scanClaude({
      stateDirectory,
      configRoot,
      isolateInvalidSessions: true,
      requiredNativeIds: [projection.nativeId],
    });
    assert.deepEqual(result.snapshot.sessions.map((session) => session.nativeId), [projection.nativeId]);
    assert.equal(result.snapshot.warnings.some((warning) => warning.includes(INVALID_NATIVE_ID)), true);
    assert.equal(result.snapshot.auxiliaryFiles.some((file) => file.endsWith(`${INVALID_NATIVE_ID}.jsonl`)), true);

    await assert.rejects(
      scanClaude({ stateDirectory, configRoot }),
      (error: unknown) => {
        assert.equal(error instanceof UnsupportedClaudeTranscriptError, true);
        assert.match((error as Error).message, /verified native identity/);
        return true;
      },
    );
    await assert.rejects(scanClaude({
      stateDirectory,
      configRoot,
      isolateInvalidSessions: true,
      requiredNativeIds: [INVALID_NATIVE_ID],
    }), /verified native identity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude scan isolation recognizes only explicit transcript validation failures", () => {
  const unsupported = new UnsupportedClaudeTranscriptError("damaged transcript fixture");
  const ioFailure = Object.assign(new Error("transient read failure"), { code: "EACCES" });

  assert.equal(isClaudeTranscriptIsolationError(unsupported), true);
  assert.equal(isClaudeTranscriptIsolationError(ioFailure), false);
  assert.equal(isClaudeTranscriptIsolationError(new Error("unknown parser failure")), false);
  assert.equal(isClaudeTranscriptIsolationError("non-error rejection"), false);
});
