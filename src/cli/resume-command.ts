import { homedir } from "node:os";

import {
  AGENTS,
  agentLabel,
  findExistingHistoryTransfer,
  openHistoryCatalog,
  prepareResumeLaunch,
  scanHistory,
  transferHistorySession,
  type Agent,
  type HistoryCatalogEntry,
  type HistorySelectionCatalog,
} from "../application/index.js";
import { sessionAgent } from "../domain/history.js";
import { pathFlavorForPlatform, samePath } from "../domain/host-path.js";
import {
  ensureAgentProcessAvailable,
  runAgentProcess,
} from "../infrastructure/agent-process.js";
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
import { humanFields, humanTitle } from "./human-output.js";
import { refreshDetectedHistory } from "./history-refresh.js";
import { withLiveStatus } from "./live-status.js";
import { runResumeWizard, type ResumeWizardRequest } from "./resume-wizard.js";
import { historySourceOptions } from "./source-options.js";

interface ResumeFlags {
  readonly last: boolean;
  readonly sessionRef?: string;
  readonly targetAgent?: Agent;
}

function parseResumeFlags(args: readonly string[]): ResumeFlags {
  let last = false;
  let sessionRef: string | undefined;
  let targetAgent: Agent | undefined;
  for (let index = 0; index < args.length;) {
    const argument = args[index]!;
    if (argument === "--last") {
      if (last) throw invalidArguments("resume accepts --last once");
      last = true;
      index++;
      continue;
    }
    if (argument === "--session" || argument.startsWith("--session=")) {
      if (sessionRef !== undefined) throw invalidArguments("resume accepts one --session value");
      [sessionRef, index] = readValue(args, index, "--session");
      continue;
    }
    if (argument === "--agent" || argument.startsWith("--agent=")) {
      if (targetAgent !== undefined) throw invalidArguments("resume accepts one --agent value");
      const [value, next] = readValue(args, index, "--agent");
      targetAgent = parseAgent(value);
      index = next;
      continue;
    }
    throw invalidArguments(`unknown resume flag: ${argument}`);
  }
  if (last && sessionRef !== undefined) throw invalidArguments("resume cannot combine --last and --session");
  return {
    last,
    ...(sessionRef === undefined ? {} : { sessionRef }),
    ...(targetAgent === undefined ? {} : { targetAgent }),
  };
}

function activeCatalog(catalog: HistorySelectionCatalog): HistorySelectionCatalog {
  const entries = catalog.entries.filter((entry) => entry.libraryState === "active");
  if (entries.length === 0) throw new Error("no active history sessions are available to resume");
  const visible = new Set(entries.map((entry) => entry.sessionRef));
  return {
    entries,
    closeSelection(sessionRefs) {
      const missing = sessionRefs.find((sessionRef) => !visible.has(sessionRef));
      if (missing !== undefined) throw new Error(`active history session was not found: ${missing}`);
      return catalog.closeSelection(sessionRefs);
    },
    preview: (sessionRef) => catalog.preview(sessionRef),
  };
}

function latestSession(catalog: HistorySelectionCatalog, cwd: string): HistoryCatalogEntry {
  return catalog.entries.find((entry) => samePath(entry.workspace, cwd, pathFlavorForPlatform())) ?? catalog.entries[0]!;
}

function transferOptions(
  globals: GlobalOptions,
  runtime: CliRuntime,
  request: ResumeWizardRequest,
  mode: "dry_run" | "apply",
) {
  const environment = runtime.environment ?? process.env;
  const cwd = runtime.cwd ?? process.cwd();
  const home = runtime.home ?? environment.HOME ?? homedir();
  return {
    stateDirectory: globals.stateDirectory,
    sessionRef: request.session.sessionRef,
    targetAgent: request.targetAgent,
    mode,
    pathMappings: request.pathMappings,
    environment,
    cwd,
    home,
    ...(globals.codexHome === undefined ? {} : { codexHome: globals.codexHome }),
    ...(globals.sqliteHome === undefined ? {} : { sqliteHome: globals.sqliteHome }),
    ...(globals.profile === undefined ? {} : { profile: globals.profile }),
    ...(globals.opencodeDataRoot === undefined ? {} : { opencodeDataRoot: globals.opencodeDataRoot }),
    ...(globals.opencodeDatabase === undefined ? {} : { opencodeDatabase: globals.opencodeDatabase }),
    ...(globals.claudeConfigRoot === undefined ? {} : { claudeConfigRoot: globals.claudeConfigRoot }),
    ...(globals.piSessionRoot === undefined ? {} : { piSessionRoot: globals.piSessionRoot }),
  };
}

