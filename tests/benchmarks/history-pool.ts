import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { scanHistory } from "../../src/application/acquisition.js";
import { listHistory, searchHistory } from "../../src/application/history.js";
import { exportHistory } from "../../src/application/transfer.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SESSIONS = 3_000;
const MAX_SESSIONS = 20_000;

type Operation = "scan" | "rescan" | "list" | "search-miss" | "search-hit" | "export";

interface WorkerOptions {
  readonly stateDirectory: string;
  readonly codexHome: string;
  readonly sqliteHome: string;
  readonly archive: string;
}

interface Metric {
  readonly operation: Operation;
  readonly durationMs: number;
  readonly maxRssKiB: number;
  readonly sessions?: number;
  readonly reusedSessions?: number;
  readonly rebuiltSessions?: number;
  readonly matches?: number;
  readonly returned?: number;
  readonly archiveSizeBytes?: number;
}

function sessionCount(arguments_: readonly string[]): number {
  if (arguments_.length === 0) return DEFAULT_SESSIONS;
  if (arguments_.length !== 2 || arguments_[0] !== "--sessions" || !/^[1-9][0-9]*$/.test(arguments_[1]!)) {
    throw new Error("usage: npm run benchmark:history -- [--sessions <count>]");
  }
  const count = Number(arguments_[1]);
  if (!Number.isSafeInteger(count) || count > MAX_SESSIONS) {
    throw new Error(`history benchmark sessions must be between 1 and ${MAX_SESSIONS}`);
  }
  return count;
}

function nativeId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function rollout(id: string, index: number, timestamp: string): string {
  const distinctive = index === 0 ? " singular-history-benchmark-needle" : "";
  return [
    JSON.stringify({
      timestamp,
      type: "session_meta",
      payload: {
        id,
        session_id: id,
        timestamp,
        cwd: `/work/history-benchmark/${index % 64}`,
        originator: "agenthist_benchmark_fixture",
        cli_version: "capability-fixture",
        model_provider: "benchmark-provider",
        model: "benchmark-model",
      },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Shared benchmark question ${index}${distinctive}` }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Shared benchmark answer ${index}` }],
      },
    }),
    "",
  ].join("\n");
}

