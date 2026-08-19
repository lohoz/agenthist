import { colorizeHuman, type HumanTone } from "./command-support.js";
import { displayWidth, padDisplay } from "./terminal-layout.js";

export interface HumanField {
  readonly label: string;
  readonly value: string;
  readonly tone?: HumanTone;
}

export function humanTitle(title: string, color: boolean): string {
  return `${colorizeHuman(title, "strong", color)}\n`;
}

export function humanSection(title: string, color: boolean): string {
  return `${colorizeHuman(title, "section", color)}\n`;
}

export function humanCount(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return humanCount(bytes, "byte");
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes / 1024;
  let unit: typeof units[number] = units[0];
  for (const candidate of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = candidate;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export function humanFieldWidth(...groups: readonly (readonly HumanField[])[]): number {
  return groups.reduce((width, fields) => Math.max(
    width,
    ...fields.map((field) => displayWidth(field.label)),
  ), 0);
}

export function humanOutputWidth(columns: number | undefined): number {
  return columns !== undefined && Number.isFinite(columns) && columns >= 40
    ? Math.floor(columns)
    : 100;
}

export function humanFields(
  fields: readonly HumanField[],
  color: boolean,
  indentation = "  ",
  labelWidth = humanFieldWidth(fields),
): string {
  if (fields.length === 0) return "";
  return fields.map((field) => {
    const lines = field.value.split("\n");
    const label = colorizeHuman(padDisplay(field.label, labelWidth), "muted", color);
    const tone = field.tone ?? "plain";
    const continuation = lines.slice(1).map((line) =>
      `${indentation}${" ".repeat(labelWidth)}  ${colorizeHuman(line, tone, color)}\n`
    ).join("");
    return `${indentation}${label}  ${colorizeHuman(lines[0] ?? "", tone, color)}\n${continuation}`;
  }).join("");
}

export function humanPage(
  noun: string,
  offset: number,
  returned: number,
  total: number,
  nextOffset: number | undefined,
  color: boolean,
): string {
  const summary = total === 0
    ? `Showing 0 ${noun}s.`
    : `Showing ${offset + 1}-${offset + returned} of ${total} ${noun}${total === 1 ? "" : "s"}.`;
  const next = nextOffset === undefined ? "" : ` Next page: --offset ${nextOffset}`;
  return `${colorizeHuman(summary + next, "muted", color)}\n`;
}
