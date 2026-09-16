import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const repository = path.resolve(import.meta.dirname, "..");
const metadata = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
const output = path.join(repository, "release-assets");
const tag = process.env.RELEASE_TAG;
const command = process.argv[2];
const publishedName = (name) => name.replace(/-Linux-(?:amd64|x86_64)\./u, "-Linux-x64.")
  .replace(/-Linux-aarch64\./u, "-Linux-arm64.");
if (command === "check-version" || command === "finalize") {
  if (tag !== `v${metadata.version}`) throw new Error("Release tag must match package.json version");
}
if (command === "collect") {
  await mkdir(output, { recursive: true });
  const directory = path.join(repository, "release");
  const files = (await readdir(directory)).filter((name) => name.startsWith(`AgentHist-${metadata.version}-`) && /\.(exe|dmg|zip|deb|rpm|AppImage)$/u.test(name));
  if (files.length === 0) throw new Error("No desktop artifacts were built");
  for (const name of files) await copyFile(path.join(directory, name), path.join(output, publishedName(name)));
} else if (command === "finalize") {
  for (const name of await readdir(output)) {
    const normalized = publishedName(name);
    if (name !== normalized) await rename(path.join(output, name), path.join(output, normalized));
  }
  const names = await readdir(output);
  for (const suffix of ["x64-Setup.exe", "x64-Portable.exe", "macOS-x64.dmg", "macOS-arm64.dmg", "Linux-x64.deb", "Linux-arm64.deb", "Linux-x64.AppImage", "Linux-arm64.AppImage", "Linux-x64.rpm", "Linux-arm64.rpm"]) {
    if (!names.includes(`AgentHist-${metadata.version}-${suffix}`)) throw new Error(`Missing release artifact: ${suffix}`);
  }
  const source = `AgentHist-${metadata.version}-source.zip`;
  execFileSync("git", ["archive", "--format=zip", `--prefix=AgentHist-${metadata.version}/`, `--output=${path.join(output, source)}`, "HEAD"], { cwd: repository });
  const files = (await readdir(output)).filter((name) => name !== "SHA256SUMS.txt").sort();
  const hashes = [];
  for (const name of files) {
    if (!(await stat(path.join(output, name))).isFile()) continue;
    hashes.push(`${createHash("sha256").update(await readFile(path.join(output, name))).digest("hex")}  ${name}`);
  }
  await writeFile(path.join(output, "SHA256SUMS.txt"), `${hashes.join("\n")}\n`);
} else if (command !== "check-version") throw new Error("Expected check-version, collect, or finalize");
