import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { dirname } from "node:path";

/**
 * Write a job definition file if its content changed. 0600: a declared
 * environment may carry credentials. Both managers share it, so "changed"
 * means the same thing to each.
 */
export async function writeDefinition(
  path: AppPath,
  content: string,
): Promise<{ path: AppPath; changed: boolean }> {
  const before = await readDefinition(path);
  if (before === content) return { path, changed: false };
  await mkdir(asAppPath(dirname(path)), { recursive: true });
  await writeFile(path, content, { mode: 0o600 });
  return { path, changed: true };
}

/**
 * Whether the definition file holds exactly `content` — what
 * {@link writeDefinition} would leave unchanged — without writing anything.
 */
export async function isDefinitionCurrent(
  path: AppPath,
  content: string,
): Promise<boolean> {
  return (await readDefinition(path)) === content;
}

/** The definition file's content, or null when there is none. */
export async function readDefinition(path: AppPath): Promise<string | null> {
  return (await exists(path)) ? await readFile(path, "utf-8") : null;
}

/** Delete a job definition file; whether there was one. */
export async function removeDefinition(path: AppPath): Promise<boolean> {
  if (!(await exists(path))) return false;
  await rm(path);
  return true;
}
