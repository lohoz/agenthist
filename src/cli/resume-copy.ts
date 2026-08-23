import {
  importWizardCopy,
  type ImportWizardCopy,
  type ImportWizardLanguage,
} from "./import-wizard/copy.js";

export function resumeWizardCopy(language: ImportWizardLanguage): ImportWizardCopy {
  const base = importWizardCopy(language);
  const chinese = language === "zh";
  return {
    ...base,
    brand: "AgentHist Resume",
    steps: [chinese ? "选择会话" : "Choose"],
    actions: {
      ...base.actions,
      next: chinese ? "继续" : "Continue",
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
      title: chinese ? "选择一个会话" : "Choose a conversation",
      noMatches: chinese ? "没有匹配当前搜索的会话。" : "No conversations match the current search.",
      searchTitle: chinese ? "搜索会话" : "Search conversations",
      searchHelp: chinese
        ? "匹配标题、工作区、模型、原生 ID 或会话引用。"
        : "Matches title, workspace, model, native ID, or session reference.",
      selectRequired: chinese ? "请选择一个会话后继续。" : "Choose a conversation before continuing.",
      previewPaneRequired: chinese ? "请先切换到会话栏再预览。" :
        "Switch to the Conversations pane to preview.",
      summary: () => chinese ? "选择一个会话" : "Choose one conversation",
    },
  };
}
