import path from "node:path";

export function piWorkspaceCarrier(cwd: string): string {
  const encoded = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${encoded}--`;
}

export function piSessionRelativePath(cwd: string, fileName: string): string {
  if (path.posix.basename(fileName) !== fileName || !fileName.endsWith(".jsonl")) {
    throw new Error(`Pi session filename is invalid: ${fileName}`);
  }
  return path.posix.join("pi", piWorkspaceCarrier(cwd), fileName);
}
