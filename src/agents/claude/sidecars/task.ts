import { readFile } from "node:fs/promises";

import { canonicalClaudeUuid } from "../identity.js";

const TASK_ID = /^(?:0|[1-9][0-9]*)$/;
const TASK_FIELDS = new Set([
  "id",
  "subject",
  "description",
  "activeForm",
  "owner",
  "status",
  "blocks",
  "blockedBy",
  "metadata",
]);
const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);

export type ClaudeTaskFileRole = "task-entry" | "task-highwatermark";

export interface ClaudeTaskPathIdentity {
  readonly sessionId: string;
  readonly role: ClaudeTaskFileRole;
  readonly taskId?: string;
}

export interface ClaudeTaskFile {
  readonly relativePath: string;
  readonly role: ClaudeTaskFileRole;
  readonly filePath: string;
}

export interface ClaudeTaskItem {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly blocks: readonly string[];
  readonly blockedBy: readonly string[];
  readonly metadataPresent: boolean;
}

export interface ClaudeTaskList {
  readonly tasks: readonly ClaudeTaskItem[];
  readonly highwatermark?: number;
  readonly searchText: readonly string[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalTaskId(value: unknown, allowZero = false): string | undefined {
  if (typeof value !== "string" || !TASK_ID.test(value)) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1) || String(number) !== value) return undefined;
  return value;
}

export function claudeTaskPathIdentity(relativePath: string): ClaudeTaskPathIdentity | undefined {
  const raw = relativePath.split("/");
  const parts = raw[0] === "claude" ? raw.slice(1) : raw;
  if (parts.length !== 3 || parts[0] !== "tasks") return undefined;
  let sessionId: string;
  try { sessionId = canonicalClaudeUuid(parts[1]!); } catch { return undefined; }
  if (parts[2] === ".highwatermark") return { sessionId, role: "task-highwatermark" };
  if (!parts[2]!.endsWith(".json")) return undefined;
  const taskId = canonicalTaskId(parts[2]!.slice(0, -".json".length));
  return taskId === undefined ? undefined : { sessionId, role: "task-entry", taskId };
}

function taskStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    const id = canonicalTaskId(item);
    if (id === undefined || result.includes(id)) return undefined;
    result.push(id);
  }
  return result;
}

function taskItem(value: unknown, expectedId: string): ClaudeTaskItem | undefined {
  const item = objectValue(value);
  if (item === undefined || Object.keys(item).some((field) => !TASK_FIELDS.has(field))) return undefined;
  const id = canonicalTaskId(item.id);
  const blocks = taskStrings(item.blocks);
  const blockedBy = taskStrings(item.blockedBy);
  if (
    id !== expectedId || typeof item.subject !== "string" || typeof item.description !== "string" ||
    (item.activeForm !== undefined && typeof item.activeForm !== "string") ||
    (item.owner !== undefined && typeof item.owner !== "string") ||
    typeof item.status !== "string" || !TASK_STATUSES.has(item.status) ||
    blocks === undefined || blockedBy === undefined || blocks.includes(id) || blockedBy.includes(id) ||
    (item.metadata !== undefined && objectValue(item.metadata) === undefined)
  ) return undefined;
  return {
    id,
    subject: item.subject,
    description: item.description,
    ...(item.activeForm === undefined ? {} : { activeForm: item.activeForm }),
    ...(item.owner === undefined ? {} : { owner: item.owner }),
    status: item.status as ClaudeTaskItem["status"],
    blocks,
    blockedBy,
    metadataPresent: item.metadata !== undefined,
  };
}

function taskGraphClosed(tasks: readonly ClaudeTaskItem[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) return false;
  for (const task of tasks) {
    for (const blocked of task.blocks) {
      if (!byId.get(blocked)?.blockedBy.includes(task.id)) return false;
    }
    for (const blocker of task.blockedBy) {
      if (!byId.get(blocker)?.blocks.includes(task.id)) return false;
    }
  }
  return true;
}

export function parseClaudeTaskItems(value: unknown): readonly ClaudeTaskItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tasks: ClaudeTaskItem[] = [];
  let previousId = 0;
  for (const valueItem of value) {
    const record = objectValue(valueItem);
    const id = canonicalTaskId(record?.id);
    const task = id === undefined ? undefined : taskItem(record, id);
    const numericId = id === undefined ? 0 : Number(id);
    if (task === undefined || numericId <= previousId) return undefined;
    tasks.push(task);
    previousId = numericId;
  }
  return taskGraphClosed(tasks) ? tasks : undefined;
}

export async function validateClaudeTaskList(options: {
  readonly sessionId: string;
  readonly files: readonly ClaudeTaskFile[];
}): Promise<ClaudeTaskList> {
  const sessionId = canonicalClaudeUuid(options.sessionId);
  const paths = new Set<string>();
  const tasks: ClaudeTaskItem[] = [];
  let highwatermark: number | undefined;
  for (const file of options.files) {
    if (paths.has(file.relativePath)) throw new Error("Claude Code task carrier is duplicated");
    paths.add(file.relativePath);
    const identity = claudeTaskPathIdentity(file.relativePath);
    if (identity === undefined || identity.sessionId !== sessionId || identity.role !== file.role) {
      throw new Error("Claude Code task carrier path is invalid");
    }
    const content = await readFile(file.filePath, "utf8");
    if (file.role === "task-highwatermark") {
      if (highwatermark !== undefined) throw new Error("Claude Code task highwatermark is duplicated");
      const value = canonicalTaskId(content.trim(), true);
      if (value === undefined) throw new Error("Claude Code task highwatermark is invalid");
      highwatermark = Number(value);
      continue;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new Error("Claude Code task entry is invalid JSON"); }
    const task = taskItem(parsed, identity.taskId!);
    if (task === undefined) throw new Error("Claude Code task entry schema is invalid");
    tasks.push(task);
  }
  tasks.sort((left, right) => Number(left.id) - Number(right.id));
  if (!taskGraphClosed(tasks)) throw new Error("Claude Code task dependency graph is incomplete");
  const maximum = tasks.length === 0 ? 0 : Number(tasks[tasks.length - 1]!.id);
  if (highwatermark !== undefined && highwatermark < maximum) {
    throw new Error("Claude Code task highwatermark precedes a live task");
  }
  return {
    tasks,
    ...(highwatermark === undefined ? {} : { highwatermark }),
    searchText: [...new Set(tasks.flatMap((task) => [task.subject, task.description, task.activeForm ?? ""]).filter(Boolean))],
  };
}
