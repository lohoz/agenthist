import {
  DEFAULT_EXPERIENCE_MAX_DEEP_INPUT_TOKENS,
  DEFAULT_EXPERIENCE_MAX_INPUT_TOKENS,
  DEFAULT_EXPERIENCE_REQUEST_INPUT_TOKENS,
  checkExperienceModels,
  dryRunExperienceReview,
  experienceReviewResultJson,
  prepareExperienceReview,
  type Agent,
  type ExperienceHistorySelection,
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
import { humanCount, humanFields, humanSection, humanTitle, type HumanField } from "./human-output.js";

function tokenValue(value: string, flag: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw invalidArguments(`${flag} requires a non-negative integer`);
  }
  return Number(value);
}

function scopeFields(selection: ExperienceHistorySelection, sessions: number): HumanField[] {
  if (selection.mode === "all") return [{ label: "Scope", value: "All active and archived history" }];
  if (selection.mode === "session") {
    return [{ label: "Scope", value: `${humanCount(sessions, "explicit session")}` }];
  }
  if (selection.workspaces.length === 1) {
    const workspace = selection.workspaces[0]!;
    const label = selection.defaultedToCurrentWorkspace ? "current workspace" : "workspace";
    return [{ label: "Scope", value: `${label} ${JSON.stringify(workspace.path)} · ${humanCount(sessions, "session")}` }];
  }
  return [{
    label: "Scope",
    value: `${selection.workspaces.length} workspaces · ${sessions} unique sessions`,
  }, {
    label: "Workspaces",
    value: selection.workspaces.map((workspace) =>
      `${JSON.stringify(workspace.path)} · ${humanCount(workspace.sessions, "session")}`).join("\n"),
  }];
}

async function runModelCheck(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  if (args[0] !== "check" || args.length !== 1) {
    throw invalidArguments("experience model requires exactly: experience model check");
  }
  const result = await checkExperienceModels({
    cwd: runtime.cwd ?? process.cwd(),
    environment: runtime.environment ?? process.env,
    ...(runtime.fetcher === undefined ? {} : { fetcher: runtime.fetcher }),
    ...(runtime.analysisProcessRunner === undefined ? {} : { processRunner: runtime.analysisProcessRunner }),
  });
  const fast = result.profiles[0]!;
  const deep = result.profiles[1]!;
  const modelLabel = (profile: typeof fast): string => profile.modelConfigured ? profile.model : "Agent default";
  const human = humanTitle("Experience model check", globals.color) + "\n" + humanFields([
    { label: "Status", value: "READY", tone: "success" },
    { label: "Evidence", value: `${modelLabel(fast)} · ${fast.endpoint}` },
    {
      label: "Organizer",
      value: deep.binding === "fast"
        ? `${modelLabel(deep)} · uses the evidence model`
        : `${modelLabel(deep)} · ${deep.endpoint}`,
    },
    { label: "Requests", value: String(result.requests) },
    { label: "History", value: "Not sent", tone: "muted" },
  ], globals.color);
  return success("experience", {
    operation: "model_check",
    profiles: result.profiles.map((profile) => ({
      tier: profile.tier,
      role: profile.tier === "fast" ? "evidence" : "candidate_organization",
      binding: profile.binding,
      model: profile.model,
      model_binding: profile.modelConfigured ? "configured" : "agent_default",
      backend: profile.backend,
      endpoint: profile.endpoint,
      endpoint_fingerprint: profile.endpointFingerprint,
      request_made: profile.requestMade,
      usage: {
        input_tokens: profile.usage.inputTokens,
        output_tokens: profile.usage.outputTokens,
        total_tokens: profile.usage.totalTokens,
      },
    })),
    requests: result.requests,
    history_sent: result.historySent,
  }, human, globals.json);
}

