import path from "node:path";

import {
  AGENTS,
  agentLabel,
  type Agent,
  type ConversationItem,
  type ImportCatalog,
  type ImportCatalogEntry,
  type ImportHistoryResult,
  type ImportSessionPreview,
  type ImportWorkspaceInspection,
} from "../../application/index.js";
import {
  cleanTerminalText,
  columns,
  displayWidth,
  ImportTerminal,
  padDisplay,
  truncateDisplay,
  wrapDisplay,
  type TerminalKey,
} from "./terminal.js";
import { paint, type TerminalRole } from "../style.js";
import {
  importWizardCopy,
  toggleImportWizardLanguage,
  type ImportWizardCopy,
  type ImportWizardLanguage,
} from "./copy.js";

const REVIEW_WORKSPACE_MAX_WIDTH = 80;

export interface ImportWizardRequest {
  readonly sessions: readonly string[];
  readonly sessionTargets: Readonly<Record<string, Agent>>;
  readonly pathMappings: readonly string[];
  readonly providerPolicy: string;
  readonly codexHome?: string;
  readonly opencodeDataRoot?: string;
  readonly claudeConfigRoot?: string;
  readonly piSessionRoot?: string;
}

export interface ImportWizardOptions {
  readonly catalog: ImportCatalog;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly agents?: readonly Agent[];
  readonly sessions: readonly string[];
  readonly targetAgent?: Agent;
  readonly pathMappings: readonly string[];
  readonly providerPolicy: string;
  readonly codexHome?: string;
  readonly opencodeDataRoot?: string;
  readonly claudeConfigRoot?: string;
  readonly piSessionRoot?: string;
  readonly color?: boolean;
  readonly language?: ImportWizardLanguage;
  resolveCodexCurrentProvider(): Promise<string>;
  listCodexProviders(): Promise<readonly ImportWizardCodexProvider[]>;
  execute(mode: "dry_run" | "apply", request: ImportWizardRequest): Promise<ImportHistoryResult>;
}

export interface ImportWizardCodexProvider {
  readonly provider: string;
  readonly sessions: number;
}

export type ImportWizardOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "completed"; readonly result: ImportHistoryResult };

interface MutableRoots {
  codex?: string;
  opencode?: string;
  claude?: string;
  pi?: string;
}

interface WizardState {
  readonly explicit: Set<string>;
  readonly targets: Map<string, Agent>;
  readonly pathMappings: string[];
  readonly roots: MutableRoots;
  codexCurrentProvider?: string;
  codexProviders?: readonly ImportWizardCodexProvider[];
  providerPolicy: string;
  query: string;
  reviewNotice?: { readonly blocked: number; readonly related: number };
}

interface ScopeAllRow {
  readonly kind: "all";
  readonly key: "all";
  readonly label: string;
  readonly entries: readonly ImportCatalogEntry[];
}

interface ScopeAgentRow {
  readonly kind: "agent";
  readonly key: string;
  readonly agent: Agent;
  readonly label: string;
  readonly entries: readonly ImportCatalogEntry[];
  readonly workspaceLabels: ReadonlyMap<string, string>;
}

interface ScopeWorkspaceRow {
  readonly kind: "workspace";
  readonly key: string;
  readonly agent: Agent;
  readonly label: string;
  readonly workspace: string;
  readonly entries: readonly ImportCatalogEntry[];
}

type ScopeRow = ScopeAllRow | ScopeAgentRow | ScopeWorkspaceRow;
type BrowserPane = "scopes" | "sessions";
type ScreenMove = "next" | "back" | "cancel" | "refresh";
type KeyHint = readonly [key: string, action: string];
type FooterHints = readonly [readonly KeyHint[], readonly KeyHint[]];

function copyFor(terminal: ImportTerminal): ImportWizardCopy {
  return importWizardCopy(terminal.language);
}

function switchLanguage(terminal: ImportTerminal, key: TerminalKey): boolean {
  if (key.name !== "l") return false;
  terminal.language = toggleImportWizardLanguage(terminal.language);
  return true;
}

function languageHint(terminal: ImportTerminal): KeyHint {
  return ["l", copyFor(terminal).actions.switchLanguage];
}

function oneLine(value: string, maximum: number): string {
  return truncateDisplay(cleanTerminalText(value).replace(/\s+/g, " ").trim() || "(untitled)", maximum);
}

function compactUpdated(value: string): string {
  return value.slice(0, 16).replace("T", " ");
}

function filteredEntries(entries: readonly ImportCatalogEntry[], query: string): readonly ImportCatalogEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return entries;
  return entries.filter((entry) => [entry.title, entry.sessionRef, entry.nativeId, entry.workspace, entry.model]
    .some((value) => value.toLocaleLowerCase().includes(needle)));
}

function normalizedWorkspace(value: string): string {
  const normalized = value.replace(/[\\/]+$/u, "");
  return normalized === "" ? value : normalized;
}

function workspaceParts(value: string): readonly string[] {
  return normalizedWorkspace(value).split(/[\\/]+/u).filter((part) => part !== "");
}

function uniqueWorkspaceLabels(workspaces: readonly string[]): ReadonlyMap<string, string> {
  const parts = new Map(workspaces.map((workspace) => [workspace, workspaceParts(workspace)]));
  return new Map(workspaces.map((workspace) => {
    const own = parts.get(workspace)!;
    if (own.length === 0) return [workspace, workspace] as const;
    for (let depth = 1; depth <= own.length; depth++) {
      const suffix = own.slice(-depth).join("/");
      const unique = workspaces.every((other) =>
        other === workspace || parts.get(other)!.slice(-depth).join("/") !== suffix);
      if (unique) {
        return [workspace, depth === own.length ? normalizedWorkspace(workspace) : `.../${suffix}`] as const;
      }
    }
    return [workspace, normalizedWorkspace(workspace)] as const;
  }));
}

function truncatePathStart(value: string, maximum: number): string {
  if (displayWidth(value) <= maximum) return value;
  if (maximum <= 3) return ".".repeat(Math.max(0, maximum));
  const available = maximum - 3;
  let suffix = "";
  let used = 0;
  for (const character of [...value].reverse()) {
    const next = displayWidth(character);
    if (used + next > available) break;
    suffix = character + suffix;
    used += next;
  }
  return `...${suffix}`;
}

function workspaceDisplay(scope: ScopeWorkspaceRow, maximum: number): string {
  const full = normalizedWorkspace(scope.workspace);
  const preferred = displayWidth(full) <= maximum ? full : scope.label;
  return truncatePathStart(preferred, maximum);
}

function sortedSessions(entries: readonly ImportCatalogEntry[]): readonly ImportCatalogEntry[] {
  return [...entries].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title));
}

function buildScopeRows(
  entries: readonly ImportCatalogEntry[],
  copy: ImportWizardCopy,
  query = "",
): readonly ScopeRow[] {
  const visible = sortedSessions(filteredEntries(entries, query));
  if (visible.length === 0) return [];
  const rows: ScopeRow[] = [{ kind: "all", key: "all", label: copy.common.allSessions, entries: visible }];
  for (const agent of AGENTS) {
    const agentEntries = visible.filter((entry) => entry.agent === agent);
    if (agentEntries.length === 0) continue;
    const workspaces = [...new Set(agentEntries.map((entry) => entry.workspace))].sort();
    const workspaceLabels = uniqueWorkspaceLabels(workspaces);
    rows.push({
      kind: "agent",
      key: `agent:${agent}`,
      agent,
      label: agentLabel(agent),
      entries: agentEntries,
      workspaceLabels,
    });
    for (const workspace of workspaces) {
      rows.push({
        kind: "workspace",
        key: `workspace:${agent}:${workspace}`,
        agent,
        label: workspaceLabels.get(workspace)!,
        workspace,
        entries: agentEntries.filter((entry) => entry.workspace === workspace),
      });
    }
  }
  return rows;
}

function closedSelection(catalog: ImportCatalog, explicit: ReadonlySet<string>): readonly ImportCatalogEntry[] {
  return explicit.size === 0 ? [] : catalog.closeSelection([...explicit]);
}

function excludeBlockedSelection(
  catalog: ImportCatalog,
  explicit: Set<string>,
  blockedReferences: ReadonlySet<string>,
): { readonly blocked: number; readonly removed: number } {
  const before = closedSelection(catalog, explicit);
  for (const reference of blockedReferences) explicit.delete(reference);

  const stillRequired = new Set(
    closedSelection(catalog, explicit)
      .map((entry) => entry.sessionRef)
      .filter((reference) => blockedReferences.has(reference)),
  );
  if (stillRequired.size > 0) {
    for (const reference of [...explicit]) {
      if (catalog.closeSelection([reference]).some((entry) => stillRequired.has(entry.sessionRef))) {
        explicit.delete(reference);
      }
    }
  }

  const after = closedSelection(catalog, explicit);
  return {
    blocked: before.filter((entry) => blockedReferences.has(entry.sessionRef)).length,
    removed: before.length - after.length,
  };
}

function targetRecord(
  selected: readonly ImportCatalogEntry[],
  targets: ReadonlyMap<string, Agent>,
): Readonly<Record<string, Agent>> {
  return Object.fromEntries(selected.map((entry) => [entry.sessionRef, targets.get(entry.sessionRef) ?? entry.agent]));
}

function replaceMapping(mappings: string[], source: string, target: string): void {
  const prefix = `${source}=`;
  const index = mappings.findIndex((mapping) => mapping.startsWith(prefix));
  if (index < 0) mappings.push(`${source}=${target}`);
  else mappings[index] = `${source}=${target}`;
}

function removeMapping(mappings: string[], source: string): void {
  const prefix = `${source}=`;
  const index = mappings.findIndex((mapping) => mapping.startsWith(prefix));
  if (index >= 0) mappings.splice(index, 1);
}

function applicableMappings(
  mappings: readonly string[],
  selected: readonly ImportCatalogEntry[],
): readonly string[] {
  const workspaces = selected.map((entry) => path.normalize(entry.workspace));
  return mappings.filter((mapping) => {
    const separator = mapping.indexOf("=");
    if (separator < 1) return true;
    const source = path.normalize(mapping.slice(0, separator));
    return workspaces.some((workspace) => workspace === source || workspace.startsWith(`${source}${path.sep}`));
  });
}

function interrupted(key: TerminalKey): boolean {
  return key.ctrl && key.name === "c";
}

