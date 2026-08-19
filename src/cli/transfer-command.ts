import { homedir } from "node:os";
import path from "node:path";

import { pathFlavorForPlatform, samePath } from "../domain/host-path.js";
import {
  AGENTS,
  agentLabel,
  exportHistory,
  importHistoryArchive,
  inspectHistoryArchive,
  listCodexImportProviders,
  openImportCatalog,
  MAX_INSPECT_LIMIT,
  resolveCodexCurrentProvider,
  type Agent,
  type ConversionFinding,
  type ImportHistoryResult,
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
  runImportWizard,
  type ImportWizardRequest,
} from "./import-wizard/index.js";
import {
  detectImportWizardLanguage,
  type ImportWizardLanguage,
} from "./import-wizard/copy.js";

function renderHumanLossFindings(findings: readonly ConversionFinding[]): string {
  const losses = findings.filter((finding) => finding.disposition !== "exact");
  return renderBoundedHumanDetails(
    losses,
    (finding) => `    ${finding.disposition}  ${finding.code}  x${finding.count}\n`,
    "finding",
  );
}

function renderImportHuman(file: string, result: ImportHistoryResult, color: boolean): string {
  const heading = result.status === "blocked"
    ? "Import blocked"
    : result.mode === "dry_run" ? "Import plan" : "Import complete";
  const routeHuman = `Routes:\n${result.routes.map((route) => {
    const label = route.sourceAgent === route.targetAgent
      ? `${agentLabel(route.sourceAgent)} (native)`
      : `${agentLabel(route.sourceAgent)} -> ${agentLabel(route.targetAgent)}  ${route.quality}`;
    return `  ${label}  ${route.sessions} session(s)\n` +
      renderHumanLossFindings(route.findings);
  }).join("")}`;
  const workspaceHuman = `Workspace paths:\n${renderBoundedHumanDetails(
    result.workspaces,
    (workspace) => {
      if (workspace.status === "mapped") {
        return `  ${colorizeHuman("> mapped", "info", color)}: ${workspace.source} -> ${workspace.target} ` +
          `(${workspace.sessions} session(s))\n`;
      }
      return `  ${colorizeHuman("= unchanged", "success", color)}: ${workspace.source} ` +
        `(${workspace.sessions} session(s))\n`;
    },
    "workspace",
  )}`;
  const resourceHuman = result.resources.length === 0 ? "" : `${result.resources.length} managed resource(s).\n`;
  const blockedHuman = result.blockedSessions.length === 0 ? "" : `Blocked sessions:\n${renderBoundedHumanDetails(
    result.blockedSessions,
    (session) => `  ${session.sourceSessionRef}  ` +
      `${agentLabel(session.sourceAgent)} -> ${agentLabel(session.targetAgent)}\n` +
      renderHumanLossFindings(session.findings),
    "blocked session",
  )}\n`;
  const summaryHuman = result.status === "blocked"
    ? `Blocked          ${result.blocked}\n\nNo changes written.\n`
    : result.mode === "dry_run"
      ? `Would import     ${result.newSessions} new\nAlready present  ${result.alreadyPresent}\n` +
        `Blocked          0\n\nNo changes written.\n`
      : `Imported         ${result.written} new\nAlready present  ${result.alreadyPresent}\nBlocked          0\n`;
  const transactionHuman = result.mode !== "apply" || result.status !== "completed"
    ? ""
    : result.agents.flatMap((agentResult) => agentResult.transactionRef === undefined
      ? []
      : [`  ${agentLabel(agentResult.agent)}  ${agentResult.transactionRef}\n`]).join("");
  return `${heading}\n\nArchive       ${file}\nSelected      ${result.selectedSessions} sessions\n\n` +
    `${routeHuman}\n${workspaceHuman}\n${resourceHuman}${blockedHuman}${summaryHuman}` +
    (transactionHuman === "" ? "" : `\nTransactions:\n${transactionHuman}`);
}

