import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { PROTOTYPES_DIR_DISPLAY } from "@plugins/infra/plugins/paths/plugins/display/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { validatePrototypeFolder } from "../core/validate";
import { readPrototypeFolder } from "../shared/read-folder";

// The `prototypes:self-contained` check.
//
// Prototypes themselves are NOT checked in: they are throwaway user content
// living in `~/.equin/apps/prototypes/`, shared by every worktree, backed up by
// the `prototypes` backup source, and validated at read time so their problems
// land on the gallery card instead of blocking somebody's code push.
//
// What remains in the repo is the part that is code, and this check guards both
// halves of that split:
//
//   1. `_template/` — the blank page every prototype is copied from — must
//      itself satisfy the self-contained contract.
//   2. Nothing else may appear in `prototypes/`. A prototype folder committed
//      here is the mistake this check exists to make loud: it would be invisible
//      to every other worktree, would need a merge to be seen, and would live in
//      the code history forever.

const TEMPLATE = "_template";

/** Entries that legitimately live in the repo's `prototypes/` dir. */
const ALLOWED_FILES = new Set(["CLAUDE.md"]);

interface Problem {
  path: string;
  detail: string;
}

const check: Check = {
  id: "prototypes:self-contained",
  description: `the repo's prototypes/ holds only the self-contained _template/ seed — authored prototypes live in ${PROTOTYPES_DIR_DISPLAY}/, not in git`,
  async run(): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const prototypesDir = join(root, "prototypes");

    let entries: Dirent<string>[];
    try {
      entries = await readdir(prototypesDir, { withFileTypes: true });
    } catch (err) {
      // No prototypes/ directory at all is a legitimate state (nothing to check).
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
      throw err;
    }

    const problems: Problem[] = [];
    let hasTemplate = false;

    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        if (name === TEMPLATE) {
          hasTemplate = true;
          continue;
        }
        problems.push({
          path: `prototypes/${name}/`,
          detail: `prototypes are no longer checked in — move this folder to ${PROTOTYPES_DIR_DISPLAY}/, where every worktree and main serve it live with no build and nothing to commit`,
        });
        continue;
      }

      if (!ALLOWED_FILES.has(name)) {
        problems.push({
          path: `prototypes/${name}`,
          detail: `unexpected — prototypes/ holds only ${TEMPLATE}/ and ${[...ALLOWED_FILES].join(", ")}`,
        });
      }
    }

    if (!hasTemplate) {
      problems.push({
        path: `prototypes/${TEMPLATE}/`,
        detail: `missing — the blank page every prototype is copied from, and what the server seeds into ${PROTOTYPES_DIR_DISPLAY}/`,
      });
    } else {
      // The seed is held to the contract it seeds: nothing is shared, so it
      // reaches outside itself for nothing either.
      const folder = await readPrototypeFolder(prototypesDir, TEMPLATE, []);
      for (const p of await validatePrototypeFolder(folder)) {
        problems.push({
          path: `prototypes/${TEMPLATE}/${p.path}`,
          detail: p.detail,
        });
      }
    }

    if (problems.length === 0) return { ok: true };

    problems.sort((a, b) => a.path.localeCompare(b.path));
    return {
      ok: false,
      message: `${problems.length} prototype problem${problems.length === 1 ? "" : "s"}:\n${problems
        .map((p) => `  ${p.path} — ${p.detail}`)
        .join("\n")}`,
      hint: `Authored prototypes live in ${PROTOTYPES_DIR_DISPLAY}/ — one flat folder each, with a self-contained index.html, copied from _template/. The repo keeps only that template and prototypes/CLAUDE.md.`,
    };
  },
};

export default check;
