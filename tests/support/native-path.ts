import path from "node:path";
import { pathToFileURL } from "node:url";

const FIXTURE_ROOTS = ["source", "tmp"] as const;

export function nativeFixturePath(posixAbsolutePath: string): string {
  if (!posixAbsolutePath.startsWith("/")) throw new Error("fixture path must be POSIX absolute");
  if (process.platform !== "win32") return posixAbsolutePath;
  return path.win32.join(path.parse(process.cwd()).root, ...posixAbsolutePath.slice(1).split("/"));
}

function nativeFixtureString(value: string): string {
  if (process.platform !== "win32") return value;
  const fileUrls: string[] = [];
  let result = value;
  for (const root of FIXTURE_ROOTS) {
    const nativeRoot = nativeFixturePath(`/${root}`);
    const nativeFileUrl = pathToFileURL(nativeRoot).href;
    for (const marker of [nativeFileUrl, `file:///${root}`]) {
      if (!result.includes(marker)) continue;
      const placeholder = `__AGENTHIST_FIXTURE_FILE_URL_${fileUrls.length}__`;
      fileUrls.push(nativeFileUrl);
      result = result.replaceAll(marker, placeholder);
    }
    const fixturePath = new RegExp(`/${root}(?:/[A-Za-z0-9._@+*~-]+)+`, "g");
    result = result.replace(fixturePath, (value) => nativeFixturePath(value));
    if (result === `/${root}`) result = nativeRoot;
  }
  for (const [index, fileUrl] of fileUrls.entries()) {
    result = result.replaceAll(`__AGENTHIST_FIXTURE_FILE_URL_${index}__`, fileUrl);
  }
  return result;
}

export function nativeFixtureValue<T>(value: T): T {
  if (typeof value === "string") return nativeFixtureString(value) as T;
  if (Array.isArray(value)) return value.map((item) => nativeFixtureValue(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, nativeFixtureValue(item)]),
    ) as T;
  }
  return value;
}

export function replaceFixtureStrings<T>(
  value: T,
  replacements: readonly (readonly [string, string])[],
): T {
  if (typeof value === "string") {
    let result: string = value;
    for (const [source, target] of replacements) result = result.replaceAll(source, target);
    return result as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceFixtureStrings(item, replacements)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceFixtureStrings(item, replacements)]),
    ) as T;
  }
  return value;
}

export function nativeFixtureJsonl(value: string): string {
  if (process.platform !== "win32") return value;
  return value.split("\n").map((line) => line === ""
    ? ""
    : JSON.stringify(nativeFixtureValue(JSON.parse(line)))).join("\n");
}
