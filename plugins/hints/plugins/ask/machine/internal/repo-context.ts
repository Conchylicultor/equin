import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

/** Where the repo's own context is copied, inside the scratch dir. */
export const REPO_CONTEXT_DIR = "repo-context";

// A CLAUDE.md import line: `@<path>` alone on its line, as Claude Code reads it.
const IMPORT_LINE = /^@(\S+)$/gm;

/**
 * Copy the checkout's root `CLAUDE.md`, and every file it imports (`@path`
 * lines, relative to it), into `<dir>/repo-context/`, keeping their layout so
 * the imports still resolve. The profile's own CLAUDE.md imports the copy:
 * inside its project, an import needs no approval, where an import of a file
 * outside it (the checkout itself) waits for Claude Code's one-time
 * external-import consent, which a headless session cannot give. Copied at
 * each launch, so the agent reads the map of the checkout as it is now.
 * Idempotent (a retried spawn copies again).
 */
export async function copyRepoContext(
  checkout: string,
  dir: string,
): Promise<void> {
  const target = join(dir, REPO_CONTEXT_DIR);
  const root = join(checkout, "CLAUDE.md");
  const files = [root];
  const text = await readFile(root, "utf8");
  for (const [, path] of text.matchAll(IMPORT_LINE)) {
    if (path === undefined)
      throw new Error("[hints.ask] an import line with no path");
    const imported = resolve(checkout, path);
    if (relative(checkout, imported).startsWith("..")) {
      throw new Error(
        `[hints.ask] the repo's CLAUDE.md imports ${path}, outside the checkout`,
      );
    }
    files.push(imported);
  }
  for (const file of files) {
    const to = join(target, relative(checkout, file));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(file, to);
  }
}