function moveCursor(current: number, key: TerminalKey, total: number, page: number): number {
  if (total === 0) return 0;
  if (key.name === "up" || key.name === "k") return Math.max(0, current - 1);
  if (key.name === "down" || key.name === "j") return Math.min(total - 1, current + 1);
  if (key.name === "pageup") return Math.max(0, current - page);
  if (key.name === "pagedown") return Math.min(total - 1, current + page);
  if (key.name === "home") return 0;
  if (key.name === "end") return total - 1;
  return current;
}

function windowAround<T>(items: readonly T[], cursor: number, limit: number): {
  readonly items: readonly T[];
  readonly start: number;
} {
  const size = Math.max(1, limit);
  const maximumStart = Math.max(0, items.length - size);
  const start = Math.min(maximumStart, Math.max(0, cursor - Math.floor(size / 2)));
  return { items: items.slice(start, start + size), start };
}

function progressLine(step: number, width: number, color: boolean, copy: ImportWizardCopy): string {
  const full = copy.steps.map((label, index) => {
    const value = `${index + 1} ${label}`;
    if (index === step) return paint(`[${value}]`, "step_current", color);
    if (index < step) return paint(value, "step_complete", color);
    return paint(value, "step_pending", color);
  }).join("  >  ");
  if (displayWidth(full) <= width) return full;
  return paint(`[${step + 1}/${copy.steps.length} ${copy.steps[step]}]`, "step_current", color);
}

function contentRows(terminal: ImportTerminal): number {
  return Math.max(3, terminal.height - 9);
}

function frameLines(
  terminal: ImportTerminal,
  color: boolean,
  step: number,
  title: string,
  summary: string,
  body: readonly string[],
  footers: FooterHints,
  notice?: string,
): string[] {
  const copy = copyFor(terminal);
  const width = terminal.width;
  const capacity = contentRows(terminal);
  const visibleBody = body.slice(0, capacity);
  const padding = Array.from({ length: capacity - visibleBody.length }, () => "");
  const heading = columns(title, summary, width);
  return [
    paint(copy.brand, "brand", color),
    progressLine(step, width, color, copy),
    "",
    paint(heading, "heading", color),
    "",
    ...visibleBody,
    ...padding,
    paint("-".repeat(Math.min(width, 120)), "divider", color),
    notice === undefined ? "" : paint(truncateDisplay(notice, width), "warning", color),
    renderHintLine(footers[0], width, color),
    renderHintLine(footers[1], width, color),
  ];
}

function renderHintLine(hints: readonly KeyHint[], width: number, color: boolean): string {
  let result = "";
  let used = 0;
  for (const [key, action] of hints) {
    const separator = result === "" ? "" : "  ";
    const keyText = `[${key}]`;
    const available = width - used - displayWidth(separator) - displayWidth(keyText) - 1;
    if (available <= 0) break;
    const actionText = truncateDisplay(action, available);
    result += separator + paint(keyText, "hint", color) + ` ${actionText}`;
    used += displayWidth(separator) + displayWidth(keyText) + 1 + displayWidth(actionText);
    if (actionText !== action) break;
  }
  return result;
}

function drawFrame(
  terminal: ImportTerminal,
  color: boolean,
  step: number,
  title: string,
  summary: string,
  body: readonly string[],
  footers: FooterHints,
  notice?: string,
): void {
  terminal.draw(frameLines(terminal, color, step, title, summary, body, footers, notice));
}

function promptFrame(
  terminal: ImportTerminal,
  color: boolean,
  step: number,
  title: string,
  details: readonly string[],
  prompt: string,
  value: string,
): readonly string[] {
  const copy = copyFor(terminal);
  const width = terminal.width;
  const available = Math.max(8, width - prompt.length);
  const shown = truncateDisplay(value, available);
  return [
    paint(copy.brand, "brand", color),
    progressLine(step, width, color, copy),
    "",
    paint(truncateDisplay(title, width), "heading", color),
    "",
    ...details.flatMap((line) => wrapDisplay(line, width)).slice(0, Math.max(1, terminal.height - 9)),
    "",
    paint(copy.common.editHelp, "muted", color),
    `${prompt}${shown}`,
  ].slice(0, terminal.height);
}

function styledColumns(
  left: string,
  right: string,
  width: number,
  leftRole: TerminalRole,
  rightRole: TerminalRole,
  color: boolean,
): string {
  const layout = columnLayout(right, width);
  const leftText = padDisplay(truncateDisplay(left, layout.leftWidth), layout.leftWidth);
  return paint(leftText, leftRole, color) +
    (layout.rightText === "" ? "" : `  ${paint(layout.rightText, rightRole, color)}`);
}

function statusColumnsLine(
  left: string,
  right: string,
  width: number,
  leftRole: TerminalRole,
  rightRole: TerminalRole,
  color: boolean,
  focused: boolean,
  retained = false,
): string {
  const innerWidth = Math.max(1, width - 2);
  const layout = columnLayout(right, innerWidth);
  const leftText = padDisplay(truncateDisplay(left, layout.leftWidth), layout.leftWidth);
  const separator = layout.rightText === "" ? "" : "  ";
  if (focused) {
    if (!color) return `> ${leftText}${separator}${layout.rightText}`;
    return paint(`  ${leftText}${separator}`, "focus", true) +
      paint(layout.rightText, rightRole, true);
  }
  if (retained) {
    if (!color) return `  ${leftText}${separator}${layout.rightText}`;
    return `  ${paint(leftText, "context", true)}` + separator +
      paint(layout.rightText, rightRole, true);
  }
  return `  ${paint(leftText, leftRole, color)}${separator}${paint(layout.rightText, rightRole, color)}`;
}

function columnLayout(right: string, width: number): { readonly leftWidth: number; readonly rightText: string } {
  const rightText = truncateDisplay(right, Math.max(0, Math.floor(width * 0.42)));
  const rightWidth = rightText === "" ? 0 : Math.max(1, displayWidth(rightText));
  return {
    leftWidth: rightText === "" ? width : Math.max(1, width - rightWidth - 2),
    rightText,
  };
}

function focusedLine(content: string, active: boolean, width: number, color: boolean): string {
  const available = Math.max(1, width - 2);
  const plain = truncateDisplay(content, available);
  if (!active) return `  ${content}`;
  if (!color) return `> ${plain}`;
  return paint(padDisplay(`  ${plain}`, width), "focus", true);
}

function paneCursorLine(
  content: string,
  focused: boolean,
  width: number,
  color: boolean,
): string {
  if (focused) return focusedLine(content, true, width, color);
  return `  ${content}`;
}

function paneWidths(width: number): { readonly left: number; readonly right: number } {
  const left = Math.min(44, Math.max(28, Math.floor(width * 0.4)));
  return { left, right: Math.max(1, width - left - 3) };
}

function paneHeading(label: string, active: boolean, width: number, color: boolean): string {
  const text = padDisplay(truncateDisplay(label, width), width);
  return paint(text, active ? "pane_heading" : "strong", color);
}

function joinedPaneLine(left: string, right: string, leftWidth: number, rightWidth: number, color: boolean): string {
  return `${padDisplay(left, leftWidth)} ${paint("|", "divider", color)} ${padDisplay(right, rightWidth)}`;
}

function browserBody(
  terminal: ImportTerminal,
  color: boolean,
  activePane: BrowserPane,
  leftTitle: string,
  rightTitle: string,
  leftRows: number,
  rightRows: number,
  leftCursor: number,
  rightCursor: number,
  renderLeft: (index: number, width: number, focused: boolean, retained: boolean) => string,
  renderRight: (index: number, width: number, focused: boolean, retained: boolean) => string,
  status: string,
): readonly string[] {
  const dual = terminal.width >= 76;
  const listCapacity = Math.max(1, contentRows(terminal) - 3);
  const leftView = windowAround(Array.from({ length: leftRows }, (_, index) => index), leftCursor, listCapacity);
  const rightView = windowAround(Array.from({ length: rightRows }, (_, index) => index), rightCursor, listCapacity);
  if (!dual) {
    const scopes = activePane === "scopes";
    const view = scopes ? leftView : rightView;
    const cursor = scopes ? leftCursor : rightCursor;
    const body = view.items.map((index) => scopes
      ? renderLeft(index, terminal.width, index === cursor, false)
      : renderRight(index, terminal.width, index === cursor, false));
    return [
      paneHeading(scopes ? leftTitle : rightTitle, true, terminal.width, color),
      paint("-".repeat(terminal.width), "divider", color),
      ...body,
      ...Array.from({ length: listCapacity - body.length }, () => ""),
      paint(truncateDisplay(status, terminal.width), "muted", color),
    ];
  }
  const widths = paneWidths(terminal.width);
  const body = [
    joinedPaneLine(
      paneHeading(leftTitle, activePane === "scopes", widths.left, color),
      paneHeading(rightTitle, activePane === "sessions", widths.right, color),
      widths.left,
      widths.right,
      color,
    ),
    joinedPaneLine(
      paint("-".repeat(widths.left), "divider", color),
      paint("-".repeat(widths.right), "divider", color),
      widths.left,
      widths.right,
      color,
    ),
  ];
  for (let offset = 0; offset < listCapacity; offset++) {
    const leftIndex = leftView.items[offset];
    const rightIndex = rightView.items[offset];
    body.push(joinedPaneLine(
      leftIndex === undefined
        ? ""
        : renderLeft(leftIndex, widths.left, activePane === "scopes" && leftIndex === leftCursor,
          activePane !== "scopes" && leftIndex === leftCursor),
      rightIndex === undefined
        ? ""
        : renderRight(rightIndex, widths.right, activePane === "sessions" && rightIndex === rightCursor,
          false),
      widths.left,
      widths.right,
      color,
    ));
  }
  body.push(paint(truncateDisplay(status, terminal.width), "muted", color));
  return body;
}

function scopeContext(
  scope: ScopeRow,
  copy: ImportWizardCopy,
  maximum = Number.MAX_SAFE_INTEGER,
): string {
  if (scope.kind === "all") return copy.common.allSessions;
  if (scope.kind === "agent") return agentLabel(scope.agent);
  const prefix = `${agentLabel(scope.agent)}: `;
  return `${prefix}${workspaceDisplay(scope, Math.max(1, maximum - displayWidth(prefix)))}`;
}

function sessionPaneTitle(terminal: ImportTerminal, scope: ScopeRow, copy: ImportWizardCopy): string {
  const paneWidth = terminal.width >= 76 ? paneWidths(terminal.width).right : terminal.width;
  const prefix = `${copy.common.sessions} · `;
  return `${prefix}${scopeContext(scope, copy, Math.max(1, paneWidth - displayWidth(prefix)))}`;
}

