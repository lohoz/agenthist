import { homedir } from "node:os";

import {
  agentLabel,
  listCodexHistoryProviders,
  listNativeTransactions,
  recoverNativeTransaction,
  rollbackNativeTransaction,
  unifyCodexHistoryProviders,
  type CodexProviderHistoryOptions,
} from "../application/index.js";
import {
  colorizeHuman,
  invalidArguments,
  readValue,
  renderBoundedHumanRecords,
  success,
  type CliResult,
  type CliRuntime,
  type GlobalOptions,
} from "./command-support.js";
import { humanCount, humanFields, humanSection, humanTitle } from "./human-output.js";
import { withLiveStatus } from "./live-status.js";
import { displayWidth, padDisplay } from "./terminal-layout.js";

const DEFAULT_CODEX_PROVIDER = "openai";
const TRANSACTION_DISPLAY_LIMIT = 20;

function transactionTone(state: string): "success" | "warning" | "error" {
  if (state === "committed" || state === "rolled_back" || state === "recovered") return "success";
  if (state === "failed" || state === "recovery_required") return "error";
  return "warning";
}

function transactionSummary(summary: Awaited<ReturnType<typeof listNativeTransactions>>[number]): Record<string, unknown> {
  return {
    transaction_ref: summary.transactionRef,
    operation: summary.operation,
    agents: summary.agents,
    state: summary.state,
    phase: summary.phase,
    direction: summary.direction,
    created_at: summary.createdAt,
    updated_at: summary.updatedAt,
    items: summary.itemCount,
    ...(summary.failure === undefined ? {} : { failure: summary.failure }),
  };
}

export async function runTransaction(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  const action = args[0];
  if (action === "list") {
    if (args.length !== 1) throw invalidArguments("transaction list accepts no arguments");
    const transactions = await listNativeTransactions(globals.stateDirectory);
    const human = renderBoundedHumanRecords(
      transactions,
      (item) => `  ${colorizeHuman(item.transactionRef, "strong", globals.color)}\n` +
        `    ${colorizeHuman(item.operation, "info", globals.color)} · ` +
        `${item.agents.map(agentLabel).join(" + ")} · ` +
        `${colorizeHuman(`${item.state}/${item.phase}`, transactionTone(item.state), globals.color)} · ` +
        `${humanCount(item.itemCount, "item")} · ${colorizeHuman(item.updatedAt, "muted", globals.color)}\n`,
      "transaction",
      TRANSACTION_DISPLAY_LIMIT,
    );
    return success(
      "transaction list",
      { transactions: transactions.map(transactionSummary) },
      humanTitle("Transactions", globals.color) + "\n" + humanFields([
        { label: "Count", value: String(transactions.length) },
      ], globals.color) + (human === "" ? "\nNo transactions found.\n" : `\n${human}`),
      globals.json,
    );
  }
  if (action !== "rollback" && action !== "recover") {
    throw invalidArguments(`unknown transaction command: ${action ?? ""}`);
  }
  const reference = args[1];
  if (reference === undefined || reference.startsWith("--")) {
    throw invalidArguments(`transaction ${action} requires one transaction reference`);
  }
  let mode: "dry-run" | "apply" | undefined;
  for (const argument of args.slice(2)) {
    if (argument !== "--dry-run" && argument !== "--apply") {
      throw invalidArguments(`unknown transaction flag: ${argument}`);
    }
    const candidate = argument === "--apply" ? "apply" : "dry-run";
    if (mode !== undefined) throw invalidArguments(`transaction ${action} requires exactly one execution mode`);
    mode = candidate;
  }
  if (mode === undefined) throw invalidArguments(`transaction ${action} requires --dry-run or --apply`);
  const result = await withLiveStatus(
    runtime,
    globals,
    action === "rollback"
      ? mode === "apply" ? "Rolling back native history" : "Planning transaction rollback"
      : mode === "apply" ? "Recovering native history" : "Planning transaction recovery",
    () => action === "rollback"
      ? rollbackNativeTransaction(globals.stateDirectory, reference, mode === "apply")
      : recoverNativeTransaction(globals.stateDirectory, reference, mode === "apply"),
  );
  const data = {
    transaction_ref: result.preview.transactionRef,
    operation: result.preview.operation,
    requested_action: result.action,
    dry_run: result.dryRun,
    ready: result.preview.ready,
    items: result.preview.items,
    findings: result.preview.findings.map((finding) => ({
      session_ref: finding.sessionRef,
      row: finding.row,
      ...(finding.section === undefined ? {} : { section: finding.section }),
      ...(finding.file === undefined ? {} : { file: finding.file }),
      ...(finding.resources === undefined ? {} : { resources: finding.resources }),
      ...(finding.goal === undefined ? {} : { goal: finding.goal }),
    })),
    ...(result.transaction === undefined ? {} : { transaction: transactionSummary(result.transaction) }),
  };
  const findings = result.preview.findings.length === 0 ? "" : "\n" + humanSection("Target state", globals.color) +
    renderBoundedHumanRecords(
      result.preview.findings,
      (finding) => {
        const positions = [
          `row ${finding.row}`,
          ...(finding.section === undefined ? [] : [`section ${finding.section}`]),
          ...(finding.file === undefined ? [] : [`file ${finding.file}`]),
          ...(finding.resources === undefined ? [] : [`resources ${finding.resources}`]),
          ...(finding.goal === undefined ? [] : [`goal ${finding.goal}`]),
        ];
        return `  ${colorizeHuman(finding.sessionRef, "strong", globals.color)}\n` +
          `    ${positions.join(" · ")}\n`;
      },
      "finding",
    );
  return success(
    `transaction ${action}`,
    data,
    humanTitle(`${action === "rollback" ? "Rollback" : "Recovery"} ` +
      `${result.dryRun ? "plan" : "complete"}`, globals.color) + "\n" + humanFields([
      {
        label: "Status",
        value: result.preview.ready ? "READY" : "BLOCKED",
        tone: result.preview.ready ? "success" : "error_strong",
      },
      { label: "Transaction", value: reference },
      { label: "Operation", value: result.preview.operation },
      { label: "Items", value: String(result.preview.items) },
      ...(result.dryRun ? [] : [{
        label: "State",
        value: result.transaction.state,
        tone: transactionTone(result.transaction.state),
      }]),
    ], globals.color) + findings + "\n" +
      (result.dryRun
        ? `${colorizeHuman("No changes written.", "muted", globals.color)}\n`
        : `${colorizeHuman("Native history updated.", "success", globals.color)}\n`),
    globals.json,
  );
}

