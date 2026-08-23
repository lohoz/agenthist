import {
  agentLabel,
  type HistoryCatalogEntry,
  type HistoryMutationOperation,
  type HistorySelectionCatalog,
} from "../application/index.js";
import {
  importWizardCopy,
  toggleImportWizardLanguage,
  type ImportWizardCopy,
  type ImportWizardLanguage,
} from "./import-wizard/copy.js";
import { chooseHistorySessions } from "./import-wizard/index.js";
import { ImportTerminal, type TerminalKey } from "./import-wizard/terminal.js";
import { paint, type TerminalRole } from "./style.js";
import {
  columns,
  displayWidth,
  truncateDisplay,
  truncateDisplayStart,
} from "./terminal-layout.js";

export interface HistoryWizardOptions {
  readonly catalog: HistorySelectionCatalog;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly cwd: string;
  readonly color?: boolean;
  readonly language?: ImportWizardLanguage;
}

export type HistoryWizardOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "resume"; readonly sessionRef: string }
  | {
      readonly status: "mutate";
      readonly sessionRef: string;
      readonly operation: HistoryMutationOperation;
      readonly name?: string;
      readonly addTags?: readonly string[];
      readonly removeTags?: readonly string[];
    };

interface HistoryWizardCopy {
  readonly brand: string;
  readonly actionsTitle: string;
  readonly state: string;
  readonly tags: string;
  readonly workspace: string;
  readonly none: string;
  readonly back: string;
  readonly move: string;
  readonly choose: string;
  readonly switchLanguage: string;
  readonly continueConversation: string;
  readonly continueDescription: string;
  readonly rename: string;
  readonly renameDescription: string;
  readonly editTags: string;
  readonly editTagsDescription: string;
  readonly archive: string;
  readonly archiveDescription: string;
  readonly unarchive: string;
  readonly unarchiveDescription: string;
  readonly delete: string;
  readonly deleteDescription: string;
  readonly undelete: string;
  readonly undeleteDescription: string;
  readonly renameTitle: string;
  readonly renameHelp: string;
  readonly namePrompt: string;
  readonly tagsTitle: string;
  readonly tagsHelp: string;
  readonly tagsPrompt: string;
  readonly tagsUnchanged: string;
  readonly deleteTitle: string;
  readonly deleteHelp: string;
  readonly confirmDelete: string;
}

interface ActionRow {
  readonly kind: "resume" | HistoryMutationOperation;
  readonly label: string;
  readonly description: string;
}

const EN: HistoryWizardCopy = {
  brand: "AgentHist History",
  actionsTitle: "Conversation actions",
  state: "State",
  tags: "Tags",
  workspace: "Workspace",
  none: "none",
  back: "Back",
  move: "Move",
  choose: "Choose",
  switchLanguage: "中文",
  continueConversation: "Continue conversation",
  continueDescription: "Open with its source Agent or convert to another Agent",
  rename: "Rename",
  renameDescription: "Change the name shown only in AgentHist",
  editTags: "Edit tags",
  editTagsDescription: "Replace the AgentHist tag list",
  archive: "Archive",
  archiveDescription: "Move out of the active history view",
  unarchive: "Unarchive",
  unarchiveDescription: "Return to the active history view",
  delete: "Delete",
  deleteDescription: "Hide from AgentHist without changing native history",
  undelete: "Restore",
  undeleteDescription: "Restore the previous AgentHist state",
  renameTitle: "Rename conversation",
  renameHelp: "Enter the name shown by AgentHist. Ctrl+U clears the input; Esc goes back.",
  namePrompt: "Name: ",
  tagsTitle: "Edit tags",
  tagsHelp: "Enter comma-separated tags. Ctrl+U clears all tags; Esc goes back.",
  tagsPrompt: "Tags: ",
  tagsUnchanged: "The tag list is unchanged.",
  deleteTitle: "Delete from AgentHist",
  deleteHelp: "The native Agent conversation will remain unchanged.",
  confirmDelete: "Press Enter to delete from the AgentHist library, or Esc to go back.",
};

const ZH: HistoryWizardCopy = {
  brand: "AgentHist 历史",
  actionsTitle: "会话操作",
  state: "状态",
  tags: "标签",
  workspace: "工作区",
  none: "无",
  back: "返回",
  move: "移动",
  choose: "确定",
  switchLanguage: "English",
  continueConversation: "继续会话",
  continueDescription: "使用原 Agent 打开，或转换到其他 Agent",
  rename: "重命名",
  renameDescription: "仅修改 AgentHist 中显示的名称",
  editTags: "编辑标签",
  editTagsDescription: "替换 AgentHist 标签列表",
  archive: "归档",
  archiveDescription: "移出活跃历史列表",
  unarchive: "取消归档",
  unarchiveDescription: "恢复到活跃历史列表",
  delete: "删除",
  deleteDescription: "从 AgentHist 隐藏，不修改原生历史",
  undelete: "恢复",
  undeleteDescription: "恢复到删除前的 AgentHist 状态",
  renameTitle: "重命名会话",
  renameHelp: "输入 AgentHist 中显示的名称。Ctrl+U 清空；Esc 返回。",
  namePrompt: "名称：",
  tagsTitle: "编辑标签",
  tagsHelp: "输入以逗号分隔的标签。Ctrl+U 清空全部标签；Esc 返回。",
  tagsPrompt: "标签：",
  tagsUnchanged: "标签没有变化。",
  deleteTitle: "从 AgentHist 删除",
  deleteHelp: "原生 Agent 会话不会受到影响。",
  confirmDelete: "按 Enter 从 AgentHist 历史库删除，或按 Esc 返回。",
};