function scopeStatus(scope: ScopeRow, copy: ImportWizardCopy, query = ""): string {
  const context = scope.kind === "workspace" ? scope.workspace : scopeContext(scope, copy);
  return query === "" ? copy.selection.scopeStatus(context) : copy.selection.searchStatus(query, context);
}

function sessionLabel(entry: ImportCatalogEntry, scope: ScopeRow): string {
  if (scope.kind === "all") return `${agentLabel(entry.agent)}: ${entry.title}`;
  if (scope.kind === "agent") {
    return `${scope.workspaceLabels.get(entry.workspace) ?? normalizedWorkspace(entry.workspace)}: ${entry.title}`;
  }
  return entry.title;
}

function renderSelectionScope(
  scope: ScopeRow,
  selected: ReadonlySet<string>,
  focused: boolean,
  retained: boolean,
  width: number,
  color: boolean,
): string {
  const count = scope.entries.filter((entry) => selected.has(entry.sessionRef)).length;
  const right = `${count}/${scope.entries.length}`;
  const innerWidth = Math.max(1, width - 2);
  const label = scope.kind === "workspace"
    ? `  ${workspaceDisplay(scope, Math.max(1, columnLayout(right, innerWidth).leftWidth - 2))}`
    : scope.label;
  return statusColumnsLine(
    label,
    right,
    width,
    scope.kind === "workspace" ? "plain" : "strong",
    "muted",
    color,
    focused,
    retained,
  );
}

function renderSelectionSession(
  entry: ImportCatalogEntry,
  scope: ScopeRow,
  explicit: ReadonlySet<string>,
  selected: ReadonlySet<string>,
  focused: boolean,
  _retained: boolean,
  width: number,
  color: boolean,
): string {
  const marker = explicit.has(entry.sessionRef) ? "✓" : selected.has(entry.sessionRef) ? "*" : " ";
  const markerRole = marker === "✓" ? "selected" : marker === "*" ? "info" : "plain";
  const content = styledColumns(
    `[${marker}] ${sessionLabel(entry, scope)}`,
    compactUpdated(entry.updatedAt),
    Math.max(1, width - 2),
    markerRole,
    "muted",
    color,
  );
  return paneCursorLine(content, focused, width, color);
}

function toggleEntries(explicit: Set<string>, entries: readonly ImportCatalogEntry[]): void {
  const remove = entries.every((entry) => explicit.has(entry.sessionRef));
  for (const entry of entries) {
    if (remove) explicit.delete(entry.sessionRef);
    else explicit.add(entry.sessionRef);
  }
}

function blockSummary(
  item: Extract<ConversationItem, { readonly kind: "message" }>,
  copy: ImportWizardCopy,
): string[] {
  return (item.portableBlocks ?? []).flatMap((block) => {
    if (block.kind === "text") return [];
    if (block.kind === "historical_tool") {
      const identity = [block.tool.namespace, block.tool.name].filter((value) => value !== undefined).join("/");
      return [copy.preview.foldedTool(block.tool.phase, identity)];
    }
    if (block.kind === "historical_resource") return [copy.preview.foldedResource(block.resource.name)];
    if (block.kind === "historical_reference") return [copy.preview.foldedReference];
    if (block.kind === "historical_reasoning" || block.kind === "historical_reasoning_trace") {
      return [copy.preview.foldedReasoning];
    }
    if (block.kind === "historical_event") return [copy.preview.historicalEvent(block.event)];
    return [copy.preview.foldedBlock(block.kind.replaceAll("_", " "))];
  });
}

function compactReference(value: string, maximum = 52): string {
  if (displayWidth(value) <= maximum) return value;
  const suffix = value.slice(-16);
  return `${value.slice(0, Math.max(8, maximum - suffix.length - 3))}...${suffix}`;
}

function metadataLines(
  label: string,
  value: string,
  width: number,
  color: boolean,
  valueRole: TerminalRole = "plain",
): string[] {
  const labelWidth = 11;
  const wrapped = wrapDisplay(value, Math.max(10, width - labelWidth));
  return wrapped.map((line, index) =>
    paint(index === 0 ? padDisplay(label, labelWidth) : " ".repeat(labelWidth), "muted", color) +
    paint(line, valueRole, color));
}

function previewFactLines(
  updated: string,
  model: string,
  width: number,
  color: boolean,
  copy: ImportWizardCopy,
): string[] {
  const combined = paint(padDisplay(copy.common.updated, 11), "muted", color) + updated +
    "    " + paint(padDisplay(copy.common.model, 7), "muted", color) + model;
  if (displayWidth(combined) <= width) return [combined];
  return [
    ...metadataLines(copy.common.updated, updated, width, color),
    ...metadataLines(copy.common.model, model, width, color),
  ];
}

function conversationLines(
  conversation: readonly ConversationItem[],
  agent: Agent,
  width: number,
  color: boolean,
  copy: ImportWizardCopy,
): string[] {
  const result: string[] = [];
  for (const item of conversation) {
    if (item.kind === "gap") {
      result.push(paint(`${copy.preview.gap}  ${oneLine(item.label, Math.max(1, width - 5))}`, "warning_strong", color));
      result.push("");
      continue;
    }
    const role = item.role === "user"
      ? copy.preview.you
      : item.role === "assistant" ? agentLabel(agent).toUpperCase() : item.role.toUpperCase();
    const roleStyle: TerminalRole = item.role === "user"
      ? "message_user"
      : item.role === "assistant" ? "message_assistant" : "message_system";
    result.push(paint(role, roleStyle, color));
    const text = cleanTerminalText(item.text).trim();
    const bounded = text.length <= 2400 ? text : `${text.slice(0, 2400)}\n${copy.preview.messageTruncated}`;
    result.push(...wrapDisplay(bounded || copy.preview.emptyMessage, Math.max(1, width - 2)).map((line) => `  ${line}`));
    for (const summary of blockSummary(item, copy)) {
      result.push(...wrapDisplay(summary, Math.max(1, width - 4))
        .map((line) => paint(`    ${line}`, "muted", color)));
    }
    result.push("");
  }
  return result.length === 0 ? [copy.preview.noConversation] : result;
}

async function showPreview(
  terminal: ImportTerminal,
  options: ImportWizardOptions,
  step: number,
  entry: ImportCatalogEntry,
  target: Agent,
): Promise<"back" | "cancel"> {
  const color = options.color === true;
  let copy = copyFor(terminal);
  drawFrame(terminal, color, step, copy.preview.title, agentLabel(entry.agent),
    [copy.preview.loading], [[], [["Esc", copy.actions.back], languageHint(terminal)]]);
  const preview: ImportSessionPreview = await options.catalog.preview(entry.sessionRef);
  let scroll = 0;
  while (true) {
    copy = copyFor(terminal);
    const metadata = [
      paint(oneLine(preview.title, terminal.width), "strong", color),
      "",
      ...metadataLines(copy.common.workspace, preview.workspace, terminal.width, color),
      ...previewFactLines(
        compactUpdated(preview.updatedAt),
        preview.model || copy.common.unknown,
        terminal.width,
        color,
        copy,
      ),
      ...metadataLines(copy.common.reference, compactReference(preview.sessionRef), terminal.width, color, "muted"),
      ...(target === preview.agent
        ? []
        : metadataLines(
          copy.common.route,
          `${agentLabel(preview.agent)} -> ${agentLabel(target)}`,
          terminal.width,
          color,
          "warning",
        )),
      "",
      paint(copy.preview.conversation, "strong", color),
      "",
    ];
    const conversation = conversationLines(preview.conversation, preview.agent, terminal.width, color, copy);
    const capacity = contentRows(terminal);
    const fixed = metadata;
    const conversationCapacity = Math.max(1, capacity - fixed.length);
    scroll = Math.min(scroll, Math.max(0, conversation.length - conversationCapacity));
    const visible = conversation.slice(scroll, scroll + conversationCapacity);
    const remaining = Math.max(0, conversation.length - scroll - visible.length);
    drawFrame(
      terminal,
      color,
      step,
      copy.preview.title,
      agentLabel(preview.agent),
      [...fixed, ...visible],
      [[
        ["Up/Down", copy.actions.scroll],
        ["PgUp/PgDn", copy.actions.page],
      ], [["Esc", copy.actions.back], languageHint(terminal)]],
      remaining === 0 ? undefined : copy.preview.remainingLines(remaining),
    );
    const key = await terminal.key();
    if (interrupted(key)) return "cancel";
    if (key.name === "escape") return "back";
    if (switchLanguage(terminal, key)) continue;
    if (key.name === "up" || key.name === "k") scroll = Math.max(0, scroll - 1);
    if (key.name === "down" || key.name === "j") scroll = Math.min(conversation.length - 1, scroll + 1);
    if (key.name === "pageup") scroll = Math.max(0, scroll - conversationCapacity);
    if (key.name === "pagedown") scroll = Math.min(conversation.length - 1, scroll + conversationCapacity);
    if (key.name === "home") scroll = 0;
    if (key.name === "end") scroll = Math.max(0, conversation.length - conversationCapacity);
  }
}