function codexProviderOptions(globals: GlobalOptions, runtime: CliRuntime): CodexProviderHistoryOptions {
  const environment = runtime.environment ?? process.env;
  return {
    stateDirectory: globals.stateDirectory,
    ...(globals.codexHome === undefined ? {} : { codexHome: globals.codexHome }),
    ...(globals.sqliteHome === undefined ? {} : { sqliteHome: globals.sqliteHome }),
    ...(globals.profile === undefined ? {} : { profile: globals.profile }),
    environment,
    cwd: runtime.cwd ?? process.cwd(),
    home: runtime.home ?? environment.HOME ?? homedir(),
  };
}

export async function runCodex(
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CliResult> {
  if (args[0] !== "provider") throw invalidArguments(`unknown Codex command: ${args[0] ?? ""}`);
  const action = args[1];
  if (action === "list") {
    if (args.length !== 2) throw invalidArguments("codex provider list accepts no arguments");
    const result = await listCodexHistoryProviders(codexProviderOptions(globals, runtime));
    const providerWidth = Math.max(0, ...result.providers.map((item) => displayWidth(item.provider)));
    const human = result.providers.map((item) =>
      `${item.current ? colorizeHuman("*", "success", globals.color) : " "} ` +
      `${colorizeHuman(
        padDisplay(item.provider, providerWidth),
        item.current ? "strong" : "plain",
        globals.color,
      )}  ` +
      `${humanCount(item.sessions, "session")}\n`
    ).join("");
    return success(
      "codex provider list",
      {
        current_provider: result.currentProvider,
        total_sessions: result.totalSessions,
        providers: result.providers,
      },
      humanTitle(`${agentLabel("codex")} history providers`, globals.color) + "\n" + humanFields([
        { label: "Current", value: result.currentProvider, tone: "success" },
        { label: "Sessions", value: String(result.totalSessions) },
        { label: "Providers", value: String(result.providers.length) },
      ], globals.color) + (human === "" ? "" : `\n${human}`),
      globals.json,
    );
  }
  if (action !== "unify") throw invalidArguments(`unknown Codex provider command: ${action ?? ""}`);
  let target: string | undefined;
  let mode: "dry-run" | "apply" | undefined;
  for (let index = 2; index < args.length;) {
    const argument = args[index]!;
    if (argument === "--to" || argument.startsWith("--to=")) {
      const [value, next] = readValue(args, index, "--to");
      if (target !== undefined) throw invalidArguments("codex provider unify accepts one --to value");
      target = value;
      index = next;
      continue;
    }
    if (argument === "--dry-run" || argument === "--apply") {
      if (mode !== undefined) throw invalidArguments("codex provider unify requires exactly one execution mode");
      mode = argument === "--apply" ? "apply" : "dry-run";
      index++;
      continue;
    }
    throw invalidArguments(`unknown Codex provider flag: ${argument}`);
  }
  if (mode === undefined) throw invalidArguments("codex provider unify requires --dry-run or --apply");
  const result = await withLiveStatus(
    runtime,
    globals,
    mode === "apply" ? "Unifying Codex history providers" : "Planning Codex provider changes",
    () => unifyCodexHistoryProviders(
      codexProviderOptions(globals, runtime),
      target ?? DEFAULT_CODEX_PROVIDER,
      mode === "apply",
    ),
  );
  const data = {
    target_provider: result.targetProvider,
    dry_run: result.dryRun,
    changed: result.changed,
    unchanged: result.unchanged,
    ...(result.transactionRef === undefined ? {} : { transaction_ref: result.transactionRef }),
    changes: result.changes.map((change) => ({
      session_ref: change.sessionRef,
      before: change.before,
      after: change.after,
    })),
  };
  const changes = result.changes.length === 0 ? "" : "\n" + humanSection("Changes", globals.color) +
    renderBoundedHumanRecords(
      result.changes,
      (change) => `  ${colorizeHuman(change.sessionRef, "strong", globals.color)}\n` +
        `    ${change.before} -> ${change.after}\n`,
      "change",
    );
  return success(
    "codex provider unify",
    data,
    humanTitle(result.dryRun ? "Codex provider plan" : "Codex providers unified", globals.color) + "\n" +
      humanFields([
        { label: "Target", value: result.targetProvider, tone: "info" },
        { label: result.dryRun ? "Would change" : "Changed", value: String(result.changed) },
        { label: "Unchanged", value: String(result.unchanged) },
        ...(result.transactionRef === undefined
          ? []
          : [{ label: "Transaction", value: result.transactionRef }]),
      ], globals.color) + changes + (result.dryRun
        ? `\n${colorizeHuman("No changes written.", "muted", globals.color)}\n`
        : ""),
    globals.json,
  );
}
