import { paint } from "./style.js";
import { displayWidth, truncateDisplay } from "./terminal-layout.js";
import type { CliRuntime, GlobalOptions } from "./command-support.js";

const CLEAR_LINE = "\r\u001b[2K";
const FRAMES = ["-", "\\", "|", "/"] as const;
const DEFAULT_DELAY_MILLISECONDS = 200;
const DEFAULT_INTERVAL_MILLISECONDS = 200;
const DEFAULT_WIDTH = 80;

export interface LiveStatus {
  update(message: string): void;
  stop(): void;
}

export interface LiveStatusOptions {
  readonly output?: NodeJS.WritableStream & {
    readonly isTTY?: boolean;
    readonly columns?: number;
  };
  readonly enabled: boolean;
  readonly color: boolean;
  readonly message: string;
  readonly delayMilliseconds?: number;
  readonly intervalMilliseconds?: number;
  readonly now?: () => number;
}

class DisabledLiveStatus implements LiveStatus {
  update(_message: string): void {}
  stop(): void {}
}

class TerminalLiveStatus implements LiveStatus {
  readonly #output: NonNullable<LiveStatusOptions["output"]>;
  readonly #color: boolean;
  readonly #startedAt: number;
  readonly #now: () => number;
  readonly #intervalMilliseconds: number;
  #message: string;
  #frame = 0;
  #visible = false;
  #stopped = false;
  #delayTimer: NodeJS.Timeout | undefined;
  #intervalTimer: NodeJS.Timeout | undefined;

  constructor(options: LiveStatusOptions) {
    this.#output = options.output!;
    this.#color = options.color;
    this.#message = options.message;
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    this.#intervalMilliseconds = options.intervalMilliseconds ?? DEFAULT_INTERVAL_MILLISECONDS;
    const delay = options.delayMilliseconds ?? DEFAULT_DELAY_MILLISECONDS;
    if (delay <= 0) {
      this.#begin();
    } else {
      this.#delayTimer = setTimeout(() => this.#begin(), delay);
      this.#delayTimer.unref();
    }
  }

  update(message: string): void {
    if (this.#stopped) return;
    this.#message = message;
    if (this.#visible) this.#render();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#delayTimer !== undefined) clearTimeout(this.#delayTimer);
    if (this.#intervalTimer !== undefined) clearInterval(this.#intervalTimer);
    if (this.#visible) this.#output.write(CLEAR_LINE);
  }

  #begin(): void {
    if (this.#stopped) return;
    this.#visible = true;
    this.#render();
    this.#intervalTimer = setInterval(() => {
      this.#frame = (this.#frame + 1) % FRAMES.length;
      this.#render();
    }, this.#intervalMilliseconds);
    this.#intervalTimer.unref();
  }

  #render(): void {
    const frame = FRAMES[this.#frame]!;
    const seconds = Math.max(0, this.#now() - this.#startedAt) / 1_000;
    const elapsed = `${seconds.toFixed(1)}s`;
    const plainPrefix = `${frame} `;
    const plainSuffix = ` · ${elapsed}`;
    const width = Math.max(12, this.#output.columns ?? DEFAULT_WIDTH);
    const messageWidth = Math.max(1, width - displayWidth(plainPrefix) - displayWidth(plainSuffix));
    const message = truncateDisplay(this.#message, messageWidth);
    this.#output.write(
      CLEAR_LINE + paint(frame, "info", this.#color) + " " + message +
      paint(plainSuffix, "muted", this.#color),
    );
  }
}

export function createLiveStatus(options: LiveStatusOptions): LiveStatus {
  if (!options.enabled || options.output?.isTTY !== true) return new DisabledLiveStatus();
  return new TerminalLiveStatus(options);
}

export async function withLiveStatus<T>(
  runtime: CliRuntime,
  globals: Pick<GlobalOptions, "json" | "color">,
  message: string,
  action: (status: LiveStatus) => Promise<T>,
): Promise<T> {
  const environment = runtime.environment ?? process.env;
  const status = createLiveStatus({
    ...(runtime.progressOutput === undefined ? {} : { output: runtime.progressOutput }),
    enabled: !globals.json && environment.TERM !== "dumb",
    color: globals.color,
    message,
  });
  try {
    return await action(status);
  } finally {
    status.stop();
  }
}
