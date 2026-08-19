import path from "node:path";

import { AGENTS, type Agent } from "../domain/agent.js";
import {
  buildSessionExperienceIndex,
  DEFAULT_EXPERIENCE_MAX_DEEP_INPUT_TOKENS,
  DEFAULT_EXPERIENCE_MAX_INPUT_TOKENS,
  DEFAULT_EXPERIENCE_REQUEST_INPUT_TOKENS,
  EXPERIENCE_PARSER_VERSION,
  planExperienceBudget,
  resolveExperienceLineages,
  type DiscoveryCard,
  type SessionExperienceIndex,
} from "./corpus.js";
import { sourceRevision } from "../domain/history-identity.js";
import { libraryState, type AgentSnapshot, type StoredSession } from "../domain/history.js";
import { loadExperienceIndexes, saveExperienceIndexes } from "./store.js";
import { loadSnapshot } from "../infrastructure/history-store.js";
import { withStateWriteLock } from "../infrastructure/state.js";
import { assertNoPendingTransactions } from "../infrastructure/transaction-store.js";

export interface ExperienceDryRunOptions {
  readonly stateDirectory: string;
  readonly cwd?: string;
  readonly agents?: readonly Agent[];
  readonly workspaceDirectories?: readonly string[];
  readonly sessionRefs?: readonly string[];
  readonly allHistory?: boolean;
  readonly since?: string;
  readonly maximumInputTokens?: number;
  readonly maximumDeepInputTokens?: number;
  readonly requestInputTokens?: number;
}

export interface ExperienceWorkspaceSelection {
  readonly path: string;
  readonly sessions: number;
}

export interface ExperienceHistorySelection {
  readonly mode: "workspace" | "session" | "all";
  readonly defaultedToCurrentWorkspace: boolean;
  readonly workspaces: readonly ExperienceWorkspaceSelection[];
  readonly sessionRefs: readonly string[];
}

export interface ExperienceAgentCorpus {
  readonly agent: Agent;
  readonly snapshotId: string;
  readonly sessions: number;
  readonly beats: number;
  readonly cards: number;
}

export interface ExperienceCorpusProfile {
  readonly agents: readonly ExperienceAgentCorpus[];
  readonly sessions: number;
  readonly lineages: number;
  readonly projects: number;
  readonly beats: number;
  readonly cards: number;
  readonly queuedCards: number;
  readonly foldedDuplicateCards: number;
  readonly archivedSessions: number;
  readonly excludedDeletedSessions: number;
  readonly excludedOutsideSelectionSessions: number;
  readonly excludedBeforeSinceSessions: number;
  readonly duplicateSessions: number;
  readonly earliest?: string;
  readonly latest?: string;
}

export interface ExperienceIndexSummary {
  readonly parserVersion: string;
  readonly reusedSessions: number;
  readonly rebuiltSessions: number;
  readonly removedSessions: number;
}

export interface ExperienceDryRunResult {
  readonly dryRun: true;
  readonly selection: ExperienceHistorySelection;
  readonly corpus: ExperienceCorpusProfile;
  readonly index: ExperienceIndexSummary;
  readonly plan: {
    readonly totalCards: number;
    readonly selectedCards: number;
    readonly remainingCards: number;
    readonly estimatedFastInputTokens: number;
    readonly fastRequests: number;
    readonly deepInputTokensUpperBound: number;
    readonly deepRequestsUpperBound: number;
    readonly maximumInputTokens: number;
    readonly maximumDeepInputTokens: number;
    readonly requestInputTokens: number;
  };
  readonly model: {
    readonly configurationRead: false;
    readonly requests: 0;
  };
  readonly excludedContent: readonly string[];
}

export interface PreparedExperienceReviewInputs {
  readonly selection: ExperienceHistorySelection;
  readonly corpus: ExperienceCorpusProfile;
  readonly index: ExperienceIndexSummary;
  readonly routingCards: readonly DiscoveryCard[];
  readonly maximumInputTokens: number;
  readonly maximumDeepInputTokens: number;
  readonly requestInputTokens: number;
}

function selectedAgents(agents: readonly Agent[] | undefined): readonly Agent[] {
  if (agents === undefined || agents.length === 0) return AGENTS;
  const requested = new Set(agents);
  return AGENTS.filter((agent) => requested.has(agent));
}

interface ExperienceSelectionRequest {
  readonly mode: "workspace" | "session" | "all";
  readonly defaultedToCurrentWorkspace: boolean;
  readonly workspaces: readonly string[];
  readonly sessionRefs: readonly string[];
}

