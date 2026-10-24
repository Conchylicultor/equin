import { readFileSync } from "fs";
import { join } from "path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { collectWebSlotContributions } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  SUB_THEME_CALL,
  readSubThemeId,
  uncontributedSubThemes,
  type DeclaredSubTheme,
} from "./internal/uncontributed";

// A sub-theme takes three steps — `defineSubTheme`, a `ThemeEngine.SubTheme`
// contribution, a `<Theme name={subThemeScope(…)}>` boundary — and skipping the
// middle one is silent: the region carries `data-theme-scope="sub:<id>"` but no
// block is ever painted for it, so it simply looks unstyled. This closes that
// gap: every declared sub-theme must be among the ones the browser registers.
// Generic: it reads the slot's contributions, never naming a contributor.

const SUB_THEME_SLOT = "ui.theme-engine.sub-theme";

const isTestFile = (path: string) =>
  /\.test\.tsx?$/.test(path) || path.includes("/__tests__/");

const check: Check = {
  id: "theme-engine:sub-themes-contributed",
  description:
    "every `defineSubTheme` is contributed through `ThemeEngine.SubTheme`, so the region wearing it is painted",
  outOfScope: ["research"],
  async run() {
    const root = await getWorktreeRoot();
    // Real-code calls only: grepCode masks comments and strings, so prose and
    // error messages naming `defineSubTheme(` are not calls.
    const calls = (
      await grepCode({
        root,
        pattern: SUB_THEME_CALL,
        grepArg: "defineSubTheme(",
        fixed: true,
      })
    ).filter((c) => !isTestFile(c.path));

    const declared: DeclaredSubTheme[] = [];
    const unreadable: string[] = [];
    for (const c of calls) {
      const id = readSubThemeId(
        readFileSync(join(root, c.path), "utf8"),
        c.line,
      );
      if (id === undefined) unreadable.push(`${c.path}:${c.line}`);
      else declared.push({ id, path: c.path, line: c.line });
    }
    if (unreadable.length > 0) {
      return {
        ok: false,
        message: `could not read the id of ${unreadable.length} \`defineSubTheme\` call(s):\n    ${unreadable.join("\n    ")}`,
        hint: 'Spell the id as the call\'s first key, a string literal: `defineSubTheme({ id: "…", label: "…", fragments: […] })`.',
      };
    }

    const { subThemes } = await collectWebSlotContributions(root, {
      subThemes: SUB_THEME_SLOT,
    });
    const contributed = new Set(
      subThemes.flatMap((c) => (typeof c.id === "string" ? [c.id] : [])),
    );
    const missing = uncontributedSubThemes(declared, contributed);
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${missing.length} sub-theme(s) declared but never contributed — a region wearing one is not painted:\n    ${missing
        .map((m) => `"${m.id}" (${m.path}:${m.line})`)
        .join("\n    ")}`,
      hint: "Add `ThemeEngine.SubTheme(<theSubTheme>)` to the `contributions` of the declaring plugin's web barrel (`@plugins/ui/plugins/theme-engine/web`). See plugins/ui/plugins/theme-engine/CLAUDE.md, Sub-themes.",
    };
  },
};

export default check;
