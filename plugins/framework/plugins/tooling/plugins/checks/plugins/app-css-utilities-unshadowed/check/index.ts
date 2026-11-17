import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { dirname, relative } from "path";
import {
  appCssPath,
  collectUtilityDecls,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

/**
 * The stylesheets app.css imports that can declare `@utility`s of their own:
 * every `@import "<package>…"` but Tailwind itself (whose utilities are its
 * engine's, not `@utility` rules, and which tailwind-merge already knows).
 */
function importedPackageSheets(css: string): string[] {
  const specs: string[] = [];
  for (const m of css.matchAll(/^@import\s+"([^"]+)"/gm)) {
    const spec = m[1]!;
    if (spec === "tailwindcss" || spec.startsWith(".")) continue;
    specs.push(spec);
  }
  return specs;
}

/**
 * Whether two `@utility` names claim the same class: equal, or one a
 * functional `<prefix>-*` that the other's name falls under.
 */
function sameClass(ours: string, theirs: string): boolean {
  const covers = (fn: string, name: string) =>
    fn.endsWith("-*") && name.startsWith(fn.slice(0, -1));
  return ours === theirs || covers(theirs, ours) || covers(ours, theirs);
}

const check: Check = {
  id: "app-css-utilities-unshadowed",
  description:
    "no custom @utility in app.css shares its name with one a stylesheet it imports declares (Tailwind merges same-name utilities silently)",
  async run() {
    const root = await getWorktreeRoot();
    const app = appCssPath(root);
    const css = await readFile(app, "utf8");
    const ours = collectUtilityDecls(css).map((d) => d.name);
    const clashes: string[] = [];
    for (const spec of importedPackageSheets(css)) {
      // Resolved the way the CSS build resolves it: from app.css's folder.
      const sheet = Bun.resolveSync(spec, dirname(app));
      const theirs = collectUtilityDecls(await readFile(sheet, "utf8")).map(
        (d) => d.name,
      );
      for (const name of ours) {
        const hit = theirs.find((t) => sameClass(name, t));
        if (hit !== undefined) {
          clashes.push(
            `\`${name}\` (app.css) — \`@utility ${hit}\` in ${spec} (${relative(root, sheet)})`,
          );
        }
      }
    }
    if (clashes.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        "app.css declares utilities an imported stylesheet declares too — Tailwind merges both into one class, so ours silently gains the package's declarations:\n" +
        clashes.map((c) => `  ${c}`).join("\n"),
      hint: "Rename the app.css utility (and its uses). shadcn 4.23's own `scroll-fade` once merged a mask-image into ours and clipped every menu's outline and shadow.",
    };
  },
};

export default check;
