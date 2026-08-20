import { homedir } from "node:os";

import {
  AGENTS,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_HISTORY_OFFSET,
  agentLabel,
  inspectHistorySources,
  listHistory,
  MAX_HISTORY_LIMIT,
  MAX_HISTORY_OFFSET,
  mutateHistory,
  scanHistory,
  searchHistory,
  showHistory,
  type Agent,
  type ConversationGap,
  type ConversationItem,
  type ConversationMessage,
  type HistoryLibraryView,
  type HistoryMutationOperation,
  type HistorySessionSummary,
  type HistoryView,
  type PortableContextBlock,
} from "../application/index.js";
import {
  colorizeHuman,
  invalidArguments,
  parseAgent,
  readValue,
  renderBoundedHumanDetails,
  success,
  type CliResult,
  type CliRuntime,
  type GlobalOptions,
} from "./command-support.js";
import {
  GAP_RUN_COLLAPSE_THRESHOLD,
  groupConversationForDisplay,
  type ConversationGapCount,
} from "./conversation-display.js";
import {
  humanCount,
  humanFields,
  humanFieldWidth,
  humanOutputWidth,
  humanPage,
  humanSection,
  humanTitle,
  type HumanField,
} from "./human-output.js";
import { withLiveStatus } from "./live-status.js";
import {
  displayWidth,
  padDisplay,
  truncateDisplay,
  truncateDisplayAround,
  wrapDisplay,
} from "./terminal-layout.js";

const AGENT_COLUMN_WIDTH = Math.max(...AGENTS.map((agent) => displayWidth(agentLabel(agent))));
const MAX_SESSION_TITLE_WIDTH = 72;
const MAX_SEARCH_SNIPPET_WIDTH = 96;
const MAX_TECHNICAL_TYPES = 12;
const SCAN_WARNING_DISPLAY_LIMIT = 20;

function sessionTitleWidth(outputWidth: number): number {
  return Math.max(12, Math.min(MAX_SESSION_TITLE_WIDTH, outputWidth - AGENT_COLUMN_WIDTH - 9));
}

function searchSnippetWidth(outputWidth: number): number {
  return Math.max(12, Math.min(MAX_SEARCH_SNIPPET_WIDTH, outputWidth - 20));
}

function statusTone(status: "ready" | "not_detected" | "blocked" | "error"):
  "success" | "warning" | "error" {
  return status === "ready" ? "success" : status === "not_detected" ? "warning" : "error";
}

