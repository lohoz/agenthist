import { lstat } from "node:fs/promises";

import {
  AGENTS,
  agentLabel,
  type Agent,
  type HistoryCatalogEntry,
  type HistorySelectionCatalog,
  type ImportHistoryResult,
} from "../application/index.js";
import { isAbsolutePath, pathFlavorForPlatform } from "../domain/host-path.js";
import { chooseHistorySessions } from "./import-wizard/index.js";
import { ImportTerminal, type TerminalKey } from "./import-wizard/terminal.js";
import { paint } from "./style.js";
import { columns, truncateDisplay, wrapDisplay } from "./terminal-layout.js";

export interface ResumeWizardRequest {
  readonly session: HistoryCatalogEntry;
  readonly targetAgent: Agent;
  readonly pathMappings: readonly string[];
}

export interface ResumeWizardOptions {
  readonly catalog: HistorySelectionCatalog;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly cwd: string;
  readonly color?: boolean;
  readonly sessionRef?: string;
  readonly targetAgent?: Agent;
  execute(mode: "dry_run" | "apply", request: ResumeWizardRequest): Promise<ImportHistoryResult>;
}

export type ResumeWizardOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "blocked" }
  | {
      readonly status: "ready";
      readonly session: HistoryCatalogEntry;
      readonly targetAgent: Agent;
      readonly cwd: string;
      readonly result?: ImportHistoryResult;
    };

function interrupted(key: TerminalKey): boolean {
  return key.ctrl && key.name === "c";
}

function frame(
  terminal: ImportTerminal,
  color: boolean,
  title: string,
  summary: string,
  body: readonly string[],
  footer: string,
): void {
  terminal.draw([
    paint("AgentHist Resume", "brand", color),
    "",
    columns(paint(title, "heading", color), summary, terminal.width),
    "",
    ...body,
    "",
    paint("-".repeat(Math.max(1, terminal.width)), "divider", color),
    footer,
  ]);
}

async function chooseTarget(
  terminal: ImportTerminal,
  source: HistoryCatalogEntry,
  selected: Agent | undefined,
  color: boolean,
): Promise<Agent | undefined> {
  const agents = [source.agent, ...AGENTS.filter((agent) => agent !== source.agent)];
  let cursor = Math.max(0, selected === undefined ? 0 : agents.indexOf(selected));
  while (true) {
    const body = agents.map((agent, index) => {
      const suffix = agent === source.agent ? "continue native history" : `convert from ${agentLabel(source.agent)}`;
      const line = columns(`  ${agentLabel(agent)}`, suffix, Math.max(1, terminal.width - 2));
      return index === cursor ? paint(`> ${line.slice(2)}`, "focus", color) : line;
    });
    frame(
      terminal,
      color,
      "Continue with",
      truncateDisplay(source.title, Math.max(12, Math.floor(terminal.width / 2))),
      body,
      "[Up/Down] Move   [Enter] Choose   [Esc] Back",
    );
    const key = await terminal.key();
    if (interrupted(key)) return undefined;
    if (key.name === "escape") return undefined;
    if (key.name === "up" || key.name === "k") cursor = (cursor - 1 + agents.length) % agents.length;
    if (key.name === "down" || key.name === "j") cursor = (cursor + 1) % agents.length;
    if (key.name === "return" || key.name === "enter") return agents[cursor];
  }
}

