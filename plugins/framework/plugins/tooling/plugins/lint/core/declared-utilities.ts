import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";

/**
 * Which custom `@utility` classes exist — the one stylesheet fact a class rule
 * may consult, read from app.css by whoever builds the lint config and handed
 * to the builder as data (`BuildLintConfigOptions.declaredUtilities`): the
 * builder's import closure is the type-check lint engine, and this reader's
 * file I/O must stay out of it.
 *
 * Read from the stylesheet by PATH rather than imported from a generated TS
 * manifest, for two reasons. A rule file cannot import a runtime value from
 * another plugin (jiti, which loads `eslint.config.ts`, does not resolve the
 * `@plugins/*` alias). And `build` regenerates its manifests in-process after
 * the lint config is first loaded, so a statically imported manifest would be
 * frozen at its previous contents (`cli:codegen-manifests-not-frozen`). A file
 * read by the config's builder each time it builds one is current for every
 * lint pass.
 *
 * The file is listed in {@link LINT_DATA_FILES}; the type-check lint cache keys
 * on {@link lintDataKey} — the declared set, not the file's bytes — so editing a
 * token value in app.css re-lints nothing, while adding or removing a utility
 * invalidates every cached lint result exactly as a rule change does.
 */

/** The app stylesheet, the single source of truth for custom `@utility` classes. */
export const APP_CSS_REL_PATH =
  "plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css";

/**
 * Files outside any `lint/` folder whose contents class rules read. Each is a
 * global trigger of the type-check lint cache: a change can alter the lint
 * result of any file, not only of the files that import it.
 */
export const LINT_DATA_FILES: readonly string[] = [APP_CSS_REL_PATH];

/**
 * Every real `@utility <name>` in app.css. Comments are stripped first, so a
 * prose mention inside one is not mistaken for a declaration — the same rule
 * as codegen's `collectUtilityDecls` (`codegen/core/app-css-utilities.ts`),
 * which this file cannot import: lint core loads under jiti.
 */
export function readDeclaredUtilities(root: AppPath): ReadonlySet<string> {
  const css = readFileSync(joinAppPath(root, APP_CSS_REL_PATH), "utf8");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set<string>();
  for (const m of code.matchAll(/@utility\s+([\w-]+)/g)) names.add(m[1]!);
  if (names.size === 0) {
    throw new Error(
      `${APP_CSS_REL_PATH} declares no @utility — the stylesheet moved or the scan broke; ` +
        `every class rule that checks a class exists would otherwise reject everything.`,
    );
  }
  return names;
}

/**
 * What lint rules read from {@link LINT_DATA_FILES}, as one stable string: the
 * sorted declared `@utility` names. A cache keyed on this, rather than on the
 * stylesheet's bytes, survives the edits to app.css that cannot change a lint
 * result — 6 of its 11 changes on main in the week to 2026-10-15 left the set
 * alone.
 */
export function lintDataKey(root: AppPath): string {
  return [...readDeclaredUtilities(root)].sort().join("\n");
}