function sourceLocationLabel(role: string): string {
  return role.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function sourceStatusLabel(status: "ready" | "not_detected" | "blocked" | "error"): string {
  return status === "not_detected" ? "NOT DETECTED" : status.toUpperCase();
}

function historySourceOptions(
  globals: GlobalOptions,
  runtime: CliRuntime,
  agents?: readonly Agent[],
) {
  const environment = runtime.environment ?? process.env;
  const cwd = runtime.cwd ?? process.cwd();
  const home = runtime.home ?? environment.HOME ?? homedir();
  return {
    ...(agents === undefined ? {} : { agents }),
    codex: {
      ...(globals.codexHome === undefined ? {} : { codexHome: globals.codexHome }),
      ...(globals.sqliteHome === undefined ? {} : { sqliteHome: globals.sqliteHome }),
      ...(globals.profile === undefined ? {} : { profile: globals.profile }),
      environment, cwd, home,
    },
    opencode: {
      ...(globals.opencodeDataRoot === undefined ? {} : { dataRoot: globals.opencodeDataRoot }),
      ...(globals.opencodeDatabase === undefined ? {} : { databasePath: globals.opencodeDatabase }),
      environment, cwd, home,
    },
    claude: {
      ...(globals.claudeConfigRoot === undefined ? {} : { configRoot: globals.claudeConfigRoot }),
      environment, cwd, home,
    },
    pi: {
      ...(globals.piSessionRoot === undefined ? {} : { sessionRoot: globals.piSessionRoot }),
      environment, cwd, home,
    },
  };
}

export async function runDoctor(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  const requested = new Set<Agent>();
  for (let index = 0; index < args.length;) {
    const argument = args[index]!;
    if (argument !== "--agent" && !argument.startsWith("--agent=")) {
      throw invalidArguments(`unknown doctor flag: ${argument}`);
    }
    const [value, next] = readValue(args, index, "--agent");
    requested.add(parseAgent(value));
    index = next;
  }
  const result = await inspectHistorySources(historySourceOptions(
    globals,
    runtime,
    requested.size === 0 ? undefined : [...requested],
  ));
  const agents = result.agents.map((agent) => ({
    agent: agent.agent,
    status: agent.status,
    locations: agent.locations,
    finding_codes: agent.findings,
    ...(agent.detail === undefined ? {} : { detail: agent.detail }),
  }));
  const color = globals.color;
  const summaryFields: HumanField[] = [
    {
      label: "Status",
      value: sourceStatusLabel(result.status),
      tone: statusTone(result.status),
    },
    {
      label: "Agents",
      value: `${result.agents.filter((agent) => agent.status === "ready").length} ready · ` +
        `${result.agents.length} checked`,
    },
  ];
  const agentGroups = result.agents.map((agent) => {
    const fields: HumanField[] = [
      {
        label: "Status",
        value: sourceStatusLabel(agent.status),
        tone: statusTone(agent.status),
      },
      ...agent.locations.map((location) => ({
        label: sourceLocationLabel(location.role),
        value: location.path,
        tone: "muted" as const,
      })),
      ...(agent.findings.length === 0
        ? []
        : [{ label: "Findings", value: agent.findings.join(", "), tone: "warning" as const }]),
      ...(agent.detail === undefined
        ? []
        : [{
            label: "Detail",
            value: agent.detail,
            tone: agent.status === "error" || agent.status === "blocked" ? "error" as const : "warning" as const,
          }]),
    ];
    return { agent, fields };
  });
  const fieldWidth = humanFieldWidth(summaryFields, ...agentGroups.map((group) => group.fields));
  const human = humanTitle("AgentHist Doctor", color) + "\n" +
    humanFields(summaryFields, color, "  ", fieldWidth) + "\n" +
    agentGroups.map(({ agent, fields }) =>
      humanSection(agentLabel(agent.agent), color) + humanFields(fields, color, "  ", fieldWidth) + "\n"
    ).join("");
  const exitCode = result.status === "ready" ? 0 : result.status === "not_detected" ? 3 :
    result.status === "blocked" ? 4 : 9;
  return success(
    "doctor",
    { schema_version: result.schemaVersion, status: result.status, agents },
    human,
    globals.json,
    exitCode,
  );
}

function summary(session: HistorySessionSummary): Record<string, unknown> {
  return {
    session_ref: session.sessionRef,
    agent: session.agent,
    title: session.title,
    context: session.context,
    model: session.model,
    provider: session.provider,
    updated_at: session.updatedAt,
    native_archived: session.nativeArchived,
    library_state: session.libraryState,
    tags: session.tags,
  };
}

function librarySummary(library: HistoryLibraryView): Record<string, unknown> {
  return {
    state: library.state,
    name: library.name,
    tags: library.tags,
    ...(library.state === "deleted" ? { restore_state: library.restoreState } : {}),
  };
}

function parseListFlags(args: readonly string[]): {
  agents?: readonly Agent[];
  view: HistoryView;
  offset: number;
  limit: number;
} {
  const agents = new Set<Agent>();
  let view: HistoryView | undefined;
  let offset: number | undefined;
  let limit: number | undefined;
  for (let index = 0; index < args.length;) {
    const argument = args[index]!;
    if (argument === "--agent" || argument.startsWith("--agent=")) {
      const [value, next] = readValue(args, index, "--agent");
      agents.add(parseAgent(value));
      index = next;
      continue;
    }
    if (argument === "--view" || argument.startsWith("--view=")) {
      if (view !== undefined) throw invalidArguments("history accepts one --view value");
      const [value, next] = readValue(args, index, "--view");
      if (value !== "active" && value !== "archived" && value !== "deleted" && value !== "all") {
        throw invalidArguments(`unsupported history view: ${value}`);
      }
      view = value;
      index = next;
      continue;
    }
    if (argument === "--offset" || argument.startsWith("--offset=")) {
      if (offset !== undefined) throw invalidArguments("history accepts one --offset value");
      const [value, next] = readValue(args, index, "--offset");
      if (!/^(?:0|[1-9][0-9]*)$/.test(value) || Number(value) > MAX_HISTORY_OFFSET) {
        throw invalidArguments(`history offset must be between 0 and ${MAX_HISTORY_OFFSET}`);
      }
      offset = Number(value);
      index = next;
      continue;
    }
    if (argument === "--limit" || argument.startsWith("--limit=")) {
      if (limit !== undefined) throw invalidArguments("history accepts one --limit value");
      const [value, next] = readValue(args, index, "--limit");
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > MAX_HISTORY_LIMIT) {
        throw invalidArguments(`history limit must be between 1 and ${MAX_HISTORY_LIMIT}`);
      }
      limit = Number(value);
      index = next;
      continue;
    }
    throw invalidArguments(`unknown history flag: ${argument}`);
  }
  return {
    ...(agents.size === 0 ? {} : { agents: [...agents] }),
    view: view ?? "active",
    offset: offset ?? DEFAULT_HISTORY_OFFSET,
    limit: limit ?? DEFAULT_HISTORY_LIMIT,
  };
}

