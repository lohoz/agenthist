import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, stat, watch } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "win32") throw new Error("the Windows installer smoke test requires Windows");

const repository = path.resolve(import.meta.dirname, "..");
const metadata = JSON.parse(await readFile(
  path.join(repository, "package.json"),
  "utf8",
));
const setup = path.resolve(
  repository,
  process.argv[2] ?? path.join("release", `AgentHist-${metadata.version}-x64-Setup.exe`),
);
await access(setup);

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repository,
      env: { ...process.env },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} exited with code ${String(code)}`));
    });
  });
}

async function waitUntilRemoved(file) {
  const missing = async () => {
    try { await access(file); return false; }
    catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
  };
  if (await missing()) return;
  const signal = AbortSignal.timeout(20_000);
  try {
    for await (const event of watch(path.dirname(file), { signal })) {
      if (event.filename !== null && event.filename !== path.basename(file)) continue;
      if (await missing()) return;
    }
  } catch (error) {
    if (await missing()) return;
    if (error?.name !== "AbortError") throw error;
  }
  throw new Error(`the uninstaller did not remove ${file}`);
}

const root = await mkdtemp(path.join(os.tmpdir(), "agenthist installer smoke "));
const installDirectory = path.join(root, "Program Files 用户 Name", "AgentHist");
const installedExecutable = path.join(installDirectory, "AgentHist.exe");
let uninstaller;
try {
  await run(setup, ["/S", `/D=${installDirectory}`]);
  await access(installedExecutable);
  assert.ok((await stat(installedExecutable)).size > 0);

  await run(process.execPath, [
    path.join(repository, "scripts", "smoke-packaged-desktop.mjs"),
    installedExecutable,
    "--default-state",
  ]);

  const entries = await readdir(installDirectory);
  const uninstallerName = entries.find((name) => /^uninstall(?: .+)?\.exe$/iu.test(name));
  assert.ok(uninstallerName, "the installed application must include an uninstaller");
  uninstaller = path.join(installDirectory, uninstallerName);
  await run(uninstaller, ["/S"]);
  await waitUntilRemoved(installedExecutable);

  process.stdout.write(`${JSON.stringify({
    setup,
    installDirectory,
    installedExecutable,
    uninstaller: uninstallerName,
    uninstalled: true,
  })}\n`);
} finally {
  try {
    if (uninstaller !== undefined) {
      await access(installedExecutable);
      await run(uninstaller, ["/S"]);
      await waitUntilRemoved(installedExecutable);
    }
  } catch {
    // The owned temporary root is removed below even if NSIS cleanup failed.
  }
  const normalizedRoot = path.resolve(root);
  const relativeRoot = path.relative(path.resolve(os.tmpdir()), normalizedRoot);
  assert.ok(relativeRoot !== "" && relativeRoot !== ".." && !relativeRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeRoot));
  await rm(normalizedRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