async function selectSessionsScreen(
  terminal: ImportTerminal,
  options: ImportWizardOptions,
  allowed: readonly ImportCatalogEntry[],
  state: WizardState,
): Promise<ScreenMove> {
  const color = options.color === true;
  let activePane: BrowserPane = "scopes";
  let scopeCursor = -1;
  let sessionCursor = 0;
  let notice = state.reviewNotice === undefined
    ? undefined
    : copyFor(terminal).review.excluded(state.reviewNotice.blocked, state.reviewNotice.related);
  delete state.reviewNotice;
  while (true) {
    const copy = copyFor(terminal);
    const selected = closedSelection(options.catalog, state.explicit);
    const selectedReferences = new Set(selected.map((entry) => entry.sessionRef));
    for (const entry of selected) {
      if (!state.targets.has(entry.sessionRef)) state.targets.set(entry.sessionRef, options.targetAgent ?? entry.agent);
    }
    const scopes = buildScopeRows(allowed, copy, state.query);
    const required = selected.length - state.explicit.size;
    const summary = copy.selection.summary(state.explicit.size, required);
    const allSelected = allowed.every((entry) => state.explicit.has(entry.sessionRef));
    if (scopes.length === 0) {
      drawFrame(
        terminal,
        color,
        0,
        copy.selection.title,
        summary,
        [copy.selection.noMatches, "", copy.selection.searchStatus(state.query, copy.common.allSessions)],
        [[
          ["/", copy.actions.changeSearch],
          ["a", allSelected ? copy.actions.clearAll : copy.actions.selectAll],
          ["Enter", copy.actions.next],
        ], [["Esc", copy.actions.exit], languageHint(terminal)]],
        notice,
      );
      notice = undefined;
      const key = await terminal.key();
      if (interrupted(key) || key.name === "escape") return "cancel";
      if (switchLanguage(terminal, key)) continue;
      if (key.name === "return" || key.name === "enter") {
        if (selected.length > 0) return "next";
        notice = copy.selection.selectRequired;
      } else if (key.name === "a") {
        if (allSelected) state.explicit.clear();
        else for (const entry of allowed) state.explicit.add(entry.sessionRef);
      } else if (key.name === "/") {
        const value = await terminal.line((input) => promptFrame(
          terminal,
          color,
          0,
          copy.selection.searchTitle,
          [copy.selection.searchHelp],
          copy.selection.searchPrompt,
          input,
        ), state.query);
        if (value !== undefined) state.query = value;
      }
      continue;
    }
    if (scopeCursor < 0) {
      const firstWorkspace = scopes.findIndex((scope) => scope.kind === "workspace");
      scopeCursor = firstWorkspace < 0 ? 0 : firstWorkspace;
    }
    scopeCursor = Math.min(scopeCursor, scopes.length - 1);
    const scope = scopes[scopeCursor]!;
    const sessions = scope.entries;
    sessionCursor = Math.min(sessionCursor, Math.max(0, sessions.length - 1));
    const body = browserBody(
      terminal,
      color,
      activePane,
      copy.common.sources,
      sessionPaneTitle(terminal, scope, copy),
      scopes.length,
      sessions.length,
      scopeCursor,
      sessionCursor,
      (index, width, focused, retained) => renderSelectionScope(
        scopes[index]!, selectedReferences, focused, retained, width, color),
      (index, width, focused, retained) => renderSelectionSession(
        sessions[index]!, scope, state.explicit, selectedReferences, focused, retained, width, color),
      scopeStatus(scope, copy, state.query),
    );
    const footer: FooterHints = [[
      ["Left/Right", copy.actions.switchPane],
      ["Up/Down", copy.actions.move],
      ["Space", copy.actions.select],
      ["Enter", copy.actions.next],
    ], [
      ["/", copy.actions.search],
      ["a", allSelected ? copy.actions.clearAll : copy.actions.selectAll],
      ...(activePane === "sessions" ? [["v", copy.actions.preview] as KeyHint] : []),
      ["Esc", copy.actions.exit],
      languageHint(terminal),
    ]];
    drawFrame(
      terminal,
      color,
      0,
      copy.selection.title,
      summary,
      body,
      footer,
      notice,
    );
    notice = undefined;
    const key = await terminal.key();
    if (interrupted(key) || key.name === "escape") return "cancel";
    if (switchLanguage(terminal, key)) continue;
    if (key.name === "return" || key.name === "enter") {
      if (selected.length === 0) {
        notice = copy.selection.selectRequired;
        continue;
      }
      return "next";
    }
    if (key.name === "/") {
      const value = await terminal.line((input) => promptFrame(
        terminal,
        color,
        0,
        copy.selection.searchTitle,
        [copy.selection.searchHelp],
        copy.selection.searchPrompt,
        input,
      ), state.query);
      if (value !== undefined) {
        state.query = value;
        scopeCursor = -1;
        sessionCursor = 0;
      }
      continue;
    }
    if (key.name === "a") {
      if (allSelected) state.explicit.clear();
      else for (const entry of allowed) state.explicit.add(entry.sessionRef);
      continue;
    }
    if (key.name === "left") {
      activePane = "scopes";
      continue;
    }
    if (key.name === "right") {
      activePane = "sessions";
      continue;
    }
    const page = Math.max(1, contentRows(terminal) - 3);
    if (activePane === "scopes") {
      const moved = moveCursor(scopeCursor, key, scopes.length, page);
      if (moved !== scopeCursor) {
        scopeCursor = moved;
        sessionCursor = 0;
        continue;
      }
    } else {
      const moved = moveCursor(sessionCursor, key, sessions.length, page);
      if (moved !== sessionCursor) {
        sessionCursor = moved;
        continue;
      }
    }
    if (key.name === "space") {
      toggleEntries(state.explicit, activePane === "scopes" ? scope.entries : [sessions[sessionCursor]!]);
      continue;
    }
    if (key.name === "v") {
      if (activePane === "sessions") {
        const entry = sessions[sessionCursor]!;
        const move = await showPreview(
          terminal,
          options,
          0,
          entry,
          state.targets.get(entry.sessionRef) ?? entry.agent,
        );
        if (move === "cancel") return "cancel";
      } else {
        notice = copy.selection.previewPaneRequired;
      }
    }
  }
}

function targetOrder(source: Agent): readonly Agent[] {
  return [source, ...AGENTS.filter((agent) => agent !== source)];
}

function setTargetsForEntries(
  catalog: ImportCatalog,
  state: WizardState,
  selected: ReadonlySet<string>,
  entries: readonly ImportCatalogEntry[],
  target: Agent,
): void {
  for (const entry of entries) {
    for (const related of catalog.closeSelection([entry.sessionRef])) {
      if (selected.has(related.sessionRef)) state.targets.set(related.sessionRef, target);
    }
  }
}

function changedTargets(entries: readonly ImportCatalogEntry[], targets: ReadonlyMap<string, Agent>): number {
  return entries.filter((entry) => (targets.get(entry.sessionRef) ?? entry.agent) !== entry.agent).length;
}

function selectedCodexProvider(policy: string, currentProvider: string): string {
  if (policy === "current") return currentProvider;
  if (policy === "preserve") return "source providers";
  return policy;
}

function targetProviderSummary(provider: string, copy: ImportWizardCopy): string {
  const value = provider === "source providers" ? copy.common.sourceProviders : provider;
  return copy.targets.targetProvider(value);
}

async function ensureCodexCurrentProvider(options: ImportWizardOptions, state: WizardState): Promise<string> {
  if (state.codexCurrentProvider !== undefined) return state.codexCurrentProvider;
  const provider = (await options.resolveCodexCurrentProvider()).trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(provider)) {
    throw new Error("the current Codex provider could not be resolved to a valid provider ID");
  }
  state.codexCurrentProvider = provider;
  if (state.providerPolicy === "current") state.providerPolicy = provider;
  return provider;
}

interface CodexProviderRow {
  readonly kind: "provider" | "custom";
  readonly label: string;
  readonly value?: string;
  readonly sessions?: number;
}

function codexProviderRows(
  currentProvider: string,
  selectedProvider: string,
  providers: readonly ImportWizardCodexProvider[],
  copy: ImportWizardCopy,
): readonly CodexProviderRow[] {
  const counts = new Map<string, number>();
  for (const item of providers) {
    if (/^[A-Za-z0-9._-]+$/u.test(item.provider) && Number.isSafeInteger(item.sessions) && item.sessions >= 0) {
      counts.set(item.provider, item.sessions);
    }
  }
  if (!counts.has(currentProvider)) counts.set(currentProvider, 0);
  if (selectedProvider !== "source providers" && !counts.has(selectedProvider)) counts.set(selectedProvider, 0);
  const ids = [...counts.keys()].sort((left, right) => {
    if (left === currentProvider) return -1;
    if (right === currentProvider) return 1;
    return left.localeCompare(right);
  });
  return [
    ...ids.map((provider): CodexProviderRow => ({
      kind: "provider",
      label: provider,
      value: provider,
      sessions: counts.get(provider)!,
    })),
    ...(selectedProvider === "source providers"
      ? [{ kind: "provider", label: copy.providers.keepSource, value: "preserve" } as CodexProviderRow]
      : []),
    { kind: "custom", label: copy.providers.enterAnother },
  ];
}

async function chooseCodexProvider(
  terminal: ImportTerminal,
  color: boolean,
  currentProvider: string,
  selectedProvider: string,
  providers: readonly ImportWizardCodexProvider[],
): Promise<{ readonly status: "chosen"; readonly provider: string } | { readonly status: "back" | "cancel" }> {
  let rows = codexProviderRows(currentProvider, selectedProvider, providers, copyFor(terminal));
  let cursor = Math.max(0, rows.findIndex((row) =>
    row.value === (selectedProvider === "source providers" ? "preserve" : selectedProvider)));
  let notice: string | undefined;
  while (true) {
    const copy = copyFor(terminal);
    rows = codexProviderRows(currentProvider, selectedProvider, providers, copy);
    const capacity = contentRows(terminal);
    const view = windowAround(rows, cursor, capacity);
    const body = view.items.map((row, index) => {
      const rowIndex = view.start + index;
      const selected = row.value === (selectedProvider === "source providers" ? "preserve" : selectedProvider);
      const left = `${selected ? "✓" : " "} ${row.label}`;
      let right = "";
      if (row.value === currentProvider) right = copy.common.current;
      if (row.sessions !== undefined) {
        const count = copy.providers.existingSessions(row.sessions);
        right = right === "" ? count : `${right} · ${count}`;
      }
      const content = styledColumns(
        left,
        right,
        Math.max(1, terminal.width - 2),
        selected ? "selected" : "plain",
        "muted",
        color,
      );
      return focusedLine(content, rowIndex === cursor, terminal.width, color);
    });
    drawFrame(
      terminal,
      color,
      1,
      copy.providers.chooseTitle,
      copy.providers.currentMachine(currentProvider),
      body,
      [[
        ["Up/Down", copy.actions.move],
        ...(rows.length <= capacity ? [] : [["PgUp/PgDn", copy.actions.page] as KeyHint]),
        ["Enter", copy.actions.choose],
      ], [["Esc", copy.actions.cancel], languageHint(terminal)]],
      notice ?? (rows.length <= capacity
        ? undefined
        : copy.providers.pagePosition(view.start + 1, view.start + view.items.length, rows.length)),
    );
    notice = undefined;
    const key = await terminal.key();
    if (interrupted(key)) return { status: "cancel" };
    if (key.name === "escape") return { status: "back" };
    if (switchLanguage(terminal, key)) continue;
    if (key.name === "return" || key.name === "enter") {
      const row = rows[cursor]!;
      if (row.kind === "provider") return { status: "chosen", provider: row.value! };
      const value = await terminal.line((input) => promptFrame(
        terminal,
        color,
        1,
        copy.providers.enterTitle,
        [
          copy.providers.currentMachine(currentProvider),
          copy.providers.enterHelp,
        ],
        copy.providers.prompt,
        input,
      ));
      if (value === undefined) continue;
      if (/^[A-Za-z0-9._-]+$/u.test(value)) return { status: "chosen", provider: value };
      notice = copy.providers.invalid;
      continue;
    }
    cursor = moveCursor(cursor, key, rows.length, capacity);
  }
}

