import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  executableCandidates,
  resolveExecutable,
} from "../../../src/infrastructure/executable.js";

test("executable resolution follows PATH on the host platform", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-executable-"));
  const bin = path.join(root, "bin");
  const windows = process.platform === "win32";
  const command = path.join(bin, `example-agent${windows ? ".CMD" : ""}`);
  const environment = windows
    ? { Path: bin, PATHEXT: ".CMD" }
    : { PATH: bin };
  try {
    await mkdir(bin);
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    if (!windows) await chmod(command, 0o755);
    assert.equal(await resolveExecutable("example-agent", {
      cwd: root,
      environment,
      platform: process.platform,
    }), command);

    if (!windows) {
      await chmod(command, 0o644);
      assert.equal(await resolveExecutable("example-agent", {
        cwd: root,
        environment,
        platform: process.platform,
      }), undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows executable candidates honor current directory, Path, and PATHEXT", () => {
  assert.deepEqual(executableCandidates("codex", {
    cwd: "C:\\workspace",
    environment: {
      Path: "C:\\tools;D:\\npm",
      PATHEXT: ".EXE;.CMD",
    },
    platform: "win32",
  }), [
    "C:\\workspace\\codex.EXE",
    "C:\\workspace\\codex.CMD",
    "C:\\tools\\codex.EXE",
    "C:\\tools\\codex.CMD",
    "D:\\npm\\codex.EXE",
    "D:\\npm\\codex.CMD",
  ]);

  assert.deepEqual(executableCandidates("codex", {
    cwd: "C:\\untrusted-workspace",
    environment: {
      Path: "C:\\tools;D:\\npm",
      PATHEXT: ".EXE;.CMD",
    },
    platform: "win32",
    searchCurrentDirectory: false,
  }), [
    "C:\\tools\\codex.EXE",
    "C:\\tools\\codex.CMD",
    "D:\\npm\\codex.EXE",
    "D:\\npm\\codex.CMD",
  ]);
});