async function realDirectory(candidate: string): Promise<boolean> {
  try {
    const info = await lstat(candidate);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function workspaceMappings(
  terminal: ImportTerminal,
  session: HistoryCatalogEntry,
  cwd: string,
  color: boolean,
): Promise<readonly string[] | undefined> {
  if (await realDirectory(session.workspace)) return [];
  let initial = cwd;
  while (true) {
    const value = await terminal.line((input) => [
      paint("AgentHist Resume", "brand", color),
      "",
      paint("Workspace moved", "heading", color),
      "",
      ...wrapDisplay(`Source: ${session.workspace}`, terminal.width),
      "",
      "Enter the existing directory where this conversation should continue:",
      "",
      `Target: ${input}`,
      "",
      "[Enter] Use directory   [Esc] Back",
    ], initial);
    if (value === undefined) return undefined;
    if (!isAbsolutePath(value, pathFlavorForPlatform())) {
      initial = value;
      continue;
    }
    if (!await realDirectory(value)) {
      initial = value;
      continue;
    }
    return [`${session.workspace}=${value}`];
  }
}

function reviewLines(
  result: ImportHistoryResult,
  session: HistoryCatalogEntry,
  target: Agent,
  color: boolean,
): string[] {
  const route = result.routes.find((item) => item.sourceAgent === session.agent && item.targetAgent === target);
  const quality = route?.quality ?? "blocked";
  const tone = quality === "blocked" ? "error_strong" : quality === "degraded" ? "warning_strong" : "success";
  const lines = [
    paint(session.title, "strong", color),
    `  ${agentLabel(session.agent)} -> ${agentLabel(target)}`,
    `  ${session.workspace}`,
    "",
    `Result  ${paint(quality.toUpperCase(), tone, color)}`,
  ];
  if (route !== undefined && route.findings.length !== 0) {
    lines.push("", paint("Known conversion impact", "section", color));
    for (const finding of route.findings.slice(0, 8)) {
      lines.push(`  ${finding.disposition.toUpperCase()}  ${finding.code} · ${finding.count}`);
    }
    if (route.findings.length > 8) lines.push(`  ... ${route.findings.length - 8} more findings`);
  }
  return lines;
}

async function confirmTransfer(
  terminal: ImportTerminal,
  result: ImportHistoryResult,
  session: HistoryCatalogEntry,
  target: Agent,
  color: boolean,
): Promise<boolean> {
  const blocked = result.status === "blocked";
  while (true) {
    frame(
      terminal,
      color,
      "Review conversion",
      blocked ? "BLOCKED" : "READY",
      reviewLines(result, session, target, color),
      blocked ? "[Esc] Back" : "[Enter] Continue   [Esc] Back",
    );
    const key = await terminal.key();
    if (interrupted(key) || key.name === "escape") return false;
    if (!blocked && (key.name === "return" || key.name === "enter")) return true;
  }
}

export async function runResumeWizard(options: ResumeWizardOptions): Promise<ResumeWizardOutcome> {
  const terminal = new ImportTerminal(options.input, options.output, "en");
  const color = options.color === true;
  terminal.open();
  try {
    let session: HistoryCatalogEntry;
    if (options.sessionRef === undefined) {
      const selected = await chooseHistorySessions(terminal, {
        catalog: options.catalog,
        sessions: [],
        selectionMode: "single",
        preferredWorkspace: options.cwd,
        color,
        step: 0,
      });
      if (selected.status === "cancelled") return { status: "cancelled" };
      session = selected.included[0]!;
    } else {
      const selected = options.catalog.closeSelection([options.sessionRef]);
      session = selected[0]!;
    }
    const targetAgent = options.targetAgent ?? await chooseTarget(terminal, session, undefined, color);
    if (targetAgent === undefined) return { status: "cancelled" };
    const pathMappings = await workspaceMappings(terminal, session, options.cwd, color);
    if (pathMappings === undefined) return { status: "cancelled" };
    const targetCwd = pathMappings.length === 0
      ? session.workspace
      : pathMappings[0]!.slice(pathMappings[0]!.indexOf("=") + 1);
    if (targetAgent === session.agent) return { status: "ready", session, targetAgent, cwd: targetCwd };

    frame(terminal, color, "Review conversion", "PREPARING", ["Checking portable history..."], "");
    const request = { session, targetAgent, pathMappings };
    const dryRun = await options.execute("dry_run", request);
    if (!await confirmTransfer(terminal, dryRun, session, targetAgent, color)) {
      return dryRun.status === "blocked" ? { status: "blocked" } : { status: "cancelled" };
    }
    frame(terminal, color, "Continue conversation", "WRITING", ["Creating native history transaction..."], "");
    const result = await options.execute("apply", request);
    return { status: "ready", session, targetAgent, cwd: targetCwd, result };
  } finally {
    terminal.close();
  }
}