function sessionTargetDescription(
  entry: ImportCatalogEntry,
  targets: ReadonlyMap<string, Agent>,
  copy: ImportWizardCopy,
): { readonly label: string; readonly role: TerminalRole } {
  const target = targets.get(entry.sessionRef) ?? entry.agent;
  const native = target === entry.agent;
  return {
    label: `${agentLabel(target)} ${native ? copy.common.native : copy.common.convert}`,
    role: native ? "success" : "warning",
  };
}

function scopeTargetDescription(
  entries: readonly ImportCatalogEntry[],
  targets: ReadonlyMap<string, Agent>,
  copy: ImportWizardCopy,
): { readonly label: string; readonly role: TerminalRole } {
  if (entries.every((entry) => (targets.get(entry.sessionRef) ?? entry.agent) === entry.agent)) {
    return { label: copy.common.native, role: "success" };
  }
  const selectedTargets = new Set(entries.map((entry) => targets.get(entry.sessionRef) ?? entry.agent));
  if (selectedTargets.size !== 1) return { label: copy.common.mixed, role: "warning" };
  const target = [...selectedTargets][0]!;
  const includesNative = entries.some((entry) => entry.agent === target);
  return {
    label: `${includesNative ? "" : "-> "}${agentLabel(target)}${includesNative ? ` ${copy.common.mixed}` : ""}`,
    role: "warning",
  };
}

function renderTargetScope(
  scope: ScopeRow,
  state: WizardState,
  copy: ImportWizardCopy,
  focused: boolean,
  retained: boolean,
  width: number,
  color: boolean,
): string {
  const target = scopeTargetDescription(scope.entries, state.targets, copy);
  const innerWidth = Math.max(1, width - 2);
  const label = scope.kind === "workspace"
    ? `  ${workspaceDisplay(scope, Math.max(1, columnLayout(target.label, innerWidth).leftWidth - 2))}`
    : scope.label;
  return statusColumnsLine(
    label,
    target.label,
    width,
    scope.kind === "workspace" ? "plain" : "strong",
    target.role,
    color,
    focused,
    retained,
  );
}

function renderTargetSession(
  entry: ImportCatalogEntry,
  scope: ScopeRow,
  state: WizardState,
  copy: ImportWizardCopy,
  focused: boolean,
  _retained: boolean,
  width: number,
  color: boolean,
): string {
  const target = sessionTargetDescription(entry, state.targets, copy);
  return statusColumnsLine(
    sessionLabel(entry, scope),
    target.label,
    width,
    "plain",
    target.role,
    color,
    focused,
  );
}

function targetRouteLabel(entries: readonly ImportCatalogEntry[], target: Agent): string {
  const native = entries.filter((entry) => entry.agent === target).length;
  if (native === entries.length) return "native";
  if (native === 0) return "convert";
  return "native + convert";
}

async function chooseTargetAgent(
  terminal: ImportTerminal,
  color: boolean,
  entries: readonly ImportCatalogEntry[],
  targets: ReadonlyMap<string, Agent>,
): Promise<{ readonly status: "chosen"; readonly agent: Agent } | { readonly status: "back" | "cancel" }> {
  const sources = new Set(entries.map((entry) => entry.agent));
  const order = sources.size === 1 ? targetOrder([...sources][0]!) : AGENTS;
  const currentTargets = new Set(entries.map((entry) => targets.get(entry.sessionRef) ?? entry.agent));
  const current = currentTargets.size === 1 ? [...currentTargets][0] : undefined;
  let cursor = current === undefined ? 0 : Math.max(0, order.indexOf(current));
  while (true) {
    const copy = copyFor(terminal);
    const body = [
      paint(copy.targets.destinationCount(entries.length), "muted", color),
      "",
      ...order.map((agent, index) => {
        const route = targetRouteLabel(entries, agent);
        const routeLabel = route === "native"
          ? copy.common.native
          : route === "convert" ? copy.common.convert : copy.common.nativeAndConvert;
        return statusColumnsLine(
          `${agentLabel(agent)}${agent === current ? copy.common.currentMarker : ""}`,
          routeLabel,
          terminal.width,
          "plain",
          route === "native" ? "success" : "warning",
          color,
          index === cursor,
        );
      }),
    ];
    drawFrame(
      terminal,
      color,
      1,
      copy.targets.chooserTitle,
      current === undefined ? copy.targets.currentlyMixed : copy.targets.currentTarget(agentLabel(current)),
      body,
      [[
        ["Up/Down", copy.actions.move],
        ["Enter", copy.actions.choose],
      ], [["Esc", copy.actions.cancel], languageHint(terminal)]],
    );
    const key = await terminal.key();
    if (interrupted(key)) return { status: "cancel" };
    if (key.name === "escape") return { status: "back" };
    if (switchLanguage(terminal, key)) continue;
    if (key.name === "return" || key.name === "enter") {
      return { status: "chosen", agent: order[cursor]! };
    }
    cursor = moveCursor(cursor, key, order.length, order.length);
  }
}

async function chooseTargetsScreen(
  terminal: ImportTerminal,
  options: ImportWizardOptions,
  selected: readonly ImportCatalogEntry[],
  state: WizardState,
): Promise<ScreenMove> {
  const color = options.color === true;
  const selectedSet = new Set(selected.map((entry) => entry.sessionRef));
  let activePane: BrowserPane = "scopes";
  const initialScopes = buildScopeRows(selected, copyFor(terminal));
  let scopeCursor = Math.max(0, initialScopes.findIndex((scope) => scope.kind === "workspace"));
  let sessionCursor = 0;
  let notice: string | undefined;
  while (true) {
    const copy = copyFor(terminal);
    const scopes = buildScopeRows(selected, copy);
    scopeCursor = Math.min(scopeCursor, scopes.length - 1);
    const scope = scopes[scopeCursor]!;
    const sessions = scope.entries;
    sessionCursor = Math.min(sessionCursor, sessions.length - 1);
    const changed = changedTargets(selected, state.targets);
    const codexTargeted = selected.some((entry) => (state.targets.get(entry.sessionRef) ?? entry.agent) === "codex");
    const currentProvider = codexTargeted ? await ensureCodexCurrentProvider(options, state) : undefined;
    const provider = currentProvider === undefined
      ? undefined
      : selectedCodexProvider(state.providerPolicy, currentProvider);
    const body = browserBody(
      terminal,
      color,
      activePane,
      copy.common.scopes,
      sessionPaneTitle(terminal, scope, copy),
      scopes.length,
      sessions.length,
      scopeCursor,
      sessionCursor,
      (index, width, focused, retained) => renderTargetScope(
        scopes[index]!, state, copy, focused, retained, width, color),
      (index, width, focused, retained) => renderTargetSession(
        sessions[index]!, scope, state, copy, focused, retained, width, color),
      scopeStatus(scope, copy),
    );
    const routeSummary = changed === 0 ? copy.targets.allNative : copy.targets.crossAgentCount(changed);
    const summary = provider === undefined
      ? routeSummary
      : `${routeSummary} · ${targetProviderSummary(provider, copy)}`;
    const footer: FooterHints = [[
      ["Left/Right", copy.actions.switchPane],
      ["Up/Down", copy.actions.move],
      ["t", copy.actions.setTarget],
      ["Enter", copy.actions.next],
    ], [
      ...(activePane === "sessions" ? [["v", copy.actions.preview] as KeyHint] : []),
      ...(codexTargeted ? [["p", copy.actions.changeProvider] as KeyHint] : []),
      ["Esc", copy.actions.back],
      languageHint(terminal),
    ]];
    drawFrame(
      terminal,
      color,
      1,
      copy.targets.title,
      summary,
      body,
      footer,
      notice,
    );
    notice = undefined;
    const key = await terminal.key();
    if (interrupted(key)) return "cancel";
    if (key.name === "escape") return "back";
    if (switchLanguage(terminal, key)) continue;
    if (key.name === "return" || key.name === "enter") return "next";
    if (key.name === "left") {
      activePane = "scopes";
      continue;
    }
    if (key.name === "right") {
      activePane = "sessions";
      continue;
    }
    const page = Math.max(1, contentRows(terminal) - 3);
    if (activePane === "scopes") {
      const moved = moveCursor(scopeCursor, key, scopes.length, page);
      if (moved !== scopeCursor) {
        scopeCursor = moved;
        sessionCursor = 0;
        continue;
      }
    } else {
      const moved = moveCursor(sessionCursor, key, sessions.length, page);
      if (moved !== sessionCursor) {
        sessionCursor = moved;
        continue;
      }
    }
    if (key.name === "t") {
      const entries = activePane === "scopes" ? scope.entries : [sessions[sessionCursor]!];
      const choice = await chooseTargetAgent(terminal, color, entries, state.targets);
      if (choice.status === "cancel") return "cancel";
      if (choice.status === "chosen") {
        setTargetsForEntries(options.catalog, state, selectedSet, entries, choice.agent);
      }
      continue;
    }
    if (key.name === "v") {
      if (activePane === "sessions") {
        const entry = sessions[sessionCursor]!;
        const move = await showPreview(
          terminal,
          options,
          1,
          entry,
          state.targets.get(entry.sessionRef) ?? entry.agent,
        );
        if (move === "cancel") return "cancel";
      } else {
        notice = copy.targets.previewPaneRequired;
      }
      continue;
    }
    if (key.name === "p" && codexTargeted) {
      if (state.codexProviders === undefined) {
        drawFrame(
          terminal,
          color,
          1,
          copy.targets.readingProviders,
          copy.common.pleaseWait,
          [copy.targets.checkingProviders],
          [[], []],
        );
        state.codexProviders = await options.listCodexProviders();
      }
      const choice = await chooseCodexProvider(
        terminal,
        color,
        currentProvider!,
        provider!,
        state.codexProviders,
      );
      if (choice.status === "cancel") return "cancel";
      if (choice.status === "chosen") state.providerPolicy = choice.provider;
      continue;
    }
  }
}

