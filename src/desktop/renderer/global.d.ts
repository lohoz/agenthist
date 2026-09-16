import type { AgentHistDesktopApi } from "../contracts.js";

declare global {
  interface Window {
    readonly agentHist: AgentHistDesktopApi;
  }
}

export {};