function copy(language: ImportWizardLanguage): HistoryWizardCopy {
  return language === "zh" ? ZH : EN;
}

function selectionCopy(language: ImportWizardLanguage): ImportWizardCopy {
  const base = importWizardCopy(language);
  const chinese = language === "zh";
  return {
    ...base,
    brand: copy(language).brand,
    steps: [chinese ? "浏览" : "Browse"],
    actions: {
      ...base.actions,
      next: chinese ? "操作" : "Actions",
      select: chinese ? "选择" : "Choose",
    },
    common: {
      ...base.common,
      sources: chinese ? "工作区" : "WORKSPACES",
      sessions: chinese ? "会话" : "CONVERSATIONS",
      allSessions: chinese ? "全部会话" : "All conversations",
    },
    preview: {
      ...base.preview,
      title: chinese ? "会话预览" : "Conversation preview",
      loading: chinese ? "正在读取本机会话..." : "Loading the local conversation...",
    },
    selection: {
      ...base.selection,
      title: chinese ? "浏览历史" : "Browse history",
      noMatches: chinese ? "没有匹配当前搜索的会话。" : "No conversations match the current search.",
      searchTitle: chinese ? "搜索会话" : "Search conversations",
      searchHelp: chinese
        ? "匹配标题、工作区、模型、标签、状态、原生 ID 或会话引用。"
        : "Matches title, workspace, model, tags, state, native ID, or session reference.",
      selectRequired: chinese ? "请选择一个会话。" : "Choose a conversation.",
      previewPaneRequired: chinese ? "请先切换到会话栏再预览。" :
        "Switch to the Conversations pane to preview.",
      summary: () => chinese ? "选择一个会话" : "Choose one conversation",
    },
  };
}

function interrupted(key: TerminalKey): boolean {
  return key.ctrl && key.name === "c";
}

function stateRole(state: HistoryCatalogEntry["libraryState"]): TerminalRole {
  return state === "active" ? "success" : state === "archived" ? "warning" : "error";
}

function actionRows(session: HistoryCatalogEntry, text: HistoryWizardCopy): readonly ActionRow[] {
  const stateAction: ActionRow = session.libraryState === "active"
    ? { kind: "archive", label: text.archive, description: text.archiveDescription }
    : session.libraryState === "archived"
      ? { kind: "unarchive", label: text.unarchive, description: text.unarchiveDescription }
      : { kind: "undelete", label: text.undelete, description: text.undeleteDescription };
  return [
    { kind: "resume", label: text.continueConversation, description: text.continueDescription },
    { kind: "rename", label: text.rename, description: text.renameDescription },
    { kind: "tag", label: text.editTags, description: text.editTagsDescription },
    stateAction,
    ...(session.libraryState === "deleted"
      ? []
      : [{ kind: "delete", label: text.delete, description: text.deleteDescription } as const]),
  ];
}

function frame(
  terminal: ImportTerminal,
  color: boolean,
  text: HistoryWizardCopy,
  title: string,
  session: HistoryCatalogEntry,
  body: readonly string[],
  footer: string,
  notice?: string,
): void {
  terminal.draw([
    paint(text.brand, "brand", color),
    "",
    columns(
      paint(title, "heading", color),
      truncateDisplay(`${agentLabel(session.agent)} · ${session.title}`, Math.max(12, Math.floor(terminal.width / 2))),
      terminal.width,
    ),
    "",
    ...body,
    "",
    paint("-".repeat(Math.max(1, terminal.width)), "divider", color),
    notice === undefined ? "" : paint(truncateDisplay(notice, terminal.width), "warning", color),
    footer,
  ]);
}