function workspaceStatus(
  workspace: ImportWorkspaceInspection,
  copy: ImportWizardCopy,
): { readonly label: string; readonly role: TerminalRole } {
  if (workspace.availability !== "available") return { label: copy.workspaces.missing, role: "error_strong" };
  if (workspace.status === "mapped") return { label: copy.workspaces.mapped, role: "info" };
  return { label: copy.workspaces.unchanged, role: "success" };
}

function workspaceSummaryLine(
  source: string,
  status: { readonly label: string; readonly role: TerminalRole },
  count: string,
  active: boolean,
  width: number,
  color: boolean,
): string {
  const innerWidth = Math.max(1, width - 2);
  const summary = `${status.label} · ${count}`;
  const layout = columnLayout(summary, innerWidth);
  const sourceText = padDisplay(truncateDisplay(source, layout.leftWidth), layout.leftWidth);
  const separator = layout.rightText === "" ? "" : "  ";
  const styledSummary = layout.rightText === summary
    ? paint(status.label, status.role, color) + paint(` · ${count}`, "muted", color)
    : paint(layout.rightText, status.role, color);
  if (!active) return `  ${sourceText}${separator}${styledSummary}`;
  if (!color) return `> ${sourceText}${separator}${layout.rightText}`;
  return paint(`  ${sourceText}${separator}`, "focus", true) + styledSummary;
}

function renderWorkspace(
  workspace: ImportWorkspaceInspection,
  active: boolean,
  width: number,
  color: boolean,
  copy: ImportWizardCopy,
): string[] {
  const status = workspaceStatus(workspace, copy);
  const target = workspace.source === workspace.target ? copy.workspaces.samePath : `-> ${workspace.target}`;
  const count = copy.workspaces.sessionCount(workspace.sessionRefs.length);
  const first = workspaceSummaryLine(workspace.source, status, count, active, width, color);
  const targetWidth = Math.max(1, width - 6);
  const second = `    ${paint(truncateDisplay(target, targetWidth), "muted", color)}`;
  return [
    first,
    second,
  ];
}

async function mapWorkspacesScreen(
  terminal: ImportTerminal,
  options: ImportWizardOptions,
  selected: readonly ImportCatalogEntry[],
  state: WizardState,
): Promise<ScreenMove> {
  const color = options.color === true;
  const destinations = targetRecord(selected, state.targets);
  const sessionReferences = selected.map((entry) => entry.sessionRef);
  const inspect = (): Promise<readonly ImportWorkspaceInspection[]> =>
    options.catalog.inspectWorkspaces(sessionReferences, destinations, state.pathMappings);
  let cursor = 0;
  let notice: string | undefined;
  let copy = copyFor(terminal);
  drawFrame(
    terminal,
    color,
    2,
    copy.workspaces.title,
    copy.workspaces.checking,
    [copy.workspaces.inspecting],
    [[], [["Esc", copy.actions.back]]],
  );
  let workspaces = await inspect();
  while (true) {
    copy = copyFor(terminal);
    cursor = Math.min(cursor, Math.max(0, workspaces.length - 1));
    const rowCapacity = Math.max(1, Math.floor((contentRows(terminal) + 1) / 3));
    const view = windowAround(workspaces, cursor, rowCapacity);
    const body = view.items.flatMap((workspace, index) => [
      ...renderWorkspace(
        workspace,
        view.start + index === cursor,
        terminal.width,
        color,
        copy,
      ),
      ...(index === view.items.length - 1 ? [] : [""]),
    ]);
    const missing = workspaces.filter((workspace) => workspace.availability !== "available").length;
    const activeWorkspace = workspaces[cursor];
    const footer: FooterHints = [[
      ["Up/Down", copy.actions.move],
      ["e", copy.actions.editMapping],
      ...(activeWorkspace?.status === "mapped" ? [["u", copy.actions.removeMapping] as KeyHint] : []),
      ["Enter", copy.actions.review],
    ], [["Esc", copy.actions.back], languageHint(terminal)]];
    drawFrame(
      terminal,
      color,
      2,
      copy.workspaces.title,
      missing === 0 ? copy.workspaces.readyCount(workspaces.length) : copy.workspaces.missingCount(missing),
      body.length === 0 ? [copy.workspaces.noneRequired] : body,
      footer,
      notice,
    );
    notice = undefined;
    const key = await terminal.key();
    if (interrupted(key)) return "cancel";
    if (key.name === "escape") return "back";
    if (switchLanguage(terminal, key)) continue;
    if (key.name === "return" || key.name === "enter") {
      const unresolved = workspaces.findIndex((workspace) => workspace.availability !== "available");
      if (unresolved >= 0) {
        cursor = unresolved;
        notice = copy.workspaces.resolveAll;
        continue;
      }
      return "next";
    }
    const moved = moveCursor(cursor, key, workspaces.length, rowCapacity);
    if (moved !== cursor) {
      cursor = moved;
      continue;
    }
    const workspace = workspaces[cursor];
    if (workspace === undefined) continue;
    if (key.name === "u") {
      removeMapping(state.pathMappings, workspace.source);
      workspaces = await inspect();
      continue;
    }
    if (key.name === "e") {
      const value = await terminal.line((input) => promptFrame(
        terminal,
        color,
        2,
        copy.workspaces.mapTitle,
        [
          `${copy.workspaces.source}: ${workspace.source}`,
          `${copy.workspaces.currentTarget}: ${workspace.target}`,
          copy.workspaces.mapHelp,
        ],
        copy.workspaces.targetPrompt,
        input,
      ));
      if (value !== undefined && value !== "") {
        replaceMapping(state.pathMappings, workspace.source, value);
        workspaces = await inspect();
      }
    }
  }
}

function importRequest(selected: readonly ImportCatalogEntry[], state: WizardState): ImportWizardRequest {
  return {
    sessions: selected.map((entry) => entry.sessionRef),
    sessionTargets: targetRecord(selected, state.targets),
    pathMappings: applicableMappings(state.pathMappings, selected),
    providerPolicy: state.providerPolicy,
    ...(state.roots.codex === undefined ? {} : { codexHome: state.roots.codex }),
    ...(state.roots.opencode === undefined ? {} : { opencodeDataRoot: state.roots.opencode }),
    ...(state.roots.claude === undefined ? {} : { claudeConfigRoot: state.roots.claude }),
    ...(state.roots.pi === undefined ? {} : { piSessionRoot: state.roots.pi }),
  };
}

function qualityRole(quality: ImportHistoryResult["routes"][number]["quality"]): TerminalRole {
  if (quality === "blocked") return "error_strong";
  if (quality === "degraded") return "warning_strong";
  return "success";
}

function reviewStatusSummary(plan: ImportHistoryResult, copy: ImportWizardCopy): string {
  if (plan.status === "blocked") {
    return copy.review.status("blocked", plan.newSessions, plan.blocked, 0);
  }
  if (plan.newSessions === 0) return copy.review.status("ready_empty", 0, 0, 0);
  const withLoss = plan.routes
    .filter((route) => route.quality === "degraded")
    .reduce((total, route) => total + route.sessions, 0);
  return copy.review.status("ready", plan.newSessions, 0, withLoss);
}

type ReviewFinding = ImportHistoryResult["routes"][number]["findings"][number];
type ReviewRoute = ImportHistoryResult["routes"][number];

interface ReviewRouteSession {
  readonly entry: ImportCatalogEntry;
  readonly quality: ReviewRoute["quality"] | undefined;
  readonly findings: readonly ReviewFinding[];
}

function reviewRouteSessions(
  plan: ImportHistoryResult,
  selected: readonly ImportCatalogEntry[],
  targets: ReadonlyMap<string, Agent>,
  route: ReviewRoute,
): ReviewRouteSession[] {
  const items = new Map(plan.items
    .filter((item) => item.sourceAgent === route.sourceAgent && item.targetAgent === route.targetAgent)
    .map((item) => [item.sourceSessionRef, item]));
  const blocked = new Map(plan.blockedSessions
    .filter((item) => item.sourceAgent === route.sourceAgent && item.targetAgent === route.targetAgent)
    .map((item) => [item.sourceSessionRef, item]));
  return selected
    .filter((entry) => entry.agent === route.sourceAgent &&
      (targets.get(entry.sessionRef) ?? entry.agent) === route.targetAgent)
    .map((entry) => {
      const item = items.get(entry.sessionRef);
      if (item !== undefined) return { entry, quality: item.quality, findings: item.findings };
      const blockedItem = blocked.get(entry.sessionRef);
      if (blockedItem !== undefined) {
        return { entry, quality: "blocked" as const, findings: blockedItem.findings };
      }
      return {
        entry,
        quality: route.sessions === 1 ? route.quality : undefined,
        findings: route.sessions === 1 ? route.findings : [],
      };
    });
}

function reviewQualityLabel(
  quality: ImportHistoryResult["routes"][number]["quality"],
  copy: ImportWizardCopy,
): string {
  return copy.review.quality(quality);
}

function findingImpactSummary(findings: readonly ReviewFinding[], copy: ImportWizardCopy): string {
  const counts = new Map<ReviewFinding["disposition"], number>();
  for (const finding of findings) {
    if (finding.disposition === "exact") continue;
    counts.set(finding.disposition, (counts.get(finding.disposition) ?? 0) + finding.count);
  }
  const dispositions: readonly ReviewFinding["disposition"][] = [
    "blocked",
    "degraded",
    "skipped",
    "synthesized",
  ];
  return dispositions.flatMap((disposition) => {
    const count = counts.get(disposition) ?? 0;
    if (count === 0) return [];
    return [copy.review.impactCount(disposition, count)];
  }).join(" · ");
}

function findingDetailLabel(
  disposition: ReviewFinding["disposition"],
  copy: ImportWizardCopy,
): string {
  return copy.review.finding(disposition);
}

function readableFindingCode(code: string): string {
  const parts = code.split(".");
  return (parts.length > 1 ? parts.slice(1) : parts).join(" ")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\bempty\b/gu, "missing")
    .replace(/\bunsupported\b/gu, "cannot be represented")
    .replace(/\bskipped\b/gu, "omitted")
    .replace(/\bsynthesized\b/gu, "reconstructed");
}

