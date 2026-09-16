// Browser-safe path identity shared by the desktop index and directory tree.
export interface WorkspacePath {
  readonly key: string;
  readonly path: string;
  readonly root: string;
  readonly segments: readonly string[];
  readonly separator: "/" | "\\";
  readonly windows: boolean;
}

export function workspacePath(value: string): WorkspacePath {
  let input = value.replace(/^\\\\\?\\UNC\\/iu, "\\\\").replace(/^\\\\\?\\(?=[a-z]:\\)/iu, "");
  const windows = /^[a-z]:[\\/]/iu.test(input) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/u.test(input) || input.startsWith("\\");
  const separator = windows ? "\\" : "/";
  if (windows) input = input.replaceAll("/", "\\");
  const drive = windows ? /^[a-z]:\\/iu.exec(input) : null;
  const unc = windows ? /^\\\\[^\\]+\\[^\\]+\\?/u.exec(input) : null;
  const root = drive !== null ? drive[0].toUpperCase()
    : unc !== null ? `${unc[0].replace(/\\+$/u, "")}\\`
      : input.startsWith(separator) ? separator : "";
  if (root === "") throw new Error("desktop history workspace is not absolute");
  const parts = input.slice(drive?.[0].length ?? unc?.[0].length ?? 1).split(separator);
  const segments: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  const path = root + segments.join(separator);
  return { key: `${windows ? "windows" : "posix"}:${windows ? path.toLowerCase() : path}`, path, root, segments, separator, windows };
}
