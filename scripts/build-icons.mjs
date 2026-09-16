import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pngToIco from "png-to-ico";
import sharp from "sharp";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repository, "build", "icon.svg");
const outputDirectory = path.join(repository, "build", "icons");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];

await mkdir(outputDirectory, { recursive: true });
const svg = await readFile(source);
const files = [];
for (const size of sizes) {
  const output = path.join(outputDirectory, `${size}x${size}.png`);
  await sharp(svg, { density: 768 }).resize(size, size).png().toFile(output);
  files.push(output);
}

await sharp(svg, { density: 768 }).resize(512, 512).png().toFile(path.join(repository, "build", "icon.png"));
await writeFile(
  path.join(repository, "build", "icon.ico"),
  await pngToIco(files.filter((file) => !file.endsWith("512x512.png"))),
);

process.stdout.write("Generated AgentHist PNG and ICO application icons.\n");
