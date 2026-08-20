import path from "node:path";

import {
  agentLabel,
  type Agent,
  type ExportCatalog,
  type ExportHistoryPlan,
  type ExportHistoryResult,
} from "../../application/index.js";
import { paint } from "../style.js";
import {
  chooseHistorySessions,
  type HistorySelectionScreenOutcome,
} from "../import-wizard/index.js";
import { ImportTerminal } from "../import-wizard/terminal.js";
import {
  columns,
  displayWidth,
  padDisplay,
  truncateDisplay,
  type TerminalKey,
} from "../import-wizard/terminal.js";
import {
  exportReviewCopy,
  exportSelectionCopy,
  type ExportReviewCopy,
  type ExportWizardLanguage,
} from "./copy.js";

export interface ExportWizardRequest {
  readonly sessions: readonly string[];
  readonly output: string;
  readonly strictSessions: false;
}

export interface ExportWizardOptions {
  readonly catalog: ExportCatalog;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly cwd: string;
  readonly archive: string;
  readonly color?: boolean;
  readonly language?: ExportWizardLanguage;
  plan(request: ExportWizardRequest): Promise<ExportHistoryPlan>;
  execute(request: ExportWizardRequest): Promise<ExportHistoryResult>;
}

export type ExportWizardOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "completed"; readonly result: ExportHistoryResult };

function interrupted(key: TerminalKey): boolean {
  return key.ctrl && key.name === "c";
}

function toggleLanguage(language: ExportWizardLanguage): ExportWizardLanguage {
  return language === "en" ? "zh" : "en";
}

function progressLine(copy: ExportReviewCopy, step: number, width: number, color: boolean): string {
  const full = copy.steps.map((label, index) => {
    const value = `${index + 1} ${label}`;
    if (index === step) return paint(`[${value}]`, "step_current", color);
    if (index < step) return paint(value, "step_complete", color);
    return paint(value, "step_pending", color);
  }).join("  >  ");
  return displayWidth(full) <= width ? full : paint(`[${step + 1}/${copy.steps.length}]`, "step_current", color);
}

function hintLine(
  hints: readonly (readonly [string, string])[],
  width: number,
  color: boolean,
): string {
  let result = "";
  for (const [key, action] of hints) {
    const item = `${result === "" ? "" : "  "}${paint(`[${key}]`, "hint", color)} ${action}`;
    if (displayWidth(result + item) > width) break;
    result += item;
  }
  return result;
}

function draw(
  terminal: ImportTerminal,
  copy: ExportReviewCopy,
  color: boolean,
  title: string,
  summary: string,
  body: readonly string[],
  scroll: number,
  notice?: string,
): number {
  const width = terminal.width;
  const capacity = Math.max(3, terminal.height - 9);
  const maximum = Math.max(0, body.length - capacity);
  const bounded = Math.max(0, Math.min(scroll, maximum));
  const visible = body.slice(bounded, bounded + capacity);
  terminal.draw([
    paint(copy.brand, "brand", color),
    progressLine(copy, 1, width, color),
    "",
    paint(columns(title, summary, width), "heading", color),
    "",
    ...visible,
    ...Array.from({ length: capacity - visible.length }, () => ""),
    paint("-".repeat(Math.min(width, 120)), "divider", color),
    notice === undefined ? "" : paint(truncateDisplay(notice, width), "warning", color),
    hintLine([["Enter", copy.export], ["o", copy.changeFile], ["Up/Down", copy.scroll], ["PgUp/PgDn", copy.page]], width, color),
    hintLine([["Esc", copy.back], ["l", copy.switchLanguage]], width, color),
  ]);
  return bounded;
}

function section(title: string, color: boolean): string {
  return paint(title, "section", color);
}

function field(label: string, value: string, color: boolean, role: "plain" | "muted" | "warning" = "plain"): string {
  return `  ${paint(padDisplay(label, 13), "muted", color)}${paint(value, role, color)}`;
}

function workspaceRows(plan: ExportHistoryPlan, copy: ExportReviewCopy, color: boolean): string[] {
  const groups = new Map<string, { readonly agents: Set<Agent>; sessions: number }>();
  for (const item of plan.items) {
    let group = groups.get(item.workspace);
    if (group === undefined) {
      group = { agents: new Set(), sessions: 0 };
      groups.set(item.workspace, group);
    }
    group.agents.add(item.agent);
    group.sessions++;
  }
  return [...groups.entries()].toSorted(([left], [right]) => left.localeCompare(right)).flatMap(([workspace, group]) => [
    `  ${paint(workspace, "strong", color)}`,
    `    ${paint(copy.sessions(group.sessions), "muted", color)} · ` +
      [...group.agents].map((agent) => paint(agentLabel(agent), "info", color)).join(", "),
  ]);
}

