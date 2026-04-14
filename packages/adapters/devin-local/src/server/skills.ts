import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveDevinSkillsHome(config: Record<string, unknown>, workspaceCwd?: string) {
  if (workspaceCwd) {
    return path.join(path.resolve(workspaceCwd), ".devin", "skills");
  }
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredCwd = asString(env.CWD) ?? asString((config as Record<string, unknown>).cwd);
  if (configuredCwd) {
    return path.join(path.resolve(configuredCwd), ".devin", "skills");
  }
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".devin", "skills");
}

async function buildDevinSkillSnapshot(config: Record<string, unknown>, workspaceCwd?: string): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveDevinSkillsHome(config, workspaceCwd);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "devin_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: ".devin/skills",
    missingDetail: "Configured but not currently linked into the workspace .devin/skills directory.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listDevinSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const workspaceCwd = asString((ctx.config as Record<string, unknown>).cwd);
  return buildDevinSkillSnapshot(ctx.config, workspaceCwd ?? undefined);
}

export async function syncDevinSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...desiredSkills,
    ...availableEntries.filter((entry) => entry.required).map((entry) => entry.key),
  ]);
  const workspaceCwd = asString((ctx.config as Record<string, unknown>).cwd);
  const skillsHome = resolveDevinSkillsHome(ctx.config, workspaceCwd ?? undefined);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildDevinSkillSnapshot(ctx.config, workspaceCwd ?? undefined);
}

export function resolveDevinDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
