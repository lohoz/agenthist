export const MINIMUM_NODE_MAJOR = 24;

export function unsupportedNodeMessage(version: string): string | undefined {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  if (Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR) return undefined;
  return `AgentHist requires Node.js ${MINIMUM_NODE_MAJOR} or newer (current: ${version}). ` +
    "Install a supported Node.js release and try again.";
}