export async function runScan(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  const requested = new Set<Agent>();
  for (let index = 0; index < args.length;) {
    const argument = args[index]!;
    if (argument === "--agent" || argument.startsWith("--agent=")) {
      const [value, next] = readValue(args, index, "--agent");
      requested.add(parseAgent(value));
      index = next;
      continue;
    }
    throw invalidArguments(`unknown scan flag: ${argument}`);
  }
  const sources = historySourceOptions(globals, runtime);
  const result = await withLiveStatus(runtime, globals, "Preparing history scan", (status) => scanHistory({
    stateDirectory: globals.stateDirectory,
    ...sources,
    ...(requested.size === 0 ? {} : { agents: [...requested] }),
    onProgress: (progress) => {
      if (progress.phase === "detecting") {
        status.update("Detecting Agent history");
      } else if (progress.phase === "preparing") {
        status.update(`Preparing ${humanCount(progress.totalAgents, "Agent source")}`);
      } else {
        status.update(
          `[${progress.currentAgent}/${progress.totalAgents}] Scanning ${agentLabel(progress.agent)} history`,
        );
      }
    },
  }));
  if (result.status === "not_detected") {
    return success(
      "scan",
      { status: "not_detected", agents: result.inspections, sessions: 0, warnings: [] },
      humanTitle("History scan", globals.color) + "\n" +
        `${colorizeHuman("No supported Agent history source was detected.", "warning", globals.color)}\n`,
      globals.json,
    );
  }
  return success(
    "scan",
    {
      ...(result.agents.length === 1 ? { agent: result.agents[0]!.agent } : {}),
      agents: result.agents.map((item) => ({
        agent: item.agent,
        sessions: item.sessions,
        reused_sessions: item.reusedSessions,
        rebuilt_sessions: item.rebuiltSessions,
        removed_sessions: item.removedSessions,
        warnings: item.warnings,
      })),
      sessions: result.sessions,
      warnings: result.warnings,
      state_directory: globals.stateDirectory,
    },
    humanTitle("History scan", globals.color) + "\n" + humanFields([
      { label: "Sessions", value: String(result.sessions), tone: "success" },
      { label: "Agents", value: String(result.agents.length) },
      { label: "State", value: globals.stateDirectory },
    ], globals.color) + "\n" + humanSection("Results", globals.color) +
      result.agents.map((item) =>
        `  ${colorizeHuman(agentLabel(item.agent), "strong", globals.color)}\n` +
        `    ${humanCount(item.sessions, "session")} · ${item.reusedSessions} reused · ${item.rebuiltSessions} rebuilt` +
        `${item.removedSessions === 0 ? "" : ` · ${item.removedSessions} removed`}\n`
      ).join("") +
      (result.warnings.length === 0 ? "" : "\n" + humanSection("Warnings", globals.color) +
        renderBoundedHumanDetails(
          result.agents.flatMap((item) => item.warnings.map((warning) => ({ agent: item.agent, warning }))),
          (item) => `  ${colorizeHuman(
            padDisplay(agentLabel(item.agent), AGENT_COLUMN_WIDTH),
            "warning_strong",
            globals.color,
          )}  ${item.warning}\n`,
          "warning",
          SCAN_WARNING_DISPLAY_LIMIT,
        )),
    globals.json,
  );
}

