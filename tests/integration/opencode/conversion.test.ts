import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { runCli } from "../../../src/cli/program.js";
import { nativeFixturePath, nativeFixtureValue } from "../../support/native-path.js";
import { createCodexTargetDatabase } from "../../support/conversion/codex-target.js";

const RETAINED_TOOL_OUTPUT = "FULL_OPENCODE_TOOL_OUTPUT_MARKER\nsecond retained line\n";
const COMPACTION_TOOL_ATTACHMENT = "OPEN_CODE_COMPACTION_TAIL_ATTACHMENT";
const COMPACTION_TOOL_ATTACHMENT_BASE64 = Buffer.from(COMPACTION_TOOL_ATTACHMENT, "utf8").toString("base64");
const LEGACY_REASONING_TRACE = "OPEN_CODE_LEGACY_REASONING_TRACE_RETAINED";
const LEGACY_REASONING_METADATA = "OPEN_CODE_LEGACY_REASONING_METADATA_MUST_NOT_MIGRATE";
const COMPACTED_TOOL_OUTPUT = "OPENCODE_COMPACTED_OUTPUT_MUST_NOT_MIGRATE";
const LEGACY_COMPACTED_PREFIX = "OPENCODE_LEGACY_COMPACTED_PREFIX_MUST_NOT_MIGRATE";
const LEGACY_COMPACTED_FILE_BASE64 = Buffer.from(LEGACY_COMPACTED_PREFIX, "utf8").toString("base64");
const TASK_RESULT = "OPENCODE_FOREGROUND_TASK_RESULT_RETAINED";
const TASK_RESUME_RESULT = "OPENCODE_FOREGROUND_TASK_RESUME_RESULT_RETAINED";
const CHILD_PRIVATE_PROMPT = "OPENCODE_CHILD_PRIVATE_PROMPT_MUST_NOT_MERGE";
const BACKGROUND_TASK_RESULT = "OPENCODE_BACKGROUND_TASK_RESULT_RETAINED";
const BACKGROUND_CHILD_PRIVATE_PROMPT = "OPENCODE_BACKGROUND_CHILD_PRIVATE_PROMPT_MUST_NOT_MERGE";
const BACKGROUND_INITIAL_CHILD_RESULT = "OPENCODE_BACKGROUND_INITIAL_CHILD_RESULT_MUST_NOT_MERGE";
const BACKGROUND_PARENT_RESPONSE = "OPENCODE_BACKGROUND_PARENT_RESPONSE_RETAINED";
const SUBTASK_PROMPT = "Inspect the command branch";
const SUBTASK_RESULT = "OPENCODE_SUBTASK_COMMAND_RESULT_RETAINED";
const SUBTASK_SUMMARY = "OPENCODE_SUBTASK_COMMAND_SUMMARY_RETAINED";
const ACTIVE_TODO = "OPENCODE_ACTIVE_TODO_RETAINED";
const COMPLETED_TODO = "OPENCODE_COMPLETED_TODO_MUST_NOT_MIGRATE";
const CANCELLED_TODO = "OPENCODE_CANCELLED_TODO_MUST_NOT_MIGRATE";
const AGENT_REPLAY =
  " Use the above message and context to generate a prompt and call the task tool with subagent: explore";
const SESSION_DIFF_MARKER = "OPENCODE_SESSION_DIFF_MUST_NOT_MIGRATE";
const COMPACTED_ATTACHMENT_BASE64 = Buffer.from("OPENCODE_COMPACTED_ATTACHMENT_MUST_NOT_MIGRATE", "utf8").toString("base64");
const FILE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=";
const FILE_IMAGE_BYTES = Buffer.from(FILE_IMAGE_BASE64, "base64");
const FILE_PDF_BYTES = Buffer.from("%PDF-1.4\n% AgentHist portable document\n%%EOF\n", "utf8");
const FILE_PDF_BASE64 = FILE_PDF_BYTES.toString("base64");
const REMOTE_FILE_URL = "https://assets.example.test/history/remote-diagram.png?revision=2";
const SOURCE_OPEN_WORK = nativeFixturePath("/source/open-work");
const LOCAL_FILE_URL = nativeFixtureValue("file:///source/open-work/context.txt");
const DIRECTORY_FILE_URL = nativeFixtureValue("file:///source/open-work/context-directory");

function conversationText(output: string): string {
  const parsed = JSON.parse(output) as { data: { conversation: Array<{ text?: string }> } };
  return parsed.data.conversation.map((item) => item.text ?? "").join("\n");
}

function managedResourcePath(root: string, content: string | Uint8Array, name: string): string {
  const digest = createHash("sha256").update(content).digest("hex");
  return path.join(root, ".agenthist", "resources", "sha256", digest, name);
}

async function createOwnedSessionDiff(dataRoot: string): Promise<void> {
  const root = path.join(dataRoot, "storage", "session_diff");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "ses_portable_tool.json"), `${JSON.stringify([{
    file: "paper.md",
    patch: `@@ -1 +1 @@\n-old\n+${SESSION_DIFF_MARKER}`,
    additions: 1,
    deletions: 1,
    status: "modified",
  }])}\n`, { mode: 0o600 });
}

