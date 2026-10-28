import type { z } from "zod";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The two moves every file in the watcher's directory makes: a whole-file JSON
// read that says what it found (never a guess), and a write-then-rename so a
// watching reader never sees half a file.

export function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

export type JsonFileRead<T> =
  | { kind: "none" }
  | { kind: "record"; record: T }
  | { kind: "unreadable"; reason: string };

/** Read and parse one JSON file: missing → `none`, bad JSON or shape → `unreadable`. */
export function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
): JsonFileRead<T> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return { kind: "none" };
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { kind: "unreadable", reason: `not JSON: ${err.message}` };
    }
    throw err;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { kind: "unreadable", reason: parsed.error.message };
  }
  return { kind: "record", record: parsed.data };
}

/** Write `value` as JSON to `dir/filename` through a pid-named temp file and a rename. */
export function writeJsonAtomic(
  dir: string,
  filename: string,
  value: unknown,
  pid: number,
): void {
  const tmp = join(dir, `${filename}.${String(pid)}.tmp`);
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, join(dir, filename));
}