function blockedReason(findings: readonly ReviewFinding[], copy: ImportWizardCopy): string {
  const reasons = [...new Set(findings
    .filter((finding) => finding.disposition === "blocked")
    .map((finding) => readableFindingCode(finding.code)))];
  if (reasons.length === 0) return copy.review.blockedReasonFallback;
  return `${reasons.slice(0, 2).join("; ")}${reasons.length <= 2 ? "" : `; +${reasons.length - 2} more`}`;
}

function reviewDetailLines(
  label: string,
  value: string,
  width: number,
  color: boolean,
  valueRole: TerminalRole = "plain",
): string[] {
  const indent = "    ";
  const labelWidth = 11;
  const prefix = indent + padDisplay(label, labelWidth);
  const continuation = " ".repeat(displayWidth(prefix));
  return wrapDisplay(value, Math.max(10, width - displayWidth(prefix))).map((line, index) =>
    paint(index === 0 ? prefix : continuation, "muted", color) + paint(line, valueRole, color));
}

function reviewSectionHeading(
  label: string,
  width: number,
  color: boolean,
  role: TerminalRole = "section",
): string {
  const heading = truncateDisplay(label, width);
  const remaining = width - displayWidth(heading);
  if (remaining < 2) return paint(heading, role, color);
  const dividerRole = role === "error_strong" ? "error_divider" : "section_divider";
  return paint(heading, role, color) + paint(` ${"-".repeat(remaining - 1)}`, dividerRole, color);
}

function reviewPlanLines(
  plan: ImportHistoryResult,
  selected: readonly ImportCatalogEntry[],
  targets: ReadonlyMap<string, Agent>,
  width: number,
  color: boolean,
  copy: ImportWizardCopy,
  codexTargetProvider?: string,
  showDetails = false,
): string[] {
  const contentWidth = Math.min(width, 96);
  const mapped = plan.workspaces.filter((workspace) => workspace.status === "mapped").length;
  const unchanged = plan.workspaces.length - mapped;
  const overview = copy.review.overviewSummary(
    plan.selectedSessions,
    plan.blocked,
    plan.newSessions,
    plan.alreadyPresent,
  );
  const result = [
    reviewSectionHeading(copy.review.overview, contentWidth, color),
    ...wrapDisplay(overview, Math.max(1, contentWidth - 2)).map((line) => `  ${line}`),
  ];

  if (plan.blockedSessions.length > 0) {
    result.push(
      "",
      reviewSectionHeading(copy.review.blockedSessions(plan.blockedSessions.length), contentWidth, color, "error_strong"),
    );
    const selectedByReference = new Map(selected.map((entry) => [entry.sessionRef, entry]));
    plan.blockedSessions.forEach((session, index) => {
      const entry = selectedByReference.get(session.sourceSessionRef);
      if (entry === undefined) {
        result.push(...wrapDisplay(
          `${index + 1}. ${compactReference(session.sourceSessionRef)} (${agentLabel(session.sourceAgent)} -> ${agentLabel(session.targetAgent)})`,
          Math.max(1, contentWidth - 2),
        ).map((line) => paint(`  ${line}`, "strong", color)));
        return;
      }
      result.push(...wrapDisplay(`${index + 1}. ${entry.title || copy.common.untitled}`, Math.max(1, contentWidth - 2))
        .map((line) => paint(`  ${line}`, "strong", color)));
      result.push(
        ...reviewDetailLines(
          copy.common.route,
          `${agentLabel(session.sourceAgent)} -> ${agentLabel(session.targetAgent)}`,
          contentWidth,
          color,
        ),
        ...reviewDetailLines(copy.common.workspace, normalizedWorkspace(entry.workspace), contentWidth, color),
        ...reviewDetailLines(
          copy.common.updated,
          compactUpdated(entry.updatedAt),
          contentWidth,
          color,
          "muted",
        ),
        ...reviewDetailLines(copy.common.reason, blockedReason(session.findings, copy), contentWidth, color, "error"),
      );
    });
  }

  result.push("", reviewSectionHeading(copy.review.routes, contentWidth, color));
  const nativeRoutes = plan.routes.filter((route) =>
    route.sourceAgent === route.targetAgent && route.quality === "native");
  const convertedRoutes = plan.routes.filter((route) =>
    route.sourceAgent !== route.targetAgent || route.quality !== "native");
  if (nativeRoutes.length > 0) {
    const nativeSessions = nativeRoutes.reduce((total, route) => total + route.sessions, 0);
    result.push(
      styledColumns(
        `  ${copy.review.nativeImports}`,
        `${copy.review.itemCount(nativeSessions, "session")} · ${copy.review.quality("native")}`,
        contentWidth,
        "strong",
        "success",
        color,
      ),
      ...wrapDisplay(
        nativeRoutes.map((route) => `${agentLabel(route.targetAgent)} ${route.sessions}`).join(" · "),
        Math.max(1, contentWidth - 4),
      ).map((line) => paint(`    ${line}`, "success", color)),
    );
  }
  if (convertedRoutes.length > 0) {
    const convertedSessions = convertedRoutes.reduce((total, route) => total + route.sessions, 0);
    result.push(styledColumns(
      `  ${copy.review.conversions}`,
      copy.review.itemCount(convertedSessions, "session"),
      contentWidth,
      "strong",
      "muted",
      color,
    ));
  }
  for (const route of convertedRoutes) {
    const left = `    ${agentLabel(route.sourceAgent)} -> ${agentLabel(route.targetAgent)}`;
    const sessions = copy.review.itemCount(route.sessions, "session");
    const right = `${sessions} · ${reviewQualityLabel(route.quality, copy)}`;
    result.push(styledColumns(left, right, contentWidth, "plain", qualityRole(route.quality), color));
    const routeSessions = reviewRouteSessions(plan, selected, targets, route);
    if (showDetails && routeSessions.length > 0) {
      result.push(paint(`      ${copy.review.sessions}`, "muted", color));
      routeSessions.forEach((session, index) => {
        const quality = session.quality === undefined ? "" : reviewQualityLabel(session.quality, copy);
        result.push(styledColumns(
          `        ${index + 1}. ${session.entry.title || copy.common.untitled}`,
          quality,
          contentWidth,
          "plain",
          session.quality === undefined ? "plain" : qualityRole(session.quality),
          color,
        ));
        const prefix = `           ${padDisplay(copy.common.workspace, 11)}`;
        const workspace = normalizedWorkspace(session.entry.workspace);
        const workspaceWidth = Math.min(
          REVIEW_WORKSPACE_MAX_WIDTH,
          Math.max(1, contentWidth - displayWidth(prefix)),
        );
        result.push(
          paint(prefix, "muted", color) +
          paint(truncatePathStart(workspace, workspaceWidth), "muted", color),
        );
        const sessionFindings = session.findings.filter((item) => item.disposition !== "exact");
        const sessionImpact = findingImpactSummary(sessionFindings, copy);
        if (sessionImpact !== "") {
          result.push(
            paint(`           ${padDisplay(copy.review.impact, 11)}`, "muted", color) +
            paint(
              sessionImpact,
              sessionFindings.some((finding) => finding.disposition === "blocked") ? "error" : "warning",
              color,
            ),
          );
        }
        if (sessionFindings.length > 0) {
          result.push(paint(`           ${copy.review.technicalDetails}`, "muted", color));
          for (const finding of sessionFindings) {
            const text = `${findingDetailLabel(finding.disposition, copy)}  ${finding.code} · x${finding.count}`;
            result.push(...wrapDisplay(text, Math.max(1, contentWidth - 13))
              .map((line) => paint(
                `             ${line}`,
                finding.disposition === "blocked" ? "error" : "warning",
                color,
              )));
          }
        }
      });
    }
    const findings = route.findings.filter((item) => item.disposition !== "exact");
    const impact = findingImpactSummary(findings, copy);
    const hasSessionDetails = showDetails && routeSessions.length > 0;
    if (impact !== "" && !hasSessionDetails) {
      result.push(
        paint(`      ${padDisplay(copy.review.impact, 10)}`, "muted", color) +
        paint(impact, route.quality === "blocked" ? "error" : "warning", color),
      );
    }
    if (showDetails && findings.length > 0 && !hasSessionDetails) {
      result.push(paint(`      ${copy.review.technicalDetails}`, "muted", color));
      for (const finding of findings) {
        const text = `${findingDetailLabel(finding.disposition, copy)}  ${finding.code} · x${finding.count}`;
        result.push(...wrapDisplay(text, Math.max(1, contentWidth - 8))
          .map((line) => paint(`        ${line}`, finding.disposition === "blocked" ? "error" : "warning", color)));
      }
    }
  }

  if (codexTargetProvider !== undefined || plan.workspaces.length > 0 || plan.resources.length > 0) {
    result.push("", reviewSectionHeading(copy.review.targetSettings, contentWidth, color));
    if (codexTargetProvider !== undefined) {
      const provider = codexTargetProvider === "source providers" ? copy.common.sourceProviders : codexTargetProvider;
      result.push(...reviewDetailLines(copy.common.provider, `Codex · ${provider}`, contentWidth, color));
    }
    if (plan.workspaces.length > 0) {
      const workspaceSummary = [
        ...(mapped === 0 ? [] : [copy.review.mappedCount(mapped)]),
        ...(unchanged === 0 ? [] : [copy.review.unchangedCount(unchanged)]),
      ].join(" · ");
      result.push(...reviewDetailLines(copy.review.workspaces, workspaceSummary, contentWidth, color));
    }
    if (plan.resources.length > 0) {
      result.push(...reviewDetailLines(
        copy.common.resources,
        copy.review.itemCount(plan.resources.length, "item"),
        contentWidth,
        color,
      ));
    }
  }
  return result;
}

async function confirmApply(
  terminal: ImportTerminal,
  color: boolean,
  plan: ImportHistoryResult,
): Promise<"apply" | "back" | "cancel"> {
  while (true) {
    const copy = copyFor(terminal);
    const agentList = plan.agents.map((entry) => agentLabel(entry.agent)).join(", ");
    const destinations = agentList === "" ? copy.review.selectedAgentHistories : agentList;
    drawFrame(
      terminal,
      color,
      3,
      copy.review.confirmTitle,
      copy.review.confirmSummary(plan.newSessions, plan.alreadyPresent),
      [
        ...wrapDisplay(copy.review.applySummary(plan.newSessions, destinations), terminal.width),
        "",
        ...wrapDisplay(copy.review.confirmGuidance, terminal.width)
          .map((line) => paint(line, "muted", color)),
      ],
      [[
        ["Enter", copy.actions.apply],
      ], [["Esc", copy.actions.back], languageHint(terminal)]],
    );
    const key = await terminal.key();
    if (interrupted(key)) return "cancel";
    if (key.name === "escape") return "back";
    if (switchLanguage(terminal, key)) continue;
    if (key.name === "return" || key.name === "enter") return "apply";
  }
}

