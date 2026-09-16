import { AnalysisFailure, type AnalysisCompletion, type AnalysisFailureReason, type OpenAIAnalysisProfile, type RequestAnalysisOptions } from "./model.js";

const BYTE_LIMIT = 4 * 1024 * 1024;
type HttpOptions = RequestAnalysisOptions & { readonly profile: OpenAIAnalysisProfile };
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function number(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }

function failure(options: HttpOptions, reason: AnalysisFailureReason, status?: number): AnalysisFailure {
  return new AnalysisFailure(`Agent API request failed: ${reason}${status === undefined ? "" : ` (HTTP ${status})`}`, {
    reason, stage: options.stage, retryable: ["timeout", "rate_limited", "upstream_failed", "connection_failed"].includes(reason),
    tier: options.profile.tier, endpoint: new URL(options.profile.requestUrl).origin, model: options.profile.model,
    ...(status === undefined ? {} : { status }),
  });
}

function httpReason(status: number): AnalysisFailureReason {
  return status === 401 || status === 403 ? "authentication_failed" : status === 404 ? "endpoint_or_model_not_found"
    : status === 429 ? "rate_limited" : status >= 500 ? "upstream_failed" : "request_rejected";
}

function requestBody(options: HttpOptions): Record<string, unknown> {
  const { profile, messages, responseFormat } = options;
  if (profile.backend === "openai-responses") return {
    model: profile.model, store: false, stream: true,
    instructions: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"),
    input: messages.filter((message) => message.role !== "system"),
    text: { format: { type: "json_schema", name: responseFormat.name, strict: true, schema: responseFormat.schema } },
    // Connectivity checks must leave space for reasoning before the short JSON answer.
    max_output_tokens: Math.max(options.maximumOutputTokens, options.stage === "model_check" ? 1024 : 0),
    ...(options.stage === "model_check" && /^(gpt-[56]|o[134])(?:[.-]|$)/u.test(profile.model) ? { reasoning: { effort: "low" } } : {}),
  };
  if (profile.backend === "anthropic-messages") return {
    model: profile.model, stream: true, max_tokens: options.maximumOutputTokens,
    system: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"),
    messages: messages.filter((message) => message.role !== "system"),
    output_config: { format: { type: "json_schema", schema: responseFormat.schema } },
  };
  return {
    model: profile.model, messages, stream: true, stream_options: { include_usage: true },
    max_completion_tokens: options.maximumOutputTokens,
    response_format: { type: "json_schema", json_schema: { name: responseFormat.name, strict: true, schema: responseFormat.schema } },
  };
}

