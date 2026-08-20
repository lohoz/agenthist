import type {
  AgentSourceOptions,
  HistorySourceInspection,
  HistorySourceLocation,
  HistorySourceLocationRole,
  HistorySourceStatus,
} from "../agents/contracts.js";
import { agentAdapter } from "../agents/registry.js";
import { selectAgents, type Agent } from "../domain/agent.js";
import { ensureStateDirectory } from "../infrastructure/history-store.js";
import { withStateWriteLock } from "../infrastructure/state.js";
import { assertNoPendingTransactions } from "../infrastructure/transaction-store.js";

export type {
  HistorySourceInspection,
  HistorySourceLocation,
  HistorySourceLocationRole,
  HistorySourceStatus,
} from "../agents/contracts.js";

export interface HistorySourceInspectionResult {
  readonly schemaVersion: "agenthist.doctor/v1";
  readonly status: HistorySourceStatus;
  readonly agents: readonly HistorySourceInspection[];
}

export interface HistorySourceContext {
  readonly cwd?: string;
  readonly home?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CodexHistorySourceOptions extends HistorySourceContext {
  readonly codexHome?: string;
  readonly sqliteHome?: string;
  readonly profile?: string;
}

export interface OpenCodeHistorySourceOptions extends HistorySourceContext {
  readonly dataRoot?: string;
  readonly databasePath?: string;
}

export interface ClaudeHistorySourceOptions extends HistorySourceContext {
  readonly configRoot?: string;
}

export interface PiHistorySourceOptions extends HistorySourceContext {
  readonly sessionRoot?: string;
}

export interface HistorySourceOptions {
  readonly agents?: readonly Agent[];
  readonly codex?: CodexHistorySourceOptions;
  readonly opencode?: OpenCodeHistorySourceOptions;
  readonly claude?: ClaudeHistorySourceOptions;
  readonly pi?: PiHistorySourceOptions;
}

export interface ScannedHistoryAgent {
  readonly agent: Agent;
  readonly sessions: number;
  readonly reusedSessions: number;
  readonly rebuiltSessions: number;
  readonly removedSessions: number;
  readonly warnings: readonly string[];
}

export interface ScanHistoryResult {
  readonly status: "scanned" | "not_detected";
  readonly stateDirectory: string;
  readonly inspections: readonly HistorySourceInspection[];
  readonly agents: readonly ScannedHistoryAgent[];
  readonly sessions: number;
  readonly warnings: readonly string[];
}

export type ScanHistoryProgress =
  | { readonly phase: "detecting" }
  | { readonly phase: "preparing"; readonly totalAgents: number }
  | {
      readonly phase: "scanning";
      readonly agent: Agent;
      readonly currentAgent: number;
      readonly totalAgents: number;
    };

export interface ScanHistoryOptions extends HistorySourceOptions {
  readonly stateDirectory: string;
  readonly onProgress?: (progress: ScanHistoryProgress) => void;
}

function sourceOptions(options: HistorySourceOptions, agent: Agent): AgentSourceOptions {
  const codex = options.codex ?? {};
  const opencode = options.opencode ?? {};
  const claude = options.claude ?? {};
  const pi = options.pi ?? {};
  const byAgent: Readonly<Record<Agent, AgentSourceOptions>> = {
    codex: {
      ...(codex.codexHome === undefined ? {} : { historyRoot: codex.codexHome }),
      ...(codex.sqliteHome === undefined ? {} : { nativeStateRoot: codex.sqliteHome }),
      ...(codex.profile === undefined ? {} : { profile: codex.profile }),
      ...(codex.cwd === undefined ? {} : { cwd: codex.cwd }),
      ...(codex.home === undefined ? {} : { home: codex.home }),
      ...(codex.environment === undefined ? {} : { environment: codex.environment }),
    },
    opencode: {
      ...(opencode.dataRoot === undefined ? {} : { historyRoot: opencode.dataRoot }),
      ...(opencode.databasePath === undefined ? {} : { databasePath: opencode.databasePath }),
      ...(opencode.cwd === undefined ? {} : { cwd: opencode.cwd }),
      ...(opencode.home === undefined ? {} : { home: opencode.home }),
      ...(opencode.environment === undefined ? {} : { environment: opencode.environment }),
    },
    claude: {
      ...(claude.configRoot === undefined ? {} : { historyRoot: claude.configRoot }),
      ...(claude.cwd === undefined ? {} : { cwd: claude.cwd }),
      ...(claude.home === undefined ? {} : { home: claude.home }),
      ...(claude.environment === undefined ? {} : { environment: claude.environment }),
    },
    pi: {
      ...(pi.sessionRoot === undefined ? {} : { historyRoot: pi.sessionRoot }),
      ...(pi.cwd === undefined ? {} : { cwd: pi.cwd }),
      ...(pi.home === undefined ? {} : { home: pi.home }),
      ...(pi.environment === undefined ? {} : { environment: pi.environment }),
    },
  };
  return byAgent[agent];
}

function aggregate(agents: readonly HistorySourceInspection[]): HistorySourceStatus {
  let status: HistorySourceStatus = "not_detected";
  for (const agent of agents) {
    if (agent.status === "error") return "error";
    if (agent.status === "blocked") status = "blocked";
    else if (agent.status === "ready" && status === "not_detected") status = "ready";
  }
  return status;
}

async function detect(options: HistorySourceOptions): Promise<HistorySourceInspectionResult> {
  const selected = selectAgents(options.agents ?? []);
  const agents: HistorySourceInspection[] = [];
  for (const agent of selected) {
    agents.push(await agentAdapter(agent).source.detect(sourceOptions(options, agent)));
  }
  return { schemaVersion: "agenthist.doctor/v1", status: aggregate(agents), agents };
}

export async function detectHistorySources(options: HistorySourceOptions): Promise<HistorySourceInspectionResult> {
  return detect(options);
}

export async function inspectHistorySources(options: HistorySourceOptions): Promise<HistorySourceInspectionResult> {
  const agents: HistorySourceInspection[] = [];
  for (const agent of selectAgents(options.agents ?? [])) {
    agents.push(await agentAdapter(agent).source.inspect(sourceOptions(options, agent)));
  }
  return { schemaVersion: "agenthist.doctor/v1", status: aggregate(agents), agents };
}

async function scanSourceRoots(options: ScanHistoryOptions, selected: readonly Agent[]): Promise<readonly string[]> {
  const roots: string[] = [];
  for (const agent of selected) {
    roots.push(...await agentAdapter(agent).source.roots(sourceOptions(options, agent)));
  }
  return roots;
}

export async function scanHistory(options: ScanHistoryOptions): Promise<ScanHistoryResult> {
  await assertNoPendingTransactions(options.stateDirectory);
  let selected = selectAgents(options.agents ?? []);
  let inspections: readonly HistorySourceInspection[] = [];
  if (options.agents === undefined || options.agents.length === 0) {
    options.onProgress?.({ phase: "detecting" });
    const detected = await detect(options);
    inspections = detected.agents;
    const failure = detected.agents.find((agent) => agent.status === "error" || agent.status === "blocked");
    if (failure !== undefined) {
      throw new Error(
        `${failure.agent} history source is ${failure.status}: ${failure.detail ?? failure.findings[0]}`,
      );
    }
    selected = detected.agents.filter((agent) => agent.status === "ready").map((agent) => agent.agent);
    if (selected.length === 0) {
      return {
        status: "not_detected",
        stateDirectory: options.stateDirectory,
        inspections,
        agents: [],
        sessions: 0,
        warnings: [],
      };
    }
  }

  options.onProgress?.({ phase: "preparing", totalAgents: selected.length });
  await ensureStateDirectory(options.stateDirectory, await scanSourceRoots(options, selected));
  return withStateWriteLock(options.stateDirectory, async () => {
    await assertNoPendingTransactions(options.stateDirectory);
    const agents: ScannedHistoryAgent[] = [];
    for (const [index, agent] of selected.entries()) {
      options.onProgress?.({
        phase: "scanning",
        agent,
        currentAgent: index + 1,
        totalAgents: selected.length,
      });
      const snapshot = await agentAdapter(agent).source.scan({
        stateDirectory: options.stateDirectory,
        ...sourceOptions(options, agent),
      });
      agents.push({
        agent,
        sessions: snapshot.sessions.length,
        reusedSessions: snapshot.scan?.reusedSessions ?? 0,
        rebuiltSessions: snapshot.scan?.rebuiltSessions ?? snapshot.sessions.length,
        removedSessions: snapshot.scan?.removedSessions ?? 0,
        warnings: snapshot.warnings,
      });
    }
    return {
      status: "scanned",
      stateDirectory: options.stateDirectory,
      inspections,
      agents,
      sessions: agents.reduce((sum, item) => sum + item.sessions, 0),
      warnings: agents.flatMap((item) => item.warnings),
    };
  });
}
