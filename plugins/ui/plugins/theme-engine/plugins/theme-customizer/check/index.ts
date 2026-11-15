import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  collectWebSlotContributions,
  codegenPassOver,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { fileSetImportClosures } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import {
  asFsPath,
  asPluginId,
  pluginDirOfRepoPath,
} from "@plugins/framework/plugins/plugin-id/core";

// The customizer is an optional editor. What paints a scope (token groups,
// themes, theme sources, sub-themes, fixed themes, variant pickers) and what
// the quick-theme popover draws must still work when the customizer's web
// artifact — or anything only it reaches — fails to fetch or evaluate. The web
// loader isolates plugins one by one, but a static import chains a plugin's
// fate to what it imports: on 2026-11-13 every token group rode on the
// customizer barrel, so one failed artifact unregistered them all.
//
// So: no web barrel contributing to those slots may reach a module of the
// customizer's web/ in its static import closure. A plugin that also wants a
// customizer section puts it in a child plugin (`<plugin>/plugins/customizer`),
// which the loader isolates. Generic: it reads the slots' contributions, never
// naming a contributor.

const GUARDED_SLOTS = {
  tokenGroups: "ui.theme-engine.token-group",
  themes: "ui.theme-engine.theme",
  subThemes: "ui.theme-engine.sub-theme",
  fixedThemes: "ui.theme-engine.fixed-theme",
  themeSources: "ui.theme-engine.theme-source",
  variantGroups: "ui.theme-engine.variant-group",
  quickThemeSections: "ui.theme-engine.quick-theme.section",
} as const;

const CUSTOMIZER = asPluginId("ui.theme-engine.theme-customizer");
const CUSTOMIZER_DIR = `plugins/${asFsPath(CUSTOMIZER)}`;

const isCustomizerWebModule = (module: string): boolean =>
  pluginDirOfRepoPath(module) === CUSTOMIZER_DIR &&
  module.slice(CUSTOMIZER_DIR.length + 1).split("/")[0] === "web";

const check: Check = {
  id: "theme-customizer:painting-off-the-editor",
  description:
    "no web plugin contributing to a theme-engine painting slot or a quick-theme section statically reaches the theme customizer's web barrel — painting and the quick-theme popover work when the editor fails to load",
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const pass = codegenPassOver(repo);
    const contributed = await collectWebSlotContributions(pass, GUARDED_SLOTS);
    // The registry always holds token groups: none read means the read is
    // broken, not that nothing paints — never pass on an empty subject.
    if (contributed.tokenGroups.length === 0)
      return {
        ok: false,
        message:
          "no `ThemeEngine.TokenGroup` contribution was read from the bundled web barrels, so nothing was checked",
        hint: "The evaluated-barrel read (codegen's collectWebSlotContributions) returned nothing for ui.theme-engine.token-group: check the slot id and that `./equin build` regenerated the records.",
      };
    const slotsByPlugin = new Map<string, Set<string>>();
    for (const [section, list] of Object.entries(contributed)) {
      for (const { plugin } of list) {
        if (!slotsByPlugin.has(plugin)) slotsByPlugin.set(plugin, new Set());
        slotsByPlugin.get(plugin)!.add(section);
      }
    }

    const findings: string[] = [];
    for (const [plugin, sections] of [...slotsByPlugin].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const barrel = `plugins/${asFsPath(asPluginId(plugin))}/web/index.ts`;
      const closure = await fileSetImportClosures(repo, [barrel], {
        dynamicImports: "cut",
      });
      const reached = [...closure.modules].filter(isCustomizerWebModule);
      if (reached.length === 0) continue;
      const chain = reached
        .map((m) => closure.importChain(m))
        .reduce((a, b) => (b.length < a.length ? b : a));
      findings.push(
        `${plugin} (contributes ${[...sections].join(", ")}) — shortest chain:\n      ${chain.join("\n    → ")}`,
      );
    }
    if (findings.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${findings.length} plugin(s) that paint or draw the quick-theme popover load the theme customizer's web barrel, so they fail with it:\n  ${findings.join("\n  ")}`,
      hint: "Move the customizer contribution (a `ThemeCustomizer.Section`) and the components only it uses into a child plugin `<plugin>/plugins/customizer/web/`, and link to the customizer through `themeCustomizerRoute` from `theme-customizer/core`. See plugins/ui/plugins/tokens/CLAUDE.md.",
    };
  },
};

export default check;
