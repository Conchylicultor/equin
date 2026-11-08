import {
  exists,
  existsSync,
  readFile,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { z } from "zod";

/**
 * The record a `playwright-browser` install leaves in its `env/`: the browser
 * executables AS PLAYWRIGHT REPORTED THEM for that install's browsers path.
 * Recorded, never re-derived — Playwright is the only authority on which
 * files a given version launches (the headed binary for a headed launch, the
 * `chrome-headless-shell` of the same revision for a headless one).
 */
export const BROWSER_EXECUTABLES_FILE = "executables.json";

/**
 * An executable Playwright recorded inside this install's own browsers dir —
 * the app's, by the install that wrote the record (a declared claim of
 * `user-path/no-unproven-claim`).
 */
const RecordedExecutableSchema = z.string().transform((p) => asAppPath(p));

export const BrowserExecutablesSchema = z.object({
  /** The `playwright-core` version that installed (and reported) them. */
  playwrightCore: z.string(),
  /** What a HEADED launch runs (`Google Chrome for Testing` on macOS). */
  headed: RecordedExecutableSchema,
  /** What a HEADLESS launch runs (`chrome-headless-shell`). */
  headlessShell: RecordedExecutableSchema,
});
export type BrowserExecutables = z.infer<typeof BrowserExecutablesSchema>;

export type ReadBrowserExecutables =
  { ok: true; executables: BrowserExecutables } | { ok: false; reason: string };

/**
 * Read the record from an install's `env/`, and check that both executables
 * it names still exist. Cheap (one small read, two stats), but on the calling
 * thread: for host code with no event loop to keep (a check, an e2e script).
 * A backend — the kind's `isIntact`, which runs on every `ensureDep` fast path
 * and every state read, and its launchers — reads `readBrowserExecutables`.
 */
export function readBrowserExecutablesSync(
  envDir: AppPath,
): ReadBrowserExecutables {
  const file = joinAppPath(envDir, BROWSER_EXECUTABLES_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: `${file} does not exist` };
    }
    throw err;
  }
  const record = parseRecord(file, raw);
  if (!record.ok) return record;
  for (const [role, path] of executablesOf(record.executables)) {
    if (!existsSync(path)) return gone(role, path, file);
  }
  return record;
}

/** `readBrowserExecutablesSync`'s async twin: the same read, off the thread. */
export async function readBrowserExecutables(
  envDir: AppPath,
): Promise<ReadBrowserExecutables> {
  const file = joinAppPath(envDir, BROWSER_EXECUTABLES_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: `${file} does not exist` };
    }
    throw err;
  }
  const record = parseRecord(file, raw);
  if (!record.ok) return record;
  for (const [role, path] of executablesOf(record.executables)) {
    if (!(await exists(path))) return gone(role, path, file);
  }
  return record;
}

function parseRecord(file: string, raw: string): ReadBrowserExecutables {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { ok: false, reason: `${file} is not JSON: ${err.message}` };
    }
    throw err;
  }
  const parsed = BrowserExecutablesSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `${file} is not a browser-executables record: ${parsed.error.message}`,
    };
  }
  return { ok: true, executables: parsed.data };
}

function executablesOf(e: BrowserExecutables) {
  return [
    ["headed", e.headed],
    ["headless-shell", e.headlessShell],
  ] as const;
}

function gone(
  role: string,
  path: string,
  file: string,
): ReadBrowserExecutables {
  return {
    ok: false,
    reason: `the ${role} executable ${path} recorded in ${file} is gone`,
  };
}