function createOpenCodeSource(databasePath: string, retainedOutputPath: string, expiredOutputPath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, version TEXT NOT NULL,
      model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE todo (
      session_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
      priority TEXT NOT NULL, position INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      PRIMARY KEY (session_id, position)
    );

    INSERT INTO project VALUES ('global', '/source/open-work');
    INSERT INTO session VALUES
      ('ses_portable_clean', 'global', NULL, '/source/open-work', '.', 'OpenCode portable conversation',
       'capability-shaped-build', '{"id":"gpt-5.4","providerID":"source-provider"}',
       1786248000000, 1786248004000, NULL),
      ('ses_portable_tool', 'global', NULL, '/source/open-work', '.', 'OpenCode tool evidence conversation',
       'another-compatible-build', '{"id":"gpt-5.4","providerID":"source-provider"}',
       1786248096000, 1786248106000, NULL),
      ('ses_portable_child', 'global', 'ses_portable_tool', '/source/open-work', '.', 'OpenCode private child conversation',
       'child-compatible-build', '{"id":"gpt-5.4","providerID":"source-provider"}',
       1786248101200, 1786248102500, NULL),
      ('ses_portable_command_child', 'global', 'ses_portable_tool', '/source/open-work', '.', 'OpenCode command child conversation',
       'command-child-compatible-build', '{"id":"gpt-5.4","providerID":"source-provider"}',
       1786248099250, 1786248099280, NULL),
      ('ses_portable_background_child', 'global', 'ses_portable_tool', '/source/open-work', '.', 'OpenCode background child conversation',
       'background-child-compatible-build', '{"id":"gpt-5.4","providerID":"source-provider"}',
       1786248103200, 1786248103900, NULL),
      ('ses_portable_resource', 'global', NULL, '/source/open-work', '.', 'OpenCode resource-blocked conversation',
       'future-compatible-build', '{"id":"gpt-5.4","providerID":"source-provider"}',
       1786248200000, 1786248205000, NULL),
      ('ses_portable_compaction', 'global', NULL, '/source/open-work', '.', 'OpenCode compacted conversation',
       'capability-shaped-build', '{"id":"gpt-5.4","providerID":"source-provider"}',
       1786248300000, 1786248307000, NULL);

    INSERT INTO todo VALUES
      ('ses_portable_tool', '${ACTIVE_TODO}', 'in_progress', 'high', 0, 1786248102000, 1786248103000),
      ('ses_portable_tool', '${COMPLETED_TODO}', 'completed', 'medium', 1, 1786248102000, 1786248103000),
      ('ses_portable_tool', '${CANCELLED_TODO}', 'cancelled', 'low', 2, 1786248102000, 1786248103000);

    INSERT INTO message VALUES
      ('msg_clean_user', 'ses_portable_clean', 1786248000000, 1786248000000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_clean_assistant', 'ses_portable_clean', 1786248001000, 1786248004000,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","error":{"name":"MessageAbortedError","data":{"message":"cancelled after partial response"}}}'),
      ('msg_tool_legacy_user', 'ses_portable_tool', 1786248096000, 1786248096000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_tool_legacy_assistant', 'ses_portable_tool', 1786248097000, 1786248097000,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_tool_legacy_user","finish":"stop"}'),
      ('msg_tool_legacy_boundary', 'ses_portable_tool', 1786248098000, 1786248098000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_tool_legacy_summary', 'ses_portable_tool', 1786248099000, 1786248099000,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_tool_legacy_boundary","summary":true,"finish":"stop"}'),
      ('msg_tool_subtask_user', 'ses_portable_tool', 1786248099100, 1786248099100,
       '{"role":"user","agent":"build","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_tool_subtask_assistant', 'ses_portable_tool', 1786248099200, 1786248099300,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_tool_subtask_user","finish":"tool-calls","mode":"explore","agent":"explore"}'),
      ('msg_tool_subtask_summary_user', 'ses_portable_tool', 1786248099400, 1786248099400,
       '{"role":"user","agent":"build","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_tool_subtask_summary_assistant', 'ses_portable_tool', 1786248099500, 1786248099500,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_tool_subtask_summary_user","finish":"stop"}'),
      ('msg_tool_user', 'ses_portable_tool', 1786248100000, 1786248100000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_tool_assistant', 'ses_portable_tool', 1786248101000, 1786248103000,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_tool_user","finish":"tool-calls"}'),
      ('msg_tool_background_update', 'ses_portable_tool', 1786248103100, 1786248103200,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_tool_user","finish":"tool-calls"}'),
      ('msg_tool_final', 'ses_portable_tool', 1786248103500, 1786248104000,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_tool_user","finish":"stop","structured":{"answer":"The tool result was reviewed","accepted":true}}'),
      ('msg_tool_background_notification', 'ses_portable_tool', 1786248104100, 1786248104100,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_tool_background_response', 'ses_portable_tool', 1786248104200, 1786248104300,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_tool_background_notification","finish":"stop"}'),
      ('msg_tool_abort_user', 'ses_portable_tool', 1786248105000, 1786248105000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_tool_abort_assistant', 'ses_portable_tool', 1786248106000, 1786248106000,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_tool_abort_user","error":{"name":"MessageAbortedError","data":{"message":"cancelled after partial response"}}}'),
      ('msg_child_user', 'ses_portable_child', 1786248101200, 1786248101200,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_child_assistant', 'ses_portable_child', 1786248101800, 1786248101800,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_child_user","finish":"stop"}'),
      ('msg_child_resume_user', 'ses_portable_child', 1786248102000, 1786248102000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_child_resume_assistant', 'ses_portable_child', 1786248102500, 1786248102500,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_child_resume_user","finish":"stop"}'),
      ('msg_command_child_user', 'ses_portable_command_child', 1786248099250, 1786248099250,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_command_child_assistant', 'ses_portable_command_child', 1786248099280, 1786248099280,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_command_child_user","finish":"stop"}'),
      ('msg_background_child_user', 'ses_portable_background_child', 1786248103200, 1786248103200,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_background_child_assistant', 'ses_portable_background_child', 1786248103400, 1786248103400,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_background_child_user","finish":"stop"}'),
      ('msg_background_child_update_user', 'ses_portable_background_child', 1786248103500, 1786248103500,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_background_child_update_assistant', 'ses_portable_background_child', 1786248103800, 1786248103900,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_background_child_update_user","finish":"stop"}'),
      ('msg_resource_user', 'ses_portable_resource', 1786248200000, 1786248200000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_resource_assistant', 'ses_portable_resource', 1786248201000, 1786248204000,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","error":{"name":"APIError","data":{"message":"provider failed","isRetryable":false}}}'),
      ('msg_resource_subtask', 'ses_portable_resource', 1786248205000, 1786248205000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_compact_user', 'ses_portable_compaction', 1786248300000, 1786248300000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_compact_assistant', 'ses_portable_compaction', 1786248301000, 1786248301002,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_compact_user","finish":"stop"}'),
      ('msg_compact_tail_user', 'ses_portable_compaction', 1786248302000, 1786248302000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_compact_tail_assistant', 'ses_portable_compaction', 1786248303000, 1786248303000,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_compact_tail_user","finish":"tool-calls"}'),
      ('msg_compact_boundary', 'ses_portable_compaction', 1786248304000, 1786248304000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_compact_summary', 'ses_portable_compaction', 1786248305000, 1786248305000,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_compact_boundary","summary":true,"finish":"stop"}'),
      ('msg_compact_continue', 'ses_portable_compaction', 1786248306000, 1786248306000,
       '{"role":"user","model":{"providerID":"source-provider","modelID":"gpt-5.4"}}'),
      ('msg_compact_final', 'ses_portable_compaction', 1786248307000, 1786248307000,
       '{"role":"assistant","providerID":"source-provider","modelID":"gpt-5.4","parentID":"msg_compact_continue","finish":"stop"}');

    INSERT INTO part VALUES
      ('prt_clean_user', 'msg_clean_user', 'ses_portable_clean', 1786248000000, 1786248000000,
       '{"type":"text","text":"Remember the OpenCode portable marker"}'),
      ('prt_clean_step_start', 'msg_clean_assistant', 'ses_portable_clean', 1786248001000, 1786248001000,
       '{"type":"step-start"}'),
      ('prt_clean_reasoning', 'msg_clean_assistant', 'ses_portable_clean', 1786248002000, 1786248002000,
       '{"type":"reasoning","text":"Readable legacy reasoning remains historical","time":{"start":1786248002000,"end":1786248002001}}'),
      ('prt_clean_text', 'msg_clean_assistant', 'ses_portable_clean', 1786248003000, 1786248003000,
       '{"type":"text","text":"The OpenCode portable marker is retained"}'),
      ('prt_clean_step_finish', 'msg_clean_assistant', 'ses_portable_clean', 1786248004000, 1786248004000,
       '{"type":"step-finish","reason":"stop","snapshot":"snapshot_clean","cost":0.01,"tokens":{"input":12,"output":4,"reasoning":0,"cache":{"read":0,"write":0}}}'),
      ('prt_tool_legacy_user', 'msg_tool_legacy_user', 'ses_portable_tool', 1786248096000, 1786248096000,
       '{"type":"text","text":"${LEGACY_COMPACTED_PREFIX}"}'),
      ('prt_tool_legacy_file', 'msg_tool_legacy_user', 'ses_portable_tool', 1786248096001, 1786248096001,
       '{"type":"file","mime":"text/plain","url":"data:text/plain;base64,${LEGACY_COMPACTED_FILE_BASE64}","filename":"legacy-prefix.txt"}'),
      ('prt_tool_legacy_assistant', 'msg_tool_legacy_assistant', 'ses_portable_tool', 1786248097000, 1786248097000,
       '{"type":"text","text":"Legacy response replaced by the completed summary"}'),
      ('prt_tool_legacy_boundary', 'msg_tool_legacy_boundary', 'ses_portable_tool', 1786248098000, 1786248098000,
       '{"type":"compaction","auto":true}'),
      ('prt_tool_legacy_summary', 'msg_tool_legacy_summary', 'ses_portable_tool', 1786248099000, 1786248099000,
       '{"type":"text","text":"Legacy handoff summary for the active tool conversation"}'),
      ('prt_tool_subtask_user', 'msg_tool_subtask_user', 'ses_portable_tool', 1786248099100, 1786248099100,
       '{"type":"subtask","prompt":"${SUBTASK_PROMPT}","description":"Review command branch","agent":"explore","model":{"providerID":"source-provider","modelID":"gpt-5.4"},"command":"review"}'),
      ('prt_tool_subtask_call', 'msg_tool_subtask_assistant', 'ses_portable_tool', 1786248099200, 1786248099300,
       '{"type":"tool","tool":"task","callID":"call_subtask_command","state":{"status":"completed","input":{"prompt":"${SUBTASK_PROMPT}","description":"Review command branch","subagent_type":"explore","command":"review"},"output":"<task id=\\"ses_portable_command_child\\" state=\\"completed\\">\\n<task_result>\\n${SUBTASK_RESULT}\\n</task_result>\\n</task>","title":"Review command branch","metadata":{"parentSessionId":"ses_portable_tool","sessionId":"ses_portable_command_child","model":{"providerID":"source-provider","modelID":"gpt-5.4"}},"time":{"start":1786248099200,"end":1786248099300}}}'),
      ('prt_tool_subtask_summary_user', 'msg_tool_subtask_summary_user', 'ses_portable_tool', 1786248099400, 1786248099400,
       '{"type":"text","text":"Summarize the task tool output above and continue with your task.","synthetic":true}'),
      ('prt_tool_subtask_summary_assistant', 'msg_tool_subtask_summary_assistant', 'ses_portable_tool', 1786248099500, 1786248099500,
       '{"type":"text","text":"${SUBTASK_SUMMARY}"}'),
      ('prt_tool_user', 'msg_tool_user', 'ses_portable_tool', 1786248100000, 1786248100000,
       '{"type":"text","text":"This history contains a tool and asks @explore to inspect it","synthetic":true,"ignored":false,"time":{"start":1786248100000,"end":1786248100000},"metadata":{"origin":"fixture"}}'),
      ('prt_tool_ignored', 'msg_tool_user', 'ses_portable_tool', 1786248100000, 1786248100000,
       '{"type":"text","text":"OPENCODE_IGNORED_TEXT_MUST_NOT_MIGRATE","ignored":true}'),
      ('prt_tool_image', 'msg_tool_user', 'ses_portable_tool', 1786248100001, 1786248100001,
       '{"type":"file","mime":"image/png","url":"data:image/png;base64,${FILE_IMAGE_BASE64}","filename":"shape.png","synthetic":true,"source":{"type":"file","path":"/source/open-work/shape.png","text":{"value":"@shape.png","start":7,"end":17}}}'),
      ('prt_tool_document', 'msg_tool_user', 'ses_portable_tool', 1786248100002, 1786248100002,
       '{"type":"file","mime":"application/pdf","url":"data:application/pdf;base64,${FILE_PDF_BASE64}","filename":"sample.pdf","synthetic":true}'),
      ('prt_tool_remote_image', 'msg_tool_user', 'ses_portable_tool', 1786248100002, 1786248100002,
       '{"type":"file","mime":"image/png","url":"${REMOTE_FILE_URL}","filename":"remote-diagram.png"}'),
      ('prt_tool_local_text', 'msg_tool_user', 'ses_portable_tool', 1786248100002, 1786248100002,
       '{"type":"file","mime":"text/plain","url":"${LOCAL_FILE_URL}","filename":"context.txt"}'),
      ('prt_tool_directory', 'msg_tool_user', 'ses_portable_tool', 1786248100002, 1786248100002,
       '{"type":"file","mime":"application/x-directory","url":"${DIRECTORY_FILE_URL}","filename":"context-directory"}'),
      ('prt_tool_agent', 'msg_tool_user', 'ses_portable_tool', 1786248100003, 1786248100003,
       '{"type":"agent","name":"explore"}'),
      ('prt_tool_agent_replay', 'msg_tool_user', 'ses_portable_tool', 1786248100004, 1786248100004,
       '{"type":"text","text":"${AGENT_REPLAY}","synthetic":true}'),
      ('prt_tool_call', 'msg_tool_assistant', 'ses_portable_tool', 1786248101000, 1786248103000,
       '{"type":"tool","tool":"read","callID":"call_fixture","metadata":{"openai":{"itemId":"fc_fixture"}},"state":{"status":"completed","input":{"filePath":"/source/open-work/paper.md"},"output":"<path>/source/open-work/paper.md</path>\\ntool output","title":"paper.md","time":{"start":1786248101000,"end":1786248103000},"metadata":{"preview":"tool output","truncated":false,"loaded":[],"display":{"type":"file","path":"/source/open-work/paper.md","text":"tool output","lineStart":1,"lineEnd":1,"totalLines":1,"truncated":false}},"attachments":[{"id":"att_pdf","sessionID":"ses_portable_tool","messageID":"msg_tool_assistant","type":"file","mime":"application/pdf","url":"data:application/pdf;base64,b25l","filename":"evidence.pdf"},{"id":"att_text","sessionID":"ses_portable_tool","messageID":"msg_tool_assistant","type":"file","mime":"text/plain","url":"data:text/plain;base64,c2Vjb25k","filename":"notes.txt"}]}}'),
      ('prt_tool_task', 'msg_tool_assistant', 'ses_portable_tool', 1786248101900, 1786248101900,
       '{"type":"tool","tool":"task","callID":"call_foreground_task","state":{"status":"completed","input":{"description":"Review branch","prompt":"Find the branch marker","subagent_type":"explore"},"output":"<task id=\\"ses_portable_child\\" state=\\"completed\\">\\n<task_result>\\n${TASK_RESULT}\\n</task_result>\\n</task>","title":"Review branch","metadata":{"parentSessionId":"ses_portable_tool","sessionId":"ses_portable_child","model":{"providerID":"source-provider","modelID":"gpt-5.4"},"truncated":false},"time":{"start":1786248101200,"end":1786248101900}}}'),
      ('prt_tool_background_task', 'msg_tool_assistant', 'ses_portable_tool', 1786248101950, 1786248101950,
       '{"type":"tool","tool":"task","callID":"call_background_task","state":{"status":"completed","input":{"background":true,"description":"Background review","prompt":"Find the background marker","subagent_type":"explore"},"output":"<task id=\\"ses_portable_background_child\\" state=\\"running\\">\\n<summary>Background task started</summary>\\n<task_result>\\nThe task is working in the background. You will be notified automatically when it finishes.\\nDO NOT sleep, poll for progress, ask the task for status, or duplicate this task\\u0027s work \\u2014 avoid working with the same files or topics it is using.\\nWork on non-overlapping tasks, or briefly tell the user what you launched and end your response.\\n</task_result>\\n</task>","title":"Background review","metadata":{"parentSessionId":"ses_portable_tool","sessionId":"ses_portable_background_child","model":{"providerID":"source-provider","modelID":"gpt-5.4"},"background":true,"jobId":"ses_portable_background_child","truncated":false},"time":{"start":1786248101901,"end":1786248101950}}}'),
      ('prt_tool_patch', 'msg_tool_assistant', 'ses_portable_tool', 1786248103000, 1786248103000,
       '{"type":"patch","hash":"snapshot_fixture","files":["/source/open-work/paper.md"]}'),
      ('prt_tool_background_update', 'msg_tool_background_update', 'ses_portable_tool', 1786248103100, 1786248103200,
       '{"type":"tool","tool":"task","callID":"call_background_update","state":{"status":"completed","input":{"background":true,"description":"Extend background review","prompt":"Add final update context","subagent_type":"explore","task_id":"ses_portable_background_child"},"output":"<task id=\\"ses_portable_background_child\\" state=\\"running\\">\\n<summary>Background task updated</summary>\\n<task_result>\\nAdditional context sent to the running background task.\\nThe task is still working in the background. You will be notified automatically when it finishes.\\nDO NOT sleep, poll for progress, ask the task for status, or duplicate this task\\u0027s work \\u2014 avoid working with the same files or topics it is using.\\nWork on non-overlapping tasks, or briefly tell the user what you sent and end your response.\\n</task_result>\\n</task>","title":"Extend background review","metadata":{"parentSessionId":"ses_portable_tool","sessionId":"ses_portable_background_child","model":{"providerID":"source-provider","modelID":"gpt-5.4"},"background":true,"jobId":"ses_portable_background_child","truncated":false},"time":{"start":1786248103100,"end":1786248103200}}}'),
      ('prt_tool_task_resume', 'msg_tool_background_update', 'ses_portable_tool', 1786248103200, 1786248103200,
       '{"type":"tool","tool":"task","callID":"call_foreground_task_resume","state":{"status":"completed","input":{"description":"Continue branch review","prompt":"Check the branch one more time","subagent_type":"explore","task_id":"ses_portable_child"},"output":"<task id=\\"ses_portable_child\\" state=\\"completed\\">\\n<task_result>\\n${TASK_RESUME_RESULT}\\n</task_result>\\n</task>","title":"Continue branch review","metadata":{"parentSessionId":"ses_portable_tool","sessionId":"ses_portable_child","model":{"providerID":"source-provider","modelID":"gpt-5.4"},"truncated":false},"time":{"start":1786248102000,"end":1786248102500}}}'),
      ('prt_tool_final', 'msg_tool_final', 'ses_portable_tool', 1786248103500, 1786248104000,
       '{"type":"tool","tool":"StructuredOutput","callID":"call_structured_output","state":{"status":"completed","input":{"answer":"The tool result was reviewed","accepted":true},"output":"Structured output captured successfully.","title":"Structured Output","metadata":{"valid":true},"time":{"start":1786248103500,"end":1786248104000}}}'),
      ('prt_tool_background_notification', 'msg_tool_background_notification', 'ses_portable_tool', 1786248104100, 1786248104100,
       '{"type":"text","synthetic":true,"text":"<task id=\\"ses_portable_background_child\\" state=\\"completed\\">\\n<summary>Background task completed: Background review</summary>\\n<task_result>\\n${BACKGROUND_TASK_RESULT}\\n</task_result>\\n</task>"}'),
      ('prt_tool_background_response', 'msg_tool_background_response', 'ses_portable_tool', 1786248104200, 1786248104300,
       '{"type":"text","text":"${BACKGROUND_PARENT_RESPONSE}"}'),
      ('prt_tool_abort_user', 'msg_tool_abort_user', 'ses_portable_tool', 1786248105000, 1786248105000,
       '{"type":"text","text":"Continue with a short response that may be interrupted"}'),
      ('prt_tool_abort_assistant', 'msg_tool_abort_assistant', 'ses_portable_tool', 1786248106000, 1786248106000,
       '{"type":"text","text":"This partial OpenCode response was persisted before interruption"}'),
      ('prt_child_user', 'msg_child_user', 'ses_portable_child', 1786248101200, 1786248101200,
       '{"type":"text","text":"${CHILD_PRIVATE_PROMPT}"}'),
      ('prt_child_assistant', 'msg_child_assistant', 'ses_portable_child', 1786248101800, 1786248101800,
       '{"type":"text","text":"${TASK_RESULT}"}'),
      ('prt_child_resume_user', 'msg_child_resume_user', 'ses_portable_child', 1786248102000, 1786248102000,
       '{"type":"text","text":"Check the branch one more time"}'),
      ('prt_child_resume_assistant', 'msg_child_resume_assistant', 'ses_portable_child', 1786248102500, 1786248102500,
       '{"type":"text","text":"${TASK_RESUME_RESULT}"}'),
      ('prt_command_child_user', 'msg_command_child_user', 'ses_portable_command_child', 1786248099250, 1786248099250,
       '{"type":"text","text":"${SUBTASK_PROMPT}"}'),
      ('prt_command_child_assistant', 'msg_command_child_assistant', 'ses_portable_command_child', 1786248099280, 1786248099280,
       '{"type":"text","text":"${SUBTASK_RESULT}"}'),
      ('prt_background_child_user', 'msg_background_child_user', 'ses_portable_background_child', 1786248103200, 1786248103200,
       '{"type":"text","text":"${BACKGROUND_CHILD_PRIVATE_PROMPT}"}'),
      ('prt_background_child_assistant', 'msg_background_child_assistant', 'ses_portable_background_child', 1786248103400, 1786248103400,
       '{"type":"text","text":"${BACKGROUND_INITIAL_CHILD_RESULT}"}'),
      ('prt_background_child_update_user', 'msg_background_child_update_user', 'ses_portable_background_child', 1786248103500, 1786248103500,
       '{"type":"text","text":"Add final update context"}'),
      ('prt_background_child_update_assistant', 'msg_background_child_update_assistant', 'ses_portable_background_child', 1786248103800, 1786248103900,
       '{"type":"text","text":"${BACKGROUND_TASK_RESULT}"}'),
      ('prt_resource_user', 'msg_resource_user', 'ses_portable_resource', 1786248200000, 1786248200000,
       '{"type":"text","text":"This history contains an unverified attachment"}'),
      ('prt_resource_file', 'msg_resource_user', 'ses_portable_resource', 1786248200001, 1786248200001,
       '{"type":"file","mime":"application/pdf","url":"file:///source/open-work/paper.pdf","filename":"paper.pdf"}'),
      ('prt_resource_bad_source', 'msg_resource_user', 'ses_portable_resource', 1786248200002, 1786248200002,
       '{"type":"file","mime":"image/png","url":"data:image/png;base64,${FILE_IMAGE_BASE64}","filename":"bad-source.png","source":{"type":"resource","clientName":"fixture","uri":"fixture://image","text":{"value":"@fixture","start":0,"end":8}}}'),
      ('prt_resource_agent', 'msg_resource_user', 'ses_portable_resource', 1786248200003, 1786248200003,
       '{"type":"agent","name":"research","source":{"value":"@research","start":5,"end":14}}'),
      ('prt_resource_call', 'msg_resource_assistant', 'ses_portable_resource', 1786248201000, 1786248204000,
       '{"type":"tool","tool":"read","callID":"call_resource","state":{"status":"completed","input":{"path":"paper.pdf"},"output":"resource output","attachments":[{"type":"file","url":"file:///source/open-work/paper.pdf"}]}}'),
      ('prt_resource_orphan_task', 'msg_resource_assistant', 'ses_portable_resource', 1786248202000, 1786248202000,
       '{"type":"tool","tool":"task","callID":"call_orphan_task","state":{"status":"completed","input":{"description":"Missing branch","prompt":"Inspect missing branch","subagent_type":"explore"},"output":"<task id=\\"ses_missing_child\\" state=\\"completed\\">\\n<task_result>\\nmissing child result\\n</task_result>\\n</task>","title":"Missing branch","metadata":{"parentSessionId":"ses_portable_resource","sessionId":"ses_missing_child","model":{"providerID":"source-provider","modelID":"gpt-5.4"}},"time":{"start":1786248201000,"end":1786248202000}}}'),
      ('prt_resource_subtask', 'msg_resource_subtask', 'ses_portable_resource', 1786248205000, 1786248205000,
       '{"type":"subtask","prompt":"Investigate the source","description":"Research source","agent":"research","model":{"providerID":"source-provider","modelID":"gpt-5.4"},"command":"research"}'),
      ('prt_compact_user', 'msg_compact_user', 'ses_portable_compaction', 1786248300000, 1786248300000,
       '{"type":"text","text":"Original user context"}'),
      ('prt_compact_assistant', 'msg_compact_assistant', 'ses_portable_compaction', 1786248301000, 1786248301000,
       '{"type":"text","text":"Retained split assistant context"}'),
      ('prt_compact_assistant_reasoning', 'msg_compact_assistant', 'ses_portable_compaction', 1786248301001, 1786248301002,
       '{"type":"reasoning","text":"${LEGACY_REASONING_TRACE}","metadata":{"openai":{"itemId":"${LEGACY_REASONING_METADATA}"}},"time":{"start":1786248301001,"end":1786248301002}}'),
      ('prt_compact_tail_user', 'msg_compact_tail_user', 'ses_portable_compaction', 1786248302000, 1786248302000,
       '{"type":"text","text":"Retained recent user context"}'),
      ('prt_compact_tail_file', 'msg_compact_tail_user', 'ses_portable_compaction', 1786248302001, 1786248302001,
       '{"type":"file","mime":"image/png","url":"data:image/png;base64,${FILE_IMAGE_BASE64}","filename":"compaction-tail.png","synthetic":true}'),
      ('prt_compact_tail_assistant', 'msg_compact_tail_assistant', 'ses_portable_compaction', 1786248303000, 1786248303000,
       '{"type":"text","text":"Retained recent assistant context"}'),
      ('prt_compact_tail_tool', 'msg_compact_tail_assistant', 'ses_portable_compaction', 1786248303001, 1786248303001,
       '{"type":"tool","tool":"bash","callID":"call_compaction_tail","state":{"status":"completed","input":{"command":"printf retained-tail"},"output":"Retained compaction tool output","attachments":[{"id":"att_compaction_tail","sessionID":"ses_portable_compaction","messageID":"msg_compact_tail_assistant","type":"file","mime":"text/plain","url":"data:text/plain;base64,${COMPACTION_TOOL_ATTACHMENT_BASE64}","filename":"compaction-tail.txt"}]}}'),
      ('prt_compact_boundary', 'msg_compact_boundary', 'ses_portable_compaction', 1786248304000, 1786248304000,
       '{"type":"compaction","auto":true,"tail_start_id":"msg_compact_assistant"}'),
      ('prt_compact_summary', 'msg_compact_summary', 'ses_portable_compaction', 1786248305000, 1786248305000,
       '{"type":"text","text":"Compacted handoff summary"}'),
      ('prt_compact_continue', 'msg_compact_continue', 'ses_portable_compaction', 1786248306000, 1786248306000,
       '{"type":"text","text":"Continue if you have next steps.","synthetic":true,"metadata":{"compaction_continue":true}}'),
      ('prt_compact_final', 'msg_compact_final', 'ses_portable_compaction', 1786248307000, 1786248307000,
       '{"type":"text","text":"Continued after compaction"}');
  `);
  const insertPart = database.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertPart.run(
    "prt_tool_retained_output",
    "msg_tool_assistant",
    "ses_portable_tool",
    1786248102100,
    1786248102100,
    JSON.stringify({
      type: "tool",
      tool: "bash",
      callID: "call_retained_output",
      state: {
        status: "completed",
        input: { command: "produce retained output" },
        output: `Output was truncated. Full output saved to: ${retainedOutputPath}`,
        metadata: { truncated: true, outputPath: retainedOutputPath },
        time: { start: 1786248102000, end: 1786248102100 },
      },
    }),
  );
  insertPart.run(
    "prt_tool_expired_output",
    "msg_tool_assistant",
    "ses_portable_tool",
    1786248102200,
    1786248102200,
    JSON.stringify({
      type: "tool",
      tool: "bash",
      callID: "call_expired_output",
      state: {
        status: "completed",
        input: { command: "produce expired output" },
        output: `Output was truncated. Full output saved to: ${expiredOutputPath}`,
        metadata: { truncated: true, outputPath: expiredOutputPath },
        time: { start: 1786248102150, end: 1786248102200 },
      },
    }),
  );
  insertPart.run(
    "prt_tool_compacted_output",
    "msg_tool_assistant",
    "ses_portable_tool",
    1786248102300,
    1786248102300,
    JSON.stringify({
      type: "tool",
      tool: "bash",
      callID: "call_compacted_output",
      state: {
        status: "completed",
        input: { command: "produce old output" },
        output: COMPACTED_TOOL_OUTPUT,
        title: "Old output",
        metadata: {},
        time: { start: 1786248102250, end: 1786248102300, compacted: 1786248103000 },
        attachments: [{
          id: "att_compacted",
          sessionID: "ses_portable_tool",
          messageID: "msg_tool_assistant",
          type: "file",
          mime: "text/plain",
          url: `data:text/plain;base64,${COMPACTED_ATTACHMENT_BASE64}`,
          filename: "compacted-secret.txt",
        }],
      },
    }),
  );
  database.prepare("UPDATE project SET worktree = ?").run(SOURCE_OPEN_WORK);
  database.prepare("UPDATE session SET directory = ?").run(SOURCE_OPEN_WORK);
  for (const table of ["message", "part"] as const) {
    const rows = database.prepare(`SELECT id, data FROM ${table}`).all() as Array<{ id: string; data: string }>;
    const update = database.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`);
    for (const row of rows) {
      update.run(JSON.stringify(nativeFixtureValue(JSON.parse(row.data))), row.id);
    }
  }
  database.close();
}

test("OpenCode historical tool evidence is rendered into ordinary Claude history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-ts-open-convert-"));
  const dataRoot = path.join(root, "opencode-data");
  const sourceState = path.join(root, "source-state");
  try {
    const toolOutputRoot = path.join(dataRoot, "tool-output");
    const retainedOutputPath = path.join(toolOutputRoot, "tool_retained");
    const expiredOutputPath = path.join(toolOutputRoot, "tool_expired");
    await mkdir(toolOutputRoot, { recursive: true });
    await writeFile(retainedOutputPath, RETAINED_TOOL_OUTPUT);
    createOpenCodeSource(path.join(dataRoot, "opencode.db"), retainedOutputPath, expiredOutputPath);
    await createOwnedSessionDiff(dataRoot);
    const runtime = { environment: { HOME: root }, cwd: root, home: root };
    const scanned = await runCli([
      "--json", "--state-dir", sourceState, "--opencode-data-root", dataRoot,
      "scan", "--agent", "opencode",
    ], runtime);
    assert.equal(scanned.exitCode, 0, scanned.stdout || scanned.stderr);

    const todoSearch = await runCli([
      "--json", "--state-dir", sourceState, "history", "search", ACTIVE_TODO, "--agent", "opencode",
    ], runtime);
    assert.equal(todoSearch.exitCode, 0, todoSearch.stderr);
    assert.equal((JSON.parse(todoSearch.stdout) as { data: { total_hits: number } }).data.total_hits, 1);

    const listed = await runCli([
      "--json", "--state-dir", sourceState, "history", "list", "--agent", "opencode", "--view", "all",
    ], runtime);
    const listedSessions = (JSON.parse(listed.stdout) as {
      data: { sessions: Array<{ session_ref: string; title: string }> };
    }).data.sessions;
    const toolRef = listedSessions.find(
      (session) => session.title === "OpenCode tool evidence conversation",
    )!.session_ref;
    const childRef = listedSessions.find(
      (session) => session.title === "OpenCode private child conversation",
    )!.session_ref;
    const compactRef = listedSessions.find(
      (session) => session.title === "OpenCode compacted conversation",
    )!.session_ref;
    const sourceShown = await runCli([
      "--json", "--state-dir", sourceState, "history", "show", toolRef,
    ], runtime);
    assert.equal(sourceShown.exitCode, 0, sourceShown.stderr);
    const sourceHistory = conversationText(sourceShown.stdout);
    assert.match(sourceHistory, /context\.txt/);
    assert.match(sourceHistory, /context-directory/);
    const compactArchive = path.join(root, "opencode-compaction-to-claude.agenthist");
    const compactExported = await runCli([
      "--json", "--state-dir", sourceState,
      "export", "--agent", "opencode", "--session", compactRef, "-o", compactArchive,
    ], runtime);
    assert.equal(compactExported.exitCode, 0, compactExported.stderr);

    const archive = path.join(root, "opencode-to-claude.agenthist");
    const exported = await runCli([
      "--json", "--state-dir", sourceState,
      "export", "--agent", "opencode", "--session", toolRef, "-o", archive,
    ], runtime);
    assert.equal(exported.exitCode, 0, exported.stderr);
    const fullArchive = path.join(root, "opencode-all.agenthist");
    const fullExported = await runCli([
      "--json", "--state-dir", sourceState, "export", "--agent", "opencode", "-o", fullArchive,
    ], runtime);
    assert.equal(fullExported.exitCode, 0, fullExported.stderr);
    const inspected = await runCli(["--json", "inspect", archive], runtime);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    const inspectedData = (JSON.parse(inspected.stdout) as {
      data: { entries: Array<{ agent: string }> };
    }).data;
    assert.equal(inspectedData.entries.every((entry) => entry.agent === "opencode"), true);

    await rm(dataRoot, { recursive: true });
    await rm(sourceState, { recursive: true });
    const targetConfig = path.join(root, "target-claude");
    const targetWork = path.join(root, "target-work");
    const targetState = path.join(root, "target-state");
    await mkdir(targetConfig, { recursive: true });
    await mkdir(targetWork, { recursive: true });
    const allPlan = await runCli([
      "--json", "--state-dir", targetState,
      "import", fullArchive, "--agent", "opencode", "--to", "claude",
      "--target", `claude=${targetConfig}`,
      "--map-path", `${SOURCE_OPEN_WORK}=${targetWork}`, "--dry-run",
    ], runtime);
    assert.equal(allPlan.exitCode, 3, allPlan.stderr);
    const allEnvelope = JSON.parse(allPlan.stdout) as {
      data?: { status: string; routes: Array<{ quality: string; findings: Array<{ code: string }> }> };
    };
    assert.ok(allEnvelope.data, allPlan.stdout);
    const allData = allEnvelope.data;
    assert.equal(allData.status, "blocked");
    const allFindingCodes = allData.routes[0]!.findings.map((finding) => finding.code);
    for (const code of [
      "opencode.tool_history.degraded",
      "opencode.reasoning_trace.degraded",
      "opencode.step_lifecycle.skipped",
      "opencode.assistant_abort.materialized",
      "opencode.tool_history.unprojectable",
      "opencode.file_history.unprojectable",
      "opencode.assistant_error.unsupported",
      "opencode.task_relation.unclosed",
      "opencode.agent_reference.unsupported",
      "opencode.subtask.unsupported",
    ]) assert.equal(allFindingCodes.includes(code), true, code);

    const importArguments = [
      "--json", "--state-dir", targetState,
      "import", archive, "--agent", "opencode", "--to", "claude",
      "--target", `claude=${targetConfig}`,
      "--map-path", `${SOURCE_OPEN_WORK}=${targetWork}`,
    ];
    const selectedPlan = await runCli([...importArguments, "--dry-run"], runtime);
    assert.equal(selectedPlan.exitCode, 0, selectedPlan.stdout || selectedPlan.stderr);
    const selected = (JSON.parse(selectedPlan.stdout) as {
      data: {
        status: string;
        routes: Array<{ quality: string }>;
        items: Array<{ source_session_ref: string; target_session_ref: string; findings: Array<{ code: string }> }>;
        resources: Array<{ name: string }>;
      };
    }).data;
    assert.equal(selected.status, "ready");
    assert.equal(selected.routes[0]!.quality, "degraded");
    const selectedItem = selected.items.find((item) => item.source_session_ref === toolRef)!;
    const selectedTargetRef = selectedItem.target_session_ref;
    const findingCodes = selectedItem.findings.map((finding) => finding.code);
    for (const code of [
      "opencode.tool_history.degraded",
      "opencode.assistant_rows.coalesced",
      "opencode.inline_resource.managed",
      "opencode.file_part.managed",
      "opencode.tool_output.managed",
      "opencode.tool_output.unavailable",
      "opencode.task_result.closed",
      "opencode.background_task.closed",
      "opencode.todo_list.degraded",
    ]) assert.equal(findingCodes.includes(code), true, code);
    assert.deepEqual(selected.resources.map((resource) => resource.name).sort(), [
      "evidence.pdf", "notes.txt", "sample.pdf", "shape.png", "tool_retained",
    ]);

    const childPlan = await runCli([
      "--json", "--state-dir", targetState,
      "import", fullArchive, "--session", childRef, "--to", "claude",
      "--target", `claude=${targetConfig}`,
      "--map-path", `${SOURCE_OPEN_WORK}=${targetWork}`, "--dry-run",
    ], runtime);
    assert.equal(childPlan.exitCode, 0, childPlan.stderr);
    const childData = (JSON.parse(childPlan.stdout) as {
      data: { items: Array<{ source_session_ref: string; findings: Array<{ code: string }> }> };
    }).data;
    const childFindingCodes = childData.items.find((item) => item.source_session_ref === childRef)!
      .findings.map((finding) => finding.code);
    assert.equal(childFindingCodes.includes("opencode.session_relation.skipped"), true);
    assert.equal(childFindingCodes.includes("opencode.session_component.unsupported"), false);

    const compactArguments = [
      "--json", "--state-dir", targetState,
      "import", compactArchive, "--agent", "opencode", "--to", "claude",
      "--target", `claude=${targetConfig}`,
      "--map-path", `${SOURCE_OPEN_WORK}=${targetWork}`,
    ];
    const compactPlan = await runCli([...compactArguments, "--dry-run"], runtime);
    assert.equal(compactPlan.exitCode, 0, compactPlan.stderr);
    const compactPlanData = (JSON.parse(compactPlan.stdout) as {
      data: {
        routes: Array<{ quality: string }>;
        items: Array<{ source_session_ref: string; target_session_ref: string; findings: Array<{ code: string }> }>;
        resources: Array<{ name: string }>;
      };
    }).data;
    assert.equal(compactPlanData.routes[0]!.quality, "degraded");
    const compactPlanItem = compactPlanData.items.find((item) => item.source_session_ref === compactRef)!;
    const compactFindingCodes = compactPlanItem.findings.map((finding) => finding.code);
    for (const code of [
      "opencode.legacy_compaction.materialized",
      "opencode.legacy_compaction_tail_timestamp.rebased",
      "opencode.reasoning_trace.degraded",
    ]) assert.equal(compactFindingCodes.includes(code), true, code);
    assert.deepEqual(compactPlanData.resources.map((resource) => resource.name).sort(), [
      "compaction-tail.png", "compaction-tail.txt",
    ]);

    const imported = await runCli([...importArguments, "--apply"], runtime);
    assert.equal(imported.exitCode, 0, imported.stderr);
    const importedData = (JSON.parse(imported.stdout) as {
      data: { written: number; resources: Array<{ name: string; materialized_path: string }> };
    }).data;
    assert.equal(importedData.written, selected.items.length);
    assert.equal(importedData.resources.length, 5);
    const pdfPath = managedResourcePath(targetWork, "one", "evidence.pdf");
    const textPath = managedResourcePath(targetWork, "second", "notes.txt");
    const fileImagePath = managedResourcePath(targetWork, FILE_IMAGE_BYTES, "shape.png");
    const fileDocumentPath = managedResourcePath(targetWork, FILE_PDF_BYTES, "sample.pdf");
    const retainedPath = managedResourcePath(targetWork, RETAINED_TOOL_OUTPUT, "tool_retained");
    assert.equal(importedData.resources.find((resource) => resource.name === "evidence.pdf")!.materialized_path, pdfPath);
    assert.equal(importedData.resources.find((resource) => resource.name === "notes.txt")!.materialized_path, textPath);
    assert.equal(
      importedData.resources.find((resource) => resource.name === "shape.png")!.materialized_path,
      fileImagePath,
    );
    assert.equal(
      importedData.resources.find((resource) => resource.name === "sample.pdf")!.materialized_path,
      fileDocumentPath,
    );
    assert.equal(
      importedData.resources.find((resource) => resource.name === "tool_retained")!.materialized_path,
      retainedPath,
    );
    assert.equal((await readFile(pdfPath)).toString("utf8"), "one");
    assert.equal(await readFile(textPath, "utf8"), "second");
    assert.deepEqual(await readFile(fileImagePath), FILE_IMAGE_BYTES);
    assert.deepEqual(await readFile(fileDocumentPath), FILE_PDF_BYTES);
    assert.equal(await readFile(retainedPath, "utf8"), RETAINED_TOOL_OUTPUT);

    const targetList = await runCli([
      "--json", "--state-dir", targetState, "history", "list", "--agent", "claude", "--view", "all",
    ], runtime);
    const shown = await runCli([
      "--json", "--state-dir", targetState, "history", "show", selectedTargetRef,
    ], runtime);
    assert.equal(shown.exitCode, 0, shown.stderr);
    const claudeHistory = conversationText(shown.stdout);
    assert.match(claudeHistory, /This history contains a tool/);
    assert.match(claudeHistory, /What did we do so far\?/);
    assert.match(claudeHistory, /Legacy handoff summary for the active tool conversation/);
    assert.match(claudeHistory, /AGENTHIST_HISTORICAL_TOOL_EVIDENCE_V1/);
    assert.match(claudeHistory, /AGENTHIST_HISTORICAL_RESOURCE_V1/);
    assert.match(claudeHistory, /AGENTHIST_HISTORICAL_REFERENCE_V1/);
    assert.match(claudeHistory, /not executed in this target session/);
    assert.match(claudeHistory, /"source_agent":"opencode"/);
    assert.match(claudeHistory, /call_fixture/);
    assert.match(claudeHistory, /paper\.md/);
    assert.match(claudeHistory, /tool output/);
    assert.match(claudeHistory, /call_foreground_task/);
    assert.match(claudeHistory, new RegExp(TASK_RESULT));
    assert.match(claudeHistory, /call_foreground_task_resume/);
    assert.equal(claudeHistory.split(TASK_RESUME_RESULT).length - 1, 1);
    assert.match(claudeHistory, /call_background_task/);
    assert.match(claudeHistory, /call_background_update/);
    assert.match(claudeHistory, /Background task updated/);
    assert.equal(claudeHistory.split(BACKGROUND_TASK_RESULT).length - 1, 1);
    assert.match(claudeHistory, new RegExp(BACKGROUND_PARENT_RESPONSE));
    assert.match(claudeHistory, /call_subtask_command/);
    assert.match(claudeHistory, new RegExp(SUBTASK_RESULT));
    assert.match(claudeHistory, new RegExp(SUBTASK_SUMMARY));
    assert.match(claudeHistory, /The following tool was executed by the user/);
    assert.match(claudeHistory, /asks @explore to inspect it/);
    assert.match(claudeHistory, /call the task tool with subagent: explore/);
    assert.match(claudeHistory, /evidence\.pdf/);
    assert.match(claudeHistory, /notes\.txt/);
    assert.match(claudeHistory, /shape\.png/);
    const historicalPayloads = claudeHistory.split("\n").flatMap((line): Record<string, unknown>[] => {
      try {
        const value: unknown = JSON.parse(line);
        return value !== null && typeof value === "object" && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
    const shapeResource = historicalPayloads.find((payload) => payload.name === "shape.png");
    assert.ok(shapeResource);
    assert.equal(typeof shapeResource.source_reference, "string");
    const sourceMarker = ":source=";
    const sourceReference = shapeResource.source_reference as string;
    const sourceOffset = sourceReference.indexOf(sourceMarker);
    assert.notEqual(sourceOffset, -1);
    const shapeSource = JSON.parse(sourceReference.slice(sourceOffset + sourceMarker.length)) as { path: string };
    assert.equal(shapeSource.path, nativeFixturePath("/source/open-work/shape.png"));
    assert.match(claudeHistory, /@shape\.png/);
    assert.match(claudeHistory, /sample\.pdf/);
    assert.match(claudeHistory, /"namespace":"opencode\.file_url"/);
    assert.equal(claudeHistory.includes(REMOTE_FILE_URL), true);
    assert.equal(claudeHistory.includes(LOCAL_FILE_URL), false);
    assert.equal(claudeHistory.includes(DIRECTORY_FILE_URL), false);
    assert.equal(claudeHistory.includes("context.txt"), false);
    assert.equal(claudeHistory.includes("context-directory"), false);
    assert.match(claudeHistory, /opencode:file-part:/);
    assert.match(claudeHistory, /opencode:tool-attachment:att_pdf/);
    assert.match(claudeHistory, /call_retained_output/);
    assert.match(claudeHistory, /tool_retained/);
    assert.match(claudeHistory, /call_expired_output/);
    assert.match(claudeHistory, /tool_expired/);
    assert.match(claudeHistory, /\[Old tool result content cleared\]/);
    assert.equal(claudeHistory.includes(COMPACTED_TOOL_OUTPUT), false);
    assert.equal(claudeHistory.includes("compacted-secret.txt"), false);
    assert.match(claudeHistory, /StructuredOutput/);
    assert.match(claudeHistory, /"accepted":true/);
    assert.match(claudeHistory, /tool result was reviewed/);
    assert.match(claudeHistory, /This partial OpenCode response was persisted before interruption/);
    assert.match(claudeHistory, /AGENTHIST_HISTORICAL_EVENT_V1/);
    assert.match(claudeHistory, /"event":"assistant_response_aborted"/);
    assert.match(claudeHistory, /AGENTHIST_HISTORICAL_WORK_STATE_V1/);
    assert.equal(claudeHistory.split(ACTIVE_TODO).length - 1, 1);
    assert.match(claudeHistory, /"priority":"high"/);
    assert.equal(claudeHistory.includes(COMPLETED_TODO), false);
    assert.equal(claudeHistory.includes(CANCELLED_TODO), false);
    assert.equal(claudeHistory.includes(FILE_IMAGE_BASE64), false);
    assert.equal(claudeHistory.includes(FILE_PDF_BASE64), false);
    assert.equal(claudeHistory.includes("OPENCODE_IGNORED_TEXT_MUST_NOT_MIGRATE"), false);
    assert.equal(claudeHistory.includes(LEGACY_COMPACTED_PREFIX), false);
    assert.equal(claudeHistory.includes("legacy-prefix.txt"), false);
    assert.equal(claudeHistory.includes(CHILD_PRIVATE_PROMPT), false);
    assert.equal(claudeHistory.includes(BACKGROUND_CHILD_PRIVATE_PROMPT), false);
    assert.equal(claudeHistory.includes(BACKGROUND_INITIAL_CHILD_RESULT), false);
    assert.equal(claudeHistory.includes(SESSION_DIFF_MARKER), false);

    const compactImported = await runCli([...compactArguments, "--apply"], runtime);
    assert.equal(compactImported.exitCode, 0, compactImported.stderr);
    const compactImportedData = (JSON.parse(compactImported.stdout) as {
      data: { written: number; resources: Array<{ name: string; materialized_path: string }> };
    }).data;
    assert.equal(compactImportedData.written, 1);
    const compactAttachmentPath = managedResourcePath(
      targetWork,
      COMPACTION_TOOL_ATTACHMENT,
      "compaction-tail.txt",
    );
    assert.equal(compactImportedData.resources.length, 2);
    assert.equal(
      compactImportedData.resources.find((resource) => resource.name === "compaction-tail.txt")!.materialized_path,
      compactAttachmentPath,
    );
    assert.equal(await readFile(compactAttachmentPath, "utf8"), COMPACTION_TOOL_ATTACHMENT);
    const compactImagePath = managedResourcePath(targetWork, FILE_IMAGE_BYTES, "compaction-tail.png");
    assert.equal(
      compactImportedData.resources.find((resource) => resource.name === "compaction-tail.png")!.materialized_path,
      compactImagePath,
    );
    assert.deepEqual(await readFile(compactImagePath), FILE_IMAGE_BYTES);
    const compactShown = await runCli([
      "--json", "--state-dir", targetState,
      "history", "show", compactPlanItem.target_session_ref,
    ], runtime);
    assert.equal(compactShown.exitCode, 0, compactShown.stderr);
    const compactHistory = conversationText(compactShown.stdout);
    const compactMarkers = [
      "What did we do so far?",
      "Compacted handoff summary",
      "Retained split assistant context",
      LEGACY_REASONING_TRACE,
      "Retained recent user context",
      "Retained recent assistant context",
      "Continue if you have next steps.",
      "Continued after compaction",
    ];
    let previousCompactMarkerIndex = -1;
    for (const marker of compactMarkers) {
      const markerIndex = compactHistory.indexOf(marker);
      assert.ok(markerIndex > previousCompactMarkerIndex, `${marker} is missing or out of compaction replay order`);
      previousCompactMarkerIndex = markerIndex;
    }
    assert.doesNotMatch(compactHistory, /Original user context/);
    assert.match(compactHistory, /AGENTHIST_HISTORICAL_REASONING_TRACE_V1/);
    assert.equal(compactHistory.includes(LEGACY_REASONING_METADATA), false);
    assert.match(compactHistory, /call_compaction_tail/);
    assert.match(compactHistory, /Retained compaction tool output/);
    assert.match(compactHistory, /compaction-tail\.png/);
    assert.match(compactHistory, /compaction-tail\.txt/);
    assert.equal(compactHistory.includes(FILE_IMAGE_BASE64), false);
    assert.equal(compactHistory.includes(COMPACTION_TOOL_ATTACHMENT_BASE64), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode historical tool evidence reaches Codex with target provider rebinding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-ts-open-to-codex-"));
  const dataRoot = path.join(root, "opencode-data");
  const sourceState = path.join(root, "source-state");
  try {
    const toolOutputRoot = path.join(dataRoot, "tool-output");
    const retainedOutputPath = path.join(toolOutputRoot, "tool_retained");
    const expiredOutputPath = path.join(toolOutputRoot, "tool_expired");
    await mkdir(toolOutputRoot, { recursive: true });
    await writeFile(retainedOutputPath, RETAINED_TOOL_OUTPUT);
    createOpenCodeSource(path.join(dataRoot, "opencode.db"), retainedOutputPath, expiredOutputPath);
    await createOwnedSessionDiff(dataRoot);
    const runtime = { environment: { HOME: root }, cwd: root, home: root };
    const scanned = await runCli([
      "--json", "--state-dir", sourceState, "--opencode-data-root", dataRoot,
      "scan", "--agent", "opencode",
    ], runtime);
    assert.equal(scanned.exitCode, 0, scanned.stdout || scanned.stderr);
    const listed = await runCli([
      "--json", "--state-dir", sourceState, "history", "list", "--agent", "opencode", "--view", "all",
    ], runtime);
    const toolRef = (JSON.parse(listed.stdout) as {
      data: { sessions: Array<{ session_ref: string; title: string }> };
    }).data.sessions.find((session) => session.title === "OpenCode tool evidence conversation")!.session_ref;
    const archive = path.join(root, "opencode-to-codex.agenthist");
    const exported = await runCli([
      "--json", "--state-dir", sourceState,
      "export", "--agent", "opencode", "--session", toolRef, "-o", archive,
    ], runtime);
    assert.equal(exported.exitCode, 0, exported.stderr);
    const inspected = await runCli(["--json", "inspect", archive], runtime);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    assert.equal((JSON.parse(inspected.stdout) as {
      data: { entries: Array<{ agent: string }> };
    }).data.entries.every((entry) => entry.agent === "opencode"), true);

    await rm(dataRoot, { recursive: true });
    await rm(sourceState, { recursive: true });
    const targetCodex = path.join(root, "target-codex");
    const targetSQLite = path.join(root, "target-sqlite");
    const targetState = path.join(root, "target-state");
    const targetWork = path.join(root, "target-work");
    await mkdir(targetCodex, { recursive: true });
    await mkdir(targetSQLite, { recursive: true });
    await mkdir(targetWork, { recursive: true });
    await writeFile(path.join(targetCodex, "config.toml"), 'model_provider = "target-provider"\n');
    createCodexTargetDatabase(path.join(targetSQLite, "state_5.sqlite"));
    const importArguments = [
      "--json", "--state-dir", targetState, "--codex-sqlite-home", targetSQLite,
      "import", archive, "--agent", "opencode", "--to", "codex",
      "--target", `codex=${targetCodex}`,
      "--map-path", `${SOURCE_OPEN_WORK}=${targetWork}`,
    ];
    const plan = await runCli([...importArguments, "--dry-run"], runtime);
    assert.equal(plan.exitCode, 0, plan.stdout || plan.stderr);
    const planData = (JSON.parse(plan.stdout) as {
      data: {
        status: string;
        routes: Array<{ quality: string }>;
        items: Array<{ source_session_ref: string; target_session_ref: string; findings: Array<{ code: string }> }>;
      };
    }).data;
    assert.equal(planData.status, "ready");
    assert.equal(planData.routes[0]!.quality, "degraded");
    const toolPlan = planData.items.find((item) => item.source_session_ref === toolRef)!;
    assert.match(toolPlan.target_session_ref, /^ahsr1_codex_/);
    assert.equal(
      toolPlan.findings.some((finding) => finding.code === "codex.memory_eligibility.disabled"),
      true,
    );
    const imported = await runCli([...importArguments, "--apply"], runtime);
    assert.equal(imported.exitCode, 0, imported.stderr);
    const importedData = (JSON.parse(imported.stdout) as {
      data: { written: number; resources: Array<{ name: string }> };
    }).data;
    assert.equal(importedData.written, planData.items.length);
    assert.equal(importedData.resources.some((resource) => resource.name === "shape.png"), true);
    assert.equal(importedData.resources.some((resource) => resource.name === "sample.pdf"), true);
    const targetDatabase = new DatabaseSync(path.join(targetSQLite, "state_5.sqlite"), { readOnly: true });
    const targetThread = targetDatabase.prepare(
      "SELECT rollout_path, memory_mode FROM threads",
    ).get() as { rollout_path: string; memory_mode: string };
    targetDatabase.close();
    assert.equal(targetThread.memory_mode, "disabled");
    const sessionMetadata = JSON.parse((await readFile(targetThread.rollout_path, "utf8")).split("\n")[0]!) as {
      payload: { memory_mode?: string };
    };
    assert.equal(sessionMetadata.payload.memory_mode, "disabled");

    const targetList = await runCli([
      "--json", "--state-dir", targetState, "history", "list", "--agent", "codex", "--view", "all",
    ], runtime);
    assert.equal(targetList.exitCode, 0, targetList.stderr);
    const targetRef = (JSON.parse(targetList.stdout) as {
      data: { sessions: Array<{ session_ref: string; provider: string; context: string }> };
    }).data.sessions.find((session) => session.session_ref === toolPlan.target_session_ref)!;
    assert.equal(targetRef.provider, "target-provider");
    assert.equal(targetRef.context, targetWork);
    const shown = await runCli([
      "--json", "--state-dir", targetState, "history", "show", targetRef.session_ref,
    ], runtime);
    assert.equal(shown.exitCode, 0, shown.stderr);
    const codexHistory = conversationText(shown.stdout);
    assert.match(codexHistory, /This history contains a tool/);
    assert.match(codexHistory, /What did we do so far\?/);
    assert.match(codexHistory, /Legacy handoff summary for the active tool conversation/);
    assert.match(codexHistory, /AGENTHIST_HISTORICAL_TOOL_EVIDENCE_V1/);
    assert.match(codexHistory, /AGENTHIST_HISTORICAL_REFERENCE_V1/);
    assert.match(codexHistory, /not executed in this target session/);
    assert.match(codexHistory, /"source_agent":"opencode"/);
    assert.match(codexHistory, /call_fixture/);
    assert.match(codexHistory, /paper\.md/);
    assert.match(codexHistory, /tool output/);
    assert.match(codexHistory, /call_foreground_task/);
    assert.match(codexHistory, new RegExp(TASK_RESULT));
    assert.match(codexHistory, /call_foreground_task_resume/);
    assert.equal(codexHistory.split(TASK_RESUME_RESULT).length - 1, 1);
    assert.match(codexHistory, /call_background_task/);
    assert.match(codexHistory, /call_background_update/);
    assert.match(codexHistory, /Background task updated/);
    assert.equal(codexHistory.split(BACKGROUND_TASK_RESULT).length - 1, 1);
    assert.match(codexHistory, new RegExp(BACKGROUND_PARENT_RESPONSE));
    assert.match(codexHistory, /call_subtask_command/);
    assert.match(codexHistory, new RegExp(SUBTASK_RESULT));
    assert.match(codexHistory, new RegExp(SUBTASK_SUMMARY));
    assert.match(codexHistory, /The following tool was executed by the user/);
    assert.match(codexHistory, /asks @explore to inspect it/);
    assert.match(codexHistory, /call the task tool with subagent: explore/);
    assert.match(codexHistory, /StructuredOutput/);
    assert.match(codexHistory, /"accepted":true/);
    assert.match(codexHistory, /This partial OpenCode response was persisted before interruption/);
    assert.match(codexHistory, /AGENTHIST_HISTORICAL_EVENT_V1/);
    assert.match(codexHistory, /"event":"assistant_response_aborted"/);
    assert.match(codexHistory, /AGENTHIST_HISTORICAL_WORK_STATE_V1/);
    assert.equal(codexHistory.split(ACTIVE_TODO).length - 1, 1);
    assert.match(codexHistory, /"priority":"high"/);
    assert.equal(codexHistory.includes(COMPLETED_TODO), false);
    assert.equal(codexHistory.includes(CANCELLED_TODO), false);
    assert.match(codexHistory, /shape\.png/);
    assert.match(codexHistory, /sample\.pdf/);
    assert.match(codexHistory, /"namespace":"opencode\.file_url"/);
    assert.equal(codexHistory.includes(REMOTE_FILE_URL), true);
    assert.equal(codexHistory.includes(LOCAL_FILE_URL), false);
    assert.equal(codexHistory.includes(DIRECTORY_FILE_URL), false);
    assert.equal(codexHistory.includes("context.txt"), false);
    assert.equal(codexHistory.includes("context-directory"), false);
    assert.match(codexHistory, /\[Old tool result content cleared\]/);
    assert.equal(codexHistory.includes(COMPACTED_TOOL_OUTPUT), false);
    assert.equal(codexHistory.includes("compacted-secret.txt"), false);
    assert.equal(codexHistory.includes(FILE_IMAGE_BASE64), false);
    assert.equal(codexHistory.includes(FILE_PDF_BASE64), false);
    assert.equal(codexHistory.includes("OPENCODE_IGNORED_TEXT_MUST_NOT_MIGRATE"), false);
    assert.equal(codexHistory.includes(LEGACY_COMPACTED_PREFIX), false);
    assert.equal(codexHistory.includes("legacy-prefix.txt"), false);
    assert.equal(codexHistory.includes(CHILD_PRIVATE_PROMPT), false);
    assert.equal(codexHistory.includes(BACKGROUND_CHILD_PRIVATE_PROMPT), false);
    assert.equal(codexHistory.includes(BACKGROUND_INITIAL_CHILD_RESULT), false);
    assert.equal(codexHistory.includes(SESSION_DIFF_MARKER), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
