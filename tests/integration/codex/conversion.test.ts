import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { runCli } from "../../../src/cli/program.js";
import { createOpenCodeTargetDatabase } from "../../support/conversion/opencode-target.js";

const CLEAN_ID = "33333333-3333-4333-8333-333333333333";
const TOOL_ID = "44444444-4444-4444-8444-444444444444";
const INCOMPLETE_TOOL_ID = "55555555-5555-4555-8555-555555555555";
const COMPACTED_ID = "66666666-6666-4666-8666-666666666666";
const AGENT_PARENT_ID = "77777777-7777-4777-8777-777777777777";
const AGENT_CHILD_ID = "88888888-8888-4888-8888-888888888888";
const AGENT_CHILD_PATH = "/root/researcher";
const AGENT_INHERITED_PROMPT = "Retain the parent research constraint for the child model";
const AGENT_INHERITED_ANSWER = "The parent constraint is available in inherited model context";
const AGENT_INHERITED_DEVELOPER = "INHERITED_DEVELOPER_CONTEXT_MUST_NOT_BECOME_DIALOGUE";
const AGENT_PRIVATE_PROMPT = "Inspect the private child workspace without exposing this instruction to the parent";
const AGENT_RESULT = "The child found the durable Agent result";
const IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=";
const IMAGE_SHA256 = "5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6";
const IMAGE_SOURCE = "/source/work/figure.png";
const REMOTE_IMAGE_URL = "https://assets.example.test/history/codex-remote-diagram.png?revision=4";
const TOOL_REMOTE_IMAGE_URL = "https://assets.example.test/history/codex-tool-output.png?revision=4";
const MEMORY_CITATION_PATH = "memories/project-guidance.md";
const AUDIO_BYTES = Buffer.from(
  "524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000",
  "hex",
);
const AUDIO_BASE64 = AUDIO_BYTES.toString("base64");
const AUDIO_SOURCE = "/source/work/voice.wav";

function conversationText(output: string): string {
  const parsed = JSON.parse(output) as { data: { conversation: Array<{ text?: string }> } };
  return parsed.data.conversation.map((item) => item.text ?? "").join("\n");
}

