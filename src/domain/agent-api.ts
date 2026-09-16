export type AgentApiProtocol = "openai-responses" | "openai-compatible-chat" | "anthropic-messages";

export interface AgentApiConfiguration {
  readonly contextWindow?: number;
  readonly protocol: AgentApiProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly source: string;
}

export class AgentApiConfigurationError extends Error {
  constructor(readonly field: "model" | "endpoint" | "credentials" | "format", message: string) {
    super(message);
    this.name = "AgentApiConfigurationError";
  }
}
