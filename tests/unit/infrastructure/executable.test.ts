import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  executableCandidates,
  resolveExecutable,
} from "../../../src/infrastructure/executable.js";

test("executable resolution follows PATH and requires an executable file on POSIX", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-executable-"));
  const bin = path.join(root, "bin");
  const command = path.join(bin, "example-agent");
  try {
    await mkdir(bin);
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    await chmod(command, 0o755);
    assert.equal(await resolveExecutable("example-agent", {
      cwd: root,
      environment: { PATH: bin },
      platform: "linux",
    }), command);

    await chmod(command, 0o644);
    assert.equal(await resolveExecutable("example-agent", {
      cwd: root,
      environment: { PATH: bin },
      platform: "linux",
    }), undefined);
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
});