function selectionRequest(options: ExperienceDryRunOptions): ExperienceSelectionRequest {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspaces = [...new Set((options.workspaceDirectories ?? []).map((workspace) => {
    if (workspace === "" || workspace.includes("\0")) throw new Error("experience --workspace requires a valid path");
    return path.resolve(cwd, workspace);
  }))].sort();
  const sessionRefs = [...new Set(options.sessionRefs ?? [])].sort();
  const modes = Number(workspaces.length > 0) + Number(sessionRefs.length > 0) + Number(options.allHistory === true);
  if (modes > 1) throw new Error("experience selection accepts only one of --workspace, --session, or --all");
  if (options.allHistory === true) {
    return { mode: "all", defaultedToCurrentWorkspace: false, workspaces: [], sessionRefs: [] };
  }
  if (sessionRefs.length > 0) {
    return { mode: "session", defaultedToCurrentWorkspace: false, workspaces: [], sessionRefs };
  }
  return {
    mode: "workspace",
    defaultedToCurrentWorkspace: workspaces.length === 0,
    workspaces: workspaces.length === 0 ? [cwd] : workspaces,
    sessionRefs: [],
  };
}

function sessionInWorkspace(session: StoredSession, workspace: string): boolean {
  if (!path.isAbsolute(session.context)) return false;
  const relative = path.relative(workspace, path.normalize(session.context));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function selectExperienceSessions(
  eligible: readonly StoredSession[],
  request: ExperienceSelectionRequest,
  since: number | undefined,
): {
  readonly selected: readonly StoredSession[];
  readonly selection: ExperienceHistorySelection;
  readonly excludedOutsideSelectionSessions: number;
  readonly excludedBeforeSinceSessions: number;
} {
  const requestedRefs = new Set(request.sessionRefs);
  const scoped = request.mode === "all"
    ? eligible
    : request.mode === "session"
      ? eligible.filter((session) => requestedRefs.has(session.sessionRef))
      : eligible.filter((session) => request.workspaces.some((workspace) => sessionInWorkspace(session, workspace)));

  if (request.mode === "session") {
    const found = new Set(scoped.map((session) => session.sessionRef));
    const missing = request.sessionRefs.filter((reference) => !found.has(reference));
    if (missing.length > 0) {
      throw new Error(
        `experience --session did not match active or archived history selected by --agent: ${missing.join(", ")}`,
      );
    }
  }
  if (request.mode === "workspace") {
    const missing = request.workspaces.filter((workspace) =>
      !scoped.some((session) => sessionInWorkspace(session, workspace)));
    if (missing.length > 0) {
      throw new Error(
        `experience --workspace matched no active or archived scanned session: ${missing.map((item) => JSON.stringify(item)).join(", ")}`,
      );
    }
  }

  const selected = scoped.filter((session) => since === undefined || Date.parse(session.updatedAt) >= since);
  if (selected.length === 0) {
    throw new Error(since === undefined
      ? "experience history selection is empty"
      : "experience history selection is empty after --since");
  }
  if (since !== undefined && request.mode === "session") {
    const found = new Set(selected.map((session) => session.sessionRef));
    const excluded = request.sessionRefs.filter((reference) => !found.has(reference));
    if (excluded.length > 0) {
      throw new Error(`experience --since excluded requested session(s): ${excluded.join(", ")}`);
    }
  }
  if (since !== undefined && request.mode === "workspace") {
    const excluded = request.workspaces.filter((workspace) =>
      !selected.some((session) => sessionInWorkspace(session, workspace)));
    if (excluded.length > 0) {
      throw new Error(
        `experience --since excluded every session in workspace(s): ${excluded.map((item) => JSON.stringify(item)).join(", ")}`,
      );
    }
  }

  return {
    selected,
    selection: {
      mode: request.mode,
      defaultedToCurrentWorkspace: request.defaultedToCurrentWorkspace,
      workspaces: request.workspaces.map((workspace) => ({
        path: workspace,
        sessions: selected.filter((session) => sessionInWorkspace(session, workspace)).length,
      })),
      sessionRefs: request.sessionRefs,
    },
    excludedOutsideSelectionSessions: eligible.length - scoped.length,
    excludedBeforeSinceSessions: scoped.length - selected.length,
  };
}

function sinceInstant(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) throw new Error("experience --since must be an ISO date or timestamp");
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error("experience --since must be an ISO date or timestamp");
  return instant;
}

