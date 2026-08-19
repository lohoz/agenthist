export interface ClaudeSessionSidecarIdentity {
  readonly subpath: readonly string[];
}

export function claudeSessionSidecarIdentity(
  relativePath: string,
  projectCarrier: string,
  sessionId: string,
): ClaudeSessionSidecarIdentity | undefined {
  const parts = relativePath.split("/");
  if (
    parts.length < 5 || parts[0] !== "claude" || parts[1] !== "projects" ||
    parts[2] !== projectCarrier || projectCarrier === "" || parts[3] !== sessionId
  ) return undefined;
  const subpath = parts.slice(4);
  return subpath.some((part) => part === "" || part === "." || part === "..")
    ? undefined
    : { subpath };
}
