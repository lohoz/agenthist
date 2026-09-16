import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopResult, RefreshResultDto, ScanProgressDto } from "../../../src/desktop/contracts.js";
import {
  DEFAULT_DESKTOP_REFRESH_INTERVAL_MS,
  createDesktopRefreshScheduler,
} from "../../../src/desktop/refresh-scheduler.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function refreshResult(sessions = 1): RefreshResultDto {
  return {
    agents: [{
      agent: "codex",
      status: "scanned",
      sessions,
      reusedSessions: 0,
      rebuiltSessions: sessions,
      removedSessions: 0,
      warnings: [],
    }],
    sessions,
    partial: false,
  };
}

function success(sessions = 1): DesktopResult<RefreshResultDto> {
  return { ok: true, value: refreshResult(sessions) };
}

test("scheduler start is idle, uses the default unref timer, and trigger forwards progress", async () => {
  let timerCallback: (() => void) | undefined;
  let interval = 0;
  let unrefCalled = false;
  let clearCalled = false;
  let refreshCalls = 0;
  const progress: ScanProgressDto[] = [];
  const completed: RefreshResultDto[] = [];
  const handle = { unref() { unrefCalled = true; } };
  const scheduler = createDesktopRefreshScheduler({
    async refresh(onProgress) {
      refreshCalls++;
      onProgress?.({ phase: "detecting" });
      return success(2);
    },
    onProgress: (value) => progress.push(value),
    onComplete: (value) => completed.push(value),
    setInterval(callback, milliseconds) {
      timerCallback = callback;
      interval = milliseconds;
      return handle;
    },
    clearInterval(value) {
      assert.equal(value, handle);
      clearCalled = true;
    },
  });
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  assert.equal(refreshCalls, 0);
  assert.equal(interval, DEFAULT_DESKTOP_REFRESH_INTERVAL_MS);
  assert.equal(unrefCalled, true);
  assert.ok(timerCallback);
  await scheduler.trigger();
  assert.equal(refreshCalls, 1);
  assert.deepEqual(progress, [{ phase: "detecting" }]);
  assert.equal(completed[0]!.sessions, 2);
  scheduler.stop();
  assert.equal(clearCalled, true);
  assert.equal(scheduler.isRunning(), false);
});

test("active refresh coalesces any number of triggers into exactly one follow-up", async () => {
  const first = deferred<DesktopResult<RefreshResultDto>>();
  const second = deferred<DesktopResult<RefreshResultDto>>();
  let calls = 0;
  const scheduler = createDesktopRefreshScheduler({
    refresh() {
      calls++;
      return calls === 1 ? first.promise : second.promise;
    },
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  scheduler.start();
  const running = scheduler.trigger();
  const coalesced = [scheduler.trigger(), scheduler.trigger(), scheduler.trigger()];
  assert.equal(calls, 1);
  first.resolve(success(1));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  second.resolve(success(2));
  await Promise.all([running, ...coalesced]);
  assert.equal(calls, 2);
  scheduler.stop();
});

test("stop clears pending work, suppresses stale callbacks, and allows an explicit restart", async () => {
  const pending = deferred<DesktopResult<RefreshResultDto>>();
  let progressCallback: ((progress: ScanProgressDto) => void) | undefined;
  let completed = 0;
  let errors = 0;
  let calls = 0;
  let cleared = 0;
  const scheduler = createDesktopRefreshScheduler({
    refresh(onProgress) {
      calls++;
      progressCallback = onProgress;
      return pending.promise;
    },
    onProgress: () => { throw new Error("progress must be suppressed after stop"); },
    onComplete: () => { completed++; },
    onError: () => { errors++; },
    setInterval: () => 7,
    clearInterval: () => { cleared++; },
  });
  scheduler.start();
  const active = scheduler.trigger();
  scheduler.trigger();
  scheduler.trigger();
  scheduler.stop();
  progressCallback?.({ phase: "detecting" });
  pending.resolve(success());
  await active;
  await scheduler.trigger();
  assert.equal(calls, 1);
  assert.equal(completed, 0);
  assert.equal(errors, 0);
  assert.equal(cleared, 1);
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  assert.equal(calls, 1);
  scheduler.stop();
  assert.equal(cleared, 2);
});

test("failed results and thrown refreshes are contained and later cycles recover", async () => {
  let calls = 0;
  const errors: string[] = [];
  const completed: number[] = [];
  const scheduler = createDesktopRefreshScheduler({
    async refresh() {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          error: { code: "source_busy", message: "Source is busy.", retryable: true },
        };
      }
      if (calls === 2) throw new Error("unexpected internal failure");
      return success(3);
    },
    onError(error) {
      errors.push(error.code);
      if (errors.length === 1) throw new Error("presentation callback failure must be contained");
    },
    onComplete(result) { completed.push(result.sessions); },
    setInterval: () => 9,
    clearInterval: () => undefined,
  });
  scheduler.start();
  await scheduler.trigger();
  await scheduler.trigger();
  await scheduler.trigger();
  assert.deepEqual(errors, ["source_busy", "background_refresh_failed"]);
  assert.deepEqual(completed, [3]);
  scheduler.stop();
});

test("fake interval ticks share the same coalescing path and stop prevents restart", async () => {
  const pending = deferred<DesktopResult<RefreshResultDto>>();
  let callback: (() => void) | undefined;
  let calls = 0;
  const scheduler = createDesktopRefreshScheduler({
    refresh() {
      calls++;
      return calls === 1 ? pending.promise : Promise.resolve(success());
    },
    intervalMs: 1_000,
    setInterval(fn) { callback = fn; return 11; },
    clearInterval: () => undefined,
  });
  scheduler.start();
  callback?.();
  callback?.();
  callback?.();
  assert.equal(calls, 1);
  pending.resolve(success());
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  scheduler.stop();
  callback?.();
  await Promise.resolve();
  assert.equal(calls, 2);
});

test("scheduler rejects unsafe interval bounds", () => {
  const refresh = async (): Promise<DesktopResult<RefreshResultDto>> => success();
  assert.throws(() => createDesktopRefreshScheduler({ refresh, intervalMs: 999 }), /outside the supported range/);
  assert.throws(
    () => createDesktopRefreshScheduler({ refresh, intervalMs: 24 * 60 * 60 * 1000 + 1 }),
    /outside the supported range/,
  );
  assert.throws(() => createDesktopRefreshScheduler({ refresh, intervalMs: Number.NaN }), /outside the supported range/);
});
