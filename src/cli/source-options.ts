import { homedir } from "node:os";

import type { Agent } from "../application/index.js";
import type { CliRuntime, GlobalOptions } from "./command-support.js";

export function historySourceOptions(
  globals: GlobalOptions,
  runtime: CliRuntime,
  agents?: readonly Agent[],
) {
  const environment = runtime.environment ?? process.env;
  const cwd = runtime.cwd ?? process.cwd();
  const home = runtime.home ?? environment.HOME ?? homedir();
  return {
    ...(agents === undefined ? {} : { agents }),
    codex: {
      ...(globals.codexHome === undefined ? {} : { codexHome: globals.codexHome }),
      ...(globals.sqliteHome === undefined ? {} : { sqliteHome: globals.sqliteHome }),
      ...(globals.profile === undefined ? {} : { profile: globals.profile }),
      environment, cwd, home,
    },
    opencode: {
      ...(globals.opencodeDataRoot === undefined ? {} : { dataRoot: globals.opencodeDataRoot }),
      ...(globals.opencodeDatabase === undefined ? {} : { databasePath: globals.opencodeDatabase }),
      environment, cwd, home,
    },
    claude: {
      ...(globals.claudeConfigRoot === undefined ? {} : { configRoot: globals.claudeConfigRoot }),
      environment, cwd, home,
    },
    pi: {
      ...(globals.piSessionRoot === undefined ? {} : { sessionRoot: globals.piSessionRoot }),
      environment, cwd, home,
    },
  };
}
