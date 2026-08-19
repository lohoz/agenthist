import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;

if (npmCli === undefined || npmCli.trim() === "") {
  throw new Error("package smoke must be started with 'npm run smoke:package'");
}

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repository,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      reject(new Error(
        `${command} ${args.join(" ")} failed (${signal ?? code ?? "unknown"})\n` +
        `${result.stdout}${result.stderr}`,
      ));
    });
  });
}

async function npm(args, cwd = repository) {
  return await run(process.execPath, [npmCli, ...args], { cwd });
}

const metadata = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agenthist-package-smoke-"));

try {
  await access(path.join(repository, ".build", "src", "cli", "main.js"));
  const packed = path.join(temporaryRoot, "packed");
  const installed = path.join(temporaryRoot, "installed");

  await mkdir(packed);
  await npm(["pack", "--ignore-scripts", "--silent", "--pack-destination", packed]);
  const archives = (await readdir(packed)).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "npm pack must create exactly one tarball");
  const archive = path.join(packed, archives[0]);

  await npm([
    "install",
    "--prefix", installed,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    archive,
  ]);

  const version = await npm(["exec", "--offline", "--prefix", installed, "--", "agenthist", "version"]);
  assert.equal(version.stdout.trim(), metadata.version);

  const help = await npm(["exec", "--offline", "--prefix", installed, "--", "agenthist", "--help"]);
  assert.match(help.stdout, /AgentHist manages, migrates, and extracts recurring experience from local Agent history\./);
  assert.match(help.stdout, /Usage:\s+agenthist/);

  process.stdout.write(`package smoke passed: ${metadata.name}@${metadata.version} (${process.platform})\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
