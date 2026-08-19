import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAnalysisProcess } from "../../../src/experience/cli-model-runner.js";

test("Agent CLI process arguments remain literal across platform launchers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist process & "));
  const bin = path.join(root, "bin with spaces & marker");
  const script = path.join(bin, "probe.mjs");
  const command = path.join(bin, process.platform === "win32" ? "agenthist-probe.cmd" : "agenthist-probe");
  const marker = path.join(root, "agenthist-injected.txt");
  const argumentsToPass = ["value with spaces", "value&echo injected>agenthist-injected.txt", "quote\"value"];
  try {
    await mkdir(bin);
    await writeFile(script, [
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), stdin: Buffer.concat(chunks).toString('utf8') }));",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    if (process.platform === "win32") {
      await writeFile(
        command,
        "@echo off\r\n\"%AGENTHIST_TEST_NODE%\" \"%~dp0probe.mjs\" %*\r\n",
        { encoding: "utf8", mode: 0o600 },
      );
    } else {
      await writeFile(
        command,
        "#!/bin/sh\nexec \"$AGENTHIST_TEST_NODE\" \"$(dirname \"$0\")/probe.mjs\" \"$@\"\n",
        { encoding: "utf8", mode: 0o700 },
      );
      await chmod(command, 0o700);
    }
    const pathName = Object.keys(process.env).find((name) => name.toLowerCase() === "path") ?? "PATH";
    const result = await runAnalysisProcess({
      command: "agenthist-probe",
      args: argumentsToPass,
      cwd: root,
      environment: {
        ...process.env,
        [pathName]: `${bin}${path.delimiter}${process.env[pathName] ?? ""}`,
        AGENTHIST_TEST_NODE: process.execPath,
      },
      stdin: "bounded input",
      timeoutMs: 10_000,
      outputByteLimit: 64 * 1024,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args: argumentsToPass, stdin: "bounded input" });
    await assert.rejects(
      access(marker),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
