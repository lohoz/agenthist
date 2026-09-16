import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
  type Rectangle,
  type WebContents,
} from "electron";

import packageMetadata from "../../package.json" with { type: "json" };
import { resolveStateDirectory } from "../application/state-location.js";
import { DESKTOP_IPC } from "./contracts.js";
import { registerDesktopIpc } from "./ipc.js";
import { createDesktopRefreshScheduler } from "./refresh-scheduler.js";
import { createDesktopService } from "./service.js";
import { createDesktopShutdownCoordinator } from "./shutdown.js";
import {
  loadDesktopWindowState,
  saveDesktopWindowState,
  type DesktopWindowState,
} from "./window-state.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const rendererEntry = path.resolve(currentDirectory, "..", "..", "desktop-renderer", "index.html");
const rendererUrl = pathToFileURL(rendererEntry);
const preloadEntry = path.join(currentDirectory, "preload.cjs");
const explicitStateDirectory = process.env.AGENTHIST_DESKTOP_STATE_DIR?.trim();
const stateDirectory = resolveStateDirectory({
  ...(explicitStateDirectory === undefined || explicitStateDirectory === ""
    ? {}
    : { explicit: explicitStateDirectory }),
});
const desktopService = createDesktopService({
  stateDirectory,
  version: packageMetadata.version,
});

let mainWindow: BrowserWindow | undefined;
let disposeIpc: (() => void) | undefined;
const refreshScheduler = createDesktopRefreshScheduler({
  refresh: (onProgress) => desktopService.refresh(onProgress),
  onProgress(progress) {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_IPC.scanProgress, progress);
    }
  },
  onError(error) {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_IPC.scanProgress, { phase: "error", error });
    }
  },
});
const desktopShutdown = createDesktopShutdownCoordinator({
  stop() { refreshScheduler.stop(); },
  cleanup() { return desktopService.dispose(); },
  quit() { app.quit(); },
});

function intersectsDisplay(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const horizontal = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
    const vertical = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
    return horizontal >= 120 && vertical >= 80;
  });
}

function browserWindowOptions(saved: DesktopWindowState): Electron.BrowserWindowConstructorOptions {
  const candidate = saved.x === undefined || saved.y === undefined
    ? undefined
    : { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  const visible = candidate !== undefined && intersectsDisplay(candidate);
  return {
    width: saved.width,
    height: saved.height,
    ...(visible && candidate !== undefined ? { x: candidate.x, y: candidate.y } : {}),
    minWidth: 920,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#18181b" : "#fafafa",
    title: "AgentHist",
    webPreferences: {
      preload: preloadEntry,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  };
}

function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isRendererUrl(value: string): boolean {
  try {
    const source = new URL(value);
    return source.protocol === "file:" && source.host === rendererUrl.host &&
      source.pathname === rendererUrl.pathname;
  } catch {
    return false;
  }
}

function isTrustedDesktopWebContents(webContents: WebContents | null): boolean {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed() || webContents === null || webContents !== window.webContents) {
    return false;
  }
  return isRendererUrl(webContents.mainFrame.url);
}

function isTrustedDesktopIpcSender(event: IpcMainInvokeEvent): boolean {
  if (!isTrustedDesktopWebContents(event.sender)) return false;
  const frame = event.senderFrame;
  return frame !== null && frame === event.sender.mainFrame && isRendererUrl(frame.url);
}

function windowPersistence(window: BrowserWindow): (() => Promise<void>) | undefined {
  if (window.isDestroyed()) return undefined;
  const bounds = window.getNormalBounds();
  const state: DesktopWindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: window.isMaximized(),
  };
  return () => saveDesktopWindowState(stateDirectory, state);
}

async function createMainWindow(): Promise<BrowserWindow> {
  const saved = await loadDesktopWindowState(stateDirectory);
  const window = new BrowserWindow(browserWindowOptions(saved));
  mainWindow = window;

  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external !== undefined) void shell.openExternal(external);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
      const external = safeExternalUrl(url);
      if (external !== undefined) void shell.openExternal(external);
    }
  });
  window.once("ready-to-show", () => {
    if (saved.maximized) window.maximize();
    window.show();
  });
  window.on("close", () => {
    const persistence = windowPersistence(window);
    if (persistence !== undefined) desktopShutdown.queueWindowPersistence(persistence);
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  await window.loadFile(rendererEntry);
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("io.github.lohoz.agenthist");
    const initialSettings = await desktopService.getSettings();
    if (initialSettings.ok) {
      nativeTheme.themeSource = initialSettings.value.theme;
      if (initialSettings.value.autoRefresh) refreshScheduler.start();
    }
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      callback(permission === "clipboard-sanitized-write" && details.isMainFrame &&
        isRendererUrl(details.requestingUrl) && isTrustedDesktopWebContents(webContents));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) =>
      permission === "clipboard-sanitized-write" && details.isMainFrame &&
      details.requestingUrl !== undefined && isRendererUrl(details.requestingUrl) &&
      isTrustedDesktopWebContents(webContents));
    disposeIpc = registerDesktopIpc({
      ipcMain,
      service: desktopService,
      authorizeSender: isTrustedDesktopIpcSender,
      onProgress(progress) {
        if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(DESKTOP_IPC.scanProgress, progress);
        }
      },
      onExperienceProgress(progress) {
        if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(DESKTOP_IPC.experienceProgress, progress);
        }
      },
      onThemeChanged(theme) {
        nativeTheme.themeSource = theme;
      },
      onAutoRefreshChanged(enabled) {
        if (enabled) refreshScheduler.start();
        else refreshScheduler.stop();
      },
    });
    await createMainWindow();
    mainWindow?.on("focus", () => { void refreshScheduler.trigger(); });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
    });
  }).catch((error: unknown) => {
    process.stderr.write(`AgentHist Desktop failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
    app.exit(1);
  });
}

app.on("will-quit", () => {
  disposeIpc?.();
  disposeIpc = undefined;
});

app.on("before-quit", (event) => {
  if (desktopShutdown.isComplete()) return;
  event.preventDefault();
  const persistence = mainWindow === undefined ? undefined : windowPersistence(mainWindow);
  void desktopShutdown.requestShutdown(persistence);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
