import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Agent } from "../domain/agent.js";
import type { RuntimePathOptions } from "../infrastructure/runtime-paths.js";
import { AGENTHIST_SKILL_FILES, AGENTHIST_SKILL_MARKER } from "./content.js";
import { resolveSkillInstallLocations, resolveSkillRemovalLocations } from "./paths.js";

export type SkillInstallStatus = "installed" | "updated" | "unchanged" | "replaced";

export interface SkillInstallResultItem {
  readonly agents: readonly Agent[];
  readonly directory: string;
  readonly shared: boolean;
  readonly status: SkillInstallStatus;
}

export interface SkillInstallResult {
  readonly items: readonly SkillInstallResultItem[];
}

export interface InstallAgentHistSkillOptions extends RuntimePathOptions {
  readonly agents?: readonly Agent[];
  readonly force?: boolean;
}

export type SkillUninstallStatus = "removed" | "absent" | "preserved";

export interface SkillUninstallResultItem {
  readonly agents: readonly Agent[];
  readonly directory: string;
  readonly shared: boolean;
  readonly status: SkillUninstallStatus;
}

export interface SkillUninstallResult {
  readonly items: readonly SkillUninstallResultItem[];
}

type ExistingSkill = "absent" | "same" | "managed" | "foreign";

interface ObservedEntry {
  readonly relativePath: string;
  readonly kind: "file" | "other";
  readonly contents?: string;
}

async function observeEntries(root: string, directory = root): Promise<readonly ObservedEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const observed: ObservedEntry[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      observed.push(...await observeEntries(root, absolute));
    } else if (entry.isFile()) {
      observed.push({ relativePath, kind: "file", contents: await readFile(absolute, "utf8") });
    } else {
      observed.push({ relativePath, kind: "other" });
    }
  }
  return observed.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function inspectExistingSkill(directory: string): Promise<ExistingSkill> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return "foreign";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }

  const observed = await observeEntries(directory);
  const expected = [...AGENTHIST_SKILL_FILES].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath));
  if (
    observed.length === expected.length &&
    observed.every((entry, index) => {
      const wanted = expected[index]!;
      return entry.kind === "file" && entry.relativePath === wanted.relativePath &&
        entry.contents === wanted.contents;
    })
  ) return "same";

  if (
    observed.length > 0 &&
    observed.every((entry) =>
      entry.kind === "file" &&
      expected.some((wanted) => wanted.relativePath === entry.relativePath) &&
      entry.contents?.includes(AGENTHIST_SKILL_MARKER) === true)
  ) return "managed";
  return "foreign";
}

async function writeSkillTree(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  for (const file of AGENTHIST_SKILL_FILES) {
    const destination = path.join(directory, ...file.relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, file.contents, { encoding: "utf8", mode: 0o644, flag: "wx" });
  }
}

async function publishSkill(directory: string, existing: ExistingSkill): Promise<void> {
  const parent = path.dirname(directory);
  const name = path.basename(directory);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const nonce = `${process.pid}-${randomUUID()}`;
  const staging = path.join(parent, `.${name}.install-${nonce}`);
  const backup = path.join(parent, `.${name}.backup-${nonce}`);
  let backupExists = false;
  try {
    await writeSkillTree(staging);
    if (existing !== "absent") {
      await rename(directory, backup);
      backupExists = true;
    }
    try {
      await rename(staging, directory);
    } catch (error) {
      if (backupExists) {
        try {
          await rename(backup, directory);
          backupExists = false;
        } catch (restoreError) {
          throw new Error(
            `skill installation failed and the previous directory remains at ${backup}`,
            { cause: restoreError },
          );
        }
      }
      throw error;
    }
    if (backupExists) {
      await rm(backup, { recursive: true, force: true });
      backupExists = false;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function installAgentHistSkill(
  options: InstallAgentHistSkillOptions = {},
): Promise<SkillInstallResult> {
  const locations = resolveSkillInstallLocations(options);
  const plans = await Promise.all(locations.map(async (location) => ({
    location,
    existing: await inspectExistingSkill(location.directory),
  })));
  const conflict = plans.find((plan) => plan.existing === "foreign");
  if (conflict !== undefined && !options.force) {
    throw new Error(
      `skill already exists and is not managed by AgentHist: ${conflict.location.directory}; ` +
      "use --force to replace it",
    );
  }

  const items: SkillInstallResultItem[] = [];
  for (const plan of plans) {
    let status: SkillInstallStatus;
    if (plan.existing === "same") {
      status = "unchanged";
    } else {
      await publishSkill(plan.location.directory, plan.existing);
      status = plan.existing === "absent"
        ? "installed"
        : plan.existing === "managed"
          ? "updated"
          : "replaced";
    }
    items.push({ ...plan.location, status });
  }
  return { items };
}

export async function uninstallAgentHistSkill(
  options: RuntimePathOptions = {},
): Promise<SkillUninstallResult> {
  const items: SkillUninstallResultItem[] = [];
  for (const location of resolveSkillRemovalLocations(options)) {
    const existing = await inspectExistingSkill(location.directory);
    if (existing === "same" || existing === "managed") {
      await rm(location.directory, { recursive: true });
      items.push({ ...location, status: "removed" });
    } else {
      items.push({ ...location, status: existing === "absent" ? "absent" : "preserved" });
    }
  }
  return { items };
}
