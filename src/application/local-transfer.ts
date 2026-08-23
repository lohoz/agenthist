import type { Agent } from "../domain/agent.js";
import { pathFlavorForPlatform } from "../domain/host-path.js";
import { importPreparedHistory, type ImportHistoryResult } from "./history-import.js";
import { withPreparedHistorySource } from "./transfer.js";

export interface TransferHistorySessionOptions {
  readonly stateDirectory: string;
  readonly sessionRef: string;
  readonly targetAgent: Agent;
  readonly mode: "dry_run" | "apply";
  readonly codexHome?: string;
  readonly sqliteHome?: string;
  readonly profile?: string;
  readonly opencodeDataRoot?: string;
  readonly opencodeDatabase?: string;
  readonly claudeConfigRoot?: string;
  readonly piSessionRoot?: string;
  readonly providerPolicy?: string;
  readonly pathMappings?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly home?: string;
}

export async function transferHistorySession(
  options: TransferHistorySessionOptions,
): Promise<ImportHistoryResult> {
  return withPreparedHistorySource({
    stateDirectory: options.stateDirectory,
    sessions: [options.sessionRef],
    strictSessions: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  }, async (source) => {
    const objects = new Map(source.sources.map((object) => [object.id, object.filePath]));
    if (objects.size !== source.sources.length) throw new Error("prepared history source has duplicate objects");
    return importPreparedHistory({
      stateDirectory: options.stateDirectory,
      targetAgent: options.targetAgent,
      mode: options.mode,
      ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
      ...(options.sqliteHome === undefined ? {} : { sqliteHome: options.sqliteHome }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.opencodeDataRoot === undefined ? {} : { opencodeDataRoot: options.opencodeDataRoot }),
      ...(options.opencodeDatabase === undefined ? {} : { opencodeDatabase: options.opencodeDatabase }),
      ...(options.claudeConfigRoot === undefined ? {} : { claudeConfigRoot: options.claudeConfigRoot }),
      ...(options.piSessionRoot === undefined ? {} : { piSessionRoot: options.piSessionRoot }),
      ...(options.providerPolicy === undefined ? {} : { providerPolicy: options.providerPolicy }),
      ...(options.pathMappings === undefined ? {} : { pathMappings: options.pathMappings }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.home === undefined ? {} : { home: options.home }),
    }, {
      entries: source.entries,
      objects,
      pathFlavor: pathFlavorForPlatform(),
    });
  });
}
