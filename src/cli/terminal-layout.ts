import { sanitizeTerminalText } from "./terminal-safety.js";

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

function oneLine(value: string): string {
  return cleanTerminalText(value).replace(/[\t\r\n]+/g, " ");
}

export function truncateDisplay(value: string, maximum: number): string {
  const text = oneLine(value);
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

export function truncateDisplayStart(value: string, maximum: number): string {
  const text = oneLine(value);
  if (maximum <= 0) return "";
  if (displayWidth(text) <= maximum) return text;
  if (maximum <= 3) return ".".repeat(maximum);
  const retained: string[] = [];
  let width = 0;
  const characters = [...text];
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index]!;
    const next = characterWidth(character);
    if (width + next > maximum - 3) break;
    retained.push(character);
    width += next;
  }
  return `...${retained.reverse().join("")}`;
}

function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function truncateDisplayAround(value: string, needle: string, maximum: number): string {
  const text = oneLine(value);
  if (maximum <= 0) return "";
  if (displayWidth(text) <= maximum) return text;
  const target = oneLine(needle);
  if (target === "") return truncateDisplay(text, maximum);
  const index = asciiFold(text).indexOf(asciiFold(target));
  if (index < 0) return truncateDisplay(text, maximum);
  const match = text.slice(index, index + target.length);
  const matchWidth = displayWidth(match);
  if (matchWidth >= maximum || maximum - matchWidth < 6) {
    return truncateDisplay(match, maximum);
  }

  const before = text.slice(0, index);
  const after = text.slice(index + target.length);
  const contextWidth = maximum - matchWidth;
  let beforeWidth = Math.floor(contextWidth / 2);
  let afterWidth = contextWidth - beforeWidth;
  const availableBefore = displayWidth(before);
  const availableAfter = displayWidth(after);
  if (availableBefore < beforeWidth) {
    afterWidth += beforeWidth - availableBefore;
    beforeWidth = availableBefore;
  } else if (availableAfter < afterWidth) {
    beforeWidth += afterWidth - availableAfter;
    afterWidth = availableAfter;
  }
  return truncateDisplayStart(before, beforeWidth) + match + truncateDisplay(after, afterWidth);
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
