import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { matchBracket } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { collectTokenGroupVars } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { listRepoFiles } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

/**
 * Enforces that INHERITED, themed CSS defaults are consumed at a theme-scope
 * root, never on a bare root (`html`/`body`/`:root`/`*`) ABOVE the scope
 * boundary.
 *
 * Why: CSS inheritance passes the *computed* value, not the `var()` reference.
 * A property like `font-family: var(--font-sans)` declared on `html` resolves
 * the var once at `:root`; a forked app's `[data-theme-scope]` descendants then
 * inherit that computed desktop value and silently ignore the app's own scoped
 * override (the override block is alive in the cascade but never re-read). The
 * result is the cross-window font/color bleed: opening one app's window changes
 * the font of every other window. Colors avoid this only because they are
 * consumed per-element via utilities (`bg-background`), re-reading the var
 * inside each scope.
 *
 * The fix is to re-declare the inherited default on the scope root itself —
 * `:root, [data-theme-scope] { … }` — so every scope re-evaluates the `var()`.
 * This check makes the bad form impossible to merge for any FUTURE inherited
 * default, not just the known font/color cases.
 *
 * A rule is flagged when ALL hold:
 *  - its selector references a bare root (`html`/`body`/`:root`/`*`) and does
 *    NOT also list a `[data-theme-scope]` selector (which would re-anchor it),
 *  - and it sets an inherited property to a themed `var(--x)` value, OR
 *    declares a custom property (`--foo`) whose value reads a themed `var(--x)`
 *    (a DERIVED helper var — e.g. `--chrome-mask: var(--background)` — which
 *    custom-property inheritance freezes at `:root` exactly like font/color, so
 *    a `[data-theme-scope]` subtree consuming it via a `var()`-based utility
 *    like `bg-chrome-mask` gets the desktop value, not its own scoped one), OR
 *    `@apply`s an inherited+themed utility (base font-family / themed text
 *    color).
 */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Blank the interior of every `@theme { … }` / `@theme inline { … }` block
 * (length preserved) so its var DECLARATIONS / bridge `var()`s — Tailwind's
 * build-time utility-token layer, never a selector-scoped rule — are not parsed
 * as runtime rules. Mirrors css-vars-single-owner.
 */
function maskThemeBlocks(src: string): string {
  let out = src;
  const re = /@theme\b[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) {
    const braceStart = out.indexOf("{", m.index);
    if (braceStart < 0) break;
    const braceEnd = matchBracket(out, braceStart, "{", "}");
    if (braceEnd < 0) break;
    out =
      out.slice(0, braceStart + 1) +
      " ".repeat(braceEnd - braceStart - 1) +
      out.slice(braceEnd);
    re.lastIndex = braceEnd;
  }
  return out;
}

// Inherited CSS properties that realistically read a themed token var. Anything
// here, declared on a bare root with a themed `var()` value, leaks across the
// scope boundary. (Non-inherited paints like `background`/`border-color` do not
// inherit, so they are intentionally excluded.)
const INHERITED_PROPS = new Set([
  "color",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "font-feature-settings",
  "font-variation-settings",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-indent",
  "text-transform",
  "text-shadow",
  "caret-color",
  "tab-size",
  "list-style",
  "list-style-type",
  "quotes",
  "-webkit-font-smoothing",
]);

/** Does the selector list reference a bare root element above the scope boundary? */
function hasBareRoot(selector: string): boolean {
  return /(^|[\s,>+~(])(html|body|:root|\*)([\s,>+~)]|\b|$)/.test(selector);
}

