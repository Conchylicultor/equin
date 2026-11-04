import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { dirname } from "node:path";

/**
 * Write a job definition file if its content changed. 0600: a declared
 * environment may carry credentials. Both managers share it, so "changed"
 * means the same thing to each.
 */
export function writeDefinition(
  path: AppPath,
  content: string,
): { path: AppPath; changed: boolean } {
  const before = existsSync(path) ? readFileSync(path, "utf-8") : null;
  if (before === content) return { path, changed: false };
  mkdirSync(asAppPath(dirname(path)), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  return { path, changed: true };
}

/**
 * Whether the definition file holds exactly `content` — what
 * {@link writeDefinition} would leave unchanged — without writing anything.
 */
export function isDefinitionCurrent(path: AppPath, content: string): boolean {
  return existsSync(path) && readFileSync(path, "utf-8") === content;
}

/** The definition file's content, or null when there is none. */
export function readDefinition(path: AppPath): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/** Delete a job definition file; whether there was one. */
export function removeDefinition(path: AppPath): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