async function createFixture(root: string, count: number): Promise<WorkerOptions> {
  const codexHome = path.join(root, "codex");
  const sqliteHome = path.join(root, "sqlite");
  const stateDirectory = path.join(root, "state");
  const archive = path.join(root, "all.agenthist");
  const sessions = path.join(codexHome, "sessions", "2026", "08", "10");
  await mkdir(sessions, { recursive: true });
  await mkdir(sqliteHome, { recursive: true });

  const database = new DatabaseSync(path.join(sqliteHome, "state_5.sqlite"));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      archived INTEGER NOT NULL,
      first_user_message TEXT NOT NULL,
      model TEXT NOT NULL
    );
    CREATE TABLE thread_dynamic_tools (
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      input_schema TEXT NOT NULL,
      defer_loading INTEGER NOT NULL DEFAULT 0,
      namespace TEXT,
      PRIMARY KEY(thread_id, position)
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);
  const insert = database.prepare(`
    INSERT INTO threads
      (id, rollout_path, created_at, updated_at, model_provider, cwd, title, archived, first_user_message, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  database.exec("BEGIN");
  try {
    const pending: Promise<void>[] = [];
    for (let index = 0; index < count; index++) {
      const id = nativeId(index);
      const updated = 1_786_320_000 + ((index * 7_919) % count);
      const timestamp = new Date(updated * 1_000).toISOString();
      const file = path.join(sessions, `rollout-2026-08-10T00-00-00-${id}.jsonl`);
      pending.push(writeFile(file, rollout(id, index, timestamp)));
      insert.run(
        id,
        file,
        updated - 1,
        updated,
        "benchmark-provider",
        `/work/history-benchmark/${index % 64}`,
        `Benchmark conversation ${index}`,
        0,
        `Shared benchmark question ${index}`,
        "benchmark-model",
      );
      if (pending.length === 64) {
        await Promise.all(pending);
        pending.length = 0;
      }
    }
    await Promise.all(pending);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return { stateDirectory, codexHome, sqliteHome, archive };
}

async function measured(operation: Operation, options: WorkerOptions): Promise<Metric> {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
  const started = performance.now();
  let details: Omit<Metric, "operation" | "durationMs" | "maxRssKiB"> = {};
  if (operation === "scan" || operation === "rescan") {
    const result = await scanHistory({
      stateDirectory: options.stateDirectory,
      agents: ["codex"],
      codex: { codexHome: options.codexHome, sqliteHome: options.sqliteHome },
    });
    const agent = result.agents[0];
    if (agent === undefined) throw new Error("history benchmark scan returned no Agent result");
    details = {
      sessions: result.sessions,
      reusedSessions: agent.reusedSessions,
      rebuiltSessions: agent.rebuiltSessions,
    };
  } else if (operation === "list") {
    const result = await listHistory({ stateDirectory: options.stateDirectory, agents: ["codex"] });
    details = { sessions: result.total, returned: result.sessions.length };
  } else if (operation === "search-miss") {
    const result = await searchHistory(
      { stateDirectory: options.stateDirectory, agents: ["codex"] },
      "history-benchmark-value-that-does-not-exist",
    );
    details = { matches: result.total, returned: result.hits.length };
  } else if (operation === "search-hit") {
    const result = await searchHistory(
      { stateDirectory: options.stateDirectory, agents: ["codex"] },
      "singular-history-benchmark-needle",
    );
    details = { matches: result.total, returned: result.hits.length };
  } else {
    const result = await exportHistory({
      stateDirectory: options.stateDirectory,
      agents: ["codex"],
      output: options.archive,
    });
    details = { sessions: result.entries, archiveSizeBytes: result.sizeBytes };
  }
  return {
    operation,
    durationMs: Math.round((performance.now() - started) * 10) / 10,
    maxRssKiB: process.resourceUsage().maxRSS,
    ...details,
  };
}

async function worker(arguments_: readonly string[]): Promise<void> {
  const operation = arguments_[0] as Operation | undefined;
  if (operation !== "scan" && operation !== "rescan" && operation !== "list" && operation !== "search-miss" &&
    operation !== "search-hit" && operation !== "export") {
    throw new Error("history benchmark worker operation is invalid");
  }
  const options = JSON.parse(arguments_[1] ?? "") as WorkerOptions;
  process.stdout.write(`${JSON.stringify(await measured(operation, options))}\n`);
}

async function runWorker(operation: Operation, options: WorkerOptions): Promise<Metric> {
  const entry = fileURLToPath(import.meta.url);
  const result = await execFileAsync(
    process.execPath,
    ["--expose-gc", entry, "worker", operation, JSON.stringify(options)],
    { maxBuffer: 1024 * 1024 },
  );
  if (result.stderr !== "") process.stderr.write(result.stderr);
  return JSON.parse(result.stdout) as Metric;
}

async function main(arguments_: readonly string[]): Promise<void> {
  if (arguments_[0] === "worker") {
    await worker(arguments_.slice(1));
    return;
  }
  const count = sessionCount(arguments_);
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-history-benchmark-"));
  try {
    const options = await createFixture(root, count);
    const metrics: Metric[] = [];
    for (const operation of ["scan", "rescan", "list", "search-miss", "search-hit", "export"] as const) {
      metrics.push(await runWorker(operation, options));
    }
    const rescan = metrics.find((metric) => metric.operation === "rescan");
    if (rescan?.reusedSessions !== count || rescan.rebuiltSessions !== 0) {
      throw new Error("history benchmark rescan did not reuse every unchanged session");
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "agenthist.history-benchmark/v1",
      sessions: count,
      metrics,
    }, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main(process.argv.slice(2));
