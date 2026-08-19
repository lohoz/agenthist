import { homedir } from "node:os";

import {
  listCodexHistoryProviders,
  listNativeTransactions,
  recoverNativeTransaction,
  rollbackNativeTransaction,
  unifyCodexHistoryProviders,
  type CodexProviderHistoryOptions,
} from "../application/index.js";
import {
  invalidArguments,
  readValue,
  success,
  type CliResult,
  type CliRuntime,
  type GlobalOptions,
} from "./command-support.js";

const DEFAULT_CODEX_PROVIDER = "openai";

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

export async function runTransaction(globals: GlobalOptions, args: readonly string[]): Promise<CliResult> {
  const action = args[0];
  if (action === "list") {
    if (args.length !== 1) throw invalidArguments("transaction list accepts no arguments");
    const transactions = await listNativeTransactions(globals.stateDirectory);
    const human = transactions.map((item) =>
      `${item.transactionRef}  ${item.operation}  ${item.state}/${item.phase}  ${item.itemCount} item(s)\n`
    ).join("");
    return success(
      "transaction list",
      { transactions: transactions.map(transactionSummary) },
      `${human}${transactions.length} transaction(s)\n`,
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
  const result = action === "rollback"
    ? await rollbackNativeTransaction(globals.stateDirectory, reference, mode === "apply")
    : await recoverNativeTransaction(globals.stateDirectory, reference, mode === "apply");
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
  return success(
    `transaction ${action}`,
    data,
    `${result.preview.ready ? "ready" : "blocked"}  ${reference}  ${result.preview.items} item(s)\n` +
      (result.dryRun ? "No changes applied.\n" : `${result.transaction.state}.\n`),
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
    const human = result.providers.map((item) =>
      `${item.current ? "*" : " "} ${item.provider}  ${item.sessions} session(s)\n`
    ).join("");
    return success(
      "codex provider list",
      {
        current_provider: result.currentProvider,
        total_sessions: result.totalSessions,
        providers: result.providers,
      },
      `${human}${result.providers.length} provider(s)\n`,
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
  const result = await unifyCodexHistoryProviders(
    codexProviderOptions(globals, runtime),
    target ?? DEFAULT_CODEX_PROVIDER,
    mode === "apply",
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
  return success(
    "codex provider unify",
    data,
    `${result.dryRun ? "Would change" : "Changed"} ${result.changed} session(s) to ${result.targetProvider}; ` +
      `${result.unchanged} already unified.\n${result.dryRun ? "No changes applied.\n" : ""}`,
    globals.json,
  );
}
