import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "../infrastructure/files.js";
import { ensurePrivateStateDirectory } from "../infrastructure/state.js";

const WINDOW_STATE_SCHEMA = "agenthist.desktop-window/v1" as const;

export interface DesktopWindowState {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly maximized: boolean;
}

export const DEFAULT_DESKTOP_WINDOW_STATE: DesktopWindowState = {
  width: 1320,
  height: 820,
  maximized: false,
};

function statePath(stateDirectory: string): string {
  return path.join(stateDirectory, "desktop", "window.json");
}

function validCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 100_000;
}

function parseWindowState(value: unknown): DesktopWindowState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    item.schemaVersion !== WINDOW_STATE_SCHEMA ||
    !validCoordinate(item.width) || item.width < 920 || item.width > 10_000 ||
    !validCoordinate(item.height) || item.height < 620 || item.height > 10_000 ||
    typeof item.maximized !== "boolean" ||
    (item.x !== undefined && !validCoordinate(item.x)) ||
    (item.y !== undefined && !validCoordinate(item.y))
  ) return undefined;
  return {
    width: item.width,
    height: item.height,
    maximized: item.maximized,
    ...(typeof item.x === "number" ? { x: item.x } : {}),
    ...(typeof item.y === "number" ? { y: item.y } : {}),
  };
}

export async function loadDesktopWindowState(stateDirectory: string): Promise<DesktopWindowState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(stateDirectory), "utf8")) as unknown;
    return parseWindowState(parsed) ?? DEFAULT_DESKTOP_WINDOW_STATE;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return DEFAULT_DESKTOP_WINDOW_STATE;
    }
    throw error;
  }
}

export async function saveDesktopWindowState(
  stateDirectory: string,
  state: DesktopWindowState,
): Promise<void> {
  const parsed = parseWindowState({ schemaVersion: WINDOW_STATE_SCHEMA, ...state });
  if (parsed === undefined) throw new Error("desktop window state is invalid");
  const desktopDirectory = path.join(stateDirectory, "desktop");
  await ensurePrivateStateDirectory(desktopDirectory);
  await writeJsonAtomic(statePath(stateDirectory), { schemaVersion: WINDOW_STATE_SCHEMA, ...parsed });
}
