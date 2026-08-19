import os from "node:os";

import { pathFlavorForPlatform, pathImplementation, type PathFlavor } from "../domain/host-path.js";

export interface RuntimePathOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
}

export interface RuntimePathContext {
  readonly environment: NodeJS.ProcessEnv;
  readonly flavor: PathFlavor;
  readonly cwd: string;
  readonly home: string;
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

export function runtimePathContext(options: RuntimePathOptions = {}): RuntimePathContext {
  const environment = options.environment ?? process.env;
  const flavor = pathFlavorForPlatform(options.platform);
  const implementation = pathImplementation(flavor);
  const cwd = implementation.resolve(options.cwd ?? process.cwd());
  const selectedHome = nonBlank(options.home) ??
    (flavor === "windows" ? nonBlank(environment.USERPROFILE) ?? nonBlank(environment.HOME) : nonBlank(environment.HOME)) ??
    os.homedir();
  if (selectedHome === "") throw new Error("home directory is unavailable");
  return { environment, flavor, cwd, home: implementation.resolve(cwd, selectedHome) };
}
