import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_DESKTOP_WINDOW_STATE,
  loadDesktopWindowState,
  saveDesktopWindowState,
} from "../../../src/desktop/window-state.js";

test("desktop window state persists valid bounds and ignores corrupt local state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-window-state-"));
  try {
    assert.deepEqual(await loadDesktopWindowState(root), DEFAULT_DESKTOP_WINDOW_STATE);
    await saveDesktopWindowState(root, { x: -1200, y: 80, width: 1440, height: 900, maximized: true });
    assert.deepEqual(
      await loadDesktopWindowState(root),
      { x: -1200, y: 80, width: 1440, height: 900, maximized: true },
    );
    await writeFile(path.join(root, "desktop", "window.json"), "{not-json", "utf8");
    assert.deepEqual(await loadDesktopWindowState(root), DEFAULT_DESKTOP_WINDOW_STATE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop window state rejects unsafe bounds before writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-window-state-invalid-"));
  try {
    await mkdir(path.join(root, "desktop"), { recursive: true });
    await assert.rejects(
      saveDesktopWindowState(root, { width: 100, height: 100, maximized: false }),
      /desktop window state is invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
