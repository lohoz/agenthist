import { homedir } from "node:os";

import packageMetadata from "../../package.json" with { type: "json" };
import { resolveStateDirectory } from "../application/index.js";
import {
  failure,
  invalidArguments,
  readValue,
  type CliResult,
  type CliRuntime,
  type GlobalOptions,
} from "./command-support.js";
import { commandHelp, rootHelp } from "./help.js";
import { runExperience } from "./experience-command.js";
import { runDoctor, runHistory, runScan } from "./history-command.js";
import { runCodex, runTransaction } from "./maintenance-command.js";
import { runSkill } from "./skill-command.js";
import { runExport, runImport, runInspect } from "./transfer-command.js";

export type { CliResult, CliRuntime } from "./command-support.js";

export const VERSION = packageMetadata.version;

function parseGlobals(args: readonly string[], runtime: CliRuntime): [GlobalOptions, readonly string[]] {
  let index = 0;
  let json = false;
  let explicitState: string | undefined;
  let codexHome: string | undefined;
  let sqliteHome: string | undefined;
  let profile: string | undefined;
  let opencodeDataRoot: string | undefined;
  let opencodeDatabase: string | undefined;
  let claudeConfigRoot: string | undefined;
  let piSessionRoot: string | undefined;
  while (index < args.length) {
    const argument = args[index]!;
    if (argument === "--json") {
      json = true;
      index++;
      continue;
    }
    let destination: "state" | "codex" | "sqlite" | "profile" | "opencode-root" | "opencode-db" |
      "claude-root" | "pi-root" | undefined;
    if (argument === "--state-dir" || argument.startsWith("--state-dir=")) destination = "state";
    if (argument === "--codex-home" || argument.startsWith("--codex-home=")) destination = "codex";
    if (argument === "--codex-sqlite-home" || argument.startsWith("--codex-sqlite-home=")) destination = "sqlite";
    if (argument === "--codex-profile" || argument.startsWith("--codex-profile=")) destination = "profile";
    if (argument === "--opencode-data-root" || argument.startsWith("--opencode-data-root=")) destination = "opencode-root";
    if (argument === "--opencode-db" || argument.startsWith("--opencode-db=")) destination = "opencode-db";
    if (argument === "--claude-config-dir" || argument.startsWith("--claude-config-dir=")) destination = "claude-root";
    if (argument === "--pi-session-dir" || argument.startsWith("--pi-session-dir=")) destination = "pi-root";
    if (destination === undefined) break;
    const [value, next] = readValue(args, index, argument.split("=")[0]!);
    index = next;
    if (destination === "state") explicitState = value;
    if (destination === "codex") codexHome = value;
    if (destination === "sqlite") sqliteHome = value;
    if (destination === "profile") profile = value;
    if (destination === "opencode-root") opencodeDataRoot = value;
    if (destination === "opencode-db") opencodeDatabase = value;
    if (destination === "claude-root") claudeConfigRoot = value;
    if (destination === "pi-root") piSessionRoot = value;
  }
  const environment = runtime.environment ?? process.env;
  const cwd = runtime.cwd ?? process.cwd();
  const home = runtime.home ?? environment.HOME ?? homedir();
  const stateDirectory = resolveStateDirectory({
    ...(explicitState === undefined ? {} : { explicit: explicitState }),
    environment,
    cwd,
    home,
  });
  return [
    {
      json,
      color: runtime.color === true,
      stateDirectory,
      ...(codexHome === undefined ? {} : { codexHome }),
      ...(sqliteHome === undefined ? {} : { sqliteHome }),
      ...(profile === undefined ? {} : { profile }),
      ...(opencodeDataRoot === undefined ? {} : { opencodeDataRoot }),
      ...(opencodeDatabase === undefined ? {} : { opencodeDatabase }),
      ...(claudeConfigRoot === undefined ? {} : { claudeConfigRoot }),
      ...(piSessionRoot === undefined ? {} : { piSessionRoot }),
    },
    args.slice(index),
  ];
}

export async function runCli(args: readonly string[], runtime: CliRuntime = {}): Promise<CliResult> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { exitCode: 0, stdout: rootHelp(runtime.color === true), stderr: "" };
  }
  if (args[0] === "--version" || args[0] === "-v") {
    return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
  }
  let json = args.includes("--json");
  let attemptedCommand = "unknown";
  try {
    const [globals, commandArgs] = parseGlobals(args, runtime);
    const command = commandArgs[0];
    json = globals.json;
    attemptedCommand = command ?? "unknown";
    if (command === "help" || command === "--help" || command === "-h") {
      if (commandArgs.length === 1) {
        return { exitCode: 0, stdout: rootHelp(globals.color && !globals.json), stderr: "" };
      }
      if (commandArgs.length !== 2) throw invalidArguments("help accepts at most one command");
      const help = commandHelp(commandArgs[1]!, globals.color && !globals.json);
      if (help === undefined) throw invalidArguments(`unknown help command: ${commandArgs[1]}`);
      return { exitCode: 0, stdout: help, stderr: "" };
    }
    if (command === "version" || command === "--version" || command === "-v") {
      if (commandArgs.length !== 1) throw invalidArguments("version accepts no arguments");
      return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
    }
    if (commandArgs.slice(1).some((argument) => argument === "--help" || argument === "-h")) {
      const help = command === undefined ? undefined : commandHelp(command, globals.color && !globals.json);
      if (help === undefined) throw invalidArguments(`unknown help command: ${command ?? ""}`);
      return { exitCode: 0, stdout: help, stderr: "" };
    }
    if (command === "doctor") return await runDoctor(globals, commandArgs.slice(1), runtime);
    if (command === "scan") return await runScan(globals, commandArgs.slice(1), runtime);
    if (command === "history") return await runHistory(globals, commandArgs.slice(1), runtime);
    if (command === "experience") return await runExperience(globals, commandArgs.slice(1), runtime);
    if (command === "skill") return await runSkill(globals, commandArgs.slice(1), runtime);
    if (command === "export") return await runExport(globals, commandArgs.slice(1), runtime);
    if (command === "inspect") return await runInspect(globals, commandArgs.slice(1), runtime);
    if (command === "import") return await runImport(globals, commandArgs.slice(1), runtime);
    if (command === "transaction") return await runTransaction(globals, commandArgs.slice(1), runtime);
    if (command === "codex") return await runCodex(globals, commandArgs.slice(1), runtime);
    throw invalidArguments(`unknown command: ${command ?? ""}`);
  } catch (error) {
    return failure(attemptedCommand, error, json, runtime.color === true);
  }
}
