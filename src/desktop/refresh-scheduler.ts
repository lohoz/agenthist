import type {
  DesktopError,
  DesktopResult,
  RefreshResultDto,
  ScanProgressDto,
} from "./contracts.js";

export const DEFAULT_DESKTOP_REFRESH_INTERVAL_MS = 60_000;
export const MIN_DESKTOP_REFRESH_INTERVAL_MS = 1_000;
export const MAX_DESKTOP_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type DesktopRefreshFunction = (
  onProgress?: (progress: ScanProgressDto) => void,
) => Promise<DesktopResult<RefreshResultDto>>;

export type DesktopIntervalHandle = number | {
  unref?: () => void;
};

export interface DesktopRefreshSchedulerOptions {
  readonly refresh: DesktopRefreshFunction;
  readonly onProgress?: (progress: ScanProgressDto) => void;
  readonly onComplete?: (result: RefreshResultDto) => void;
  readonly onError?: (error: DesktopError) => void;
  readonly intervalMs?: number;
  readonly setInterval?: (callback: () => void, milliseconds: number) => DesktopIntervalHandle;
  readonly clearInterval?: (handle: DesktopIntervalHandle) => void;
}

export interface DesktopRefreshScheduler {
  start(): void;
  trigger(): Promise<void>;
  stop(): void;
  isRunning(): boolean;
}

function callbackSafely<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch {
    // A presentation callback must never reject or restart the refresh loop.
  }
}

function unexpectedRefreshError(): DesktopError {
  return {
    code: "background_refresh_failed",
    message: "后台历史刷新失败。",
    retryable: true,
  };
}

export function createDesktopRefreshScheduler(
  options: DesktopRefreshSchedulerOptions,
): DesktopRefreshScheduler {
  if (typeof options.refresh !== "function") throw new Error("desktop refresh function is required");
  const intervalMs = options.intervalMs ?? DEFAULT_DESKTOP_REFRESH_INTERVAL_MS;
  if (
    !Number.isSafeInteger(intervalMs) || intervalMs < MIN_DESKTOP_REFRESH_INTERVAL_MS ||
    intervalMs > MAX_DESKTOP_REFRESH_INTERVAL_MS
  ) throw new Error("desktop refresh interval is outside the supported range");

  const schedule = options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const cancel = options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let timer: DesktopIntervalHandle | undefined;
  let started = false;
  let stopped = false;
  let queued = false;
  let active: Promise<void> | undefined;

  const runOnce = async (): Promise<void> => {
    try {
      const result = await options.refresh((progress) => {
        if (!started || stopped) return;
        callbackSafely(options.onProgress, progress);
      });
      if (!started || stopped) return;
      if (result.ok) callbackSafely(options.onComplete, result.value);
      else callbackSafely(options.onError, result.error);
    } catch {
      if (started && !stopped) callbackSafely(options.onError, unexpectedRefreshError());
    }
  };

  const runLoop = async (): Promise<void> => {
    try {
      do {
        queued = false;
        await runOnce();
      } while (started && !stopped && queued);
    } finally {
      active = undefined;
    }
  };

  const trigger = (): Promise<void> => {
    if (!started || stopped) return Promise.resolve();
    if (active !== undefined) {
      queued = true;
      return active;
    }
    active = runLoop();
    return active;
  };

  return {
    start() {
      if (started) return;
      stopped = false;
      started = true;
      timer = schedule(() => { void trigger(); }, intervalMs);
      if (typeof timer === "object") timer.unref?.();
    },

    trigger,

    stop() {
      if (stopped) return;
      stopped = true;
      started = false;
      queued = false;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
    },

    isRunning() {
      return started && !stopped;
    },
  };
}