export async function runExport(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  const agents = new Set<Agent>();
  const sessions: string[] = [];
  let output: string | undefined;
  for (let index = 0; index < args.length;) {
    const argument = args[index]!;
    if (argument === "--agent" || argument.startsWith("--agent=")) {
      const [value, next] = readValue(args, index, "--agent");
      agents.add(parseAgent(value));
      index = next;
      continue;
    }
    if (argument === "--session" || argument.startsWith("--session=")) {
      const [value, next] = readValue(args, index, "--session");
      sessions.push(value);
      index = next;
      continue;
    }
    if (argument === "-o" || argument === "--output" || argument.startsWith("--output=")) {
      const [value, next] = readValue(args, index, "--output");
      output = value;
      index = next;
      continue;
    }
    throw invalidArguments(`unknown export flag: ${argument}`);
  }
  const result = await exportHistory({
    stateDirectory: globals.stateDirectory,
    cwd: runtime.cwd ?? process.cwd(),
    sessions,
    ...(agents.size === 0 ? {} : { agents: [...agents] }),
    ...(output === undefined ? {} : { output }),
  });
  return success(
    "export",
    {
      file: result.file,
      size_bytes: result.sizeBytes,
      sha256: result.sha256,
      entries: result.entries,
      agents: result.agents,
      objects: result.objects,
      resources: result.resources,
    },
    `Exported ${result.entries} session(s) to ${result.file}\n` +
      result.agents.map((item) => `  ${item.agent}  ${item.sessions} session(s)\n`).join(""),
    globals.json,
  );
}

