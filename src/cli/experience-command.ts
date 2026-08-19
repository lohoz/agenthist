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

function labeled(label: string, value: string, color: boolean): string {
  return `${colorizeHuman(`${label}:`, "muted", color)} ${value}\n`;
}

function tokenValue(value: string, flag: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw invalidArguments(`${flag} requires a non-negative integer`);
  }
  return Number(value);
}

function scopeSummary(selection: ExperienceHistorySelection, sessions: number, color: boolean): string {
  if (selection.mode === "all") return labeled("Scope", "all active and archived history", color);
  if (selection.mode === "session") return labeled("Scope", `${sessions} explicit session(s)`, color);
  if (selection.workspaces.length === 1) {
    const workspace = selection.workspaces[0]!;
    const label = selection.defaultedToCurrentWorkspace ? "current workspace" : "workspace";
    return labeled("Scope", `${label} ${JSON.stringify(workspace.path)} (${sessions} session(s))`, color);
  }
  return labeled("Scope", `${selection.workspaces.length} workspaces (${sessions} unique session(s))`, color) +
    labeled("Workspaces", selection.workspaces.map((workspace) =>
      `${JSON.stringify(workspace.path)} (${workspace.sessions})`).join(", "), color);
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
  const human =
    `${colorizeHuman("Experience model check", "section", globals.color)}\n` +
    labeled("Evidence", `${colorizeHuman("ok", "success", globals.color)} ` +
      `(${modelLabel(fast)}, ${fast.endpoint})`, globals.color) +
    (deep.binding === "fast"
      ? labeled("Organizer", `uses evidence model (${modelLabel(deep)}); no additional check request`, globals.color)
      : labeled("Organizer", `${colorizeHuman("ok", "success", globals.color)} ` +
        `(${modelLabel(deep)}, ${deep.endpoint})`, globals.color)) +
    labeled("Requests", String(result.requests), globals.color) +
    `${colorizeHuman("No Agent history was sent.", "muted", globals.color)}\n`;
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
    const continuation = result.review === undefined
      ? `${colorizeHuman(
          "Experience extraction is incomplete; rerun the same command to continue from cache.",
          "warning",
          globals.color,
        )}\n`
      : "";
    const publication = result.review === undefined
      ? ""
      : labeled("Output", colorizeHuman(result.review.publication.directory, "success", globals.color), globals.color) +
        labeled(
          "Next",
          "open a new session with this directory as context to verify, merge, rewrite, or reject the candidates.",
          globals.color,
        );
    const consolidationTone = result.consolidation.status === "completed" || result.consolidation.status === "not_needed"
      ? "success"
      : "warning";
    const human =
      `${colorizeHuman("Experience extraction", "section", globals.color)}\n` +
      scopeSummary(result.selection, result.corpus.sessions, globals.color) +
      labeled("Corpus", `${result.corpus.sessions} session(s), ${result.corpus.lineages} lineage(s), ` +
        `${result.corpus.projects} project(s)`, globals.color) +
      labeled("Evidence", `${result.fast.availableCards}/${result.fast.totalCards} card(s), ` +
        `${result.fast.evidenceEvents} event(s); ${result.fast.requests} request(s), ` +
        `${result.fast.usage.inputTokens} input / ${result.fast.usage.outputTokens} output tokens`, globals.color) +
      labeled("Candidate organization", `(${colorizeHuman(
        result.consolidation.status,
        consolidationTone,
        globals.color,
      )}) ${result.consolidation.groups} candidate(s), ` +
        `${result.consolidation.unroutedOccurrences} unrouted event(s); ${result.consolidation.requests} request(s), ` +
        `${result.consolidation.usage.inputTokens} input / ` +
        `${result.consolidation.usage.outputTokens} output tokens`, globals.color) +
      continuation + publication;
    return success("experience", experienceReviewResultJson(result), human, globals.json);
  }
  const result = await dryRunExperienceReview(options);
  const corpus = result.corpus;
  const plan = result.plan;
  const human =
    `${colorizeHuman("Experience extraction", "section", globals.color)}  ` +
      `${colorizeHuman("DRY-RUN", "warning_strong", globals.color)}\n` +
    scopeSummary(result.selection, corpus.sessions, globals.color) +
    labeled("Corpus", `${corpus.sessions} session(s), ${corpus.lineages} lineage(s), ` +
      `${corpus.projects} project(s), ${corpus.beats} beat(s), ${corpus.cards} card(s)`, globals.color) +
    labeled("Queue", `${corpus.queuedCards} card(s) after folding ` +
      `${corpus.foldedDuplicateCards} proven duplicate(s)`, globals.color) +
    labeled("Index", `${result.index.rebuiltSessions} rebuilt, ${result.index.reusedSessions} reused, ` +
      `${result.index.removedSessions} removed`, globals.color) +
    labeled("Evidence plan", `${plan.selectedCards}/${plan.totalCards} card(s), ${plan.fastRequests} request(s), ` +
      `~${plan.estimatedFastInputTokens}/${plan.maximumInputTokens} input tokens`, globals.color) +
    labeled("Candidate organization upper bound", `${plan.deepInputTokensUpperBound}/` +
      `${plan.maximumDeepInputTokens} input tokens`, globals.color) +
    `${colorizeHuman(
      "No model configuration was read, no output directory was created, and no network request was made.",
      "muted",
      globals.color,
    )}\n`;
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