function preflightFailureLines(
  message: string,
  width: number,
  color: boolean,
  copy: ImportWizardCopy,
): string[] {
  const openCodeCompatibility = /OpenCode/iu.test(message) &&
    /(schema|column|primary key|identity|closure)/iu.test(message);
  const summary = openCodeCompatibility
    ? copy.review.openCodeFailure
    : copy.review.genericFailure;
  const guidance = openCodeCompatibility
    ? copy.review.openCodeGuidance
    : copy.review.genericGuidance;
  return [
    paint(summary, "error_strong", color),
    "",
    ...wrapDisplay(guidance, width),
    "",
    paint(copy.review.technicalDetail, "strong", color),
    ...wrapDisplay(message, width).map((line) => paint(line, "muted", color)),
  ];
}

async function reviewScreen(
  terminal: ImportTerminal,
  options: ImportWizardOptions,
  selected: readonly ImportCatalogEntry[],
  state: WizardState,
): Promise<ScreenMove | { readonly status: "completed"; readonly result: ImportHistoryResult }> {
  const color = options.color === true;
  const request = importRequest(selected, state);
  const reviewNotice = state.reviewNotice;
  delete state.reviewNotice;
  let copy = copyFor(terminal);
  const initialNotice = reviewNotice === undefined
    ? copy.review.runningPreflight
    : copy.review.excluded(reviewNotice.blocked, reviewNotice.related);
  drawFrame(
    terminal,
    color,
    3,
    copy.review.title,
    copy.review.preparing,
    [initialNotice],
    [[], [["Esc", copy.actions.back]]],
  );
  let plan: ImportHistoryResult;
  try {
    plan = await options.execute("dry_run", request);
  } catch (error) {
    const message = cleanTerminalText(error instanceof Error ? error.message : String(error));
    let scroll = 0;
    while (true) {
      copy = copyFor(terminal);
      const lines = preflightFailureLines(message, terminal.width, color, copy);
      const capacity = contentRows(terminal);
      scroll = Math.min(scroll, Math.max(0, lines.length - capacity));
      const body = lines.slice(scroll, scroll + capacity);
      const scrollable = lines.length > capacity;
      drawFrame(
        terminal,
        color,
        3,
        copy.review.preflightFailed,
        copy.review.noChangesWritten,
        body,
        [[...(scrollable ? [["Up/Down", copy.actions.scroll] as KeyHint] : [])], [
          ["Esc", copy.actions.back],
          languageHint(terminal),
        ]],
        scrollable ? copy.review.position(scroll + 1, scroll + body.length, lines.length) : undefined,
      );
      const key = await terminal.key();
      if (interrupted(key)) return "cancel";
      if (key.name === "escape") return "back";
      if (switchLanguage(terminal, key)) continue;
      if (key.name === "up" || key.name === "k") scroll = Math.max(0, scroll - 1);
      else if (key.name === "down" || key.name === "j") scroll = Math.min(lines.length - 1, scroll + 1);
      else if (key.name === "pageup") scroll = Math.max(0, scroll - capacity);
      else if (key.name === "pagedown") scroll = Math.min(lines.length - 1, scroll + capacity);
      else if (key.name === "home") scroll = 0;
      else if (key.name === "end") scroll = Math.max(0, lines.length - capacity);
    }
  }
  const codexTargeted = selected.some((entry) =>
    (state.targets.get(entry.sessionRef) ?? entry.agent) === "codex");
  const codexTargetProvider = codexTargeted && state.codexCurrentProvider !== undefined
    ? selectedCodexProvider(state.providerPolicy, state.codexCurrentProvider)
    : undefined;
  const hasDetails = plan.routes.some((route) =>
    route.findings.some((finding) => finding.disposition !== "exact"));
  let showDetails = false;
  let scroll = 0;
  while (true) {
    copy = copyFor(terminal);
    const planLines = reviewPlanLines(
      plan,
      selected,
      state.targets,
      terminal.width,
      color,
      copy,
      codexTargetProvider,
      showDetails,
    );
    const capacity = contentRows(terminal);
    scroll = Math.min(scroll, Math.max(0, planLines.length - capacity));
    const body = planLines.slice(scroll, scroll + capacity);
    const scrollable = planLines.length > capacity;
    const primaryHints: KeyHint[] = [
      ...(plan.status === "blocked" ? [["e", copy.actions.excludeBlocked] as KeyHint] : []),
      ...(plan.status === "blocked" ? [] : [["Enter", copy.actions.continue] as KeyHint]),
      ...(hasDetails ? [["d", showDetails ? copy.actions.hideDetails : copy.actions.showDetails] as KeyHint] : []),
      ...(scrollable
        ? [["Up/Down", copy.actions.scroll] as KeyHint, ["PgUp/PgDn", copy.actions.page] as KeyHint]
        : []),
    ];
    const position = scrollable ? ` · ${copy.review.position(scroll + 1, scroll + body.length, planLines.length)}` : "";
    const noticeText = reviewNotice === undefined
      ? ""
      : `${copy.review.excluded(reviewNotice.blocked, reviewNotice.related)} · `;
    const notice = `${noticeText}${copy.review.dryRunComplete}${position}`;
    drawFrame(
      terminal,
      color,
      3,
      columns(copy.review.title, reviewStatusSummary(plan, copy), Math.min(terminal.width, 96)),
      "",
      body,
      [primaryHints, [["Esc", copy.actions.back], languageHint(terminal)]],
      notice,
    );
    const key = await terminal.key();
    if (interrupted(key)) return "cancel";
    if (key.name === "escape") return "back";
    if (switchLanguage(terminal, key)) continue;
    if (key.name === "d" && hasDetails) {
      showDetails = !showDetails;
      if (!showDetails) {
        scroll = 0;
      } else {
        const detailedLines = reviewPlanLines(
          plan,
          selected,
          state.targets,
          terminal.width,
          color,
          copy,
          codexTargetProvider,
          true,
        );
        const firstDetail = detailedLines.findIndex((line) => {
          const label = cleanTerminalText(line).trim();
          return label === copy.review.sessions || label === copy.review.technicalDetails;
        });
        scroll = Math.max(0, firstDetail - 1);
      }
      continue;
    }
    if (key.name === "e" && plan.status === "blocked") {
      const excluded = excludeBlockedSelection(
        options.catalog,
        state.explicit,
        new Set(plan.blockedSessions.map((session) => session.sourceSessionRef)),
      );
      const related = Math.max(0, excluded.removed - excluded.blocked);
      state.reviewNotice = { blocked: excluded.blocked, related };
      return "refresh";
    }
    if (key.name === "up" || key.name === "k") scroll = Math.max(0, scroll - 1);
    else if (key.name === "down" || key.name === "j") scroll = Math.min(planLines.length - 1, scroll + 1);
    else if (key.name === "pageup") scroll = Math.max(0, scroll - capacity);
    else if (key.name === "pagedown") scroll = Math.min(planLines.length - 1, scroll + capacity);
    else if (key.name === "home") scroll = 0;
    else if (key.name === "end") scroll = Math.max(0, planLines.length - capacity);
    else if (key.name === "return" || key.name === "enter") {
      if (plan.status === "blocked") continue;
      const confirmation = await confirmApply(terminal, color, plan);
      if (confirmation === "cancel") return "cancel";
      if (confirmation === "back") continue;
      copy = copyFor(terminal);
      drawFrame(
        terminal,
        color,
        3,
        copy.review.applyingTitle,
        copy.common.pleaseWait,
        [copy.review.writingTransaction],
        [[], []],
      );
      return { status: "completed", result: await options.execute("apply", request) };
    }
  }
}

export async function runImportWizard(options: ImportWizardOptions): Promise<ImportWizardOutcome> {
  const allowed = options.agents === undefined
    ? options.catalog.entries
    : options.catalog.entries.filter((entry) => options.agents!.includes(entry.agent));
  if (allowed.length === 0) throw new Error("archive has no history for the selected Agent");
  const byReference = new Map(allowed.map((entry) => [entry.sessionRef, entry]));
  const initialReferences = options.sessions.length === 0 ? allowed.map((entry) => entry.sessionRef) : options.sessions;
  const missing = initialReferences.find((reference) => !byReference.has(reference));
  if (missing !== undefined) throw new Error(`selected history session was not found: ${missing}`);
  const state: WizardState = {
    explicit: new Set(initialReferences),
    targets: new Map(options.catalog.entries.map((entry) => [entry.sessionRef, options.targetAgent ?? entry.agent])),
    pathMappings: [...options.pathMappings],
    roots: {
      ...(options.codexHome === undefined ? {} : { codex: options.codexHome }),
      ...(options.opencodeDataRoot === undefined ? {} : { opencode: options.opencodeDataRoot }),
      ...(options.claudeConfigRoot === undefined ? {} : { claude: options.claudeConfigRoot }),
      ...(options.piSessionRoot === undefined ? {} : { pi: options.piSessionRoot }),
    },
    providerPolicy: options.providerPolicy,
    query: "",
  };
  const terminal = new ImportTerminal(options.input, options.output, options.language ?? "en");
  let step = 0;
  terminal.open();
  try {
    while (true) {
      if (step === 0) {
        const move = await selectSessionsScreen(terminal, options, allowed, state);
        if (move === "cancel") return { status: "cancelled" };
        step = 1;
        continue;
      }
      const selected = closedSelection(options.catalog, state.explicit);
      if (step === 1) {
        const move = await chooseTargetsScreen(terminal, options, selected, state);
        if (move === "cancel") return { status: "cancelled" };
        step = move === "back" ? 0 : 2;
        continue;
      }
      if (step === 2) {
        const move = await mapWorkspacesScreen(terminal, options, selected, state);
        if (move === "cancel") return { status: "cancelled" };
        step = move === "back" ? 1 : 3;
        continue;
      }
      const outcome = await reviewScreen(terminal, options, selected, state);
      if (typeof outcome === "object") return outcome;
      if (outcome === "cancel") return { status: "cancelled" };
      step = outcome === "refresh" ? (state.explicit.size === 0 ? 0 : 3) : 2;
    }
  } finally {
    terminal.close();
  }
}
