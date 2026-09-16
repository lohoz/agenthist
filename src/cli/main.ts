#!/usr/bin/env node

import { suppressNodeSQLiteExperimentalWarning } from "./node-warnings.js";
import { unsupportedNodeMessage } from "./runtime-support.js";

const unsupportedRuntime = unsupportedNodeMessage(process.versions.node);
if (unsupportedRuntime !== undefined) {
  process.stderr.write(`${unsupportedRuntime}\n`);
  process.exitCode = 1;
} else {
  suppressNodeSQLiteExperimentalWarning();

  const { runCli } = await import("./program.js");

  const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
  const result = await runCli(process.argv.slice(2), {
    color,
    input: process.stdin,
    output: process.stdout,
    progressOutput: process.stderr,
  });
  if (result.stdout !== "") {
    process.stdout.write(result.stdout);
  }
  if (result.stderr !== "") {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}