export async function runResume(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  if (globals.json) throw invalidArguments("resume is interactive and does not support --json");
  if (runtime.input?.isTTY !== true || runtime.output?.isTTY !== true) {
    throw invalidArguments("resume requires an interactive terminal");
  }
  const flags = parseResumeFlags(args);
  const sourceAgent = flags.sessionRef === undefined ? undefined : sessionAgent(flags.sessionRef);
  if (flags.sessionRef !== undefined && sourceAgent === undefined) {
    throw invalidArguments(`invalid AgentHist session reference: ${flags.sessionRef}`);
  }
  const refreshAgents = sourceAgent === undefined
    ? undefined
    : [...new Set([sourceAgent, flags.targetAgent].filter((agent): agent is Agent => agent !== undefined))];
  const refreshLabel = refreshAgents === undefined
    ? "Agent history"
    : refreshAgents.length === 1 ? `${agentLabel(refreshAgents[0]!)} history` : "selected Agent history";
  await withLiveStatus(runtime, globals, `Refreshing ${refreshLabel}`, async (status) => {
    status.update(`Refreshing detected ${refreshLabel}`);
    await refreshDetectedHistory(globals, runtime, refreshAgents ?? AGENTS);
  });
  const completeCatalog = await openHistoryCatalog(globals.stateDirectory);
  const catalog = flags.sessionRef === undefined ? activeCatalog(completeCatalog) : completeCatalog;
  const cwd = runtime.cwd ?? process.cwd();
  const sessionRef = flags.sessionRef ?? (flags.last ? latestSession(catalog, cwd).sessionRef : undefined);
  const outcome = await runResumeWizard({
    catalog,
    input: runtime.input,
    output: runtime.output,
    cwd,
    ...(sessionRef === undefined ? {} : { sessionRef }),
    ...(flags.targetAgent === undefined ? {} : { targetAgent: flags.targetAgent }),
    color: globals.color,
    ensureTargetAvailable: async (request, targetCwd) => {
      const launch = prepareResumeLaunch({
        agent: request.targetAgent,
        nativeId: request.session.nativeId,
        cwd: targetCwd,
      });
      const checker = runtime.agentProcessAvailabilityChecker ?? ensureAgentProcessAvailable;
      await checker(launch, runtime.environment ?? process.env);
    },
    findExistingTarget: (request) => findExistingHistoryTransfer(
      transferOptions(globals, runtime, request, "dry_run"),
    ),
    execute: (mode, request) => transferHistorySession(transferOptions(globals, runtime, request, mode)),
  });
  if (outcome.status === "cancelled") {
    return success("resume", { status: "cancelled" }, "Resume cancelled.\n", false);
  }
  if (outcome.status === "blocked") {
    return success(
      "resume",
      { status: "blocked" },
      `${colorizeHuman("Conversion blocked", "error_strong", globals.color)} · No history was written.\n`,
      false,
      3,
    );
  }

  const imported = outcome.result?.items.find((item) =>
    item.sourceSessionRef === outcome.session.sessionRef && item.targetAgent === outcome.targetAgent);
  if (outcome.result !== undefined && imported === undefined) {
    throw new Error("resume import did not return the selected target session");
  }
  const nativeId = outcome.targetNativeId ?? imported?.targetNativeId ?? outcome.session.nativeId;
  const launchCwd = imported?.cwd ?? outcome.cwd;
  const launch = prepareResumeLaunch({ agent: outcome.targetAgent, nativeId, cwd: launchCwd });
  runtime.output.write(
    `\n${colorizeHuman("Opening", "info", globals.color)} ${agentLabel(outcome.targetAgent)} · ${outcome.session.title}\n`,
  );
  const runner = runtime.agentProcessRunner ?? runAgentProcess;
  const processResult = await runner(launch, runtime.environment ?? process.env);

  let refreshWarning: string | undefined;
  try {
    await withLiveStatus(runtime, globals, `Refreshing ${agentLabel(outcome.targetAgent)} history`, async () => {
      await scanHistory({
        ...historySourceOptions(globals, runtime, [outcome.targetAgent]),
        stateDirectory: globals.stateDirectory,
      });
    });
  } catch (error) {
    refreshWarning = error instanceof Error ? error.message : "unknown scan error";
  }
  const result = success(
    "resume",
    {
      status: processResult.exitCode === 0 ? "completed" : "agent_exited_nonzero",
      source_agent: outcome.session.agent,
      target_agent: outcome.targetAgent,
      source_session_ref: outcome.session.sessionRef,
      native_id: nativeId,
      cwd: launchCwd,
      reused_existing: outcome.reusedExisting === true,
      agent_exit_code: processResult.exitCode,
      refreshed: refreshWarning === undefined,
    },
    humanTitle("Conversation closed", globals.color) + "\n" + humanFields([
      { label: "Agent", value: agentLabel(outcome.targetAgent), tone: "info" },
      { label: "Session", value: outcome.session.title },
      { label: "Exit code", value: String(processResult.exitCode), tone: processResult.exitCode === 0 ? "success" : "warning" },
      { label: "History", value: refreshWarning === undefined ? "REFRESHED" : "REFRESH FAILED", tone: refreshWarning === undefined ? "success" : "warning" },
    ], globals.color) + "\n",
    false,
    processResult.exitCode,
  );
  return refreshWarning === undefined ? result : {
    ...result,
    stderr: `${colorizeHuman("warning:", "warning_strong", globals.color)} ${refreshWarning}\n`,
  };
}