function rollout(
  id: string,
  prompt: string,
  answer: string,
  tool: "none" | "function" | "custom" | "incomplete",
  options: {
    readonly audio?: boolean;
    readonly embeddedMedia?: boolean;
    readonly externalSessionImportMarker?: boolean;
    readonly image?: boolean;
    readonly memoryCitation?: boolean;
    readonly minute?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly finalOrdinalGap?: number;
    readonly remoteImage?: boolean;
    readonly selections?: boolean;
  } = {},
): string {
  const audio = options.audio ?? false;
  const embeddedMedia = options.embeddedMedia ?? false;
  const image = options.image ?? false;
  const minute = options.minute ?? "00";
  const remoteImage = options.remoteImage ?? false;
  const selections = options.selections ?? false;
  const timestamp = (seconds: string): string =>
    `2026-08-09T03:${minute}:${seconds.includes(".") ? seconds : `${seconds}.000`}Z`;
  const displayRecord = (
    seconds: string,
    role: "user" | "assistant",
    message: string,
    localImages: readonly string[] = [],
    phase?: string,
    localAudio: readonly string[] = [],
  ): Record<string, unknown> => {
    const eventTimestamp = timestamp(seconds);
    if (options.metadata?.history_mode === "paginated") {
      const textElement = (token: string): Record<string, unknown> => {
        const index = message.indexOf(token);
        if (index < 0) throw new Error(`Codex fixture selection token is missing: ${token}`);
        const start = Buffer.byteLength(message.slice(0, index), "utf8");
        return {
          byte_range: { start, end: start + Buffer.byteLength(token, "utf8") },
          placeholder: token,
        };
      };
      return {
        timestamp: eventTimestamp,
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: id,
          turn_id: `turn_${id}`,
          item: role === "user"
            ? {
              type: "UserMessage",
              id: `user_${id}_${seconds}`,
              content: [
                ...(embeddedMedia
                  ? [
                    { type: "image", image_url: `data:image/png;base64,${IMAGE_BASE64}`, detail: "low" },
                    { type: "audio", audio_url: `data:audio/wav;base64,${AUDIO_BASE64}` },
                  ]
                  : []),
                ...(remoteImage
                  ? [{ type: "image", image_url: REMOTE_IMAGE_URL, detail: "auto" }]
                  : []),
                ...localImages.map((imagePath) => ({ type: "local_image", path: imagePath, detail: "original" })),
                ...localAudio.map((audioPath) => ({ type: "local_audio", path: audioPath })),
                {
                  type: "text",
                  text: message,
                  text_elements: selections ? [textElement("$migration-audit"), textElement("@docs")] : [],
                },
                ...(selections
                  ? [
                    { type: "skill", name: "migration-audit", path: "/source/.codex/skills/migration-audit/SKILL.md" },
                    { type: "mention", name: "docs", path: "app://docs-connector" },
                  ]
                  : []),
              ],
            }
            : {
              type: "AgentMessage",
              id: `agent_${id}_${seconds}`,
              content: [{ type: "Text", text: message }],
              ...(phase === undefined ? {} : { phase }),
              ...(options.memoryCitation === true && seconds === "03"
                ? {
                  memory_citation: {
                    entries: [{
                      path: MEMORY_CITATION_PATH,
                      lineStart: 12,
                      lineEnd: 14,
                      note: "Use the verified migration constraint",
                    }],
                    rolloutIds: [id],
                  },
                }
                : {}),
            },
          completed_at_ms: Date.parse(eventTimestamp),
        },
      };
    }
    return {
      timestamp: eventTimestamp,
      type: "event_msg",
      payload: role === "user"
        ? {
          type: "user_message",
          message,
          ...(localImages.length === 0 && !embeddedMedia && !remoteImage
            ? {}
            : {
              images: [
                ...(embeddedMedia ? [`data:image/png;base64,${IMAGE_BASE64}`] : []),
                ...(remoteImage ? [REMOTE_IMAGE_URL] : []),
              ],
              image_details: [
                ...(embeddedMedia ? ["low"] : []),
                ...(remoteImage ? ["auto"] : []),
              ],
              local_images: localImages,
              local_image_details: localImages.map(() => "original"),
            }),
          ...(localAudio.length === 0 && !embeddedMedia
            ? {}
            : {
              audio: embeddedMedia ? [`data:audio/wav;base64,${AUDIO_BASE64}`] : [],
              local_audio: localAudio,
            }),
          ...(localImages.length === 0 && localAudio.length === 0 && !embeddedMedia && !remoteImage
            ? {}
            : { text_elements: [] }),
        }
        : { type: "agent_message", message, ...(phase === undefined ? {} : { phase }) },
    };
  };
  const records: Array<Record<string, unknown>> = [
    {
      timestamp: timestamp("00"),
      type: "session_meta",
      payload: {
        id,
        session_id: id,
        timestamp: timestamp("00"),
        cwd: "/source/work",
        originator: "codex_cli_rs",
        cli_version: "capability-shaped-fixture",
        model_provider: "source-provider",
        model: "gpt-5.4",
        ...(options.metadata ?? {}),
      },
    },
    {
      timestamp: timestamp("01"),
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Synthetic execution context that must not become portable dialogue" }],
      },
    },
    {
      timestamp: timestamp("01"),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>synthetic source machine</environment_context>" }],
      },
    },
    {
      timestamp: timestamp("01"),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          ...(embeddedMedia
            ? [
              { type: "input_image", image_url: `data:image/png;base64,${IMAGE_BASE64}`, detail: "low" },
              { type: "input_audio", audio_url: `data:audio/wav;base64,${AUDIO_BASE64}` },
            ]
            : []),
          ...(remoteImage
            ? [{ type: "input_image", image_url: REMOTE_IMAGE_URL, detail: "auto" }]
            : []),
          ...(image ? [
            {
              type: "input_text",
              text: `<image name=[Image #${1 + Number(embeddedMedia) + Number(remoteImage)}] path="${IMAGE_SOURCE}">`,
            },
            { type: "input_image", image_url: `data:image/png;base64,${IMAGE_BASE64}`, detail: "original" },
            { type: "input_text", text: "</image>" },
          ] : []),
          ...(audio ? [
            { type: "input_text", text: `<audio name=[Audio #${embeddedMedia ? 2 : 1}] path="${AUDIO_SOURCE}">` },
            { type: "input_audio", audio_url: `data:audio/wav;base64,${AUDIO_BASE64}` },
            { type: "input_text", text: "</audio>" },
          ] : []),
          { type: "input_text", text: prompt },
        ],
      },
    },
    displayRecord(
      "01",
      "user",
      prompt,
      image ? [IMAGE_SOURCE] : [],
      undefined,
      audio ? [AUDIO_SOURCE] : [],
    ),
    {
      timestamp: timestamp("02"),
      type: "response_item",
      payload: { type: "reasoning", id: "reasoning_fixture", encrypted_content: "opaque", summary: [] },
    },
    {
      timestamp: timestamp("02.050"),
      type: "response_item",
      payload: {
        type: "reasoning",
        id: "reasoning_summary_fixture",
        summary: [
          { type: "summary_text", text: "**Checking the portable history**" },
          { type: "summary_text", text: "The requested evidence is present and can be summarized safely." },
        ],
        content: [{ type: "reasoning_text", text: "raw reasoning must not enter converted history" }],
        encrypted_content: "encrypted reasoning must not enter converted history",
      },
    },
  ];
  if (tool !== "none") {
    const custom = tool === "custom";
    const callId = custom ? "call_custom_fixture" : "call_mcp_fixture";
    if (custom) {
      records.push(displayRecord(
        "02.100",
        "assistant",
        "Applying the requested historical patch.",
        [],
        "commentary",
      ));
      records.push({
        timestamp: timestamp("02.100"),
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Applying the requested historical patch." }],
        },
      });
    }
    records.push({
      timestamp: timestamp("02"),
      type: "response_item",
      payload: custom
        ? {
          type: "custom_tool_call",
          name: "apply_patch",
          namespace: "workspace",
          status: "completed",
          id: "ctc_fixture",
          call_id: callId,
          input: "*** Begin Patch\n*** Update File: paper.md\n@@\n+retain evidence\n*** End Patch",
          internal_chat_message_metadata_passthrough: { turn_id: "turn_custom_fixture" },
        }
        : {
          type: "function_call",
          name: "read_history_resource",
          namespace: "mcp__portable_fixture",
          id: "fc_mcp_fixture",
          call_id: callId,
          arguments: "{\"path\":\"paper.md\"}",
          encrypted_function_args: ["CODEX_ENCRYPTED_FUNCTION_ARGS_MUST_NOT_REACH_VISIBLE_HISTORY"],
          internal_chat_message_metadata_passthrough: { turn_id: "turn_function_fixture" },
        },
    });
    if (tool === "function" || custom) {
      records.push({
        timestamp: timestamp("02.500"),
        type: "response_item",
        payload: custom
          ? {
            type: "custom_tool_call_output",
            id: "ctco_fixture",
            call_id: callId,
            name: "apply_patch",
            output: "Done!",
            internal_chat_message_metadata_passthrough: { turn_id: "turn_custom_fixture" },
          }
          : {
            type: "function_call_output",
            id: "fco_mcp_fixture",
            call_id: callId,
            output: [
              { type: "input_text", text: "Wall time: 0.1250 seconds\nOutput:" },
              { type: "input_image", image_url: `data:image/png;base64,${IMAGE_BASE64}`, detail: "low" },
              { type: "input_image", image_url: TOOL_REMOTE_IMAGE_URL, detail: "auto" },
              { type: "input_audio", audio_url: `data:audio/wav;base64,${AUDIO_BASE64}` },
              {
                type: "encrypted_content",
                encrypted_content: "CODEX_MCP_CIPHERTEXT_MUST_NOT_REACH_VISIBLE_HISTORY",
              },
              { type: "input_text", text: "MCP historical tool output" },
            ],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_function_fixture" },
          },
      });
      if (tool === "function") {
        records.push({
          timestamp: timestamp("02.750"),
          type: "response_item",
          payload: {
            type: "local_shell_call",
            id: "lsh_fixture",
            call_id: "call_local_shell_fixture",
            status: "completed",
            action: {
              type: "exec",
              command: ["sh", "-lc", "printf historical-shell"],
              timeout_ms: 1000,
              working_directory: "/source/work",
              env: null,
              user: null,
            },
            internal_chat_message_metadata_passthrough: { turn_id: "turn_local_shell_fixture" },
          },
        });
        records.push({
          timestamp: timestamp("02.775"),
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "fco_local_shell_fixture",
            call_id: "call_local_shell_fixture",
            output: "historical shell stdout",
            internal_chat_message_metadata_passthrough: { turn_id: "turn_local_shell_fixture" },
          },
        });
        records.push({
          timestamp: timestamp("02.800"),
          type: "response_item",
          payload: {
            type: "web_search_call",
            id: "ws_fixture",
            status: "completed",
            action: { type: "search", query: "Codex historical evidence" },
            internal_chat_message_metadata_passthrough: { turn_id: "turn_web_search_fixture" },
          },
        });
        records.push({
          timestamp: timestamp("02.850"),
          type: "response_item",
          payload: {
            type: "tool_search_call",
            id: "tsc_fixture",
            call_id: "call_tool_search_fixture",
            execution: "client",
            arguments: { query: "historical lookup", limit: 1 },
            internal_chat_message_metadata_passthrough: { turn_id: "turn_tool_search_fixture" },
          },
        });
        records.push({
          timestamp: timestamp("02.875"),
          type: "response_item",
          payload: {
            type: "tool_search_output",
            id: "tso_fixture",
            call_id: "call_tool_search_fixture",
            status: "completed",
            execution: "client",
            tools: [{
              type: "function",
              name: "historical_lookup",
              description: "Search retained historical evidence",
            }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_tool_search_fixture" },
          },
        });
        records.push({
          timestamp: timestamp("02.900"),
          type: "response_item",
          payload: {
            type: "image_generation_call",
            id: "ig_fixture",
            status: "completed",
            revised_prompt: "A two-pixel portable history marker",
            result: IMAGE_BASE64,
            internal_chat_message_metadata_passthrough: { turn_id: "turn_image_generation_fixture" },
          },
        });
      }
    }
  }
  records.push(displayRecord("03", "assistant", answer));
  records.push({
    timestamp: timestamp("03"),
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] },
  });
  if (options.externalSessionImportMarker === true) {
    records.push({
      timestamp: timestamp("03.500"),
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "<EXTERNAL SESSION IMPORTED>",
        phase: null,
        memory_citation: null,
      },
    });
  }
  const historyBase = options.metadata?.history_base;
  const historyBaseOrdinal = historyBase !== null && typeof historyBase === "object" && !Array.isArray(historyBase)
    ? (historyBase as Record<string, unknown>).end_ordinal_exclusive
    : undefined;
  const startOrdinal = typeof historyBaseOrdinal === "number" ? historyBaseOrdinal : 0;
  const serialized = options.metadata?.history_mode === "paginated"
    ? records.map((record, index) => ({
      ...record,
      ordinal: startOrdinal + index + (index === records.length - 1 ? (options.finalOrdinalGap ?? 0) : 0),
    }))
    : records;
  return `${serialized.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function paginatedEndOrdinalExclusive(value: string): number {
  const last = JSON.parse(value.trimEnd().split("\n").at(-1)!) as { ordinal?: unknown };
  if (typeof last.ordinal !== "number" || !Number.isSafeInteger(last.ordinal)) {
    throw new Error("Codex paginated fixture has no final ordinal");
  }
  return last.ordinal + 1;
}

function compactedRollout(): string {
  const base = rollout(
    COMPACTED_ID,
    "PRE_COMPACTION_TRANSCRIPT_MUST_NOT_REACH_TARGET",
    "PRE_COMPACTION_ANSWER_MUST_NOT_REACH_TARGET",
    "none",
    { minute: "30" },
  );
  const records = [{
    timestamp: "2026-08-09T03:30:03.500Z",
    type: "response_item",
    payload: {
      type: "compaction",
      id: "cmp_superseded_fixture",
      encrypted_content: "superseded opaque compaction",
    },
  }, {
    timestamp: "2026-08-09T03:30:04.000Z",
    type: "compacted",
    payload: {
      message: "Compacted summary: the verified result is forty-two",
      replacement_history: [
        {
          type: "message",
          id: "msg_retained_requirement",
          role: "user",
          content: [{ type: "input_text", text: "Retain the compacted research constraint" }],
          phase: null,
          internal_chat_message_metadata_passthrough: { turn_id: "turn_retained_requirement" },
        },
        {
          type: "message",
          id: "msg_compaction_summary",
          role: "user",
          content: [{ type: "input_text", text: "Compacted summary: the verified result is forty-two" }],
          phase: null,
          internal_chat_message_metadata_passthrough: null,
        },
      ],
      window_number: 2,
      first_window_id: "019c3f6e-0000-7000-8000-000000000001",
      previous_window_id: "019c3f6e-0000-7000-8000-000000000002",
      window_id: "019c3f6e-0000-7000-8000-000000000003",
    },
  }, {
    timestamp: "2026-08-09T03:30:05.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Use the compacted result in the next step" }],
    },
  }, {
    timestamp: "2026-08-09T03:30:05.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "Use the compacted result in the next step" },
  }, {
    timestamp: "2026-08-09T03:30:06.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "The compacted result is available for continued work" },
  }, {
    timestamp: "2026-08-09T03:30:06.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "The compacted result is available for continued work" }],
    },
  }, {
    timestamp: "2026-08-09T03:30:07.000Z",
    type: "event_msg",
    payload: { type: "thread_rolled_back", num_turns: 1 },
  }, {
    timestamp: "2026-08-09T03:30:08.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Continue from the compacted context after rollback" }],
    },
  }, {
    timestamp: "2026-08-09T03:30:08.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "Continue from the compacted context after rollback" },
  }, {
    timestamp: "2026-08-09T03:30:09.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "The rolled-back turn is absent and work can continue" },
  }, {
    timestamp: "2026-08-09T03:30:09.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "The rolled-back turn is absent and work can continue" }],
    },
  }, {
    timestamp: "2026-08-09T03:30:10.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Run a closed tool before interruption" }],
    },
  }, {
    timestamp: "2026-08-09T03:30:10.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "Run a closed tool before interruption" },
  }, {
    timestamp: "2026-08-09T03:30:10.100Z",
    type: "response_item",
    payload: {
      type: "function_call",
      id: "fc_aborted_fixture",
      name: "read_file",
      arguments: JSON.stringify({ path: "interrupted.txt" }),
      call_id: "call_aborted_fixture",
      internal_chat_message_metadata_passthrough: { turn_id: "turn_aborted_fixture" },
    },
  }, {
    timestamp: "2026-08-09T03:30:10.200Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      id: "fco_aborted_fixture",
      call_id: "call_aborted_fixture",
      output: "Closed output retained before interruption",
      internal_chat_message_metadata_passthrough: { turn_id: "turn_aborted_fixture" },
    },
  }, {
    timestamp: "2026-08-09T03:30:10.300Z",
    type: "response_item",
    payload: {
      type: "message",
      id: "msg_aborted_fixture",
      role: "developer",
      content: [{
        type: "input_text",
        text: "<turn_aborted>\nThe previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>",
      }],
      phase: null,
      internal_chat_message_metadata_passthrough: { turn_id: "turn_aborted_fixture" },
    },
  }, {
    timestamp: "2026-08-09T03:30:10.300Z",
    type: "event_msg",
    payload: {
      type: "turn_aborted",
      turn_id: "turn_aborted_fixture",
      reason: "interrupted",
      started_at: 1,
      completed_at: 2,
      duration_ms: 1,
    },
  }, {
    timestamp: "2026-08-09T03:30:11.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Continue after the interrupted turn" }],
    },
  }, {
    timestamp: "2026-08-09T03:30:11.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "Continue after the interrupted turn" },
  }, {
    timestamp: "2026-08-09T03:30:12.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "The interruption boundary is retained and work continued" },
  }, {
    timestamp: "2026-08-09T03:30:12.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "The interruption boundary is retained and work continued" }],
    },
  }];
  return `${base}${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function agentEnvelope(
  type: "NEW_TASK" | "FINAL_ANSWER",
  recipient: string,
  author: string,
  payload: string,
): string {
  return `Message Type: ${type}\nTask name: ${recipient}\nSender: ${author}\nPayload:\n${payload}`;
}

function parentAgentRollout(): string {
  const base = rollout(
    AGENT_PARENT_ID,
    "Delegate the isolated research task",
    "The child Agent is working independently",
    "none",
    { embeddedMedia: true, image: true, minute: "40", metadata: { history_mode: "paginated" } },
  );
  const result = agentEnvelope("FINAL_ANSWER", "/root", AGENT_CHILD_PATH, AGENT_RESULT);
  const records = [{
    timestamp: "2026-08-09T03:40:04.000Z",
    type: "inter_agent_communication_metadata",
    payload: { trigger_turn: false },
  }, {
    timestamp: "2026-08-09T03:40:04.000Z",
    type: "response_item",
    payload: {
      type: "agent_message",
      id: "msg_agent_result_fixture",
      author: AGENT_CHILD_PATH,
      recipient: "/root",
      content: [{ type: "input_text", text: result }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_parent_result_fixture" },
    },
  }, {
    timestamp: "2026-08-09T03:40:05.000Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: AGENT_PARENT_ID,
      turn_id: "turn_parent_result_fixture",
      item: {
        type: "AgentMessage",
        id: "agent_parent_result_fixture",
        content: [{ type: "Text", text: "The parent integrated the durable Agent result" }],
      },
      completed_at_ms: Date.parse("2026-08-09T03:40:05.000Z"),
    },
  }, {
    timestamp: "2026-08-09T03:40:05.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "The parent integrated the durable Agent result" }],
    },
  }];
  const nextOrdinal = paginatedEndOrdinalExclusive(base);
  return `${base}${records.map((record, index) =>
    JSON.stringify({ ...record, ordinal: nextOrdinal + index })).join("\n")}\n`;
}

