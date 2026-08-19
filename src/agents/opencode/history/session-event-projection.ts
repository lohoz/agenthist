type SQLiteRow = Record<string, unknown>;

interface OpenCodeSessionEvent {
  readonly data: Record<string, unknown>;
  readonly seq: number;
  readonly timestamp: number;
  readonly type: string;
}

interface OpenCodeMessageEvent extends OpenCodeSessionEvent {
  readonly messageId: string;
}

interface OpenCodeCompactionEvent extends OpenCodeMessageEvent {
  readonly kind: "started" | "ended";
  readonly reason: "auto" | "manual";
  readonly text?: string;
  readonly recent?: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try { return objectValue(JSON.parse(value)); } catch { return undefined; }
}

function integer(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return undefined;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const fields = new Set(allowed);
  return Object.keys(value).every((name) => fields.has(name));
}

function sessionEvent(row: SQLiteRow, types: ReadonlySet<string>): OpenCodeSessionEvent | undefined {
  const data = jsonObject(row.data);
  const type = typeof row.type === "string" && types.has(row.type) ? row.type : undefined;
  const seq = integer(row.seq);
  const timestamp = data === undefined ? undefined : integer(data.timestamp);
  if (
    type === undefined || typeof row.id !== "string" || row.id === "" ||
    typeof row.aggregate_id !== "string" || row.aggregate_id === "" ||
    data === undefined || seq === undefined || timestamp === undefined ||
    data.sessionID !== row.aggregate_id
  ) return undefined;
  return { data, seq, timestamp, type };
}

function messageEvent(row: SQLiteRow, types: ReadonlySet<string>): OpenCodeMessageEvent | undefined {
  const event = sessionEvent(row, types);
  if (event === undefined || typeof event.data.messageID !== "string" || event.data.messageID === "") return undefined;
  return { ...event, messageId: event.data.messageID };
}

const COMPACTION_EVENT_TYPES = new Set([
  "session.next.compaction.started.1",
  "session.next.compaction.ended.1",
]);

function compactionEvent(row: SQLiteRow): OpenCodeCompactionEvent | undefined {
  const event = messageEvent(row, COMPACTION_EVENT_TYPES);
  if (event === undefined) return undefined;
  const reason = event.data.reason;
  if (reason !== "auto" && reason !== "manual") return undefined;
  if (event.type === "session.next.compaction.started.1") {
    if (!hasOnlyFields(event.data, ["timestamp", "sessionID", "messageID", "reason"])) return undefined;
    return { ...event, kind: "started", reason };
  }
  if (
    !hasOnlyFields(event.data, ["timestamp", "sessionID", "messageID", "reason", "text", "recent"]) ||
    typeof event.data.text !== "string" || typeof event.data.recent !== "string"
  ) return undefined;
  return {
    ...event,
    kind: "ended",
    reason,
    text: event.data.text,
    recent: event.data.recent,
  };
}

export function closedOpenCodeCompactionEvent(
  row: SQLiteRow,
  data: Record<string, unknown>,
  events: readonly SQLiteRow[],
): boolean {
  const messageId = typeof row.id === "string" ? row.id : undefined;
  const sessionId = typeof row.session_id === "string" ? row.session_id : undefined;
  const rowSeq = integer(row.seq);
  const rowTimestamp = integer(row.time_created);
  if (messageId === undefined || sessionId === undefined || rowSeq === undefined || rowTimestamp === undefined) {
    return false;
  }
  const relevant = events.filter((event) =>
    event.aggregate_id === sessionId && typeof event.type === "string" && COMPACTION_EVENT_TYPES.has(event.type)
  );
  const decoded = relevant.map(compactionEvent);
  if (decoded.some((event) => event === undefined)) return false;
  const matching = decoded.filter(
    (event): event is OpenCodeCompactionEvent => event !== undefined && event.messageId === messageId,
  );
  const started = matching.filter((event) => event.kind === "started");
  const ended = matching.filter((event) => event.kind === "ended");
  const start = started[0];
  const end = ended[0];
  return started.length === 1 && ended.length === 1 && start !== undefined && end !== undefined &&
    start.seq < end.seq && start.timestamp <= end.timestamp && end.seq === rowSeq && end.timestamp === rowTimestamp &&
    start.reason === end.reason && data.reason === end.reason && data.summary === end.text && data.recent === end.recent;
}

const CONTEXT_EVENT_TYPES = new Set(["session.next.context.updated.1"]);

function contextEvent(row: SQLiteRow): OpenCodeMessageEvent | undefined {
  const event = messageEvent(row, CONTEXT_EVENT_TYPES);
  return event !== undefined && hasOnlyFields(event.data, ["timestamp", "sessionID", "messageID", "text"]) &&
      typeof event.data.text === "string"
    ? event
    : undefined;
}