export async function requestHttpAnalysis(options: HttpOptions): Promise<AnalysisCompletion> {
  const controller = new AbortController();
  const timeout = options.timeoutMs ?? (options.stage === "model_check" ? 30_000 : 90_000);
  let idleTimer = setTimeout(() => controller.abort(), timeout);
  const totalTimer = setTimeout(() => controller.abort(), options.stage === "model_check" ? timeout : timeout * 6);
  const resetIdle = (): void => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), timeout); };
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await (options.fetcher ?? fetch)(options.profile.requestUrl, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", accept: "text/event-stream, application/json",
        ...(options.profile.headers ?? { authorization: `Bearer ${options.profile.apiKey}` }) },
      body: JSON.stringify(requestBody(options)),
    });
    if (!response.ok) throw failure(options, httpReason(response.status), response.status);
    if (response.body === null) throw failure(options, "protocol_mismatch", response.status);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const streaming = response.headers.get("content-type")?.includes("text/event-stream") === true;
    let buffer = "";
    let bytes = 0;
    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let complete = false;
    let stoppedEarly = false;
    const usage = (value: unknown): void => {
      const data = object(value);
      inputTokens = number(data.input_tokens ?? data.prompt_tokens) || inputTokens;
      outputTokens = number(data.output_tokens ?? data.completion_tokens) || outputTokens;
      totalTokens = number(data.total_tokens) || inputTokens + outputTokens;
    };
    const responseText = (value: unknown): string => {
      const data = object(value);
      if (typeof data.output_text === "string") return data.output_text;
      return (Array.isArray(data.output) ? data.output : []).flatMap((item) => {
        const blocks = object(item).content;
        return (Array.isArray(blocks) ? blocks : []).flatMap((block) => object(block).type === "output_text" && typeof object(block).text === "string" ? [object(block).text] : []);
      }).join("");
    };
    const event = (raw: string): void => {
      const data = raw.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data === "") return;
      if (data === "[DONE]") { complete = true; return; }
      let value: Record<string, unknown>;
      try { value = object(JSON.parse(data)); } catch { throw failure(options, "protocol_mismatch", response!.status); }
      const type = value.type;
      if (type === "error" || type === "response.failed" || value.error) {
        const error = object(value.error ?? object(value.response).error);
        const code = String(error.code ?? error.type ?? "");
        throw failure(options, code === "cyber_policy" || code === "content_filter" ? "content_rejected"
          : /rate_limit/u.test(code) ? "rate_limited" : /auth/u.test(code) ? "authentication_failed" : "upstream_failed", response!.status);
      }
      if (type === "response.incomplete") throw failure(options, "invalid_model_output", response!.status);
      if (type === "response.output_text.delta" && typeof value.delta === "string") content += value.delta;
      if (type === "response.completed") {
        content = responseText(value.response) || content;
        usage(object(value.response).usage);
        complete = true;
      }
      if (type === "message_start") usage(object(value.message).usage);
      if (type === "content_block_start" && object(value.content_block).type === "text") content += String(object(value.content_block).text ?? "");
      if (type === "content_block_delta" && object(value.delta).type === "text_delta") content += String(object(value.delta).text ?? "");
      if (type === "message_delta") { usage(value.usage); stoppedEarly = object(value.delta).stop_reason === "max_tokens"; }
      if (type === "message_stop") complete = true;
      if (Array.isArray(value.choices)) {
        const choice = object(value.choices[0]);
        const delta = object(choice.delta);
        if (typeof delta.content === "string") content += delta.content;
        if (choice.finish_reason === "length") stoppedEarly = true;
        usage(value.usage);
      }
    };
    while (!complete) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      resetIdle();
      bytes += value.byteLength;
      if (bytes > BYTE_LIMIT) throw failure(options, "protocol_mismatch", response.status);
      buffer += decoder.decode(value, { stream: true });
      if (streaming) {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/u.exec(buffer)) !== null) {
          event(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (complete) break;
        }
      }
    }
    if (streaming && !complete && buffer.trim()) event(buffer);
    if (!streaming) {
      let data: Record<string, unknown>;
      try { data = object(JSON.parse(buffer)); } catch { throw failure(options, "protocol_mismatch", response.status); }
      if (data.error) throw failure(options, "upstream_failed", response.status);
      usage(data.usage);
      if (options.profile.backend === "openai-responses") {
        content = responseText(data);
        complete = data.status === "completed";
        stoppedEarly = data.status === "incomplete";
      } else if (options.profile.backend === "anthropic-messages") {
        content = (Array.isArray(data.content) ? data.content : []).flatMap((item) => object(item).type === "text" ? [String(object(item).text ?? "")] : []).join("");
        complete = data.type === "message";
        stoppedEarly = data.stop_reason === "max_tokens";
      } else {
        const choice = object(Array.isArray(data.choices) ? data.choices[0] : undefined);
        content = String(object(choice.message).content ?? "");
        complete = !!content;
        stoppedEarly = choice.finish_reason === "length";
      }
    }
    if (!complete || !content || stoppedEarly) throw failure(options, stoppedEarly ? "invalid_model_output" : "protocol_mismatch", response.status);
    return { content, usage: { inputTokens, outputTokens, totalTokens },
      ...(response.headers.get("x-request-id") ? { requestId: response.headers.get("x-request-id")! } : {}) };
  } catch (error) {
    if (error instanceof AnalysisFailure) throw error;
    const code = String((error as { cause?: { code?: string } }).cause?.code ?? "");
    throw failure(options, controller.signal.aborted ? "timeout" : /ENOTFOUND|EAI_AGAIN/u.test(code) ? "dns_failed" : /CERT|TLS|SSL/u.test(code) ? "tls_failed" : "connection_failed");
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (reader !== undefined) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    else if (response?.body) void response.body.cancel().catch(() => undefined);
  }
}