function reviewBody(
  plan: ExportHistoryPlan,
  selected: number,
  copy: ExportReviewCopy,
  color: boolean,
): string[] {
  const required = Math.max(0, plan.entries + plan.skippedSessions.length - selected);
  return [
    section(copy.overview, color),
    field(copy.selected, copy.sessions(selected), color),
    field(copy.included, `${copy.sessions(plan.entries)}${required === 0 ? "" : ` · ${copy.required(required)}`}`, color),
    field(copy.ready, copy.sessions(plan.entries), color),
    field(copy.unavailable, copy.sessions(plan.skippedSessions.length), color,
      plan.skippedSessions.length === 0 ? "muted" : "warning"),
    "",
    section(copy.destination, color),
    `  ${paint(plan.file, "strong", color)}`,
    "",
    section(copy.agents, color),
    ...plan.agents.map((item) => `  ${paint(padDisplay(agentLabel(item.agent), 14), "info", color)}` +
      paint(copy.sessions(item.sessions), "plain", color)),
    "",
    section(copy.workspaces, color),
    ...workspaceRows(plan, copy, color),
    ...(plan.skippedSessions.length === 0 ? [] : [
      "",
      section(copy.skipped, color),
      ...plan.skippedSessions.flatMap((session) => [
        `  ${paint(session.title, "warning", color)}`,
        `    ${paint(agentLabel(session.agent), "info", color)} · ${paint(session.reason, "muted", color)}`,
      ]),
    ]),
  ];
}

function requestedSessions(
  catalog: ExportCatalog,
  selection: Extract<HistorySelectionScreenOutcome, { readonly status: "selected" }>,
): readonly string[] {
  const selected = new Set(selection.sessions);
  const allAvailable = catalog.entries.every((entry) => selected.has(entry.sessionRef));
  return allAvailable
    ? [...selection.sessions, ...catalog.skippedSessions.map((session) => session.sessionRef)]
    : selection.sessions;
}

function archiveInputFrame(
  terminal: ImportTerminal,
  copy: ExportReviewCopy,
  color: boolean,
  value: string,
): readonly string[] {
  return [
    paint(copy.brand, "brand", color),
    progressLine(copy, 1, terminal.width, color),
    "",
    paint(copy.editTitle, "heading", color),
    "",
    paint(copy.editHelp, "muted", color),
    "",
    `${copy.filePrompt}${truncateDisplay(value, Math.max(8, terminal.width - displayWidth(copy.filePrompt)))}`,
  ];
}

async function preparePlan(
  terminal: ImportTerminal,
  options: ExportWizardOptions,
  request: ExportWizardRequest,
): Promise<ExportHistoryPlan> {
  const copy = exportReviewCopy(terminal.language);
  terminal.draw([
    paint(copy.brand, "brand", options.color === true),
    progressLine(copy, 1, terminal.width, options.color === true),
    "",
    paint(copy.preparing, "heading", options.color === true),
  ]);
  return await options.plan(request);
}

export async function runExportWizard(options: ExportWizardOptions): Promise<ExportWizardOutcome> {
  const terminal = new ImportTerminal(options.input, options.output, options.language ?? "en");
  let selected: readonly string[] = [];
  let archive = options.archive;
  terminal.open();
  try {
    while (true) {
      const selection = await chooseHistorySessions(terminal, {
        catalog: options.catalog,
        sessions: selected,
        ...(options.color === undefined ? {} : { color: options.color }),
        copy: exportSelectionCopy,
        step: 0,
      });
      if (selection.status === "cancelled") return { status: "cancelled" };
      selected = selection.sessions;
      const sessions = requestedSessions(options.catalog, selection);
      let request: ExportWizardRequest = { sessions, output: archive, strictSessions: false };
      let plan = await preparePlan(terminal, options, request);
      archive = plan.file;
      let scroll = 0;
      let notice: string | undefined;
      while (true) {
        const copy = exportReviewCopy(terminal.language);
        const body = reviewBody(plan, sessions.length, copy, options.color === true);
        scroll = draw(
          terminal,
          copy,
          options.color === true,
          copy.title,
          copy.summary(plan.entries, plan.skippedSessions.length),
          body,
          scroll,
          notice,
        );
        notice = undefined;
        const key = await terminal.key();
        if (interrupted(key)) return { status: "cancelled" };
        if (key.name === "escape") break;
        if (key.name === "l") {
          terminal.language = toggleLanguage(terminal.language);
          continue;
        }
        const page = Math.max(1, terminal.height - 10);
        if (key.name === "up" || key.name === "k") scroll = Math.max(0, scroll - 1);
        if (key.name === "down" || key.name === "j") scroll = Math.min(body.length - 1, scroll + 1);
        if (key.name === "pageup") scroll = Math.max(0, scroll - page);
        if (key.name === "pagedown") scroll = Math.min(body.length - 1, scroll + page);
        if (key.name === "o") {
          const value = await terminal.line((input) =>
            archiveInputFrame(terminal, exportReviewCopy(terminal.language), options.color === true, input), archive);
          if (value === undefined) continue;
          const resolved = path.resolve(options.cwd, value);
          if (!resolved.endsWith(".agenthist")) {
            notice = copy.invalidFile;
            continue;
          }
          archive = resolved;
          request = { sessions, output: archive, strictSessions: false };
          plan = await preparePlan(terminal, options, request);
          archive = plan.file;
          scroll = 0;
          continue;
        }
        if (key.name === "return" || key.name === "enter") {
          terminal.draw([
            paint(copy.brand, "brand", options.color === true),
            progressLine(copy, 1, terminal.width, options.color === true),
            "",
            paint(copy.exporting, "heading", options.color === true),
          ]);
          return { status: "completed", result: await options.execute(request) };
        }
      }
    }
  } finally {
    terminal.close();
  }
}