async function runReview(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  const agents = new Set<Agent>();
  const workspaces: string[] = [];
  const sessions: string[] = [];
  let allHistory = false;
  let dryRun = false;
  let since: string | undefined;
  let outputDirectory: string | undefined;
  let maximumInputTokens: number | undefined;
  let maximumDeepInputTokens: number | undefined;
  let requestInputTokens: number | undefined;
  for (let index = 0; index < args.length;) {
    const argument = args[index]!;
    if (argument === "--dry-run") {
      if (dryRun) throw invalidArguments("experience accepts --dry-run once");
      dryRun = true;
      index++;
      continue;
    }
    if (argument === "--agent" || argument.startsWith("--agent=")) {
      const [value, next] = readValue(args, index, "--agent");
      agents.add(parseAgent(value));
      index = next;
      continue;
    }
    if (argument === "--workspace" || argument.startsWith("--workspace=")) {
      const [value, next] = readValue(args, index, "--workspace");
      workspaces.push(value);
      index = next;
      continue;
    }
    if (argument === "--session" || argument.startsWith("--session=")) {
      const [value, next] = readValue(args, index, "--session");
      sessions.push(value);
      index = next;
      continue;
    }
    if (argument === "--all") {
      if (allHistory) throw invalidArguments("experience accepts --all once");
      allHistory = true;
      index++;
      continue;
    }
    if (argument === "--since" || argument.startsWith("--since=")) {
      if (since !== undefined) throw invalidArguments("experience accepts one --since value");
      [since, index] = readValue(args, index, "--since");
      continue;
    }
    if (argument === "-o" || argument === "--output" || argument.startsWith("--output=")) {
      if (outputDirectory !== undefined) throw invalidArguments("experience accepts one --output value");
      [outputDirectory, index] = readValue(args, index, argument === "-o" ? "-o" : "--output");
      continue;
    }
    let tokenFlag: "--max-input-tokens" | "--max-deep-input-tokens" | "--request-input-tokens" | undefined;
    if (argument === "--max-input-tokens" || argument.startsWith("--max-input-tokens=")) {
      tokenFlag = "--max-input-tokens";
    } else if (argument === "--max-deep-input-tokens" || argument.startsWith("--max-deep-input-tokens=")) {
      tokenFlag = "--max-deep-input-tokens";
    } else if (argument === "--request-input-tokens" || argument.startsWith("--request-input-tokens=")) {
      tokenFlag = "--request-input-tokens";
    }
    if (tokenFlag !== undefined) {
      const [value, next] = readValue(args, index, tokenFlag);
      const tokens = tokenValue(value, tokenFlag);
      if (tokenFlag === "--max-input-tokens") {
        if (maximumInputTokens !== undefined) throw invalidArguments(`experience accepts one ${tokenFlag}`);
        maximumInputTokens = tokens;
      } else if (tokenFlag === "--max-deep-input-tokens") {
        if (maximumDeepInputTokens !== undefined) throw invalidArguments(`experience accepts one ${tokenFlag}`);
        maximumDeepInputTokens = tokens;
      } else {
        if (requestInputTokens !== undefined) throw invalidArguments(`experience accepts one ${tokenFlag}`);
        requestInputTokens = tokens;
      }
      index = next;
      continue;
    }
    throw invalidArguments(`unknown experience flag: ${argument}`);
  }
  const selectionModes = Number(workspaces.length > 0) + Number(sessions.length > 0) + Number(allHistory);
  if (selectionModes > 1) {
    throw invalidArguments("experience accepts only one of --workspace, --session, or --all");
  }
  if (dryRun && outputDirectory !== undefined) {
    throw invalidArguments("experience --dry-run does not accept --output");
  }
  const options = {
    stateDirectory: globals.stateDirectory,
    cwd: runtime.cwd ?? process.cwd(),
    ...(agents.size === 0 ? {} : { agents: [...agents] }),
    ...(workspaces.length === 0 ? {} : { workspaceDirectories: workspaces }),
    ...(sessions.length === 0 ? {} : { sessionRefs: sessions }),
    ...(allHistory ? { allHistory: true } : {}),
    ...(since === undefined ? {} : { since }),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(maximumInputTokens === undefined ? {} : { maximumInputTokens }),
    ...(maximumDeepInputTokens === undefined ? {} : { maximumDeepInputTokens }),
    ...(requestInputTokens === undefined ? {} : { requestInputTokens }),
  };
  if (!dryRun) {
    const result = await prepareExperienceReview({
      ...options,
      environment: runtime.environment ?? process.env,
      ...(runtime.fetcher === undefined ? {} : { fetcher: runtime.fetcher }),
      ...(runtime.analysisProcessRunner === undefined ? {} : { processRunner: runtime.analysisProcessRunner }),
    });
    const consolidationTone = result.consolidation.status === "completed" || result.consolidation.status === "not_needed"
      ? "success"
      : "warning";
    const human = humanTitle("Experience extraction", globals.color) + "\n" + humanFields([
      {
        label: "Status",
        value: result.review === undefined ? "INCOMPLETE" : "COMPLETE",
        tone: result.review === undefined ? "warning_strong" : "success",
      },
      ...scopeFields(result.selection, result.corpus.sessions),
    ], globals.color) + "\n" + humanSection("Corpus", globals.color) + humanFields([
      { label: "Sessions", value: String(result.corpus.sessions) },
      { label: "Lineages", value: String(result.corpus.lineages) },
      { label: "Projects", value: String(result.corpus.projects) },
    ], globals.color) + "\n" + humanSection("Evidence", globals.color) + humanFields([
      { label: "Cards", value: `${result.fast.availableCards}/${result.fast.totalCards}` },
      { label: "Events", value: String(result.fast.evidenceEvents) },
      { label: "Requests", value: String(result.fast.requests) },
      {
        label: "Tokens",
        value: `${result.fast.usage.inputTokens} input · ${result.fast.usage.outputTokens} output`,
      },
    ], globals.color) + "\n" + humanSection("Candidates", globals.color) + humanFields([
      { label: "Status", value: result.consolidation.status.toUpperCase(), tone: consolidationTone },
      { label: "Groups", value: String(result.consolidation.groups) },
      { label: "Unrouted", value: String(result.consolidation.unroutedOccurrences) },
      { label: "Requests", value: String(result.consolidation.requests) },
      {
        label: "Tokens",
        value: `${result.consolidation.usage.inputTokens} input · ` +
          `${result.consolidation.usage.outputTokens} output`,
      },
    ], globals.color) + (result.review === undefined
      ? "\n" + colorizeHuman(
          "Rerun the same command to continue from the cached progress.",
          "warning",
          globals.color,
        ) + "\n"
      : "\n" + humanSection("Output", globals.color) + humanFields([
          { label: "Directory", value: result.review.publication.directory, tone: "success" },
          {
            label: "Next",
            value: "Open a new session with this directory as context to verify, merge, rewrite, or reject candidates.",
          },
        ], globals.color));
    return success("experience", experienceReviewResultJson(result), human, globals.json);
  }
  const result = await dryRunExperienceReview(options);
  const corpus = result.corpus;
  const plan = result.plan;
  const human = humanTitle("Experience extraction plan", globals.color) + "\n" + humanFields([
    { label: "Status", value: "DRY RUN", tone: "warning_strong" },
    ...scopeFields(result.selection, corpus.sessions),
  ], globals.color) + "\n" + humanSection("Corpus", globals.color) + humanFields([
    { label: "Sessions", value: String(corpus.sessions) },
    { label: "Lineages", value: String(corpus.lineages) },
    { label: "Projects", value: String(corpus.projects) },
    { label: "Beats", value: String(corpus.beats) },
    { label: "Cards", value: String(corpus.cards) },
    { label: "Queued", value: String(corpus.queuedCards) },
    { label: "Folded", value: String(corpus.foldedDuplicateCards) },
  ], globals.color) + "\n" + humanSection("Index", globals.color) + humanFields([
    { label: "Rebuilt", value: String(result.index.rebuiltSessions) },
    { label: "Reused", value: String(result.index.reusedSessions) },
    { label: "Removed", value: String(result.index.removedSessions) },
  ], globals.color) + "\n" + humanSection("Model plan", globals.color) + humanFields([
    { label: "Evidence cards", value: `${plan.selectedCards}/${plan.totalCards}` },
    { label: "Evidence requests", value: String(plan.fastRequests) },
    {
      label: "Evidence tokens",
      value: `~${plan.estimatedFastInputTokens}/${plan.maximumInputTokens} input`,
    },
    {
      label: "Candidate tokens",
      value: `${plan.deepInputTokensUpperBound}/${plan.maximumDeepInputTokens} input upper bound`,
    },
  ], globals.color) + "\n" + colorizeHuman(
    "No model configuration, output files, or network requests were used.",
    "muted",
    globals.color,
  ) + "\n";
  return success("experience", {
    dry_run: result.dryRun,
    selection: {
      mode: result.selection.mode,
      defaulted_to_current_workspace: result.selection.defaultedToCurrentWorkspace,
      workspaces: result.selection.workspaces.map((workspace) => ({ path: workspace.path, sessions: workspace.sessions })),
      session_refs: [...result.selection.sessionRefs],
    },
    corpus: {
      sessions: corpus.sessions,
      lineages: corpus.lineages,
      projects: corpus.projects,
      beats: corpus.beats,
      cards: corpus.cards,
      queued_cards: corpus.queuedCards,
      folded_duplicate_cards: corpus.foldedDuplicateCards,
      archived_sessions: corpus.archivedSessions,
      excluded_deleted_sessions: corpus.excludedDeletedSessions,
      excluded_outside_selection_sessions: corpus.excludedOutsideSelectionSessions,
      excluded_before_since_sessions: corpus.excludedBeforeSinceSessions,
      duplicate_sessions: corpus.duplicateSessions,
      agents: corpus.agents.map((agent) => ({
        agent: agent.agent,
        snapshot_id: agent.snapshotId,
        sessions: agent.sessions,
        beats: agent.beats,
        cards: agent.cards,
      })),
      ...(corpus.earliest === undefined ? {} : { earliest: corpus.earliest, latest: corpus.latest }),
    },
    index: {
      parser_version: result.index.parserVersion,
      reused_sessions: result.index.reusedSessions,
      rebuilt_sessions: result.index.rebuiltSessions,
      removed_sessions: result.index.removedSessions,
    },
    plan: {
      total_cards: plan.totalCards,
      selected_cards: plan.selectedCards,
      remaining_cards: plan.remainingCards,
      estimated_evidence_input_tokens: plan.estimatedFastInputTokens,
      evidence_requests: plan.fastRequests,
      candidate_input_tokens_upper_bound: plan.deepInputTokensUpperBound,
      candidate_requests_upper_bound: plan.deepRequestsUpperBound,
      maximum_input_tokens: plan.maximumInputTokens,
      maximum_deep_input_tokens: plan.maximumDeepInputTokens,
      request_input_tokens: plan.requestInputTokens,
    },
    model: { configuration_read: false, requests: 0 },
    excluded_content: result.excludedContent,
    defaults: {
      maximum_input_tokens: DEFAULT_EXPERIENCE_MAX_INPUT_TOKENS,
      maximum_deep_input_tokens: DEFAULT_EXPERIENCE_MAX_DEEP_INPUT_TOKENS,
      request_input_tokens: DEFAULT_EXPERIENCE_REQUEST_INPUT_TOKENS,
    },
  }, human, globals.json);
}

export async function runExperience(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  const subcommand = args[0];
  if (subcommand === "model") return runModelCheck(globals, args.slice(1), runtime);
  return runReview(globals, args, runtime);
}
