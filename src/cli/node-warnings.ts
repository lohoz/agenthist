const SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature and might change at any time";

function warningType(warning: string | Error, detail: readonly unknown[]): string | undefined {
  const option = detail[0];
  if (typeof option === "string") return option;
  if (option !== null && typeof option === "object" && "type" in option && typeof option.type === "string") {
    return option.type;
  }
  return warning instanceof Error ? warning.name : undefined;
}

export function isNodeSQLiteExperimentalWarning(
  warning: string | Error,
  detail: readonly unknown[],
): boolean {
  const message = warning instanceof Error ? warning.message : warning;
  return warningType(warning, detail) === "ExperimentalWarning" && message === SQLITE_EXPERIMENTAL_WARNING;
}

export function suppressNodeSQLiteExperimentalWarning(): void {
  const original = process.emitWarning.bind(process) as (...values: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...detail: unknown[]): void => {
    if (isNodeSQLiteExperimentalWarning(warning, detail)) return;
    original(warning, ...detail);
  }) as typeof process.emitWarning;
}
