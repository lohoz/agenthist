#!/usr/bin/env node

import { runCli } from "./program.js";

const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
const result = await runCli(process.argv.slice(2), { color, input: process.stdin, output: process.stdout });
if (result.stdout !== "") {
  process.stdout.write(result.stdout);
}
if (result.stderr !== "") {
  process.stderr.write(result.stderr);
}
process.exitCode = result.exitCode;
