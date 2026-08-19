import { pathImplementation } from "../domain/host-path.js";
import { runtimePathContext } from "../infrastructure/runtime-paths.js";

export interface StateLocationOptions {
  readonly explicit?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
}

export function resolveStateDirectory(options: StateLocationOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const context = runtimePathContext(options);
  const implementation = pathImplementation(context.flavor);
  if (options.explicit !== undefined) {
    if (options.explicit.trim() === "") {
      throw new Error("state directory cannot be blank");
    }
    return implementation.resolve(context.cwd, options.explicit);
  }
  if (context.flavor === "windows") {
    const localAppData = context.environment.LOCALAPPDATA?.trim();
    const root = localAppData === undefined || localAppData === ""
      ? implementation.join(context.home, "AppData", "Local")
      : implementation.resolve(context.cwd, localAppData);
    return implementation.join(root, "AgentHist");
  }
  const xdg = context.environment.XDG_STATE_HOME?.trim();
  if (xdg !== undefined && xdg !== "") {
    return implementation.join(implementation.resolve(context.cwd, xdg), "agenthist");
  }
  return platform === "darwin"
    ? implementation.join(context.home, "Library", "Application Support", "AgentHist")
    : implementation.join(context.home, ".local", "state", "agenthist");
}
