// The program manifest: which files the worker's program LOADED — every
// `program.getSourceFiles()` path, repo and `node_modules` alike. The program
// key (`../check/program-key.ts`) hashes their contents to say "this exact
// program"; it used to read the same list out of the `.tsbuildinfo`, which
// the keyed engine no longer writes.
//
// Paths are stored relative to the repo root and resolved on read, so a
// manifest is about the tree it sits in, never the worktree that wrote it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, relative, resolve } from "path";

/**
 * What the manifest on disk says. A discriminated result, not a nullable list:
 * a cold worktree (no manifest) is normal, an unreadable one is worth naming,
 * and only `files` may be keyed on — an empty list would mint a key for an
 * empty program.
 */
export type ProgramManifest =
  | { kind: "files"; files: string[] }
  | { kind: "absent" }
  | { kind: "unreadable"; why: string };

export function writeProgramManifest(
  path: string,
  root: string,
  files: readonly string[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({
      files: files.map((f) => relative(root, f).split("\\").join("/")),
    }),
  );
  renameSync(tmp, path); // atomic on the same filesystem
}

/** The files the last program loaded, as absolute paths under `root`. */
export function readProgramManifest(
  path: string,
  root: string,
): ProgramManifest {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { kind: "absent" };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { kind: "unreadable", why: "program manifest is not valid JSON" };
  }
  const files = (doc as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) {
    return { kind: "unreadable", why: "program manifest has no files array" };
  }
  return {
    kind: "files",
    files: (files as string[]).map((f) => resolve(root, f)),
  };
}