function childAgentRollout(): string {
  const prompt = agentEnvelope("NEW_TASK", AGENT_CHILD_PATH, "/root", AGENT_PRIVATE_PROMPT);
  const records = [{
    timestamp: "2026-08-09T03:50:00.000Z",
    type: "session_meta",
    payload: {
      id: AGENT_CHILD_ID,
      session_id: AGENT_PARENT_ID,
      forked_from_id: AGENT_PARENT_ID,
      parent_thread_id: AGENT_PARENT_ID,
      timestamp: "2026-08-09T03:50:00.000Z",
      cwd: "/source/work",
      originator: "codex_cli_rs",
      cli_version: "capability-shaped-fixture",
      model_provider: "source-provider",
      model: "gpt-5.4",
      history_mode: "paginated",
      subagent_history_start_ordinal: 5,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: AGENT_PARENT_ID,
            depth: 1,
            agent_path: AGENT_CHILD_PATH,
          },
        },
      },
      thread_source: "subagent",
      agent_path: AGENT_CHILD_PATH,
    },
  }, {
    timestamp: "2026-08-09T03:50:00.100Z",
    type: "session_meta",
    payload: {
      id: AGENT_PARENT_ID,
      session_id: AGENT_PARENT_ID,
      timestamp: "2026-08-09T03:40:00.000Z",
      cwd: "/source/work",
      originator: "codex_cli_rs",
      cli_version: "capability-shaped-fixture",
      model_provider: "source-provider",
      model: "gpt-5.4",
      history_mode: "paginated",
    },
  }, {
    timestamp: "2026-08-09T03:50:00.200Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: AGENT_INHERITED_DEVELOPER }],
    },
  }, {
    timestamp: "2026-08-09T03:50:00.300Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: AGENT_INHERITED_PROMPT }],
    },
  }, {
    timestamp: "2026-08-09T03:50:00.400Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: AGENT_INHERITED_ANSWER }],
    },
  }, {
    timestamp: "2026-08-09T03:50:01.000Z",
    type: "inter_agent_communication_metadata",
    payload: { trigger_turn: true },
  }, {
    timestamp: "2026-08-09T03:50:01.000Z",
    type: "response_item",
    payload: {
      type: "agent_message",
      id: "msg_agent_task_fixture",
      author: "/root",
      recipient: AGENT_CHILD_PATH,
      content: [{ type: "input_text", text: prompt }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_child_fixture" },
    },
  }, {
    timestamp: "2026-08-09T03:50:02.000Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: AGENT_CHILD_ID,
      turn_id: "turn_child_fixture",
      item: {
        type: "AgentMessage",
        id: "agent_child_result_fixture",
        content: [{ type: "Text", text: AGENT_RESULT }],
      },
      completed_at_ms: Date.parse("2026-08-09T03:50:02.000Z"),
    },
  }, {
    timestamp: "2026-08-09T03:50:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: AGENT_RESULT }],
    },
  }, {
    timestamp: "2026-08-09T03:50:03.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "turn_child_fixture",
      last_agent_message: AGENT_RESULT,
    },
  }];
  return `${records.map((record, ordinal) => JSON.stringify({ ...record, ordinal })).join("\n")}\n`;
}