async function chooseAction(
  terminal: ImportTerminal,
  session: HistoryCatalogEntry,
  color: boolean,
): Promise<ActionRow | undefined> {
  let cursor = 0;
  while (true) {
    const text = copy(terminal.language);
    const actions = actionRows(session, text);
    cursor = Math.min(cursor, actions.length - 1);
    const body = [
      `  ${paint(text.state, "muted", color)}  ${paint(session.libraryState.toUpperCase(), stateRole(session.libraryState), color)}`,
      `  ${paint(text.tags, "muted", color)}  ${session.tags.length === 0 ? text.none : session.tags.join(", ")}`,
      `  ${paint(text.workspace, "muted", color)}  ${truncateDisplayStart(session.workspace, Math.max(12, terminal.width - 15))}`,
      "",
      ...actions.map((action, index) => {
        const line = columns(`  ${action.label}`, action.description, Math.max(1, terminal.width - 2));
        return index === cursor ? paint(`> ${line.slice(2)}`, "focus", color) : line;
      }),
    ];
    frame(
      terminal,
      color,
      text,
      text.actionsTitle,
      session,
      body,
      `[Up/Down] ${text.move}   [Enter] ${text.choose}   [Esc] ${text.back}   [l] ${text.switchLanguage}`,
    );
    const key = await terminal.key();
    if (interrupted(key) || key.name === "escape") return undefined;
    if (key.name === "l") {
      terminal.language = toggleImportWizardLanguage(terminal.language);
      continue;
    }
    if (key.name === "up" || key.name === "k") cursor = (cursor - 1 + actions.length) % actions.length;
    if (key.name === "down" || key.name === "j") cursor = (cursor + 1) % actions.length;
    if (key.name === "return" || key.name === "enter") return actions[cursor];
  }
}

function inputFrame(
  terminal: ImportTerminal,
  color: boolean,
  text: HistoryWizardCopy,
  title: string,
  help: string,
  prompt: string,
  value: string,
): readonly string[] {
  return [
    paint(text.brand, "brand", color),
    "",
    paint(title, "heading", color),
    "",
    paint(help, "muted", color),
    "",
    `${prompt}${truncateDisplay(value, Math.max(8, terminal.width - displayWidth(prompt)))}`,
  ];
}

function normalizedTags(value: string): readonly string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter((tag) => tag !== ""))].sort();
}

async function confirmDelete(
  terminal: ImportTerminal,
  session: HistoryCatalogEntry,
  color: boolean,
): Promise<boolean> {
  while (true) {
    const text = copy(terminal.language);
    frame(
      terminal,
      color,
      text,
      text.deleteTitle,
      session,
      [paint(session.title, "strong", color), "", text.deleteHelp, text.confirmDelete],
      `[Enter] ${text.delete}   [Esc] ${text.back}   [l] ${text.switchLanguage}`,
    );
    const key = await terminal.key();
    if (interrupted(key) || key.name === "escape") return false;
    if (key.name === "l") {
      terminal.language = toggleImportWizardLanguage(terminal.language);
      continue;
    }
    if (key.name === "return" || key.name === "enter") return true;
  }
}

export async function runHistoryWizard(options: HistoryWizardOptions): Promise<HistoryWizardOutcome> {
  const terminal = new ImportTerminal(options.input, options.output, options.language ?? "en");
  const color = options.color === true;
  terminal.open();
  try {
    while (true) {
      const selection = await chooseHistorySessions(terminal, {
        catalog: options.catalog,
        sessions: [],
        selectionMode: "single",
        preferredWorkspace: options.cwd,
        color,
        copy: selectionCopy,
        step: 0,
      });
      if (selection.status === "cancelled") return { status: "cancelled" };
      const session = selection.included[0]!;
      const action = await chooseAction(terminal, session, color);
      if (action === undefined) continue;
      if (action.kind === "resume") return { status: "resume", sessionRef: session.sessionRef };
      if (action.kind === "rename") {
        const text = copy(terminal.language);
        const name = await terminal.line(
          (value) => inputFrame(terminal, color, text, text.renameTitle, text.renameHelp, text.namePrompt, value),
          session.title,
        );
        if (name === undefined) continue;
        return { status: "mutate", sessionRef: session.sessionRef, operation: "rename", name };
      }
      if (action.kind === "tag") {
        const text = copy(terminal.language);
        const value = await terminal.line(
          (input) => inputFrame(terminal, color, text, text.tagsTitle, text.tagsHelp, text.tagsPrompt, input),
          session.tags.join(", "),
        );
        if (value === undefined) continue;
        const tags = normalizedTags(value);
        const current = [...session.tags].sort();
        const addTags = tags.filter((tag) => !current.includes(tag));
        const removeTags = current.filter((tag) => !tags.includes(tag));
        if (addTags.length + removeTags.length === 0) {
          frame(terminal, color, text, text.actionsTitle, session, [text.tagsUnchanged], `[Esc] ${text.back}`);
          await terminal.key();
          continue;
        }
        return {
          status: "mutate",
          sessionRef: session.sessionRef,
          operation: "tag",
          addTags,
          removeTags,
        };
      }
      if (action.kind === "delete" && !await confirmDelete(terminal, session, color)) continue;
      return { status: "mutate", sessionRef: session.sessionRef, operation: action.kind };
    }
  } finally {
    terminal.close();
  }
}