function renderLabeledValue(label: string, value: string, indentation = "    "): string {
  const lines = value.split("\n");
  return `${indentation}${label}: ${lines[0] ?? ""}\n` +
    lines.slice(1).map((line) => `${indentation}  ${line}\n`).join("");
}

function renderJson(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (rendered === undefined) throw new Error("portable history evidence is not serializable");
  return rendered;
}

function renderResource(
  resource: Extract<PortableContextBlock, { readonly kind: "historical_resource" }>["resource"],
  indentation = "    ",
): string {
  return `${indentation}${resource.name} (${resource.mediaType}, ${resource.sizeBytes} bytes)\n` +
    renderLabeledValue("path", resource.relativePath, `${indentation}  `) +
    renderLabeledValue("source", resource.sourceReference, `${indentation}  `) +
    renderLabeledValue("sha256", resource.sha256, `${indentation}  `);
}

function renderReference(
  reference: Extract<PortableContextBlock, { readonly kind: "historical_reference" }>["reference"],
  indentation = "  ",
): string {
  let rendered = `${indentation}[source reference] ${reference.namespace}/${reference.type}\n` +
    renderLabeledValue("locator", reference.locator, `${indentation}  `);
  if (reference.title !== undefined) {
    rendered += renderLabeledValue("title", renderJson(reference.title), `${indentation}  `);
  }
  if (reference.context !== undefined) {
    rendered += renderLabeledValue("context", renderJson(reference.context), `${indentation}  `);
  }
  if (reference.citations !== undefined) {
    rendered += renderLabeledValue("citations", renderJson(reference.citations), `${indentation}  `);
  }
  return rendered;
}

function renderPortableBlock(block: PortableContextBlock): string {
  if (block.kind === "text") return "";
  if (block.kind === "historical_citations") {
    return `  [citation evidence]\n${renderLabeledValue("citations", renderJson(block.citations))}`;
  }
  if (block.kind === "historical_context") {
    return `  [historical context] source_role=${block.context.sourceRole}\n` +
      renderLabeledValue("text", block.context.text);
  }
  if (block.kind === "historical_event") {
    return `  [historical event] ${block.event}\n${renderLabeledValue("reason", block.reason)}`;
  }
  if (block.kind === "historical_work_state") {
    return `  [historical work state] ${block.workState.sourceKind}\n` +
      block.workState.items.map((item) => renderLabeledValue("item", renderJson(item))).join("");
  }
  if (block.kind === "historical_reasoning") {
    return "  [reasoning summary]\n" +
      block.summary.map((section) => renderLabeledValue("section", section)).join("");
  }
  if (block.kind === "historical_reasoning_trace") {
    return `  [reasoning trace]\n${renderLabeledValue("text", block.text)}`;
  }
  if (block.kind === "historical_reference") {
    return renderReference(block.reference);
  }
  if (block.kind === "historical_resource") {
    return `  [resource evidence]\n${renderResource(block.resource)}`;
  }
  const tool = block.tool;
  const identity = [tool.namespace, tool.name].filter((value) => value !== undefined).join("/");
  let rendered = `  [tool ${tool.phase}]${identity === "" ? "" : ` ${identity}`} call_id=${tool.callId}` +
    `${tool.status === undefined ? "" : ` status=${tool.status}`}\n`;
  if (tool.input !== undefined) rendered += renderLabeledValue("input", renderJson(tool.input));
  if (tool.output !== undefined) rendered += renderLabeledValue("output", renderJson(tool.output));
  if (tool.error !== undefined) rendered += renderLabeledValue("error", renderJson(tool.error));
  for (const resource of tool.resources ?? []) rendered += renderResource(resource);
  for (const reference of tool.references ?? []) rendered += renderReference(reference, "    ");
  return rendered;
}

