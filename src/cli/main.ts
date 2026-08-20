#!/usr/bin/env node

import { suppressNodeSQLiteExperimentalWarning } from "./node-warnings.js";

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
