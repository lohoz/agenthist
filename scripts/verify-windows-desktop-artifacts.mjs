import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "win32") throw new Error("Windows desktop artifact verification requires Windows");

const repository = path.resolve(import.meta.dirname, "..");
const metadata = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
const releaseDirectory = path.join(repository, "release");
const setup = path.join(releaseDirectory, `AgentHist-${metadata.version}-x64-Setup.exe`);
const portable = path.join(releaseDirectory, `AgentHist-${metadata.version}-x64-Portable.exe`);
const unpacked = path.join(releaseDirectory, "win-unpacked", "AgentHist.exe");

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repository,
      env: { ...process.env },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(script)} exited with code ${String(code)}`));
    });
  });
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectApplicationPe(file) {
  const handle = await open(file, "r");
  try {
    const dos = Buffer.alloc(64);
    await handle.read(dos, 0, dos.length, 0);
    assert.equal(dos.subarray(0, 2).toString("ascii"), "MZ");
    const peOffset = dos.readUInt32LE(0x3c);
    const header = Buffer.alloc(96);
    await handle.read(header, 0, header.length, peOffset);
    assert.equal(header.subarray(0, 4).toString("binary"), "PE\0\0");
    const machine = header.readUInt16LE(4);
    const optionalMagic = header.readUInt16LE(24);
    const subsystem = header.readUInt16LE(24 + 68);
    return { machine, optionalMagic, subsystem };
  } finally {
    await handle.close();
  }
}

const rootExecutables = (await readdir(releaseDirectory))
  .filter((name) => name.toLowerCase().endsWith(".exe"))
  .toSorted();
assert.deepEqual(rootExecutables, [path.basename(portable), path.basename(setup)].toSorted());

const artifacts = [];
for (const file of [setup, portable, unpacked]) {
  const info = await stat(file);
  assert.ok(info.isFile() && info.size > 0);
  artifacts.push({ file, sizeBytes: info.size, sha256: await sha256(file) });
}

const pe = await inspectApplicationPe(unpacked);
assert.equal(pe.machine, 0x8664, "the packaged AgentHist application must target Windows x64");
assert.equal(pe.optionalMagic, 0x20b, "the packaged AgentHist application must be PE32+ (64-bit)");
assert.equal(pe.subsystem, 2, "the packaged AgentHist application must use the Windows GUI subsystem");

const packagedSmoke = path.join(repository, "scripts", "smoke-packaged-desktop.mjs");
await runNode(packagedSmoke);
await runNode(packagedSmoke, [portable, "--portable-cdp"]);
await runNode(path.join(repository, "scripts", "smoke-windows-installer.mjs"), [setup]);

process.stdout.write(`${JSON.stringify({
  schemaVersion: "agenthist.windows-artifacts/v1",
  version: metadata.version,
  architecture: "x64",
  subsystem: "windows-gui",
  artifacts,
  smoke: ["isolated-unpacked", "portable", "installed", "uninstall"],
}, null, 2)}\n`);