function renderConversationMessage(item: ConversationMessage, color: boolean): string {
  const tone = item.role === "user"
    ? "message_user"
    : item.role === "assistant" ? "message_assistant" : "message_system";
  return `${colorizeHuman(item.role.toUpperCase(), tone, color)}\n${item.text}\n` +
    (item.portableBlocks ?? []).map(renderPortableBlock).join("") +
    "\n";
}

function renderConversationGap(item: ConversationGap, color: boolean): string {
  return `${colorizeHuman(`[gap${item.code === undefined ? "" : ` ${item.code}`}]`, "warning", color)} ` +
    `${item.label}\n\n`;
}

interface TechnicalCount {
  readonly code: string;
  readonly count: number;
}

function countTechnicalCodes(codes: readonly string[]): TechnicalCount[] {
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts].map(([code, count]) => ({ code, count }));
}

function renderTechnicalCounts(
  counts: readonly TechnicalCount[],
  color: boolean,
  outputWidth: number,
): string {
  const shown = counts.slice(0, MAX_TECHNICAL_TYPES).map((item) => ({
    ...item,
    shownCode: truncateDisplay(item.code, Math.max(12, Math.min(56, outputWidth - 10))),
  }));
  const codeWidth = Math.max(0, ...shown.map((item) => displayWidth(item.shownCode)));
  const rows = shown.map((item) =>
    `  ${colorizeHuman(padDisplay(item.shownCode, codeWidth), "muted", color)}  ×${item.count}\n`
  ).join("");
  const remaining = counts.length - shown.length;
  return rows + (remaining === 0
    ? ""
    : `  ${colorizeHuman(`... ${remaining} more types; use --json for details.`, "muted", color)}\n`);
}

function renderGapRun(
  gaps: readonly ConversationGap[],
  counts: readonly ConversationGapCount[],
  color: boolean,
  outputWidth: number,
): string {
  if (gaps.length < GAP_RUN_COLLAPSE_THRESHOLD) {
    return gaps.map((gap) => renderConversationGap(gap, color)).join("");
  }
  return `${colorizeHuman(`[${gaps.length} history gaps collapsed]`, "warning", color)}\n` +
    renderTechnicalCounts(counts, color, outputWidth) + "\n";
}

export function renderHistoryConversation(
  conversation: readonly ConversationItem[],
  color: boolean,
  outputWidth = 100,
): string {
  const rendered: string[] = [];
  const notes: string[] = [];
  for (const group of groupConversationForDisplay(conversation)) {
    if (group.kind === "message") {
      notes.push(...(group.message.portableNotes ?? []));
      rendered.push(renderConversationMessage(group.message, color));
    } else {
      rendered.push(renderGapRun(group.gaps, group.counts, color, outputWidth));
    }
  }
  if (notes.length !== 0) {
    const counts = countTechnicalCodes(notes);
    rendered.push(humanSection("Technical notes", color));
    rendered.push(renderTechnicalCounts(counts, color, outputWidth));
    const summary = `${notes.length} annotations collapsed across ${counts.length} ` +
      `${counts.length === 1 ? "type" : "types"}; use --json for exact placement.`;
    rendered.push(wrapDisplay(summary, Math.max(20, outputWidth - 2)).map((line) =>
      `  ${colorizeHuman(line, "muted", color)}\n`
    ).join(""));
  }
  return rendered.join("");
}

function sessionListItem(
  session: HistorySessionSummary,
  index: number,
  titleWidth: number,
  color: boolean,
): string {
  const title = truncateDisplay(session.title || "(untitled)", titleWidth);
  const context = session.context === "" ? "No workspace" : session.context;
  const state = session.libraryState === "active" ? "" : ` · ${session.libraryState}`;
  const agent = padDisplay(agentLabel(session.agent), AGENT_COLUMN_WIDTH);
  return `  ${String(index + 1).padStart(2)}. ${colorizeHuman(agent, "info", color)} · ` +
    `${colorizeHuman(title, "strong", color)}\n` +
    `      ${colorizeHuman(session.sessionRef, "muted", color)}\n` +
    `      ${colorizeHuman(`${context} · ${session.updatedAt}${state}`, "muted", color)}\n`;
}

