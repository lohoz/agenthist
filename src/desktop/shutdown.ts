export interface DesktopShutdownCoordinatorOptions {
  readonly stop: () => void;
  readonly cleanup: () => Promise<void>;
  readonly quit: () => void;
}

export interface DesktopShutdownCoordinator {
  queueWindowPersistence(operation: () => Promise<void>): void;
  requestShutdown(finalWindowPersistence?: () => Promise<void>): Promise<void>;
  isShuttingDown(): boolean;
  isComplete(): boolean;
}

export function createDesktopShutdownCoordinator(
  options: DesktopShutdownCoordinatorOptions,
): DesktopShutdownCoordinator {
  let windowPersistenceTail: Promise<void> = Promise.resolve();
  let acceptingWindowPersistence = true;
  let shutdownInFlight: Promise<void> | undefined;
  let complete = false;

  const queueWindowPersistence = (operation: () => Promise<void>): void => {
    if (!acceptingWindowPersistence) return;
    const pending = windowPersistenceTail.then(operation);
    // Persistence failures must neither become unhandled rejections nor keep
    // the application alive forever. Later writes still run in order.
    windowPersistenceTail = pending.then(() => undefined, () => undefined);
  };

  const drainWindowPersistence = async (): Promise<void> => {
    while (true) {
      const observed = windowPersistenceTail;
      await observed;
      if (observed === windowPersistenceTail) return;
    }
  };

  const requestShutdown = (
    finalWindowPersistence?: () => Promise<void>,
  ): Promise<void> => {
    if (shutdownInFlight !== undefined) return shutdownInFlight;
    if (complete) return Promise.resolve();
    if (finalWindowPersistence !== undefined) queueWindowPersistence(finalWindowPersistence);
    try { options.stop(); } catch { /* shutdown must continue */ }
    shutdownInFlight = (async () => {
      const cleanup = Promise.resolve()
        .then(options.cleanup)
        .then(() => undefined, () => undefined);
      await Promise.all([cleanup, drainWindowPersistence()]);
      // Include persistence queued while service cleanup was draining.
      await drainWindowPersistence();
      acceptingWindowPersistence = false;
      complete = true;
      options.quit();
    })();
    return shutdownInFlight;
  };

  return {
    queueWindowPersistence,
    requestShutdown,
    isShuttingDown() { return shutdownInFlight !== undefined && !complete; },
    isComplete() { return complete; },
  };
}
