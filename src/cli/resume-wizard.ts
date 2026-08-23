import { lstat } from "node:fs/promises";

import {
  AGENTS,
  agentLabel,
  type Agent,
  type HistoryCatalogEntry,
  type HistorySelectionCatalog,
  type ImportHistoryResult,
  type ExistingHistoryTransfer,
} from "../application/index.js";
import { isAbsolutePath, pathFlavorForPlatform } from "../domain/host-path.js";
import {
  readDirectoryInput,
  type DirectoryInputFrame,
  type DirectoryInputView,
} from "./import-wizard/directory-input.js";
import { chooseHistorySessions } from "./import-wizard/index.js";
import { ImportTerminal, type TerminalKey } from "./import-wizard/terminal.js";
import { resumeWizardCopy } from "./resume-copy.js";
import { paint } from "./style.js";
import {
  columns,
  truncateDisplay,
  truncateDisplayStart,
  wrapDisplay,
} from "./terminal-layout.js";

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
  ensureTargetAvailable(request: ResumeWizardRequest, cwd: string): Promise<void>;
  findExistingTarget(request: ResumeWizardRequest): Promise<ExistingHistoryTransfer | undefined>;
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
      readonly targetNativeId?: string;
      readonly reusedExisting?: boolean;
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

function directoryInputFrame(
  terminal: ImportTerminal,
  source: string,
  color: boolean,
  view: DirectoryInputView,
): DirectoryInputFrame {
  const width = terminal.width;
  const sourceLines = wrapDisplay(`Source workspace: ${source}`, width);
  const header = [
    paint("AgentHist Resume", "brand", color),
    "",
    paint("Workspace moved", "heading", color),
    "",
    ...sourceLines,
    "",
  ];
  const cursorLine = header.length;
  const feedback = view.invalid
    ? "Choose an existing directory."
    : "Up/Down chooses · Enter fills choice or confirms · Tab completes · Ctrl+U clears · Esc goes back";
  const available = Math.max(1, terminal.height - header.length - 5);
  const maximumStart = Math.max(0, view.candidates.length - available);
  const start = Math.min(maximumStart, Math.max(0, view.activeCandidate - Math.floor(available / 2)));
  const candidates = view.candidates.slice(start, start + available);
  return {
    lines: [
      ...header,
      `Target directory: ${truncateDisplayStart(view.value, Math.max(8, width - 18))}`,
      "",
      paint("Directory candidates", "section", color),
      ...(candidates.length === 0
        ? [paint("  No matching directories", "muted", color)]
        : candidates.map((candidate, index) => {
            const active = view.candidateSelected && start + index === view.activeCandidate;
            const line = `${active ? ">" : " "} ${truncateDisplayStart(candidate, Math.max(1, width - 2))}`;
            return active ? paint(line, "focus", color) : line;
          })),
      paint(feedback, view.invalid ? "warning" : "muted", color),
    ],
    cursorLine,
  };
}

async function workspaceMappings(
  terminal: ImportTerminal,
  session: HistoryCatalogEntry,
  cwd: string,
  color: boolean,
): Promise<readonly string[] | undefined> {
  if (await realDirectory(session.workspace)) return [];
  const value = await readDirectoryInput(terminal, {
    initial: cwd,
    seeds: [cwd],
    render: (view) => directoryInputFrame(terminal, session.workspace, color, view),
  });
  if (value === undefined) return undefined;
  if (!isAbsolutePath(value, pathFlavorForPlatform())) return undefined;
  return [`${session.workspace}=${value}`];
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
        languageSwitch: false,
        color,
        copy: resumeWizardCopy,
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
    const request = { session, targetAgent, pathMappings };
    frame(
      terminal,
      color,
      "Continue conversation",
      "CHECKING",
      [`Checking ${agentLabel(targetAgent)} CLI...`],
      "",
    );
    await options.ensureTargetAvailable(request, targetCwd);
    if (targetAgent === session.agent) return { status: "ready", session, targetAgent, cwd: targetCwd };

    frame(terminal, color, "Continue conversation", "CHECKING", ["Looking for an existing continuation..."], "");
    const existing = await options.findExistingTarget(request);
    if (existing !== undefined) {
      return {
        status: "ready",
        session,
        targetAgent,
        cwd: targetCwd,
        targetNativeId: existing.targetNativeId,
        reusedExisting: true,
      };
    }

    frame(terminal, color, "Review conversion", "PREPARING", ["Checking portable history..."], "");
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