export async function runHistory(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime = {},
): Promise<CliResult> {
  const action = args[0];
  const outputWidth = humanOutputWidth(runtime.output?.columns);
  if (action === "list") {
    const flags = parseListFlags(args.slice(1));
    const result = await withLiveStatus(runtime, globals, "Loading history", () =>
      listHistory({ stateDirectory: globals.stateDirectory, ...flags }));
    const human = result.sessions
      .map((session, index) => sessionListItem(session, index, sessionTitleWidth(outputWidth), globals.color))
      .join("\n");
    return success(
      "history list",
      {
        total_sessions: result.total,
        returned_sessions: result.returned,
        remaining_sessions: result.remaining,
        offset: result.offset,
        limit: result.limit,
        ...(result.nextOffset === undefined ? {} : { next_offset: result.nextOffset }),
        sessions: result.sessions.map(summary),
      },
      humanTitle("History", globals.color) + "\n" + humanFields([
        { label: "View", value: flags.view },
        { label: "Sessions", value: String(result.total) },
      ], globals.color) + (human === "" ? "\nNo sessions found.\n" : `\n${human}\n`) +
        humanPage("session", result.offset, result.returned, result.total, result.nextOffset, globals.color),
      globals.json,
    );
  }
  if (action === "search") {
    const query = args[1];
    if (query === undefined || query.startsWith("--")) {
      throw invalidArguments("history search requires a literal query");
    }
    const flags = parseListFlags(args.slice(2));
    const result = await withLiveStatus(runtime, globals, "Searching history", () =>
      searchHistory({ stateDirectory: globals.stateDirectory, ...flags }, query));
    const human = result.hits
      .map((hit, index) => {
        const fullTitle = hit.session.title || "(untitled)";
        const title = truncateDisplay(fullTitle, sessionTitleWidth(outputWidth));
        const titleMatch = hit.field === "title" && hit.snippet === fullTitle;
        const match = titleMatch
          ? colorizeHuman("title match", "muted", globals.color)
          : `${colorizeHuman(hit.field, "muted", globals.color)}  ` +
            truncateDisplayAround(hit.snippet, query, searchSnippetWidth(outputWidth));
        const context = hit.session.context === "" ? "No workspace" : hit.session.context;
        const agent = padDisplay(agentLabel(hit.session.agent), AGENT_COLUMN_WIDTH);
        return `  ${String(index + 1).padStart(2)}. ` +
          `${colorizeHuman(agent, "info", globals.color)} · ` +
          `${colorizeHuman(title, "strong", globals.color)}\n` +
          `      ${match}\n` +
          `      ${colorizeHuman(`${context} · ${hit.session.updatedAt}`, "muted", globals.color)}\n` +
          `      ${colorizeHuman(hit.session.sessionRef, "muted", globals.color)}\n`;
      })
      .join("");
    return success(
      "history search",
      {
        query,
        total_hits: result.total,
        returned_hits: result.returned,
        remaining_hits: result.remaining,
        offset: result.offset,
        limit: result.limit,
        ...(result.nextOffset === undefined ? {} : { next_offset: result.nextOffset }),
        hits: result.hits.map((hit) => ({ ...summary(hit.session), field: hit.field, snippet: hit.snippet })),
      },
      humanTitle("History search", globals.color) + "\n" + humanFields([
        { label: "Query", value: query },
        { label: "View", value: flags.view },
        { label: "Hits", value: String(result.total) },
      ], globals.color) + (human === "" ? "\nNo matches found.\n" : `\n${human}\n`) +
        humanPage("hit", result.offset, result.returned, result.total, result.nextOffset, globals.color),
      globals.json,
    );
  }
  if (action === "show") {
    if (args.length !== 2) throw invalidArguments("history show requires exactly one session reference");
    const session = await withLiveStatus(runtime, globals, "Loading history session", () =>
      showHistory(globals.stateDirectory, args[1]!));
    const body = renderHistoryConversation(session.conversation, globals.color, outputWidth);
    return success(
      "history show",
      { session: summary(session), conversation: session.conversation },
      humanTitle("History session", globals.color) + "\n" + humanFields([
        { label: "Title", value: session.title || "(untitled)", tone: "strong" },
        { label: "Agent", value: agentLabel(session.agent) },
        { label: "Session", value: session.sessionRef },
        { label: "Workspace", value: session.context || "-" },
        { label: "Updated", value: session.updatedAt },
        { label: "Model", value: session.model || "-" },
        { label: "Provider", value: session.provider || "-" },
        { label: "Library", value: session.libraryState },
        ...(session.tags.length === 0 ? [] : [{ label: "Tags", value: session.tags.join(", ") }]),
      ], globals.color) + "\n" + humanSection("Conversation", globals.color) + `\n${body}`,
      globals.json,
    );
  }
  if (
    action === "rename" || action === "tag" || action === "archive" || action === "unarchive" ||
    action === "delete" || action === "undelete"
  ) {
    const reference = args[1];
    if (reference === undefined || reference === "" || reference.startsWith("--")) {
      throw invalidArguments(`history ${action} requires one session reference`);
    }
    let name: string | undefined;
    const addTags: string[] = [];
    const removeTags: string[] = [];
    if (action === "rename") {
      for (let index = 2; index < args.length;) {
        const argument = args[index]!;
        if (argument === "--name") {
          const value = args[index + 1];
          if (name !== undefined || value === undefined || value.startsWith("--")) {
            throw invalidArguments("history rename requires exactly one --name value");
          }
          name = value;
          index += 2;
          continue;
        }
        if (argument.startsWith("--name=")) {
          if (name !== undefined) throw invalidArguments("history rename accepts --name once");
          name = argument.slice("--name=".length);
          index++;
          continue;
        }
        throw invalidArguments(`unknown history rename flag: ${argument}`);
      }
      if (name === undefined) throw invalidArguments("history rename requires --name <name>");
    } else if (action === "tag") {
      for (let index = 2; index < args.length;) {
        const argument = args[index]!;
        if (
          argument !== "--add" && !argument.startsWith("--add=") &&
          argument !== "--remove" && !argument.startsWith("--remove=")
        ) throw invalidArguments(`unknown history tag flag: ${argument}`);
        const flag = argument === "--add" || argument.startsWith("--add=") ? "--add" : "--remove";
        const [value, next] = readValue(args, index, flag);
        (flag === "--add" ? addTags : removeTags).push(value);
        index = next;
      }
      if (addTags.length + removeTags.length === 0) {
        throw invalidArguments("history tag requires at least one --add or --remove");
      }
    } else if (args.length !== 2) {
      throw invalidArguments(`history ${action} accepts exactly one session reference`);
    }
    const result = await mutateHistory({
      stateDirectory: globals.stateDirectory,
      sessionRef: reference,
      operation: action as HistoryMutationOperation,
      ...(name === undefined ? {} : { name }),
      ...(addTags.length === 0 ? {} : { addTags }),
      ...(removeTags.length === 0 ? {} : { removeTags }),
    });
    const before = librarySummary(result.before);
    const after = librarySummary(result.after);
    return success(
      `history ${action}`,
      {
        session_ref: result.sessionRef,
        agent: result.agent,
        operation: result.operation,
        changed: result.changed,
        before,
        after,
      },
      humanTitle("History updated", globals.color) + "\n" + humanFields([
        {
          label: "Result",
          value: result.changed ? "CHANGED" : "NO CHANGE",
          tone: result.changed ? "success" : "muted",
        },
        { label: "Session", value: result.sessionRef },
        { label: "Agent", value: agentLabel(result.agent) },
        { label: "Operation", value: action, tone: "info" },
        ...(result.before.state === result.after.state
          ? []
          : [{ label: "State", value: `${result.before.state} -> ${result.after.state}` }]),
        ...(result.before.name === result.after.name
          ? []
          : [{ label: "Name", value: `${result.before.name || "-"} -> ${result.after.name || "-"}` }]),
        ...(result.before.tags.join("\0") === result.after.tags.join("\0")
          ? []
          : [{
              label: "Tags",
              value: `${result.before.tags.join(", ") || "-"} -> ${result.after.tags.join(", ") || "-"}`,
            }]),
      ], globals.color),
      globals.json,
    );
  }
  throw invalidArguments(`unknown history command: ${action ?? ""}`);
}
