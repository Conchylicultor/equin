import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Write a job definition file if its content changed. 0600: a declared
 * environment may carry credentials. Both managers share it, so "changed"
 * means the same thing to each.
 */
export function writeDefinition(
  path: string,
  content: string,
): { path: string; changed: boolean } {
  const before = existsSync(path) ? readFileSync(path, "utf-8") : null;
  if (before === content) return { path, changed: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  return { path, changed: true };
}

/**
 * Whether the definition file holds exactly `content` — what
 * {@link writeDefinition} would leave unchanged — without writing anything.
 */
export function isDefinitionCurrent(path: string, content: string): boolean {
  return existsSync(path) && readFileSync(path, "utf-8") === content;
}

/** Delete a job definition file; whether there was one. */
export function removeDefinition(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
