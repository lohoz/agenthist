import {
  listCodexProviderUsage,
  listCodexProviders,
  resolveCodexSource,
  unifyCodexProviders,
} from "../agents/codex/index.js";
import { withStateReadLock, withStateWriteLock } from "../infrastructure/state.js";
import { assertNoPendingTransactions } from "../infrastructure/transaction-store.js";

export interface CodexCurrentProviderOptions {
  readonly codexHome?: string;
  readonly sqliteHome?: string;
  readonly profile?: string;
  readonly cwd?: string;
  readonly home?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CodexProviderHistoryOptions extends CodexCurrentProviderOptions {
  readonly stateDirectory: string;
}

export interface CodexProviderHistoryCount {
  readonly provider: string;
  readonly sessions: number;
  readonly current: boolean;
}

export interface CodexProviderHistoryList {
  readonly currentProvider: string;
  readonly providers: readonly CodexProviderHistoryCount[];
  readonly totalSessions: number;
}

export interface CodexProviderHistoryChange {
  readonly sessionRef: string;
  readonly before: string;
  readonly after: string;
}

export interface CodexProviderHistoryUnifyResult {
  readonly targetProvider: string;
  readonly dryRun: boolean;
  readonly changed: number;
  readonly unchanged: number;
  readonly changes: readonly CodexProviderHistoryChange[];
  readonly transactionRef?: string;
}

export async function resolveCodexCurrentProvider(
  options: CodexCurrentProviderOptions,
): Promise<string> {
  const source = await resolveCodexSource(options);
  if (source.currentProvider === "") {
    throw new Error(`Codex current provider cannot be resolved from ${source.configPath}`);
  }
  return source.currentProvider;
}

export async function listCodexImportProviders(
  options: CodexCurrentProviderOptions,
): Promise<CodexProviderHistoryList> {
  const result = await listCodexProviderUsage(options);
  return {
    currentProvider: result.currentProvider,
    providers: result.providers.map((item) => ({
      provider: item.provider,
      sessions: item.sessions,
      current: item.current,
    })),
    totalSessions: result.totalSessions,
  };
}

export async function listCodexHistoryProviders(
  options: CodexProviderHistoryOptions,
): Promise<CodexProviderHistoryList> {
  return withStateReadLock(options.stateDirectory, async () => {
    const result = await listCodexProviders(options);
    return {
      currentProvider: result.currentProvider,
      providers: result.providers.map((item) => ({
        provider: item.provider,
        sessions: item.sessions,
        current: item.current,
      })),
      totalSessions: result.totalSessions,
    };
  });
}

export async function unifyCodexHistoryProviders(
  options: CodexProviderHistoryOptions,
  requested: string,
  apply: boolean,
): Promise<CodexProviderHistoryUnifyResult> {
  const execute = async (): Promise<CodexProviderHistoryUnifyResult> => {
    const result = await unifyCodexProviders(options, requested, apply);
    return {
      targetProvider: result.targetProvider,
      dryRun: !apply,
      changed: result.changes.length,
      unchanged: result.unchanged,
      changes: result.changes.map((change) => ({
        sessionRef: change.sessionRef,
        before: change.before,
        after: change.after,
      })),
      ...(result.transactionRef === undefined ? {} : { transactionRef: result.transactionRef }),
    };
  };
  if (!apply) {
    return withStateReadLock(options.stateDirectory, async () => {
      await assertNoPendingTransactions(options.stateDirectory);
      return execute();
    });
  }
  return withStateWriteLock(options.stateDirectory, async () => {
    await assertNoPendingTransactions(options.stateDirectory);
    return execute();
  });
}