export async function runInspect(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  const file = args[0];
  if (file === undefined || file.startsWith("--")) throw invalidArguments("inspect requires one .agenthist file");
  const agents = new Set<Agent>();
  const sessions: string[] = [];
  let limit: number | undefined;
  let cursor: string | undefined;
  for (let index = 1; index < args.length;) {
    const argument = args[index]!;
    if (argument === "--agent" || argument.startsWith("--agent=")) {
      const [value, next] = readValue(args, index, "--agent");
      agents.add(parseAgent(value));
      index = next;
      continue;
    }
    if (argument === "--session" || argument.startsWith("--session=")) {
      const [value, next] = readValue(args, index, "--session");
      sessions.push(value);
      index = next;
      continue;
    }
    if (argument === "--limit" || argument.startsWith("--limit=")) {
      if (limit !== undefined) throw invalidArguments("inspect accepts one --limit value");
      const [value, next] = readValue(args, index, "--limit");
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > MAX_INSPECT_LIMIT) {
        throw invalidArguments(`inspect limit must be between 1 and ${MAX_INSPECT_LIMIT}`);
      }
      limit = Number(value);
      index = next;
      continue;
    }
    if (argument === "--cursor" || argument.startsWith("--cursor=")) {
      if (cursor !== undefined) throw invalidArguments("inspect accepts one --cursor value");
      [cursor, index] = readValue(args, index, "--cursor");
      continue;
    }
    throw invalidArguments(`unknown inspect flag: ${argument}`);
  }
  const result = await inspectHistoryArchive(path.resolve(runtime.cwd ?? process.cwd(), file), {
    sessions,
    ...(agents.size === 0 ? {} : { agents: [...agents] }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const entries = result.entries.map((entry) => ({
    session_ref: entry.sessionRef,
    agent: entry.agent,
    title: entry.title,
    context: entry.context,
    native_archived: entry.nativeArchived,
    library_state: entry.libraryState,
    tags: entry.tags,
    objects: entry.objects,
    resource_count: entry.resources.length,
    resources: entry.resources.map((resource) => ({
      sha256: resource.sha256,
      size_bytes: resource.sizeBytes,
      media_type: resource.mediaType,
      name: resource.name,
      source: resource.sourceReference,
      relative_path: resource.relativePath,
      disposition: "exact",
    })),
  }));
  const humanEntries = entries.map((entry) => {
    return `${entry.session_ref}  ${entry.agent}  ${entry.title || "(untitled)"}\n`;
  }).join("");
  const workspaceHuman = `Workspaces:\n${renderBoundedHumanDetails(
    result.workspaces,
    (workspace) => `  ${workspace.source}  ${workspace.sessions} session(s)  ${workspace.agents.join(",")}\n`,
    "workspace",
  )}`;
  const human = `${workspaceHuman}${humanEntries}${result.returnedEntries} of ${result.totalEntries} session(s); ` +
    `${result.remainingEntries} remaining.\n` +
    (result.nextCursor === undefined ? "" : `next cursor: ${result.nextCursor}\n`);
  return success(
    "inspect",
    {
      file: result.file,
      size_bytes: result.sizeBytes,
      sha256: result.sha256,
      entries,
      workspaces: result.workspaces.map((workspace) => ({
        source: workspace.source,
        agents: workspace.agents,
        sessions: workspace.sessions,
      })),
      total_entries: result.totalEntries,
      returned_entries: result.returnedEntries,
      remaining_entries: result.remainingEntries,
      resources: result.totalResources,
      ...(result.nextCursor === undefined ? {} : { next_cursor: result.nextCursor }),
    },
    human,
    globals.json,
  );
}

export async function runImport(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  const file = args[0];
  if (file === undefined || file.startsWith("--")) throw invalidArguments("import requires one .agenthist file");
  let mode: "dry_run" | "apply" | undefined;
  let targetAgent: Agent | undefined;
  let targetCodexHome: string | undefined;
  let targetOpenCodeRoot: string | undefined;
  let targetClaudeRoot: string | undefined;
  let targetPiRoot: string | undefined;
  let providerPolicy = "current";
  let providerPolicyExplicit = false;
  let language: ImportWizardLanguage | undefined;
  const agents = new Set<Agent>();
  const sessions: string[] = [];
  const pathMappings: string[] = [];
  for (let index = 1; index < args.length;) {
    const argument = args[index]!;
    if (argument === "--dry-run" || argument === "--apply") {
      const candidate = argument === "--apply" ? "apply" : "dry_run";
      if (mode !== undefined) throw invalidArguments("import accepts exactly one of --dry-run or --apply");
      mode = candidate;
      index++;
      continue;
    }
    if (argument === "--to" || argument.startsWith("--to=")) {
      const [value, next] = readValue(args, index, "--to");
      if (targetAgent !== undefined) throw invalidArguments("import accepts one --to value");
      targetAgent = parseAgent(value);
      index = next;
      continue;
    }
    if (argument === "--agent" || argument.startsWith("--agent=")) {
      const [value, next] = readValue(args, index, "--agent");
      agents.add(parseAgent(value));
      index = next;
      continue;
    }
    if (argument === "--session" || argument.startsWith("--session=")) {
      const [value, next] = readValue(args, index, "--session");
      sessions.push(value);
      index = next;
      continue;
    }
    if (argument === "--target" || argument.startsWith("--target=")) {
      const [value, next] = readValue(args, index, "--target");
      const separator = value.indexOf("=");
      const targetToken = separator < 1 ? "" : value.slice(0, separator);
      const candidate = value.slice(separator + 1);
      if (targetToken === "" || candidate === "") {
        throw invalidArguments(
          `import target must use --target <${AGENTS.join("|")}>=/path`,
        );
      }
      const targetAgent = parseAgent(targetToken);
      if (targetAgent === "codex") {
        if (targetCodexHome !== undefined &&
          !samePath(path.resolve(targetCodexHome), path.resolve(candidate), pathFlavorForPlatform())) {
          throw invalidArguments("Codex import target is ambiguous");
        }
        targetCodexHome = candidate;
      } else if (targetAgent === "opencode") {
        if (targetOpenCodeRoot !== undefined &&
          !samePath(path.resolve(targetOpenCodeRoot), path.resolve(candidate), pathFlavorForPlatform())) {
          throw invalidArguments("OpenCode import target is ambiguous");
        }
        targetOpenCodeRoot = candidate;
      } else if (targetAgent === "claude") {
        if (targetClaudeRoot !== undefined &&
          !samePath(path.resolve(targetClaudeRoot), path.resolve(candidate), pathFlavorForPlatform())) {
          throw invalidArguments("Claude Code import target is ambiguous");
        }
        targetClaudeRoot = candidate;
      } else {
        if (targetPiRoot !== undefined &&
          !samePath(path.resolve(targetPiRoot), path.resolve(candidate), pathFlavorForPlatform())) {
          throw invalidArguments("Pi import target is ambiguous");
        }
        targetPiRoot = candidate;
      }
      index = next;
      continue;
    }
    if (argument === "--map-path" || argument.startsWith("--map-path=")) {
      const [value, next] = readValue(args, index, "--map-path");
      pathMappings.push(value);
      index = next;
      continue;
    }
    if (argument === "--codex-provider" || argument.startsWith("--codex-provider=")) {
      const [value, next] = readValue(args, index, "--codex-provider");
      providerPolicy = value;
      providerPolicyExplicit = true;
      index = next;
      continue;
    }
    if (argument === "--language" || argument.startsWith("--language=")) {
      if (language !== undefined) throw invalidArguments("import accepts one --language value");
      const [value, next] = readValue(args, index, "--language");
      if (value !== "en" && value !== "zh") {
        throw invalidArguments("import language must be en or zh");
      }
      language = value;
      index = next;
      continue;
    }
    throw invalidArguments(`unknown import flag: ${argument}`);
  }
  if (mode !== undefined && language !== undefined) {
    throw invalidArguments("--language is only available for interactive import");
  }
  if (
    globals.codexHome !== undefined && targetCodexHome !== undefined &&
    !samePath(path.resolve(globals.codexHome), path.resolve(targetCodexHome), pathFlavorForPlatform())
  ) throw invalidArguments("--codex-home and --target select different Codex homes");
  if (
    globals.opencodeDataRoot !== undefined && targetOpenCodeRoot !== undefined &&
    !samePath(path.resolve(globals.opencodeDataRoot), path.resolve(targetOpenCodeRoot), pathFlavorForPlatform())
  ) throw invalidArguments("--opencode-data-root and --target select different OpenCode data roots");
  if (
    globals.claudeConfigRoot !== undefined && targetClaudeRoot !== undefined &&
    !samePath(path.resolve(globals.claudeConfigRoot), path.resolve(targetClaudeRoot), pathFlavorForPlatform())
  ) throw invalidArguments("--claude-config-dir and --target select different Claude Code config roots");
  if (
    globals.piSessionRoot !== undefined && targetPiRoot !== undefined &&
    !samePath(path.resolve(globals.piSessionRoot), path.resolve(targetPiRoot), pathFlavorForPlatform())
  ) throw invalidArguments("--pi-session-dir and --target select different Pi session roots");
  const environment = runtime.environment ?? process.env;
  const cwd = runtime.cwd ?? process.cwd();
  const home = runtime.home ?? environment.HOME ?? homedir();
  const codexHome = targetCodexHome ?? globals.codexHome;
  const opencodeDataRoot = targetOpenCodeRoot ?? globals.opencodeDataRoot;
  const claudeConfigRoot = targetClaudeRoot ?? globals.claudeConfigRoot;
  const piSessionRoot = targetPiRoot ?? globals.piSessionRoot;
  const executeImport = (
    selectedMode: "dry_run" | "apply",
    wizardRequest?: ImportWizardRequest,
  ): Promise<ImportHistoryResult> => importHistoryArchive({
    file,
    stateDirectory: globals.stateDirectory,
    mode: selectedMode,
    sessions: wizardRequest?.sessions ?? sessions,
    pathMappings: wizardRequest?.pathMappings ?? pathMappings,
    ...(wizardRequest === undefined
      ? targetAgent === undefined ? {} : { targetAgent }
      : { sessionTargets: wizardRequest.sessionTargets }),
    ...(wizardRequest === undefined
      ? providerPolicyExplicit ? { providerPolicy } : {}
      : Object.values(wizardRequest.sessionTargets).includes("codex") || providerPolicyExplicit
        ? { providerPolicy: wizardRequest.providerPolicy }
        : {}),
    ...(agents.size === 0 ? {} : { agents: [...agents] }),
    environment,
    cwd,
    home,
    ...((wizardRequest?.codexHome ?? codexHome) === undefined
      ? {}
      : { codexHome: wizardRequest?.codexHome ?? codexHome }),
    ...((wizardRequest?.opencodeDataRoot ?? opencodeDataRoot) === undefined
      ? {}
      : { opencodeDataRoot: wizardRequest?.opencodeDataRoot ?? opencodeDataRoot }),
    ...((wizardRequest?.claudeConfigRoot ?? claudeConfigRoot) === undefined
      ? {}
      : { claudeConfigRoot: wizardRequest?.claudeConfigRoot ?? claudeConfigRoot }),
    ...((wizardRequest?.piSessionRoot ?? piSessionRoot) === undefined
      ? {}
      : { piSessionRoot: wizardRequest?.piSessionRoot ?? piSessionRoot }),
    ...(globals.opencodeDatabase === undefined ? {} : { opencodeDatabase: globals.opencodeDatabase }),
    ...(globals.sqliteHome === undefined ? {} : { sqliteHome: globals.sqliteHome }),
    ...(globals.profile === undefined ? {} : { profile: globals.profile }),
  });

  let result: ImportHistoryResult;
  if (mode === undefined) {
    if (
      globals.json || runtime.input?.isTTY !== true || runtime.output?.isTTY !== true
    ) throw invalidArguments("interactive import requires a terminal; use --dry-run or --apply");
    const catalog = await openImportCatalog(file, cwd);
    try {
      const outcome = await runImportWizard({
        catalog,
        input: runtime.input,
        output: runtime.output,
        ...(agents.size === 0 ? {} : { agents: [...agents] }),
        sessions,
        ...(targetAgent === undefined ? {} : { targetAgent }),
        pathMappings,
        providerPolicy,
        language: language ?? detectImportWizardLanguage(environment),
        color: runtime.color === true,
        resolveCodexCurrentProvider: () => resolveCodexCurrentProvider({
          environment,
          cwd,
          home,
          ...(codexHome === undefined ? {} : { codexHome }),
          ...(globals.sqliteHome === undefined ? {} : { sqliteHome: globals.sqliteHome }),
          ...(globals.profile === undefined ? {} : { profile: globals.profile }),
        }),
        listCodexProviders: async () => {
          const result = await listCodexImportProviders({
            environment,
            cwd,
            home,
            ...(codexHome === undefined ? {} : { codexHome }),
            ...(globals.sqliteHome === undefined ? {} : { sqliteHome: globals.sqliteHome }),
            ...(globals.profile === undefined ? {} : { profile: globals.profile }),
          });
          return result.providers;
        },
        ...(codexHome === undefined ? {} : { codexHome }),
        ...(opencodeDataRoot === undefined ? {} : { opencodeDataRoot }),
        ...(claudeConfigRoot === undefined ? {} : { claudeConfigRoot }),
        ...(piSessionRoot === undefined ? {} : { piSessionRoot }),
        execute: executeImport,
      });
      if (outcome.status === "cancelled") {
        return success(
          "import",
          { status: "cancelled", written: 0 },
          "Import cancelled.\nNo changes written.\n",
          false,
        );
      }
      result = outcome.result;
    } finally {
      await catalog.close();
    }
  } else {
    result = await executeImport(mode);
  }
  const data = {
    mode: result.mode,
    status: result.status,
    selected_sessions: result.selectedSessions,
    new_sessions: result.newSessions,
    written: result.written,
    already_present: result.alreadyPresent,
    blocked: result.blocked,
    blocked_sessions: result.blockedSessions.map((session) => ({
      source_agent: session.sourceAgent,
      target_agent: session.targetAgent,
      source_session_ref: session.sourceSessionRef,
      findings: session.findings,
    })),
    routes: result.routes.map((route) => ({
      source_agent: route.sourceAgent,
      target_agent: route.targetAgent,
      quality: route.quality,
      sessions: route.sessions,
      findings: route.findings,
    })),
    agents: result.agents.map((agentResult) => ({
      agent: agentResult.agent,
      target: {
        root: agentResult.target.root,
        ...(agentResult.target.databaseRoot === undefined
          ? {}
          : { database_root: agentResult.target.databaseRoot }),
        ...(agentResult.target.database === undefined ? {} : { database: agentResult.target.database }),
      },
      new_sessions: agentResult.newSessions,
      written: agentResult.written,
      already_present: agentResult.alreadyPresent,
      ...(agentResult.transactionRef === undefined ? {} : { transaction_ref: agentResult.transactionRef }),
    })),
    workspaces: result.workspaces.map((workspace) => ({
      source: workspace.source,
      target: workspace.target,
      status: workspace.status,
      agents: workspace.agents,
      sessions: workspace.sessions,
    })),
    resources: result.resources.map((resource) => ({
      agent: resource.agent,
      session_refs: resource.sessionRefs,
      sha256: resource.sha256,
      size_bytes: resource.sizeBytes,
      media_type: resource.mediaType,
      name: resource.name,
      source: resource.sourceReference,
      relative_path: resource.relativePath,
      materialized_path: resource.materializedPath,
      classification: resource.classification,
      ...(resource.reason === undefined ? {} : { reason: resource.reason }),
    })),
    items: result.items.map((item) => ({
      source_agent: item.sourceAgent,
      target_agent: item.targetAgent,
      source_session_ref: item.sourceSessionRef,
      target_session_ref: item.targetSessionRef,
      quality: item.quality,
      findings: item.findings,
      classification: item.classification,
      destination: item.destination,
      provider: item.provider,
      source_cwd: item.sourceCwd,
      cwd: item.cwd,
      workspace_status: item.workspaceStatus,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    })),
    transactions: result.agents.flatMap((agentResult) => agentResult.transactionRef === undefined ? [] : [{
      agent: agentResult.agent,
      transaction_ref: agentResult.transactionRef,
    }]),
  };
  return success(
    "import",
    data,
    renderImportHuman(file, result, runtime.color === true),
    globals.json,
    result.status === "blocked" ? 3 : 0,
  );
}
