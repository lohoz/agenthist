import { emitKeypressEvents } from "node:readline";

import type { ImportWizardLanguage } from "./copy.js";
import { sanitizeHumanOutput, sanitizeTerminalText } from "../terminal-safety.js";

interface KeypressDescriptor {
  readonly name?: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

interface KeypressInput extends NodeJS.ReadableStream {
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): this;
  on(event: "keypress", listener: (character: string, key: KeypressDescriptor) => void): this;
  off(event: "keypress", listener: (character: string, key: KeypressDescriptor) => void): this;
}

interface TerminalOutput extends NodeJS.WritableStream {
  readonly columns?: number;
  readonly rows?: number;
}

export interface TerminalKey {
  readonly name: string;
  readonly text: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

function wideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function characterWidth(character: string): number {
  if (/\p{Mark}/u.test(character)) return 0;
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && wideCodePoint(codePoint) ? 2 : 1;
}

export function cleanTerminalText(value: string): string {
  return sanitizeTerminalText(value);
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const character of cleanTerminalText(value)) width += characterWidth(character);
  return width;
}

export function truncateDisplay(value: string, maximum: number): string {
  const text = cleanTerminalText(value).replace(/[\t\r\n]+/g, " ");
  if (maximum <= 0) return "";
  if (displayWidth(text) <= maximum) return text;
  if (maximum <= 3) return ".".repeat(maximum);
  let result = "";
  let width = 0;
  for (const character of text) {
    const next = characterWidth(character);
    if (width + next > maximum - 3) break;
    result += character;
    width += next;
  }
  return `${result}...`;
}

export function padDisplay(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`;
}

export function columns(left: string, right: string, width: number): string {
  const maximum = Math.max(0, width);
  if (maximum === 0) return "";
  const rightText = truncateDisplay(right, Math.floor(maximum * 0.58));
  if (rightText === "") return truncateDisplay(left, maximum);
  const rightWidth = displayWidth(rightText);
  const leftWidth = maximum - rightWidth - 2;
  if (leftWidth <= 0) return truncateDisplay(rightText, maximum);
  return `${padDisplay(truncateDisplay(left, leftWidth), leftWidth)}  ${rightText}`;
}

export function wrapDisplay(value: string, width: number): string[] {
  const maximum = Math.max(1, width);
  const result: string[] = [];
  for (const sourceLine of cleanTerminalText(value).split("\n")) {
    let remaining = sourceLine;
    if (remaining === "") {
      result.push("");
      continue;
    }
    while (displayWidth(remaining) > maximum) {
      const characters = [...remaining];
      let consumed = 0;
      let used = 0;
      let lastWhitespace = -1;
      for (let index = 0; index < characters.length; index++) {
        const next = characterWidth(characters[index]!);
        if (used + next > maximum) break;
        used += next;
        consumed = index + 1;
        if (/\s/u.test(characters[index]!)) lastWhitespace = index;
      }
      if (lastWhitespace >= Math.floor(consumed / 2)) consumed = lastWhitespace + 1;
      result.push(characters.slice(0, consumed).join("").trimEnd());
      remaining = characters.slice(consumed).join("").trimStart();
    }
    result.push(remaining);
  }
  return result;
}

function normalizedKey(character: string, key: KeypressDescriptor): TerminalKey {
  return {
    name: key.name ?? (character === " " ? "space" : character),
    text: character,
    ctrl: key.ctrl === true,
    meta: key.meta === true,
    shift: key.shift === true,
  };
}

export class ImportTerminal {
  readonly input: KeypressInput;
  readonly output: TerminalOutput;
  private readonly queued: TerminalKey[] = [];
  private readonly waiting: Array<(key: TerminalKey) => void> = [];
  private opened = false;
  private previousRaw = false;
  private previousLines: string[] = [];
  language: ImportWizardLanguage;

  constructor(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    language: ImportWizardLanguage = "en",
  ) {
    this.input = input as KeypressInput;
    this.output = output as TerminalOutput;
    this.language = language;
  }

  readonly onKeypress = (character: string, descriptor: KeypressDescriptor): void => {
    const key = normalizedKey(character, descriptor);
    const waiter = this.waiting.shift();
    if (waiter === undefined) this.queued.push(key);
    else waiter(key);
  };

  get width(): number {
    const columns = this.output.columns;
    return columns !== undefined && columns >= 40 ? columns : 100;
  }

  get height(): number {
    const rows = this.output.rows;
    return rows !== undefined && rows >= 12 ? rows : 24;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.previousLines = [];
    emitKeypressEvents(this.input as NodeJS.ReadStream);
    this.input.on("keypress", this.onKeypress);
    this.previousRaw = this.input.isRaw === true;
    this.input.setRawMode?.(true);
    this.input.resume();
    this.output.write("\u001b[?1049h\u001b[?25l");
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.input.off("keypress", this.onKeypress);
    this.input.setRawMode?.(this.previousRaw);
    this.input.pause();
    this.output.write("\u001b[?25h\u001b[?1049l");
    this.previousLines = [];
  }

  draw(lines: readonly string[], cursor = false): void {
    const visible = lines.slice(0, this.height).map(sanitizeHumanOutput);
    let output = "\u001b[?25l";
    if (this.previousLines.length === 0) {
      output += `\u001b[H\u001b[2J${visible.join("\n")}`;
    } else {
      const rows = Math.max(this.previousLines.length, visible.length);
      for (let index = 0; index < rows; index++) {
        const current = visible[index] ?? "";
        if ((this.previousLines[index] ?? "") === current) continue;
        output += `\u001b[${index + 1};1H\u001b[2K${current}`;
      }
    }
    this.previousLines = [...visible];
    if (cursor) {
      const row = Math.max(1, visible.length);
      const column = Math.max(1, Math.min(this.width, displayWidth(visible.at(-1) ?? "") + 1));
      output += `\u001b[${row};${column}H\u001b[?25h`;
    }
    this.output.write(output);
  }

  async key(): Promise<TerminalKey> {
    const queued = this.queued.shift();
    if (queued !== undefined) return queued;
    return await new Promise<TerminalKey>((resolve) => { this.waiting.push(resolve); });
  }

  async line(lines: (value: string) => readonly string[], initial = ""): Promise<string | undefined> {
    let value = initial;
    while (true) {
      this.draw(lines(value), true);
      const key = await this.key();
      if (key.ctrl && key.name === "c" || key.name === "escape") return undefined;
      if (key.name === "return" || key.name === "enter") return cleanTerminalText(value).trim();
      if (key.name === "backspace") {
        value = [...value].slice(0, -1).join("");
        continue;
      }
      if (key.ctrl && key.name === "u") {
        value = "";
        continue;
      }
      if (!key.ctrl && !key.meta && key.text !== "" && !/[\u0000-\u001f\u007f]/u.test(key.text)) {
        value += key.text;
      }
    }
  }
}
