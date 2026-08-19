import { homedir } from "node:os";

import {
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
  type ConversationItem,
  type HistoryLibraryView,
  type HistoryMutationOperation,
  type HistoryPage,
  type HistorySessionSummary,
  type HistoryView,
  type PortableContextBlock,
} from "../application/index.js";
import {
  colorizeHuman,
  invalidArguments,
  parseAgent,
  readValue,
  success,
  type CliResult,
  type CliRuntime,
  type GlobalOptions,
} from "./command-support.js";

function statusTone(status: "ready" | "not_detected" | "blocked" | "error"):
  "success" | "warning" | "error" {
  return status === "ready" ? "success" : status === "not_detected" ? "warning" : "error";
}

function sourceLocationLabel(role: string): string {
  return role.replaceAll("_", " ");
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
  const human = `${colorizeHuman("AgentHist doctor", "section", color)}  ` +
    `${colorizeHuman(result.status.toUpperCase(), statusTone(result.status), color)}\n\n` +
    result.agents.map((agent) =>
      `${colorizeHuman(agentLabel(agent.agent), "section", color)}  ` +
      `${colorizeHuman(agent.status.toUpperCase(), statusTone(agent.status), color)}\n` +
      agent.locations.map((location) =>
        `  ${colorizeHuman(sourceLocationLabel(location.role).padEnd(18), "muted", color)}` +
        `${colorizeHuman(location.path, "muted", color)}\n`
      ).join("") +
      agent.findings.map((finding) =>
        `  ${colorizeHuman("finding".padEnd(18), "muted", color)}` +
        `${colorizeHuman(finding, "warning", color)}\n`
      ).join("") +
      (agent.detail === undefined
        ? ""
        : `  ${colorizeHuman("detail".padEnd(18), "muted", color)}` +
          `${colorizeHuman(agent.detail, agent.status === "error" || agent.status === "blocked" ? "error" : "warning", color)}\n`)
    ).join("\n");
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
  const result = await scanHistory({
    stateDirectory: globals.stateDirectory,
    ...sources,
    ...(requested.size === 0 ? {} : { agents: [...requested] }),
  });
  if (result.status === "not_detected") {
    return success(
      "scan",
      { status: "not_detected", agents: result.inspections, sessions: 0, warnings: [] },
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
    `${result.agents.map((item) =>
      `${colorizeHuman("Scanned", "success", globals.color)} ` +
      `${colorizeHuman(agentLabel(item.agent), "info", globals.color)}: ${item.sessions} session(s) · ` +
      `${item.reusedSessions} reused · ` +
      `${item.rebuiltSessions} rebuilt${item.removedSessions === 0 ? "" : ` · ${item.removedSessions} removed`}\n`
    ).join("")}` +
      result.warnings.map((warning) =>
        `${colorizeHuman("warning:", "warning_strong", globals.color)} ${warning}\n`
      ).join(""),
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

function renderConversationItem(item: ConversationItem, color: boolean): string {
  if (item.kind === "gap") {
    return `${colorizeHuman(`[gap${item.code === undefined ? "" : ` ${item.code}`}]`, "warning", color)} ` +
      `${item.label}\n`;
  }
  const tone = item.role === "user"
    ? "message_user"
    : item.role === "assistant" ? "message_assistant" : "message_system";
  return `${colorizeHuman(`${item.role}:`, tone, color)} ${item.text}\n` +
    (item.portableBlocks ?? []).map(renderPortableBlock).join("") +
    (item.portableNotes ?? []).map((note) => `  [note] ${note}\n`).join("");
}

function renderPageSummary(
  label: string,
  page: HistoryPage,
): string {
  return `${page.returned} of ${page.total} ${label}(s) at offset ${page.offset}; ` +
    `${page.remaining} remaining.\n` +
    (page.nextOffset === undefined ? "" : `next offset: ${page.nextOffset}\n`);
}

export async function runHistory(globals: GlobalOptions, args: readonly string[]): Promise<CliResult> {
  const action = args[0];
  if (action === "list") {
    const flags = parseListFlags(args.slice(1));
    const result = await listHistory({ stateDirectory: globals.stateDirectory, ...flags });
    const human = result.sessions
      .map((session) =>
        `${colorizeHuman(session.sessionRef, "muted", globals.color)}  ${session.title || "(untitled)"}\n`
      )
      .join("");
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
      `${human}${colorizeHuman(renderPageSummary("session", result).trimEnd(), "muted", globals.color)}\n`,
      globals.json,
    );
  }
  if (action === "search") {
    const query = args[1];
    if (query === undefined || query.startsWith("--")) {
      throw invalidArguments("history search requires a literal query");
    }
    const flags = parseListFlags(args.slice(2));
    const result = await searchHistory({ stateDirectory: globals.stateDirectory, ...flags }, query);
    const human = result.hits
      .map((hit) =>
        `${colorizeHuman(hit.session.sessionRef, "muted", globals.color)}  ` +
        `${colorizeHuman(`${hit.field}:`, "info", globals.color)} ${hit.snippet}\n`
      )
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
      `${human}${colorizeHuman(renderPageSummary("hit", result).trimEnd(), "muted", globals.color)}\n`,
      globals.json,
    );
  }
  if (action === "show") {
    if (args.length !== 2) throw invalidArguments("history show requires exactly one session reference");
    const session = await showHistory(globals.stateDirectory, args[1]!);
    const body = session.conversation.map((item) => renderConversationItem(item, globals.color)).join("");
    return success(
      "history show",
      { session: summary(session), conversation: session.conversation },
      `${colorizeHuman(session.sessionRef, "muted", globals.color)}\n` +
        `${colorizeHuman(session.title || "(untitled)", "strong", globals.color)}\n\n${body}`,
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
      `${colorizeHuman(result.changed ? "Changed" : "No change", result.changed ? "success" : "muted", globals.color)} ` +
        `${colorizeHuman(result.sessionRef, "muted", globals.color)}: ` +
        `${colorizeHuman(action, "info", globals.color)} ` +
        `(${String(before.state)} -> ${String(after.state)})\n`,
      globals.json,
    );
  }
  throw invalidArguments(`unknown history command: ${action ?? ""}`);
}
