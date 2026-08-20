import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanTerminalText, type ImportTerminal } from "./terminal.js";

export interface DirectoryInputView {
  readonly value: string;
  readonly candidates: readonly string[];
  readonly activeCandidate: number;
  readonly candidateSelected: boolean;
  readonly invalid: boolean;
}

export interface DirectoryInputFrame {
  readonly lines: readonly string[];
  readonly cursorLine: number;
}

export interface DirectoryInputOptions {
  readonly initial?: string;
  readonly seeds?: readonly string[];
  readonly limit?: number;
  render(view: DirectoryInputView): DirectoryInputFrame;
}

export function resolveDirectoryInput(value: string): string | undefined {
  const clean = cleanTerminalText(value).trim();
  if (clean === "" || !path.isAbsolute(clean)) return undefined;
  return path.normalize(clean);
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

class DirectoryCandidates {
  readonly seeds: readonly string[];
  readonly limit: number;
  readonly entries = new Map<string, readonly string[]>();

  constructor(options: DirectoryInputOptions) {
    this.seeds = unique([
      ...(options.seeds ?? []),
      process.cwd(),
      os.homedir(),
    ].filter((value) => path.isAbsolute(value)).map((value) => path.normalize(value)));
    this.limit = options.limit ?? 6;
  }

  async for(value: string): Promise<readonly string[]> {
    const clean = cleanTerminalText(value).trim();
    if (clean === "") {
      const available = await Promise.all(this.seeds.map(async (seed) =>
        await isDirectory(seed) ? seed : undefined));
      return available.filter((seed): seed is string => seed !== undefined).slice(0, this.limit);
    }

    if (!path.isAbsolute(clean)) return [];
    const resolved = path.normalize(clean);
    const endsAtDirectoryBoundary = clean.endsWith(path.sep);
    const parent = endsAtDirectoryBoundary ? resolved : path.dirname(resolved);
    const prefix = endsAtDirectoryBoundary ? "" : path.basename(resolved);
    const entries = await this.read(parent);
    const comparablePrefix = process.platform === "win32" ? prefix.toLocaleLowerCase() : prefix;
    return entries
      .filter((name) => prefix.startsWith(".") || !name.startsWith("."))
      .filter((name) => {
        const comparableName = process.platform === "win32" ? name.toLocaleLowerCase() : name;
        return comparableName.startsWith(comparablePrefix);
      })
      .map((name) => path.join(parent, name))
      .slice(0, this.limit);
  }

  private async read(parent: string): Promise<readonly string[]> {
    const cached = this.entries.get(parent);
    if (cached !== undefined) return cached;
    try {
      const discovered = await readdir(parent, { withFileTypes: true });
      const available = await Promise.all(discovered.map(async (entry) =>
        entry.isDirectory() || (entry.isSymbolicLink() && await isDirectory(path.join(parent, entry.name)))
          ? entry.name
          : undefined));
      const entries = available
        .filter((entry): entry is string => entry !== undefined)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      this.entries.set(parent, entries);
      return entries;
    } catch {
      this.entries.set(parent, []);
      return [];
    }
  }
}

function nextInput(value: string, text: string): string {
  return value + text;
}

export async function readDirectoryInput(
  terminal: ImportTerminal,
  options: DirectoryInputOptions,
): Promise<string | undefined> {
  const source = new DirectoryCandidates(options);
  let value = options.initial ?? "";
  let candidates = await source.for(value);
  let activeCandidate = 0;
  let candidateSelected = false;
  let invalid = false;

  const refresh = async (): Promise<void> => {
    candidates = await source.for(value);
    activeCandidate = Math.max(0, Math.min(activeCandidate, Math.max(0, candidates.length - 1)));
  };

  while (true) {
    const frame = options.render({ value, candidates, activeCandidate, candidateSelected, invalid });
    terminal.draw(frame.lines, { line: frame.cursorLine });
    const key = await terminal.key();
    if (key.ctrl && key.name === "c" || key.name === "escape") return undefined;
    if (key.name === "up") {
      if (candidates.length > 0) {
        activeCandidate = candidateSelected
          ? Math.max(0, activeCandidate - 1)
          : candidates.length - 1;
        candidateSelected = true;
        invalid = false;
      }
      continue;
    }
    if (key.name === "down") {
      if (candidates.length > 0) {
        activeCandidate = candidateSelected
          ? Math.min(candidates.length - 1, activeCandidate + 1)
          : 0;
        candidateSelected = true;
        invalid = false;
      }
      continue;
    }
    if (key.name === "tab") {
      const candidate = candidates[activeCandidate];
      if (candidate === undefined) continue;
      const resolved = resolveDirectoryInput(value);
      value = resolved === candidate ? `${candidate}${path.sep}` : candidate;
      activeCandidate = 0;
      candidateSelected = false;
      invalid = false;
      await refresh();
      continue;
    }
    if (key.name === "return" || key.name === "enter") {
      const candidate = candidates[activeCandidate];
      if (candidateSelected && candidate !== undefined && await isDirectory(candidate)) {
        value = candidate;
        activeCandidate = 0;
        candidateSelected = false;
        invalid = false;
        await refresh();
        continue;
      }
      const resolved = resolveDirectoryInput(value);
      if (resolved !== undefined && await isDirectory(resolved)) return resolved;
      if (candidate !== undefined && await isDirectory(candidate)) {
        value = candidate;
        activeCandidate = 0;
        candidateSelected = false;
        invalid = false;
        await refresh();
        continue;
      }
      invalid = true;
      continue;
    }
    if (key.name === "backspace") {
      value = [...value].slice(0, -1).join("");
      activeCandidate = 0;
      candidateSelected = false;
      invalid = false;
      await refresh();
      continue;
    }
    if (key.ctrl && key.name === "u") {
      value = "";
      activeCandidate = 0;
      candidateSelected = false;
      invalid = false;
      await refresh();
      continue;
    }
    if (!key.ctrl && !key.meta && key.text !== "" && !/[\u0000-\u001f\u007f]/u.test(key.text)) {
      value = nextInput(value, key.text);
      activeCandidate = 0;
      candidateSelected = false;
      invalid = false;
      await refresh();
    }
  }
}
