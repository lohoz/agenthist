import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { invalidArguments } from "./command-support.js";
import { humanBytes } from "./human-output.js";
import { ImportTerminal } from "./import-wizard/terminal.js";
import type { ImportWizardLanguage } from "./import-wizard/copy.js";
import { paint } from "./style.js";
import { columns, displayWidth, padDisplay, truncateDisplay } from "./terminal-layout.js";

export interface ArchiveFileCandidate {
  readonly file: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: Date;
}

export type ArchivePickerOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "selected"; readonly file: string };

export interface ArchivePickerOptions {
  readonly action: "inspect" | "import";
  readonly cwd: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly color?: boolean;
  readonly language?: ImportWizardLanguage;
}

interface ArchivePickerCopy {
  readonly brand: string;
  readonly title: string;
  readonly archive: string;
  readonly size: string;
  readonly modified: string;
  readonly move: string;
  readonly open: string;
  readonly cancel: string;
  readonly switchLanguage: string;
  count(value: number): string;
}

function copy(action: ArchivePickerOptions["action"], language: ImportWizardLanguage): ArchivePickerCopy {
  if (language === "zh") {
    return {
      brand: action === "import" ? "AgentHist 导入" : "AgentHist 检查",
      title: "选择 AgentHist 文件",
      archive: "文件",
      size: "大小",
      modified: "修改时间",
      move: "移动",
      open: "打开",
      cancel: "取消",
      switchLanguage: "English",
      count: (value) => `${value} 个文件`,
    };
  }
  return {
    brand: action === "import" ? "AgentHist Import" : "AgentHist Inspect",
    title: "Choose an AgentHist file",
    archive: "FILE",
    size: "SIZE",
    modified: "MODIFIED",
    move: "Move",
    open: "Open",
    cancel: "Cancel",
    switchLanguage: "中文",
    count: (value) => `${value} ${value === 1 ? "file" : "files"}`,
  };
}

function compactTime(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hour = String(value.getHours()).padStart(2, "0");
  const minute = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function archiveMetadata(candidate: ArchiveFileCandidate): string {
  return `${humanBytes(candidate.sizeBytes)}  ${compactTime(candidate.modifiedAt)}`;
}

export async function listArchiveFiles(cwd: string): Promise<readonly ArchiveFileCandidate[]> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".agenthist"))
    .map(async (entry): Promise<ArchiveFileCandidate> => {
      const file = path.resolve(cwd, entry.name);
      const metadata = await stat(file);
      return {
        file,
        name: entry.name,
        sizeBytes: metadata.size,
        modifiedAt: metadata.mtime,
      };
    }));
  return candidates.sort((left, right) =>
    right.modifiedAt.getTime() - left.modifiedAt.getTime() || left.name.localeCompare(right.name));
}

function archiveRow(
  candidate: ArchiveFileCandidate,
  width: number,
  metadataWidth: number,
  focused: boolean,
  color: boolean,
): string {
  const metadata = archiveMetadata(candidate);
  const contentWidth = Math.max(1, width - 2);
  const nameWidth = Math.max(4, contentWidth - metadataWidth - 2);
  const name = padDisplay(truncateDisplay(candidate.name, nameWidth), nameWidth);
  const row = `${name}  ${truncateDisplay(metadata, metadataWidth)}`;
  return `${focused ? "> " : "  "}${focused
    ? paint(row, "focus", color)
    : `${paint(name, "strong", color)}  ${paint(truncateDisplay(metadata, metadataWidth), "muted", color)}`}`;
}

export async function selectArchiveFile(options: ArchivePickerOptions): Promise<ArchivePickerOutcome> {
  const candidates = await listArchiveFiles(options.cwd);
  if (candidates.length === 0) {
    throw invalidArguments(`no .agenthist files found in current directory: ${options.cwd}`);
  }
  if (candidates.length === 1) return { status: "selected", file: candidates[0]!.file };

  const terminal = new ImportTerminal(options.input, options.output, options.language ?? "en");
  const color = options.color === true;
  let cursor = 0;
  terminal.open();
  try {
    while (true) {
      const text = copy(options.action, terminal.language);
      const pageSize = Math.max(1, terminal.height - 10);
      const pageStart = Math.min(
        Math.max(0, cursor - pageSize + 1),
        Math.max(0, candidates.length - pageSize),
      );
      const visible = candidates.slice(pageStart, pageStart + pageSize);
      const rowWidth = Math.max(12, terminal.width - 2);
      const contentWidth = Math.max(1, rowWidth - 2);
      const metadataWidth = Math.min(
        Math.max(...candidates.map((candidate) => displayWidth(archiveMetadata(candidate)))),
        Math.floor(contentWidth * 0.48),
      );
      const headerRight = `${padDisplay(
        text.size,
        Math.max(displayWidth(text.size), metadataWidth - displayWidth(text.modified) - 2),
      )}  ${text.modified}`;
      const headerLeftWidth = Math.max(4, contentWidth - metadataWidth - 2);
      terminal.draw([
        paint(text.brand, "brand", color),
        "",
        columns(paint(text.title, "heading", color), paint(text.count(candidates.length), "muted", color), terminal.width),
        paint(options.cwd, "muted", color),
        "",
        `  ${paint(padDisplay(text.archive, headerLeftWidth), "muted", color)}  ${paint(headerRight, "muted", color)}`,
        paint("-".repeat(Math.max(1, terminal.width)), "divider", color),
        ...visible.map((candidate, index) =>
          archiveRow(candidate, rowWidth, metadataWidth, pageStart + index === cursor, color)),
        "",
        paint("-".repeat(Math.max(1, terminal.width)), "divider", color),
        `[Up/Down] ${text.move}   [Enter] ${text.open}   [Esc] ${text.cancel}   [l] ${text.switchLanguage}`,
      ]);
      const key = await terminal.key();
      if (key.ctrl && key.name === "c" || key.name === "escape") return { status: "cancelled" };
      if (key.name === "l") {
        terminal.language = terminal.language === "en" ? "zh" : "en";
        continue;
      }
      if (key.name === "up" || key.name === "k") cursor = Math.max(0, cursor - 1);
      if (key.name === "down" || key.name === "j") cursor = Math.min(candidates.length - 1, cursor + 1);
      if (key.name === "pageup") cursor = Math.max(0, cursor - pageSize);
      if (key.name === "pagedown") cursor = Math.min(candidates.length - 1, cursor + pageSize);
      if (key.name === "home") cursor = 0;
      if (key.name === "end") cursor = candidates.length - 1;
      if (key.name === "return" || key.name === "enter") {
        return { status: "selected", file: candidates[cursor]!.file };
      }
    }
  } finally {
    terminal.close();
  }
}
