import path from "node:path";

export type PathFlavor = "posix" | "windows";

export function pathFlavorForPlatform(platform: NodeJS.Platform = process.platform): PathFlavor {
  return platform === "win32" ? "windows" : "posix";
}

export function pathImplementation(flavor: PathFlavor): typeof path.posix {
  return flavor === "windows" ? path.win32 : path.posix;
}

export function normalizeAbsolutePath(value: string, flavor: PathFlavor, label: string): string {
  if (value.includes("\0") || !pathImplementation(flavor).isAbsolute(value)) {
    throw new Error(`${label} is not an absolute ${flavor} path: ${value}`);
  }
  return pathImplementation(flavor).normalize(value);
}

export function isAbsolutePath(value: string, flavor: PathFlavor): boolean {
  return !value.includes("\0") && pathImplementation(flavor).isAbsolute(value);
}

export function pathIdentity(value: string, flavor: PathFlavor): string {
  const normalized = pathImplementation(flavor).normalize(value);
  return flavor === "windows" ? normalized.toLowerCase() : normalized;
}

export function samePath(left: string, right: string, flavor: PathFlavor): boolean {
  return pathIdentity(left, flavor) === pathIdentity(right, flavor);
}

export function relativePathSegments(
  root: string,
  value: string,
  flavor: PathFlavor,
): readonly string[] | undefined {
  const implementation = pathImplementation(flavor);
  const normalizedRoot = implementation.normalize(root);
  const normalizedValue = implementation.normalize(value);
  const relative = implementation.relative(normalizedRoot, normalizedValue);
  if (relative === "") return [];
  if (implementation.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${implementation.sep}`)) {
    return undefined;
  }
  return relative.split(implementation.sep);
}

export function joinPathSegments(root: string, segments: readonly string[], flavor: PathFlavor): string {
  return pathImplementation(flavor).join(root, ...segments);
}
