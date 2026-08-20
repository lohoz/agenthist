import {
  importWizardCopy,
  type ImportWizardCopy,
  type ImportWizardLanguage,
} from "../import-wizard/copy.js";

export type ExportWizardLanguage = ImportWizardLanguage;

export interface ExportReviewCopy {
  readonly brand: string;
  readonly steps: readonly string[];
  readonly title: string;
  readonly preparing: string;
  readonly exporting: string;
  readonly overview: string;
  readonly destination: string;
  readonly agents: string;
  readonly workspaces: string;
  readonly skipped: string;
  readonly selected: string;
  readonly included: string;
  readonly ready: string;
  readonly unavailable: string;
  readonly changeFile: string;
  readonly export: string;
  readonly back: string;
  readonly scroll: string;
  readonly page: string;
  readonly editTitle: string;
  readonly editHelp: string;
  readonly filePrompt: string;
  readonly invalidFile: string;
  readonly switchLanguage: string;
  summary(ready: number, skipped: number): string;
  sessions(count: number): string;
  required(count: number): string;
}

const EN_REVIEW: ExportReviewCopy = {
  brand: "AgentHist Export",
  steps: ["Select", "Review"],
  title: "Review export",
  preparing: "Preparing export",
  exporting: "Exporting selected history",
  overview: "Overview",
  destination: "Archive",
  agents: "Agents",
  workspaces: "Workspaces",
  skipped: "Unavailable sessions",
  selected: "Selected",
  included: "Included",
  ready: "Ready",
  unavailable: "Unavailable",
  changeFile: "Change file",
  export: "Export",
  back: "Back",
  scroll: "Scroll",
  page: "Page",
  editTitle: "Choose archive file",
  editHelp: "Enter a .agenthist file. Esc cancels this edit; Ctrl+U clears the input.",
  filePrompt: "Archive: ",
  invalidFile: "The archive file must end with .agenthist.",
  switchLanguage: "中文",
  summary: (ready, skipped) => `${ready} ready${skipped === 0 ? "" : ` · ${skipped} skipped`}`,
  sessions: (count) => `${count} ${count === 1 ? "session" : "sessions"}`,
  required: (count) => `${count} required ${count === 1 ? "dependency" : "dependencies"}`,
};

const ZH_REVIEW: ExportReviewCopy = {
  brand: "AgentHist 导出",
  steps: ["选择", "确认"],
  title: "确认导出",
  preparing: "正在准备导出",
  exporting: "正在导出所选历史",
  overview: "概览",
  destination: "归档文件",
  agents: "Agent",
  workspaces: "工作区",
  skipped: "不可导出的会话",
  selected: "已选择",
  included: "实际包含",
  ready: "可导出",
  unavailable: "不可导出",
  changeFile: "修改文件",
  export: "导出",
  back: "返回",
  scroll: "滚动",
  page: "翻页",
  editTitle: "选择归档文件",
  editHelp: "请输入以 .agenthist 结尾的文件名。Esc 取消编辑，Ctrl+U 清空输入。",
  filePrompt: "归档文件：",
  invalidFile: "归档文件必须以 .agenthist 结尾。",
  switchLanguage: "English",
  summary: (ready, skipped) => `${ready} 个可导出${skipped === 0 ? "" : ` · ${skipped} 个跳过`}`,
  sessions: (count) => `${count} 个会话`,
  required: (count) => `${count} 个必要依赖`,
};

export function exportSelectionCopy(language: ExportWizardLanguage): ImportWizardCopy {
  const base = importWizardCopy(language);
  const review = language === "zh" ? ZH_REVIEW : EN_REVIEW;
  return {
    ...base,
    brand: review.brand,
    steps: review.steps,
    actions: {
      ...base.actions,
      next: language === "zh" ? "确认" : "Review",
      exit: language === "zh" ? "取消" : "Cancel",
    },
    selection: {
      ...base.selection,
      title: language === "zh" ? "选择要导出的历史" : "Select history to export",
    },
  };
}

export function exportReviewCopy(language: ExportWizardLanguage): ExportReviewCopy {
  return language === "zh" ? ZH_REVIEW : EN_REVIEW;
}