/** Does the selector list re-anchor at the per-app scope (so the var re-reads)? */
function hasScope(selector: string): boolean {
  return /\[data-theme-scope/.test(selector);
}

/**
 * Strip a Tailwind class to its bare utility: drop `variant:` prefixes and a
 * trailing `/opacity`. `dark:text-foreground/50` → `text-foreground`.
 */
function bareUtility(cls: string): string {
  const noVariant = cls.slice(cls.lastIndexOf(":") + 1);
  return noVariant.split("/")[0] ?? noVariant;
}

/**
 * Is this `@apply` utility an inherited+themed default? Covers the two families
 * that actually inherit AND read a runtime token: base font-family
 * (`font-sans|serif|mono`) and themed text color (`text-<token>` where
 * `--<token>` is a token-group var). `text-sm` etc. map to `--sm` (not a token
 * var) and are correctly ignored. Raw inherited properties are caught
 * separately and comprehensively by INHERITED_PROPS, so this list only needs
 * the utility forms in actual use.
 */
function isThemedInheritedUtility(
  cls: string,
  themedVars: Set<string>,
): boolean {
  const u = bareUtility(cls);
  if (/^font-(sans|serif|mono)$/.test(u)) return true;
  if (u.startsWith("text-")) {
    const token = u.slice("text-".length);
    if (themedVars.has(`--${token}`)) return true;
  }
  return false;
}

const check: Check = {
  id: "inherited-theme-defaults-scoped",
  description:
    "Inherited themed CSS defaults (font-family, text color, …) and derived custom-property helpers (--chrome-mask, …) are consumed at a theme-scope root (:root, [data-theme-scope]), never on a bare html/body above the scope boundary",
  async run() {
    const root = await getWorktreeRoot();

    // Fresh token-group vars (the live descriptors, not the committed manifest —
    // see collectTokenGroupVars). Used to tell a themed `var()` / utility apart
    // from a structural one (`--z-nav`, `--radius`, system colors).
    const byGroup = await collectTokenGroupVars(root);
    const themedVars = new Set(Object.values(byGroup).flat());

    // Selected from `listRepoFiles`'s one git-backed enumeration, never a
    // hand-rolled `git ls-files <glob>`: that lists index entries whose file the
    // worktree no longer has, so a CSS file deleted-but-not-yet-committed
    // reached `readFileSync` below and crashed the check on the author's own
    // deletion. `listRepoFiles` subtracts those, and includes not-yet-tracked
    // files — so a brand-new plugin's CSS is checked from its first build.
    const cssFiles = (await listRepoFiles(root)).filter(
      (p) => p.startsWith("plugins/") && p.endsWith(".css"),
    );
    const offenders: { file: string; selector: string; decl: string }[] = [];

    for (const rel of cssFiles) {
      const raw = readFileSync(join(root, rel), "utf8");
      const code = maskThemeBlocks(stripComments(raw));

      // Innermost `selector { decls }` rules (decls contain no nested braces, so
      // a wrapping `@layer base { … }` is skipped and its inner rules matched).
      for (const m of code.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const selector = (m[1] ?? "").trim();
        const decls = m[2] ?? "";
        if (!selector || !hasBareRoot(selector) || hasScope(selector)) continue;

        // (A) raw inherited property — OR a derived custom property (`--foo`) —
        // reading a themed var. Custom properties always inherit, so a derived
        // helper var declared at a bare root freezes its `var(--x)` to the
        // desktop value for the whole tree, exactly like an inherited native
        // property (the `--chrome-mask` sticky-mask bleed). Native NON-inherited
        // paints (`background`, `border-color`) don't inherit and stay excluded.
        for (const d of decls.split(";")) {
          const idx = d.indexOf(":");
          if (idx < 0) continue;
          const prop = d.slice(0, idx).trim().toLowerCase();
          const value = d.slice(idx + 1);
          if (!INHERITED_PROPS.has(prop) && !prop.startsWith("--")) continue;
          for (const vm of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
            const name = vm[1];
            if (name && themedVars.has(name)) {
              offenders.push({
                file: rel,
                selector,
                decl: `${prop}: …${name}…`,
              });
            }
          }
        }

        // (B) @apply of an inherited+themed utility (font-family / themed color).
        for (const am of decls.matchAll(/@apply\s+([^;]+);?/g)) {
          for (const cls of (am[1] ?? "").trim().split(/\s+/)) {
            if (cls && isThemedInheritedUtility(cls, themedVars)) {
              offenders.push({ file: rel, selector, decl: `@apply ${cls}` });
            }
          }
        }
      }
    }

    if (offenders.length === 0) return { ok: true };

    const lines = offenders
      .map((o) => `  ${o.file} — \`${o.selector}\` { ${o.decl} }`)
      .join("\n");
    return {
      ok: false,
      message: `Inherited themed default anchored above the theme-scope boundary:\n${lines}`,
      hint:
        "Move the declaration onto the scope root so every scope re-reads the var: " +
        "`:root, [data-theme-scope] { … }` (the desktop scope PLUS each app scope). " +
        "On a bare html/body the var resolves once at :root, so forked apps inherit the " +
        "computed desktop value and their scoped override is silently ignored.",
    };
  },
};

export default check;