export function closedOpenCodeSystemEvent(
  row: SQLiteRow,
  data: Record<string, unknown>,
  events: readonly SQLiteRow[],
): boolean {
  const messageId = typeof row.id === "string" ? row.id : undefined;
  const sessionId = typeof row.session_id === "string" ? row.session_id : undefined;
  const rowSeq = integer(row.seq);
  const rowTimestamp = integer(row.time_created);
  if (messageId === undefined || sessionId === undefined || rowSeq === undefined || rowTimestamp === undefined) {
    return false;
  }
  const relevant = events.filter((event) =>
    event.aggregate_id === sessionId && typeof event.type === "string" && CONTEXT_EVENT_TYPES.has(event.type)
  );
  const decoded = relevant.map(contextEvent);
  if (decoded.some((event) => event === undefined)) return false;
  const matching = decoded.filter(
    (event): event is OpenCodeMessageEvent => event !== undefined && event.messageId === messageId,
  );
  const event = matching[0];
  return matching.length === 1 && event !== undefined && event.seq === rowSeq && event.timestamp === rowTimestamp &&
    event.data.text === data.text;
}

const SYNTHETIC_EVENT_TYPES = new Set(["session.next.synthetic.1"]);

function syntheticEvent(row: SQLiteRow): OpenCodeMessageEvent | undefined {
  const event = messageEvent(row, SYNTHETIC_EVENT_TYPES);
  return event !== undefined && hasOnlyFields(event.data, ["timestamp", "sessionID", "messageID", "text"]) &&
      typeof event.data.text === "string"
    ? event
    : undefined;
}

export function closedOpenCodeSyntheticEvent(
  row: SQLiteRow,
  data: Record<string, unknown>,
  events: readonly SQLiteRow[],
): boolean {
  const messageId = typeof row.id === "string" ? row.id : undefined;
  const sessionId = typeof row.session_id === "string" ? row.session_id : undefined;
  const rowSeq = integer(row.seq);
  const rowTimestamp = integer(row.time_created);
  if (messageId === undefined || sessionId === undefined || rowSeq === undefined || rowTimestamp === undefined) {
    return false;
  }
  const relevant = events.filter((event) =>
    event.aggregate_id === sessionId && typeof event.type === "string" && SYNTHETIC_EVENT_TYPES.has(event.type)
  );
  const decoded = relevant.map(syntheticEvent);
  if (decoded.some((event) => event === undefined)) return false;
  const matching = decoded.filter(
    (event): event is OpenCodeMessageEvent => event !== undefined && event.messageId === messageId,
  );
  const event = matching[0];
  return matching.length === 1 && event !== undefined && event.seq === rowSeq && event.timestamp === rowTimestamp &&
    event.data.text === data.text && event.data.sessionID === data.sessionID;
}

const SHELL_EVENT_TYPES = new Set([
  "session.next.shell.started.1",
  "session.next.shell.ended.1",
]);

type OpenCodeShellEvent =
  | (OpenCodeMessageEvent & {
      readonly callId: string;
      readonly command: string;
      readonly kind: "started";
    })
  | (OpenCodeSessionEvent & {
      readonly callId: string;
      readonly kind: "ended";
      readonly output: string;
    });

function shellEvent(row: SQLiteRow): OpenCodeShellEvent | undefined {
  const event = sessionEvent(row, SHELL_EVENT_TYPES);
  if (event === undefined || typeof event.data.callID !== "string" || event.data.callID === "") return undefined;
  if (event.type === "session.next.shell.started.1") {
    const message = messageEvent(row, SHELL_EVENT_TYPES);
    if (
      message === undefined ||
      !hasOnlyFields(message.data, ["timestamp", "sessionID", "messageID", "callID", "command"]) ||
      typeof message.data.command !== "string"
    ) return undefined;
    return { ...message, callId: message.data.callID as string, command: message.data.command, kind: "started" };
  }
  if (
    !hasOnlyFields(event.data, ["timestamp", "sessionID", "callID", "output"]) ||
    typeof event.data.output !== "string"
  ) return undefined;
  return { ...event, callId: event.data.callID, kind: "ended", output: event.data.output };
}

export function closedOpenCodeShellEvents(
  row: SQLiteRow,
  data: Record<string, unknown>,
  events: readonly SQLiteRow[],
): boolean {
  const messageId = typeof row.id === "string" ? row.id : undefined;
  const sessionId = typeof row.session_id === "string" ? row.session_id : undefined;
  const rowSeq = integer(row.seq);
  const rowTimestamp = integer(row.time_created);
  const completed = integer(objectValue(data.time)?.completed);
  if (
    messageId === undefined || sessionId === undefined || rowSeq === undefined || rowTimestamp === undefined ||
    completed === undefined || typeof data.callID !== "string"
  ) return false;
  const relevant = events.filter((event) =>
    event.aggregate_id === sessionId && typeof event.type === "string" && SHELL_EVENT_TYPES.has(event.type)
  );
  const decoded = relevant.map(shellEvent);
  if (decoded.some((event) => event === undefined)) return false;
  const matching = decoded.filter(
    (event): event is OpenCodeShellEvent => event !== undefined && event.callId === data.callID,
  );
  const started = matching.filter(
    (event): event is Extract<OpenCodeShellEvent, { readonly kind: "started" }> =>
      event.kind === "started" && event.messageId === messageId,
  );
  const ended = matching.filter(
    (event): event is Extract<OpenCodeShellEvent, { readonly kind: "ended" }> => event.kind === "ended",
  );
  const start = started[0];
  const end = ended[0];
  return matching.length === 2 && started.length === 1 && ended.length === 1 && start !== undefined && end !== undefined &&
    start.seq === rowSeq && start.timestamp === rowTimestamp && start.command === data.command &&
    start.seq < end.seq && start.timestamp <= end.timestamp && end.timestamp === completed && end.output === data.output;
}
