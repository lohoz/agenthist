import assert from "node:assert/strict";
import test from "node:test";

import { isNodeSQLiteExperimentalWarning } from "../../../src/cli/node-warnings.js";

const SQLITE_WARNING = "SQLite is an experimental feature and might change at any time";

test("only the Node SQLite experimental warning is suppressed", () => {
  assert.equal(isNodeSQLiteExperimentalWarning(SQLITE_WARNING, ["ExperimentalWarning"]), true);
  assert.equal(isNodeSQLiteExperimentalWarning(SQLITE_WARNING, ["Warning"]), false);
  assert.equal(isNodeSQLiteExperimentalWarning("another experimental feature", ["ExperimentalWarning"]), false);

  const warning = new Error(SQLITE_WARNING);
  warning.name = "ExperimentalWarning";
  assert.equal(isNodeSQLiteExperimentalWarning(warning, []), true);
});
