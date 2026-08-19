export function claudeProjectCarrier(cwd: string): string {
  const encoded = cwd.replace(/[^A-Za-z0-9]/g, "-");
  if (encoded === "" || Buffer.byteLength(encoded, "utf8") > 4096) {
    throw new Error("Claude Code project carrier exceeds limits");
  }
  return encoded;
}
