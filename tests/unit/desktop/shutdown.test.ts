import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopShutdownCoordinator } from "../../../src/desktop/shutdown.js";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("shutdown drains close persistence and cleanup before quitting exactly once", async () => {
  const persisted = deferred();
  const cleaned = deferred();
  const events: string[] = [];
  let quitCalls = 0;
  let stopCalls = 0;
  const coordinator = createDesktopShutdownCoordinator({
    stop() { stopCalls++; },
    async cleanup() {
      events.push("cleanup:start");
      await cleaned.promise;
      events.push("cleanup:end");
    },
    quit() { quitCalls++; events.push("quit"); },
  });
  coordinator.queueWindowPersistence(async () => {
    events.push("persist:start");
    await persisted.promise;
    events.push("persist:end");
  });

  const shutdown = coordinator.requestShutdown();
  assert.equal(coordinator.isShuttingDown(), true);
  assert.equal(stopCalls, 1);
  await Promise.resolve();
  assert.deepEqual(events.toSorted(), ["cleanup:start", "persist:start"]);
  cleaned.resolve();
  await Promise.resolve();
  assert.equal(quitCalls, 0);
  persisted.resolve();
  await shutdown;
  assert.deepEqual(events.at(-1), "quit");
  assert.equal(quitCalls, 1);
  assert.equal(coordinator.isComplete(), true);

  await coordinator.requestShutdown();
  assert.equal(stopCalls, 1);
  assert.equal(quitCalls, 1);
});

test("shutdown awaits the latest queued persistence and contains write and cleanup failures", async () => {
  const latest = deferred();
  let quitCalls = 0;
  const coordinator = createDesktopShutdownCoordinator({
    stop() { throw new Error("stop failure"); },
    async cleanup() { throw new Error("private cleanup failure"); },
    quit() { quitCalls++; },
  });
  coordinator.queueWindowPersistence(async () => { throw new Error("private write failure"); });
  const shutdown = coordinator.requestShutdown();
  coordinator.queueWindowPersistence(async () => { await latest.promise; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(quitCalls, 0);
  latest.resolve();
  await shutdown;
  assert.equal(quitCalls, 1);
  assert.equal(coordinator.isComplete(), true);

  coordinator.queueWindowPersistence(async () => {
    throw new Error("must not run after shutdown");
  });
  await Promise.resolve();
  assert.equal(quitCalls, 1);
});