async function snapshots(stateDirectory: string, agents: readonly Agent[]): Promise<AgentSnapshot[]> {
  const result: AgentSnapshot[] = [];
  for (const agent of agents) {
    const snapshot = await loadSnapshot(stateDirectory, agent);
    if (snapshot === undefined) {
      if (agents.length !== AGENTS.length) throw new Error(`no scanned ${agent} history; run agenthist scan first`);
      continue;
    }
    result.push(snapshot);
  }
  if (result.length === 0) throw new Error("no scanned history; run agenthist scan first");
  return result;
}

function applyLineages(indexes: readonly SessionExperienceIndex[]): SessionExperienceIndex[] {
  const lineages = resolveExperienceLineages(indexes.map((index) => ({
    sessionRef: index.sessionRef,
    logicalDigest: index.logicalDigest,
    nativeRelationKeys: index.nativeRelationKeys,
  })));
  return indexes.map((index) => {
    const lineageRef = lineages.get(index.sessionRef);
    if (lineageRef === undefined) throw new Error("experience lineage assignment is incomplete");
    return {
      ...index,
      lineageRef,
      beats: index.beats.map((beat) => ({ ...beat, lineageRef })),
      cards: index.cards.map((card) => ({ ...card, lineageRef })),
    };
  });
}

function corpusProfile(
  snapshots: readonly AgentSnapshot[],
  selectedSessions: readonly StoredSession[],
  indexes: readonly SessionExperienceIndex[],
  queuedCards: number,
  excludedDeletedSessions: number,
  excludedOutsideSelectionSessions: number,
  excludedBeforeSinceSessions: number,
): ExperienceCorpusProfile {
  const timestamps = selectedSessions.flatMap((session) => {
    const instant = Date.parse(session.updatedAt);
    return Number.isFinite(instant) ? [session.updatedAt] : [];
  }).sort();
  const byRef = new Map(indexes.map((index) => [index.sessionRef, index]));
  const agents = snapshots.map((snapshot) => {
    const sessions = selectedSessions.filter((session) => session.agent === snapshot.agent);
    const agentIndexes = sessions.flatMap((session) => {
      const index = byRef.get(session.sessionRef);
      return index === undefined ? [] : [index];
    });
    return {
      agent: snapshot.agent,
      snapshotId: snapshot.snapshotId,
      sessions: sessions.length,
      beats: agentIndexes.reduce((total, index) => total + index.beats.length, 0),
      cards: agentIndexes.reduce((total, index) => total + index.cards.length, 0),
    };
  });
  const lineageCounts = new Map<string, number>();
  indexes.forEach((index) => {
    lineageCounts.set(index.lineageRef, (lineageCounts.get(index.lineageRef) ?? 0) + 1);
  });
  return {
    agents,
    sessions: selectedSessions.length,
    lineages: lineageCounts.size,
    projects: new Set(indexes.map((index) => index.projectKey)).size,
    beats: indexes.reduce((total, index) => total + index.beats.length, 0),
    cards: indexes.reduce((total, index) => total + index.cards.length, 0),
    queuedCards,
    foldedDuplicateCards: indexes.reduce((total, index) => total + index.cards.length, 0) - queuedCards,
    archivedSessions: selectedSessions.filter((session) => libraryState(session.library) === "archived").length,
    excludedDeletedSessions,
    excludedOutsideSelectionSessions,
    excludedBeforeSinceSessions,
    duplicateSessions: [...lineageCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    ...(timestamps.length === 0 ? {} : { earliest: timestamps[0]!, latest: timestamps.at(-1)! }),
  };
}

function lineageRepresentativeCards(indexes: readonly SessionExperienceIndex[]): DiscoveryCard[] {
  const byContent = new Map<string, DiscoveryCard>();
  for (const card of indexes.flatMap((index) => index.cards)) {
    const key = `${card.lineageRef}\0${card.contentDigest}`;
    const previous = byContent.get(key);
    if (previous === undefined || card.cardRef < previous.cardRef) byContent.set(key, card);
  }
  return [...byContent.values()];
}

export async function prepareExperienceReviewInputsUnlocked(
  options: ExperienceDryRunOptions,
): Promise<PreparedExperienceReviewInputs> {
  await assertNoPendingTransactions(options.stateDirectory);
  const agents = selectedAgents(options.agents);
  const currentSnapshots = await snapshots(options.stateDirectory, agents);
  const since = sinceInstant(options.since);
  const request = selectionRequest(options);
  const allSessions = currentSnapshots.flatMap((snapshot) => snapshot.sessions);
  const requestedRefs = new Set(request.sessionRefs);
  const inRequestedScope = (session: StoredSession): boolean => request.mode === "all" ||
    (request.mode === "session"
      ? requestedRefs.has(session.sessionRef)
      : request.workspaces.some((workspace) => sessionInWorkspace(session, workspace)));
  const excludedDeletedSessions = allSessions.filter((session) =>
    libraryState(session.library) === "deleted" && inRequestedScope(session)).length;
  const eligible = allSessions.filter((session) => libraryState(session.library) !== "deleted");
  const selectedHistory = selectExperienceSessions(eligible, request, since);
  const selected = selectedHistory.selected;

  const existing = new Map((await loadExperienceIndexes(options.stateDirectory)).map((index) => [index.sessionRef, index]));
  const snapshotByAgent = new Map(currentSnapshots.map((snapshot) => [snapshot.agent, snapshot]));
  let reusedSessions = 0;
  let rebuiltSessions = 0;
  const indexes = selected.map((session): SessionExperienceIndex => {
    const revision = sourceRevision(session);
    const cached = existing.get(session.sessionRef);
    if (cached !== undefined && cached.sourceRevision === revision && cached.parserVersion === EXPERIENCE_PARSER_VERSION) {
      reusedSessions++;
      return cached.snapshotId === snapshotByAgent.get(session.agent)!.snapshotId
        ? cached
        : { ...cached, snapshotId: snapshotByAgent.get(session.agent)!.snapshotId };
    }
    rebuiltSessions++;
    return buildSessionExperienceIndex(session, snapshotByAgent.get(session.agent)!.snapshotId, revision);
  });
  const resolved = applyLineages(indexes);
  const selectedIndexes = resolved;
  const representativeCards = lineageRepresentativeCards(selectedIndexes);
  const maximumInputTokens = options.maximumInputTokens ?? DEFAULT_EXPERIENCE_MAX_INPUT_TOKENS;
  const maximumDeepInputTokens = options.maximumDeepInputTokens ?? DEFAULT_EXPERIENCE_MAX_DEEP_INPUT_TOKENS;
  const requestInputTokens = options.requestInputTokens ?? DEFAULT_EXPERIENCE_REQUEST_INPUT_TOKENS;
  const removedSessions = await saveExperienceIndexes({
    stateDirectory: options.stateDirectory,
    scopeAgents: currentSnapshots.map((snapshot) => snapshot.agent),
    currentSessionRefs: eligible.map((session) => session.sessionRef),
    indexes,
  });
  return {
    selection: selectedHistory.selection,
    corpus: corpusProfile(
      currentSnapshots,
      selected,
      selectedIndexes,
      representativeCards.length,
      excludedDeletedSessions,
      selectedHistory.excludedOutsideSelectionSessions,
      selectedHistory.excludedBeforeSinceSessions,
    ),
    index: {
      parserVersion: EXPERIENCE_PARSER_VERSION,
      reusedSessions,
      rebuiltSessions,
      removedSessions,
    },
    routingCards: representativeCards,
    maximumInputTokens,
    maximumDeepInputTokens,
    requestInputTokens,
  };
}

export async function dryRunExperienceReview(options: ExperienceDryRunOptions): Promise<ExperienceDryRunResult> {
  return withStateWriteLock(options.stateDirectory, async () => {
    const prepared = await prepareExperienceReviewInputsUnlocked(options);
    const budget = planExperienceBudget(
      prepared.routingCards,
      prepared.maximumInputTokens,
      prepared.maximumDeepInputTokens,
      prepared.requestInputTokens,
    );
    return {
      dryRun: true,
      selection: prepared.selection,
      corpus: prepared.corpus,
      index: prepared.index,
      plan: {
        totalCards: budget.totalCards,
        selectedCards: budget.selectedCards,
        remainingCards: budget.remainingCards,
        estimatedFastInputTokens: budget.estimatedFastInputTokens,
        fastRequests: budget.fastRequests,
        deepInputTokensUpperBound: budget.deepInputTokensUpperBound,
        deepRequestsUpperBound: budget.deepRequestsUpperBound,
        maximumInputTokens: prepared.maximumInputTokens,
        maximumDeepInputTokens: prepared.maximumDeepInputTokens,
        requestInputTokens: prepared.requestInputTokens,
      },
      model: { configurationRead: false, requests: 0 },
      excludedContent: [
        "system/developer messages as experience claims",
        "raw reasoning and historical privileged context",
        "attachment bytes and large tool output",
        "AgentHist library entries marked deleted",
      ],
    };
  });
}
