import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { collectTokenGroupVars } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { listRepoFiles } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { maskNonDeclarations } from "./mask";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

/**
 * Enforces that every token-group CSS var has exactly ONE declaring owner.
 * Token *value* resolution is a deliberate layered cascade (default → preset →
 * override); token *declaration* is the opposite — it must be single-owner, and
 * any overlap there is a real, ambiguous conflict that ThemeInjector or the
 * cascade would resolve silently/order-dependently.
 *
 * Fails if:
 *  (a) any var appears in 2+ token groups (cross-group collision); or
 *  (b) any token-group var is also DECLARED (`--x:`, not a `var(--x)` reference)
 *      in tracked CSS, EXCLUDING declarations inside `@theme { … }` /
 *      `@theme inline { … }` blocks (Tailwind's build-time utility-token layer,
 *      a defined lower-precedence position rather than an ambiguous same-level
 *      conflict). A container style query's condition
 *      (`@container style(--x: custom)`) READS the var, so it is not a
 *      declaration either.
 */

const check: Check = {
  id: "css-vars-single-owner",
  description:
    "Every token-group CSS var has exactly one declaring owner (no cross-group collision; no static-CSS re-declaration outside @theme)",
  async run() {
    const root = await getWorktreeRoot();

    // Fresh from the real `defineTokenGroup` descriptors — NOT the committed
    // manifest, whose static import is frozen in the ESM cache before codegen
    // rewrites it within the same build (see collectTokenGroupVars).
    const tokenGroupVarsByGroup = await collectTokenGroupVars(root);

    // (a) Cross-group collisions: var → the groups that claim it.
    const owners = new Map<string, string[]>();
    for (const [groupId, vars] of Object.entries(tokenGroupVarsByGroup)) {
      for (const v of vars) {
        const list = owners.get(v);
        if (list) list.push(groupId);
        else owners.set(v, [groupId]);
      }
    }
    const collisions = [...owners.entries()].filter(
      ([, groups]) => groups.length > 1,
    );

    // Set of all token-group vars (any group), for the static-CSS overlap scan.
    const tokenGroupVars = new Set(owners.keys());

    // (b) Static-CSS overlap: token-group vars DECLARED outside @theme blocks.
    // The web app.css lives under plugins/ (web-core), so the plugins glob
    // covers every tracked CSS file.
    // Selected from `listRepoFiles`'s one git-backed enumeration, never a
    // hand-rolled `git ls-files <glob>`: that lists index entries whose file the
    // worktree no longer has, so a CSS file deleted-but-not-yet-committed
    // reached `readFileSync` below and crashed the check on the author's own
    // deletion. `listRepoFiles` subtracts those, and includes not-yet-tracked
    // files — so a brand-new plugin's CSS is checked from its first build.
    const cssFiles = (await listRepoFiles(root)).filter(
      (p) => p.startsWith("plugins/") && p.endsWith(".css"),
    );
    const overlaps: { name: string; file: string }[] = [];
    for (const rel of cssFiles) {
      const raw = readFileSync(join(root, rel), "utf8");
      const code = maskNonDeclarations(raw);
      for (const mm of code.matchAll(/(--[\w-]+)\s*:/g)) {
        const name = mm[1];
        if (name && tokenGroupVars.has(name))
          overlaps.push({ name, file: rel });
      }
    }

    if (collisions.length === 0 && overlaps.length === 0) return { ok: true };

    const parts: string[] = [];
    if (collisions.length) {
      const lines = collisions
        .map(([name, groups]) => `  ${name} — claimed by: ${groups.join(", ")}`)
        .join("\n");
      parts.push(`Token-group var declared by multiple groups:\n${lines}`);
    }
    if (overlaps.length) {
      const lines = overlaps.map((o) => `  ${o.name} (${o.file})`).join("\n");
      parts.push(
        `Token-group var re-declared in static CSS (outside @theme):\n${lines}`,
      );
    }
    return {
      ok: false,
      message: parts.join("\n\n"),
      hint: "Each token-group var must have exactly one declaring owner. For a cross-group collision, rename one group's schema key. For a static-CSS overlap, reference the token via var(--x) (never declare it) — a token's only declaring owner is its token group (emitted by ThemeInjector).",
    };
  },
};

export default check;
