import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

class TestResizeObserver implements ResizeObserver {
  readonly #callback: ResizeObserverCallback;
  readonly #observed = new WeakSet<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }

  readonly observe = vi.fn((target: Element): void => {
    if (this.#observed.has(target)) return;
    this.#observed.add(target);
    const rect = target.getBoundingClientRect();
    const entry = {
      target,
      contentRect: rect,
      borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
      contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
      devicePixelContentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
    } as unknown as ResizeObserverEntry;
    queueMicrotask(() => this.#callback([entry], this));
  });
  readonly unobserve = vi.fn((target: Element): void => {
    this.#observed.delete(target);
  });
  readonly disconnect = vi.fn();
}

afterEach(() => cleanup());

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: TestResizeObserver,
});

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: vi.fn((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })),
});

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: vi.fn(async () => {}) },
});

Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value(this: HTMLElement): DOMRect {
    const height = this.classList.contains("virtual-list-row")
      ? 82
      : this.classList.contains("virtual-conversation-row")
        ? 128
        : this.classList.contains("chat-list-scroll") || this.classList.contains("conversation-scroll")
          ? 720
          : 40;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 900,
      bottom: height,
      width: 900,
      height,
      toJSON: () => ({}),
    };
  },
});

Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement): number {
    return this.classList.contains("chat-list-scroll") || this.classList.contains("conversation-scroll") ? 720 : 40;
  },
});

Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get(): number { return 900; },
});

Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement): number { return this.clientHeight; },
});

Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(this: HTMLElement): number { return this.clientWidth; },
});

HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number, y?: number): void {
  this.scrollTop = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
  this.dispatchEvent(new Event("scroll"));
};

HTMLElement.prototype.hasPointerCapture = function hasPointerCapture(): boolean { return false; };
HTMLElement.prototype.setPointerCapture = function setPointerCapture(): void {};
HTMLElement.prototype.releasePointerCapture = function releasePointerCapture(): void {};
HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {};

Object.defineProperty(window, "requestAnimationFrame", {
  configurable: true,
  writable: true,
  value: (callback: FrameRequestCallback): number => window.setTimeout(() => callback(performance.now()), 0),
});

Object.defineProperty(window, "cancelAnimationFrame", {
  configurable: true,
  writable: true,
  value: (handle: number): void => window.clearTimeout(handle),
});
