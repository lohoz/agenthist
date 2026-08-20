import {
  isAgent,
  OperationError,
  type Agent,
  type AnalysisProcessRunner,
} from "../application/index.js";
import { paint } from "./style.js";
import { sanitizeHumanOutput } from "./terminal-safety.js";

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliRuntime {
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly home?: string;
  readonly fetcher?: typeof fetch;
  readonly analysisProcessRunner?: AnalysisProcessRunner;
  readonly color?: boolean;
  readonly input?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly output?: NodeJS.WritableStream & { readonly isTTY?: boolean; readonly columns?: number };
  readonly progressOutput?: NodeJS.WritableStream & {
    readonly isTTY?: boolean;
    readonly columns?: number;
  };
}

export interface GlobalOptions {
  readonly json: boolean;
  readonly color: boolean;
  readonly stateDirectory: string;
  readonly codexHome?: string;
  readonly sqliteHome?: string;
  readonly profile?: string;
  readonly opencodeDataRoot?: string;
  readonly opencodeDatabase?: string;
  readonly claudeConfigRoot?: string;
  readonly piSessionRoot?: string;
}

export type CliErrorCode = "invalid_arguments" | "operation_failed" | "internal_error";

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function invalidArguments(message: string): CliUsageError {
  return new CliUsageError(message);
}

const HUMAN_DETAIL_LIMIT = 50;

export type HumanTone =
  | "plain"
  | "strong"
  | "muted"
  | "section"
  | "info"
  | "success"
  | "warning"
  | "warning_strong"
  | "error"
  | "error_strong"
  | "message_user"
  | "message_assistant"
  | "message_system";

export function colorizeHuman(
  text: string,
  tone: HumanTone,
  enabled: boolean,
): string {
  return paint(text, tone, enabled);
}

function renderBoundedHumanItems<T>(
  items: readonly T[],
  render: (item: T) => string,
  label: string,
  limit: number,
  separator: string,
): string {
  const shown = items.slice(0, limit).map(render).join(separator);
  const remaining = items.length - Math.min(items.length, limit);
  const omittedLabel = remaining === 1 ? label : `${label}s`;
  return shown + (remaining === 0
    ? ""
    : `${shown === "" ? "" : separator}... ${remaining} more ${omittedLabel}; ` +
      "use --json for complete details.\n");
}

export function renderBoundedHumanDetails<T>(
  items: readonly T[],
  render: (item: T) => string,
  label: string,
  limit = HUMAN_DETAIL_LIMIT,
): string {
  return renderBoundedHumanItems(items, render, label, limit, "");
}

export function renderBoundedHumanRecords<T>(
  items: readonly T[],
  render: (item: T) => string,
  label: string,
  limit = HUMAN_DETAIL_LIMIT,
): string {
  return renderBoundedHumanItems(items, render, label, limit, "\n");
}

export function readValue(args: readonly string[], index: number, flag: string): [string, number] {
  const argument = args[index]!;
  const equals = argument.indexOf("=");
  if (equals >= 0) {
    const value = argument.slice(equals + 1);
    if (value === "") throw invalidArguments(`${flag} requires a value`);
    return [value, index + 1];
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw invalidArguments(`${flag} requires a value`);
  return [value, index + 2];
}

export function parseAgent(argument: string): Agent {
  if (!isAgent(argument)) throw invalidArguments(`unsupported Agent: ${argument}`);
  return argument;
}

export function success(command: string, data: unknown, human: string, json: boolean, exitCode = 0): CliResult {
  return {
    exitCode,
    stdout: json
      ? `${JSON.stringify({ schema_version: "agenthist.output/v1", command, data })}\n`
      : sanitizeHumanOutput(human),
    stderr: "",
  };
}

export function failure(command: string, error: unknown, json: boolean, color = false): CliResult {
  const detail: {
    readonly code: CliErrorCode;
    readonly message: string;
    readonly exitCode: number;
    readonly details?: Readonly<Record<string, unknown>>;
  } =
    error instanceof CliUsageError
      ? { code: "invalid_arguments", message: error.message, exitCode: 2 }
      : error instanceof OperationError
        ? { code: "operation_failed", message: error.message, exitCode: 3, details: error.details }
      : error instanceof Error
        ? { code: "operation_failed", message: error.message, exitCode: 3 }
        : { code: "internal_error", message: "unknown internal error", exitCode: 9 };
  return json
    ? {
        exitCode: detail.exitCode,
        stdout: `${JSON.stringify({
          schema_version: "agenthist.output/v1",
          command,
          error: {
            code: detail.code,
            message: detail.message,
            ...(detail.details === undefined ? {} : { details: detail.details }),
          },
        })}\n`,
        stderr: "",
      }
    : {
        exitCode: detail.exitCode,
        stdout: "",
        stderr: sanitizeHumanOutput(`${paint("agenthist:", "error_strong", color)} ${detail.message}\n`),
      };
}
