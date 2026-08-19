import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPathMappingsConsumed,
  mapAbsolutePath,
  parsePathMappings,
} from "../../../src/domain/path-mapping.js";
import { samePath } from "../../../src/domain/host-path.js";

test("Windows path identity accepts equivalent verbatim paths", () => {
  assert.equal(
    samePath(
      String.raw`C:\Users\Alice\.codex\sessions\rollout.jsonl`,
      String.raw`\\?\c:\users\alice\.codex\sessions\rollout.jsonl`,
      "windows",
    ),
    true,
  );
  assert.equal(
    samePath(
      String.raw`\\server\share\.codex\sessions\rollout.jsonl`,
      String.raw`\\?\UNC\SERVER\SHARE\.codex\sessions\rollout.jsonl`,
      "windows",
    ),
    true,
  );
  assert.equal(
    samePath(
      String.raw`C:\Users\Alice\.codex\sessions\first.jsonl`,
      String.raw`\\?\C:\Users\Alice\.codex\sessions\second.jsonl`,
      "windows",
    ),
    false,
  );
});

test("path mappings translate POSIX and Windows roots by path semantics", () => {
  const windows = parsePathMappings([
    String.raw`C:\Users\Alice\Project=D:\Work\Project`,
  ], { sourceFlavor: "windows", targetFlavor: "windows" });
  assert.equal(
    mapAbsolutePath(String.raw`c:\users\alice\project\src\main.ts`, windows, "workspace"),
    String.raw`D:\Work\Project\src\main.ts`,
  );
  assertPathMappingsConsumed(windows);

  const crossPlatform = parsePathMappings([
    String.raw`C:\Users\Alice\Project=/Users/alice/Project`,
  ], { sourceFlavor: "windows", targetFlavor: "posix" });
  assert.equal(
    mapAbsolutePath(String.raw`C:\Users\Alice\Project\docs`, crossPlatform, "workspace"),
    "/Users/alice/Project/docs",
  );
  assertPathMappingsConsumed(crossPlatform);
});

test("a cross-platform import requires an explicit workspace mapping", () => {
  const mappings = parsePathMappings([], { sourceFlavor: "posix", targetFlavor: "windows" });
  assert.throws(
    () => mapAbsolutePath("/home/alice/project", mappings, "workspace"),
    /add an explicit --map-path/,
  );
});