function createThreadDatabase(databasePath: string, rows: Array<{
  readonly id: string;
  readonly rolloutPath: string;
  readonly title: string;
  readonly parentId?: string;
}>): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      archived INTEGER NOT NULL,
      first_user_message TEXT NOT NULL,
      model TEXT NOT NULL
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    )
  `);
  const insert = database.prepare(`
    INSERT INTO threads
      (id, rollout_path, created_at, updated_at, model_provider, cwd, title, archived, first_user_message, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.rolloutPath,
      1786244400,
      1786244403,
      "source-provider",
      "/source/work",
      row.title,
      0,
      row.title,
      "gpt-5.4",
    );
    if (row.parentId !== undefined) {
      database.prepare(
        "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)",
      ).run(row.parentId, row.id, "closed");
    }
  }
  database.close();
}

test("Codex portable context preserves tools and materializes closed replacement history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-ts-convert-"));
  const codexHome = path.join(root, "codex-home");
  const sqliteHome = path.join(root, "codex-sqlite");
  const sourceState = path.join(root, "source-state");
  const cleanRelative = path.join("sessions", "2026", "08", "09", `rollout-2026-08-09T03-00-00-${CLEAN_ID}.jsonl`);
  const toolRelative = path.join("sessions", "2026", "08", "09", `rollout-2026-08-09T03-10-00-${TOOL_ID}.jsonl`);
  const incompleteRelative = path.join(
    "sessions", "2026", "08", "09", `rollout-2026-08-09T03-20-00-${INCOMPLETE_TOOL_ID}.jsonl`,
  );
  const compactedRelative = path.join(
    "sessions", "2026", "08", "09", `rollout-2026-08-09T03-30-00-${COMPACTED_ID}.jsonl`,
  );
  const agentParentRelative = path.join(
    "sessions", "2026", "08", "09", `rollout-2026-08-09T03-40-00-${AGENT_PARENT_ID}.jsonl`,
  );
  const agentChildRelative = path.join(
    "sessions", "2026", "08", "09", `rollout-2026-08-09T03-50-00-${AGENT_CHILD_ID}.jsonl`,
  );
  try {
    await mkdir(path.dirname(path.join(codexHome, cleanRelative)), { recursive: true });
    await mkdir(sqliteHome, { recursive: true });
    const cleanRollout = rollout(
      CLEAN_ID,
      "Remember the portable migration marker",
      "The portable migration marker is retained",
      "function",
      { finalOrdinalGap: 3, metadata: { history_mode: "paginated" } },
    );
    const cleanEndOrdinalExclusive = paginatedEndOrdinalExclusive(cleanRollout);
    const toolRollout = rollout(
      TOOL_ID,
      "Read paper.md and retain the historical evidence with $migration-audit and @docs",
      "The Codex tool evidence is retained",
      "custom",
      {
        audio: true,
        embeddedMedia: true,
        externalSessionImportMarker: true,
        image: true,
        memoryCitation: true,
        minute: "10",
        remoteImage: true,
        selections: true,
        metadata: {
          history_mode: "paginated",
          history_base: {
            thread_id: CLEAN_ID,
            end_ordinal_exclusive: cleanEndOrdinalExclusive,
            end_byte_offset: Buffer.byteLength(cleanRollout),
          },
        },
      },
    );
    await writeFile(path.join(codexHome, cleanRelative), cleanRollout);
    await writeFile(path.join(codexHome, toolRelative), toolRollout);
    const incompleteRollout = rollout(
      INCOMPLETE_TOOL_ID,
      "This session has an incomplete tool call",
      "Incomplete tool history must remain blocked",
      "incomplete",
      { minute: "20" },
    );
    const nativeControlRecords = [{
      timestamp: "2026-08-09T03:20:03.100Z",
      type: "inter_agent_communication_metadata",
      payload: { trigger_turn: true },
    }, {
      timestamp: "2026-08-09T03:20:03.100Z",
      type: "response_item",
      payload: {
        type: "agent_message",
        id: "msg_inter_agent_fixture",
        author: "researcher",
        recipient: "default",
        content: [{ type: "input_text", text: "Private Agent control flow must remain blocked" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_inter_agent_fixture" },
      },
    }, {
      timestamp: "2026-08-09T03:20:03.200Z",
      type: "world_state",
      payload: {
        full: true,
        state: { cwd: "/source/work", git: { branch: "fixture" } },
      },
    }, {
      timestamp: "2026-08-09T03:20:03.300Z",
      type: "future_control_record",
      payload: { semantic_state: "must fail closed" },
    }, {
      timestamp: "2026-08-09T03:20:03.350Z",
      type: "event_msg",
      payload: { type: "thread_rolled_back", num_turns: 1 },
    }, {
      timestamp: "2026-08-09T03:20:03.360Z",
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: "turn_interrupted_fixture",
        reason: "interrupted",
        started_at: 1786245600,
        completed_at: 1786245603,
        duration_ms: 3000,
      },
    }, {
      timestamp: "2026-08-09T03:20:03.370Z",
      type: "event_msg",
      payload: { type: "context_compacted" },
    }, {
      timestamp: "2026-08-09T03:20:03.400Z",
      type: "response_item",
      payload: {
        type: "compaction",
        id: "cmp_remote_fixture",
        encrypted_content: "opaque remote compaction",
      },
    }, {
      timestamp: "2026-08-09T03:20:03.500Z",
      type: "response_item",
      payload: {
        type: "context_compaction",
        id: "cmp_context_fixture",
        encrypted_content: "opaque context compaction",
      },
    }, {
      timestamp: "2026-08-09T03:20:04.000Z",
      type: "compacted",
      payload: {
        message: "A compacted summary must not be duplicated with the original transcript",
        replacement_history: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Continue from the compacted context" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Compacted context retained" }],
          },
        ],
        window_number: 1,
        first_window_id: "019c3f6e-0000-7000-8000-000000000001",
        window_id: "019c3f6e-0000-7000-8000-000000000002",
      },
    }];
    await writeFile(
      path.join(codexHome, incompleteRelative),
      `${incompleteRollout}${nativeControlRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    await writeFile(path.join(codexHome, compactedRelative), compactedRollout());
    await writeFile(path.join(codexHome, agentParentRelative), parentAgentRollout());
    await writeFile(path.join(codexHome, agentChildRelative), childAgentRollout());
    createThreadDatabase(path.join(sqliteHome, "state_5.sqlite"), [
      { id: CLEAN_ID, rolloutPath: path.join(codexHome, cleanRelative), title: "Clean portable conversation" },
      { id: TOOL_ID, rolloutPath: path.join(codexHome, toolRelative), title: "Closed tool conversation" },
      {
        id: INCOMPLETE_TOOL_ID,
        rolloutPath: path.join(codexHome, incompleteRelative),
        title: "Incomplete tool conversation",
      },
      {
        id: COMPACTED_ID,
        rolloutPath: path.join(codexHome, compactedRelative),
        title: "Compacted portable conversation",
      },
      {
        id: AGENT_PARENT_ID,
        rolloutPath: path.join(codexHome, agentParentRelative),
        title: "Agent parent conversation",
      },
      {
        id: AGENT_CHILD_ID,
        rolloutPath: path.join(codexHome, agentChildRelative),
        title: "Agent child private conversation",
        parentId: AGENT_PARENT_ID,
      },
    ]);

    const runtime = { environment: { HOME: root }, cwd: root, home: root };
    const scanned = await runCli([
      "--json", "--state-dir", sourceState,
      "--codex-home", codexHome, "--codex-sqlite-home", sqliteHome,
      "scan", "--agent", "codex",
    ], runtime);
    assert.equal(scanned.exitCode, 0, scanned.stderr);

    const listed = await runCli([
      "--json", "--state-dir", sourceState, "history", "list", "--agent", "codex", "--view", "all",
    ], runtime);
    assert.equal(listed.exitCode, 0, listed.stderr);
    const sessions = (JSON.parse(listed.stdout) as {
      data: { sessions: Array<{ session_ref: string; title: string }> };
    }).data.sessions;
    const mcpRef = sessions.find((session) => session.title === "Clean portable conversation")!.session_ref;
    const toolRef = sessions.find((session) => session.title === "Closed tool conversation")!.session_ref;
    const compactedRef = sessions.find((session) =>
      session.title === "Compacted portable conversation")!.session_ref;
    const agentParentRef = sessions.find((session) => session.title === "Agent parent conversation")!.session_ref;
    const agentChildRef = sessions.find((session) =>
      session.title === "Agent child private conversation")!.session_ref;
    const agentChildSourceShow = await runCli([
      "--json", "--state-dir", sourceState, "history", "show", agentChildRef,
    ], runtime);
    assert.equal(agentChildSourceShow.exitCode, 0, agentChildSourceShow.stderr);
    const agentChildSourceHistory = conversationText(agentChildSourceShow.stdout);
    assert.match(agentChildSourceHistory, new RegExp(AGENT_PRIVATE_PROMPT));
    assert.match(agentChildSourceHistory, new RegExp(AGENT_RESULT));
    assert.doesNotMatch(agentChildSourceHistory, new RegExp(AGENT_INHERITED_PROMPT));
    assert.doesNotMatch(agentChildSourceHistory, new RegExp(AGENT_INHERITED_ANSWER));
    assert.doesNotMatch(agentChildSourceHistory, new RegExp(AGENT_INHERITED_DEVELOPER));
    const compactedSourceShow = await runCli([
      "--json", "--state-dir", sourceState, "history", "show", compactedRef,
    ], runtime);
    assert.equal(compactedSourceShow.exitCode, 0, compactedSourceShow.stderr);
    const compactedSourceHistory = conversationText(compactedSourceShow.stdout);
    assert.match(compactedSourceHistory, /PRE_COMPACTION_TRANSCRIPT_MUST_NOT_REACH_TARGET/);
    assert.match(compactedSourceHistory, /Use the compacted result in the next step/);
    assert.match(compactedSourceHistory, /\[turn aborted\]/);
    const mcpShow = await runCli([
      "--state-dir", sourceState, "history", "show", mcpRef,
    ], runtime);
    assert.equal(mcpShow.exitCode, 0, mcpShow.stderr);
    assert.match(
      mcpShow.stdout,
      /\[tool call\] mcp__portable_fixture\/read_history_resource call_id=call_mcp_fixture/,
    );
    assert.match(mcpShow.stdout, /MCP historical tool output/);
    assert.match(mcpShow.stdout, /\[source reference\] codex\.tool_output_image_url\/image/);
    assert.match(mcpShow.stdout, new RegExp(TOOL_REMOTE_IMAGE_URL.replace(/[.?]/g, "\\$&")));
    assert.doesNotMatch(mcpShow.stdout, /CODEX_ENCRYPTED_FUNCTION_ARGS_MUST_NOT_REACH_VISIBLE_HISTORY/);
    assert.doesNotMatch(mcpShow.stdout, /CODEX_MCP_CIPHERTEXT_MUST_NOT_REACH_VISIBLE_HISTORY/);
    const humanShow = await runCli([
      "--state-dir", sourceState, "history", "show", toolRef,
    ], runtime);
    assert.equal(humanShow.exitCode, 0, humanShow.stderr);
    assert.match(humanShow.stdout, /\[tool call\] workspace\/apply_patch call_id=call_custom_fixture status=completed/);
    assert.match(humanShow.stdout, /\[tool result\] call_id=call_custom_fixture/);
    assert.match(humanShow.stdout, /\[citation evidence\]/);
    assert.match(humanShow.stdout, /memories\/project-guidance\.md/);
    assert.match(humanShow.stdout, /\[reasoning summary\]/);
    assert.match(humanShow.stdout, /\[resource evidence\]/);
    assert.match(humanShow.stdout, /\[source reference\] codex\.input_image_url\/image/);
    assert.match(humanShow.stdout, new RegExp(REMOTE_IMAGE_URL.replace(/[.?]/g, "\\$&")));
    assert.doesNotMatch(humanShow.stdout, /<EXTERNAL SESSION IMPORTED>/);

    const archive = path.join(root, "codex-to-claude.agenthist");
    const exported = await runCli([
      "--json", "--state-dir", sourceState,
      "export", "--agent", "codex", "--session", toolRef, "-o", archive,
    ], runtime);
    assert.equal(exported.exitCode, 0, exported.stderr);
    const inspected = await runCli(["--json", "inspect", archive], runtime);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    assert.equal((JSON.parse(inspected.stdout) as {
      data: { entries: Array<{ agent: string }> };
    }).data.entries.every((entry) => entry.agent === "codex"), true);

    const compactedClaudeArchive = path.join(root, "codex-compacted-to-claude.agenthist");
    const compactedExported = await runCli([
      "--json", "--state-dir", sourceState,
      "export", "--agent", "codex", "--session", compactedRef, "-o", compactedClaudeArchive,
    ], runtime);
    assert.equal(compactedExported.exitCode, 0, compactedExported.stderr);
    const openArchive = compactedClaudeArchive;

    const agentPairArchive = path.join(root, "codex-agent-pair-to-claude.agenthist");
    const agentPairExported = await runCli([
      "--json", "--state-dir", sourceState,
      "export", "--agent", "codex",
      "--session", agentParentRef, "--session", agentChildRef, "-o", agentPairArchive,
    ], runtime);
    assert.equal(agentPairExported.exitCode, 0, agentPairExported.stderr);
    const fullArchive = path.join(root, "codex-all.agenthist");
    const fullExported = await runCli([
      "--json", "--state-dir", sourceState, "export", "--agent", "codex", "-o", fullArchive,
    ], runtime);
    assert.equal(fullExported.exitCode, 0, fullExported.stderr);

    await rm(codexHome, { recursive: true });
    await rm(sqliteHome, { recursive: true });
    await rm(sourceState, { recursive: true });

    const targetConfig = path.join(root, "target-claude");
    const targetWork = path.join(root, "target-work");
    const targetState = path.join(root, "target-state");
    await mkdir(targetConfig, { recursive: true });
    await mkdir(targetWork, { recursive: true });
    const blockedPlan = await runCli([
      "--json", "--state-dir", targetState,
      "import", fullArchive, "--agent", "codex", "--to", "claude",
      "--target", `claude=${targetConfig}`,
      "--map-path", `/source/work=${targetWork}`, "--dry-run",
    ], runtime);
    assert.equal(blockedPlan.exitCode, 3, blockedPlan.stderr);
    const blockedData = (JSON.parse(blockedPlan.stdout) as {
      data: {
        status: string;
        blocked: number;
        blocked_sessions: Array<{ source_session_ref: string; findings: Array<{ code: string }> }>;
        routes: Array<{ quality: string; findings: Array<{ code: string }> }>;
      };
    }).data;
    assert.equal(blockedData.status, "blocked");
    assert.equal(blockedData.blocked > 0, true);
    assert.equal(blockedData.blocked_sessions.length, blockedData.blocked);
    assert.equal(blockedData.blocked_sessions.every((item) => item.source_session_ref !== ""), true);
    const blockedFindings = blockedData.routes[0]!.findings.map((finding) => finding.code);
    for (const code of [
      "codex.tool_history.degraded",
      "codex.tool_history.unprojectable",
      "codex.compaction.unsupported",
      "codex.inter_agent_communication.unsupported",
      "codex.thread_rollback.unsupported",
      "codex.turn_aborted.unsupported",
    ]) assert.equal(blockedFindings.includes(code), true, code);

    const importArguments = [
      "--json", "--state-dir", targetState,
      "import", archive, "--agent", "codex", "--to", "claude",
      "--target", `claude=${targetConfig}`,
      "--map-path", `/source/work=${targetWork}`,
    ];
    const dryImport = await runCli([...importArguments, "--dry-run"], runtime);
    assert.equal(dryImport.exitCode, 0, dryImport.stderr);
    const dryImportData = (JSON.parse(dryImport.stdout) as {
      data: {
        status: string;
        new_sessions: number;
        written: number;
        routes: Array<{ quality: string }>;
        items: Array<{
          source_session_ref: string;
          target_session_ref: string;
          findings: Array<{ code: string }>;
        }>;
        resources: Array<{ name: string; sha256: string }>;
      };
    }).data;
    assert.equal(dryImportData.status, "ready");
    assert.equal(dryImportData.routes[0]!.quality, "degraded");
    assert.equal(dryImportData.new_sessions, dryImportData.items.length);
    assert.equal(dryImportData.written, 0);
    const selectedItem = dryImportData.items.find((item) => item.source_session_ref === toolRef)!;
    assert.match(selectedItem.target_session_ref, /^ahsr1_claude_ck1_/);
    const selectedFindings = selectedItem.findings.map((finding) => finding.code);
    for (const code of [
      "codex.reasoning_summary.degraded",
      "codex.reasoning_raw.skipped",
      "codex.encrypted_function_args.skipped",
      "codex.tool_history.degraded",
      "codex.input_image.managed",
      "codex.input_audio.managed",
      "codex.tool_output_image.managed",
      "codex.image_generation_result.managed",
      "codex.memory_citation.materialized",
      "codex.paginated_lineage.materialized",
    ]) assert.equal(selectedFindings.includes(code), true, code);
    assert.deepEqual(dryImportData.resources.map((resource) => resource.name).sort(), [
      "attachment.png",
      "attachment.wav",
      "figure.png",
      "generated-image.png",
      "input-audio-1.wav",
      "input-image-1.png",
      "voice.wav",
    ]);
    const imported = await runCli([...importArguments, "--apply"], runtime);
    assert.equal(imported.exitCode, 0, imported.stderr);
    assert.equal(
      (JSON.parse(imported.stdout) as { data: { written: number } }).data.written,
      dryImportData.items.length,
    );
    const repeated = await runCli([...importArguments, "--apply"], runtime);
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    const repeatedData = (JSON.parse(repeated.stdout) as {
      data: { written: number; already_present: number };
    }).data;
    assert.equal(repeatedData.written, 0);
    assert.equal(repeatedData.already_present, dryImportData.items.length);

    const targetList = await runCli([
      "--json", "--state-dir", targetState, "history", "list", "--agent", "claude", "--view", "all",
    ], runtime);
    assert.equal(targetList.exitCode, 0, targetList.stderr);
    const targetSession = { session_ref: selectedItem.target_session_ref };
    const shown = await runCli([
      "--json", "--state-dir", targetState, "history", "show", targetSession.session_ref,
    ], runtime);
    assert.equal(shown.exitCode, 0, shown.stderr);
    const targetHistory = conversationText(shown.stdout);
    assert.match(targetHistory, /Remember the portable migration marker/);
    assert.match(targetHistory, /The portable migration marker is retained/);
    assert.match(targetHistory, /Read paper\.md and retain the historical evidence/);
    assert.match(targetHistory, /\$migration-audit and @docs/);
    assert.match(targetHistory, /Applying the requested historical patch/);
    assert.match(targetHistory, /Codex tool evidence is retained/);
    assert.match(targetHistory, /AGENTHIST_HISTORICAL_TOOL_EVIDENCE_V1/);
    assert.match(targetHistory, /AGENTHIST_HISTORICAL_CITATIONS_V1/);
    assert.match(targetHistory, /memories\/project-guidance\.md/);
    assert.match(targetHistory, /Use the verified migration constraint/);
    assert.match(targetHistory, /AGENTHIST_HISTORICAL_REASONING_SUMMARY_V1/);
    assert.match(targetHistory, /Historical readable reasoning summary only/);
    assert.match(targetHistory, /Checking the portable history/);
    assert.match(targetHistory, /The requested evidence is present and can be summarized safely/);
    assert.match(targetHistory, /not executed in this target session/);
    assert.match(targetHistory, /"source_agent":"codex"/);
    assert.match(targetHistory, /call_mcp_fixture/);
    assert.match(targetHistory, /"namespace":"mcp__portable_fixture"/);
    assert.match(targetHistory, /"name":"read_history_resource"/);
    assert.match(targetHistory, /paper\.md/);
    assert.doesNotMatch(targetHistory, /CODEX_ENCRYPTED_FUNCTION_ARGS_MUST_NOT_REACH_VISIBLE_HISTORY/);
    assert.match(
      targetHistory,
      /"output":\[\{"type":"input_text","text":"Wall time: 0\.1250 seconds\\nOutput:"\},\{"type":"managed_resource"/,
    );
    assert.match(targetHistory, /"source_type":"input_image"/);
    assert.match(targetHistory, /"resource_relative_path":"\.agenthist\/resources\/sha256\//);
    assert.match(
      targetHistory,
      /"detail":"low"\},\{"type":"historical_reference","source_type":"input_image","namespace":"codex\.tool_output_image_url"/,
    );
    assert.match(targetHistory, new RegExp(TOOL_REMOTE_IMAGE_URL.replace(/[.?]/g, "\\$&")));
    assert.match(targetHistory, /"detail":"auto"\},\{"type":"managed_resource","source_type":"input_audio"/);
    assert.match(
      targetHistory,
      /"media_type":"audio\/wav"\},\{"type":"encrypted_content","omitted":true\},\{"type":"input_text","text":"MCP historical tool output"\}\]/,
    );
    assert.doesNotMatch(targetHistory, /CODEX_MCP_CIPHERTEXT_MUST_NOT_REACH_VISIBLE_HISTORY/);
    assert.match(targetHistory, /voice\.wav/);
    assert.match(targetHistory, /call_local_shell_fixture/);
    assert.match(targetHistory, /"name":"local_shell"/);
    assert.match(targetHistory, /"command":\["sh","-lc","printf historical-shell"\]/);
    assert.match(targetHistory, /"working_directory":"\/source\/work"/);
    assert.match(targetHistory, /historical shell stdout/);
    assert.match(targetHistory, /"call_id":"ws_fixture"/);
    assert.match(targetHistory, /"name":"web_search"/);
    assert.match(targetHistory, /"query":"Codex historical evidence"/);
    assert.match(targetHistory, /call_tool_search_fixture/);
    assert.match(targetHistory, /"name":"tool_search"/);
    assert.match(targetHistory, /"query":"historical lookup","limit":1/);
    assert.match(targetHistory, /"name":"historical_lookup"/);
    assert.match(targetHistory, /Search retained historical evidence/);
    assert.match(targetHistory, /"call_id":"ig_fixture"/);
    assert.match(targetHistory, /"name":"image_generation"/);
    assert.match(targetHistory, /A two-pixel portable history marker/);
    assert.match(targetHistory, /"source_type":"image_generation_result"/);
    assert.match(targetHistory, /call_custom_fixture/);
    assert.match(targetHistory, /"name":"apply_patch"/);
    assert.match(targetHistory, /"namespace":"workspace"/);
    assert.match(targetHistory, /retain evidence/);
    assert.match(targetHistory, /Done!/);
    assert.match(targetHistory, /AGENTHIST_HISTORICAL_RESOURCE_V1/);
    assert.match(targetHistory, /AGENTHIST_HISTORICAL_REFERENCE_V1/);
    assert.match(targetHistory, /"namespace":"codex\.input_image_url"/);
    assert.match(targetHistory, new RegExp(REMOTE_IMAGE_URL.replace(/[.?]/g, "\\$&")));
    assert.match(targetHistory, /"media_type":"image\/png"/);
    assert.match(targetHistory, new RegExp(IMAGE_SHA256));
    assert.doesNotMatch(targetHistory, /Synthetic execution context|synthetic source machine/);
    assert.doesNotMatch(targetHistory, /migration-audit\/SKILL\.md|app:\/\/docs-connector/);
    assert.doesNotMatch(
      targetHistory,
      /raw reasoning must not enter converted history|encrypted reasoning must not enter converted history/,
    );
    const receiver = path.join(
      targetWork,
      ".agenthist", "resources", "sha256", IMAGE_SHA256, "figure.png",
    );
    assert.deepEqual(await readFile(receiver), Buffer.from(IMAGE_BASE64, "base64"));
    const directImageReceiver = path.join(
      targetWork,
      ".agenthist", "resources", "sha256", IMAGE_SHA256, "input-image-1.png",
    );
    assert.deepEqual(await readFile(directImageReceiver), Buffer.from(IMAGE_BASE64, "base64"));
    const toolReceiver = path.join(
      targetWork,
      ".agenthist", "resources", "sha256", IMAGE_SHA256, "attachment.png",
    );
    assert.deepEqual(await readFile(toolReceiver), Buffer.from(IMAGE_BASE64, "base64"));
    const generatedImageReceiver = path.join(
      targetWork,
      ".agenthist", "resources", "sha256", IMAGE_SHA256, "generated-image.png",
    );
    assert.deepEqual(await readFile(generatedImageReceiver), Buffer.from(IMAGE_BASE64, "base64"));
    const audioResource = dryImportData.resources.find((resource) => resource.name === "attachment.wav")!;
    const audioReceiver = path.join(
      targetWork,
      ".agenthist", "resources", "sha256", audioResource.sha256, "attachment.wav",
    );
    assert.deepEqual(await readFile(audioReceiver), AUDIO_BYTES);
    const inputAudioResource = dryImportData.resources.find((resource) => resource.name === "voice.wav")!;
    const inputAudioReceiver = path.join(
      targetWork,
      ".agenthist", "resources", "sha256", inputAudioResource.sha256, "voice.wav",
    );
    assert.deepEqual(await readFile(inputAudioReceiver), AUDIO_BYTES);
    const directAudioResource = dryImportData.resources.find((resource) =>
      resource.name === "input-audio-1.wav")!;
    const directAudioReceiver = path.join(
      targetWork,
      ".agenthist", "resources", "sha256", directAudioResource.sha256, "input-audio-1.wav",
    );
    assert.deepEqual(await readFile(directAudioReceiver), AUDIO_BYTES);

    const compactedArguments = [
      "--json", "--state-dir", targetState,
      "import", compactedClaudeArchive, "--agent", "codex", "--to", "claude",
      "--target", `claude=${targetConfig}`,
      "--map-path", `/source/work=${targetWork}`,
    ];
    const compactedPlan = await runCli([...compactedArguments, "--dry-run"], runtime);
    assert.equal(compactedPlan.exitCode, 0, compactedPlan.stderr);
    const compactedPlanData = (JSON.parse(compactedPlan.stdout) as {
      data: {
        routes: Array<{ quality: string }>;
        items: Array<{
          source_session_ref: string;
          target_session_ref: string;
          findings: Array<{ code: string; count: number }>;
        }>;
      };
    }).data;
    assert.equal(compactedPlanData.routes[0]!.quality, "degraded");
    const compactedPlanItem = compactedPlanData.items.find((item) => item.source_session_ref === compactedRef)!;
    for (const [code, count] of [
      ["codex.replacement_history.materialized", 1],
      ["codex.compaction_user_messages.coalesced", 2],
      ["codex.thread_rollback.materialized", 1],
      ["codex.turn_aborted.materialized", 1],
    ] as const) {
      assert.equal(compactedPlanItem.findings.some((finding) =>
        finding.code === code && finding.count === count), true, code);
    }
    assert.equal(compactedPlanItem.findings.some((finding) =>
      finding.code === "codex.compaction.unsupported"), false);
    const compactedImported = await runCli([...compactedArguments, "--apply"], runtime);
    assert.equal(compactedImported.exitCode, 0, compactedImported.stderr);
    const compactedClaudeList = await runCli([
      "--json", "--state-dir", targetState, "history", "list", "--agent", "claude", "--view", "all",
    ], runtime);
    assert.equal(compactedClaudeList.exitCode, 0, compactedClaudeList.stderr);
    const compactedClaudeRef = compactedPlanItem.target_session_ref;
    const compactedClaudeShow = await runCli([
      "--json", "--state-dir", targetState, "history", "show", compactedClaudeRef,
    ], runtime);
    assert.equal(compactedClaudeShow.exitCode, 0, compactedClaudeShow.stderr);
    const compactedClaudeHistory = conversationText(compactedClaudeShow.stdout);
    assert.match(compactedClaudeHistory, /Retain the compacted research constraint/);
    assert.match(compactedClaudeHistory, /Compacted summary: the verified result is forty-two/);
    assert.match(compactedClaudeHistory, /Continue from the compacted context after rollback/);
    assert.match(compactedClaudeHistory, /The rolled-back turn is absent and work can continue/);
    assert.match(compactedClaudeHistory, /AGENTHIST_HISTORICAL_EVENT_V1/);
    assert.match(compactedClaudeHistory, /call_aborted_fixture/);
    assert.match(compactedClaudeHistory, /Closed output retained before interruption/);
    assert.match(compactedClaudeHistory, /Continue after the interrupted turn/);
    assert.match(compactedClaudeHistory, /The interruption boundary is retained and work continued/);
    assert.doesNotMatch(
      compactedClaudeHistory,
      /PRE_COMPACTION_|superseded opaque compaction|Use the compacted result|available for continued work/,
    );

    const agentPairArguments = [
      "--json", "--state-dir", targetState,
      "import", agentPairArchive, "--agent", "codex", "--to", "claude",
      "--target", `claude=${targetConfig}`,
      "--map-path", `/source/work=${targetWork}`,
    ];
    const agentPairPlan = await runCli([...agentPairArguments, "--dry-run"], runtime);
    assert.equal(agentPairPlan.exitCode, 0, agentPairPlan.stderr);
    const agentPairPlanData = (JSON.parse(agentPairPlan.stdout) as {
      data: {
        routes: Array<{ quality: string }>;
        items: Array<{
          source_session_ref: string;
          target_session_ref: string;
          quality: string;
          findings: Array<{ code: string }>;
        }>;
      };
    }).data;
    assert.equal(agentPairPlanData.routes[0]!.quality, "degraded");
    assert.equal(agentPairPlanData.items.length, 2);
    for (const item of agentPairPlanData.items) {
      const findings = item.findings.map((finding) => finding.code);
      assert.equal(item.quality, "degraded");
      assert.equal(findings.includes("codex.agent_message_context.materialized"), true);
      assert.equal(findings.includes("codex.spawn_relation.skipped"), true);
      assert.equal(findings.includes("codex.spawn_graph.unsupported"), false);
      if (item.source_session_ref === agentParentRef) {
        assert.equal(findings.includes("codex.subagent_inherited_context.materialized"), false);
      } else {
        assert.equal(findings.includes("codex.subagent_inherited_context.materialized"), true);
      }
    }
    const convertedParentRef = agentPairPlanData.items.find((item) =>
      item.source_session_ref === agentParentRef)!.target_session_ref;
    const convertedChildRef = agentPairPlanData.items.find((item) =>
      item.source_session_ref === agentChildRef)!.target_session_ref;
    const agentPairImported = await runCli([...agentPairArguments, "--apply"], runtime);
    assert.equal(agentPairImported.exitCode, 0, agentPairImported.stderr);
    assert.equal((JSON.parse(agentPairImported.stdout) as { data: { written: number } }).data.written, 2);
    const convertedParentShow = await runCli([
      "--json", "--state-dir", targetState, "history", "show", convertedParentRef,
    ], runtime);
    const convertedChildShow = await runCli([
      "--json", "--state-dir", targetState, "history", "show", convertedChildRef,
    ], runtime);
    assert.equal(convertedParentShow.exitCode, 0, convertedParentShow.stderr);
    assert.equal(convertedChildShow.exitCode, 0, convertedChildShow.stderr);
    const convertedParentHistory = conversationText(convertedParentShow.stdout);
    const convertedChildHistory = conversationText(convertedChildShow.stdout);
    assert.match(convertedParentHistory, /Message Type: FINAL_ANSWER/);
    assert.match(convertedParentHistory, new RegExp(AGENT_RESULT));
    assert.match(convertedParentHistory, /The parent integrated the durable Agent result/);
    assert.doesNotMatch(convertedParentHistory, new RegExp(AGENT_PRIVATE_PROMPT));
    assert.match(convertedChildHistory, /Message Type: NEW_TASK/);
    assert.equal(convertedChildHistory.split(AGENT_INHERITED_PROMPT).length - 1, 1);
    assert.equal(convertedChildHistory.split(AGENT_INHERITED_ANSWER).length - 1, 1);
    assert.match(convertedChildHistory, new RegExp(AGENT_PRIVATE_PROMPT));
    assert.match(convertedChildHistory, new RegExp(AGENT_RESULT));
    assert.doesNotMatch(convertedChildHistory, new RegExp(AGENT_INHERITED_DEVELOPER));

    const targetOpenCode = path.join(root, "target-opencode");
    const targetOpenState = path.join(root, "target-open-state");
    await mkdir(targetOpenCode, { recursive: true });
    createOpenCodeTargetDatabase(path.join(targetOpenCode, "opencode.db"));
    const openArguments = [
      "--json", "--state-dir", targetOpenState,
      "import", openArchive, "--agent", "codex", "--to", "opencode",
      "--target", `opencode=${targetOpenCode}`,
      "--map-path", `/source/work=${targetWork}`,
    ];
    const openPlan = await runCli([...openArguments, "--dry-run"], runtime);
    assert.equal(openPlan.exitCode, 0, openPlan.stderr);
    assert.equal((JSON.parse(openPlan.stdout) as {
      data: { routes: Array<{ quality: string }> };
    }).data.routes[0]!.quality, "degraded");
    const compactedOpenImported = await runCli([...openArguments, "--apply"], runtime);
    assert.equal(compactedOpenImported.exitCode, 0, compactedOpenImported.stderr);
    const compactedOpenList = await runCli([
      "--json", "--state-dir", targetOpenState,
      "history", "list", "--agent", "opencode", "--view", "all",
    ], runtime);
    assert.equal(compactedOpenList.exitCode, 0, compactedOpenList.stderr);
    const compactedOpenRef = (JSON.parse(compactedOpenList.stdout) as {
      data: { sessions: Array<{ session_ref: string; title: string }> };
    }).data.sessions.find((session) => session.title === "Compacted portable conversation")!.session_ref;
    const compactedOpenShow = await runCli([
      "--json", "--state-dir", targetOpenState, "history", "show", compactedOpenRef,
    ], runtime);
    assert.equal(compactedOpenShow.exitCode, 0, compactedOpenShow.stderr);
    const compactedOpenHistory = conversationText(compactedOpenShow.stdout);
    assert.match(compactedOpenHistory, /Retain the compacted research constraint/);
    assert.match(compactedOpenHistory, /Compacted summary: the verified result is forty-two/);
    assert.match(compactedOpenHistory, /Continue from the compacted context after rollback/);
    assert.match(compactedOpenHistory, /The rolled-back turn is absent and work can continue/);
    assert.match(compactedOpenHistory, /AGENTHIST_HISTORICAL_EVENT_V1/);
    assert.match(compactedOpenHistory, /call_aborted_fixture/);
    assert.match(compactedOpenHistory, /Closed output retained before interruption/);
    assert.match(compactedOpenHistory, /Continue after the interrupted turn/);
    assert.match(compactedOpenHistory, /The interruption boundary is retained and work continued/);
    assert.doesNotMatch(
      compactedOpenHistory,
      /PRE_COMPACTION_|superseded opaque compaction|Use the compacted result|available for continued work/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
