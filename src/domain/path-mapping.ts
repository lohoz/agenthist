import {
  joinPathSegments,
  normalizeAbsolutePath,
  pathFlavorForPlatform,
  pathIdentity,
  relativePathSegments,
  samePath,
  type PathFlavor,
} from "./host-path.js";

export interface PathMappingRule {
  readonly source: string;
  readonly target: string;
  consumed: boolean;
}

export interface PathMappings {
  readonly sourceFlavor: PathFlavor;
  readonly targetFlavor: PathFlavor;
  readonly rules: PathMappingRule[];
}

export interface ParsePathMappingsOptions {
  readonly sourceFlavor?: PathFlavor;
  readonly targetFlavor?: PathFlavor;
}

export function parsePathMappings(
  values: readonly string[],
  options: ParsePathMappingsOptions = {},
): PathMappings {
  const sourceFlavor = options.sourceFlavor ?? pathFlavorForPlatform();
  const targetFlavor = options.targetFlavor ?? pathFlavorForPlatform();
  const result: PathMappingRule[] = [];
  const bySource = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    const source = separator < 0 ? "" : value.slice(0, separator);
    const target = separator < 0 ? "" : value.slice(separator + 1);
    const cleanSource = normalizeAbsolutePath(source, sourceFlavor, "path mapping source");
    const cleanTarget = normalizeAbsolutePath(target, targetFlavor, "path mapping target");
    if (sourceFlavor === targetFlavor && samePath(cleanSource, cleanTarget, sourceFlavor)) {
      throw new Error(`path mapping has no effect: ${value}`);
    }
    const sourceKey = pathIdentity(cleanSource, sourceFlavor);
    const targetKey = pathIdentity(cleanTarget, targetFlavor);
    const previous = bySource.get(sourceKey);
    if (previous !== undefined && previous !== targetKey) {
      throw new Error(`path mapping source is ambiguous: ${cleanSource}`);
    }
    if (previous === undefined) {
      bySource.set(sourceKey, targetKey);
      result.push({ source: cleanSource, target: cleanTarget, consumed: false });
    }
  }
  result.sort((left, right) => right.source.length - left.source.length || left.source.localeCompare(right.source));
  return { sourceFlavor, targetFlavor, rules: result };
}

export function mapAbsolutePath(value: string, mappings: PathMappings, label: string): string {
  const clean = normalizeAbsolutePath(value, mappings.sourceFlavor, label);
  for (const mapping of mappings.rules) {
    const segments = relativePathSegments(mapping.source, clean, mappings.sourceFlavor);
    if (segments !== undefined) {
      mapping.consumed = true;
      return joinPathSegments(mapping.target, segments, mappings.targetFlavor);
    }
  }
  if (mappings.sourceFlavor !== mappings.targetFlavor) {
    throw new Error(
      `${label} uses a ${mappings.sourceFlavor} path on a ${mappings.targetFlavor} target; add an explicit --map-path`,
    );
  }
  return clean;
}

export function assertPathMappingsConsumed(mappings: PathMappings): void {
  const unused = mappings.rules.find((mapping) => !mapping.consumed);
  if (unused !== undefined) throw new Error(`path mapping was not used: ${unused.source}=${unused.target}`);
}
