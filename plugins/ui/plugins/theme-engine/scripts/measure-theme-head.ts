// Times the server's first-frame theme render (renderThemeHead) over the real
// declarations — every token group, code theme, sub-theme and fixed theme the
// build generated — and every tab app, `--themed` of them with a theme of
// their own (the rest follow the desktop), and splits one entry's cost into
// its parts: the scopes' group blocks, the sub-theme blocks, the fixed themes.
//
//   ./equin run plugins/ui/plugins/theme-engine/scripts/measure-theme-head.ts [--themed 4] [--runs 10]
//
// Research: research/2026-11-08-infra-file-watcher-close-stall.md (§ theme)
import { declaredApps } from "@plugins/apps-core/server";
import { paintThemeStyles } from "../core";
import {
  codeThemes,
  fixedThemes,
  subThemes,
  tokenGroups,
} from "../server/internal/theme-declarations.generated";
import { renderThemeHead } from "../server/internal/theme-head";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const themed = flag("themed", 4);
const runs = flag("runs", 10);

const sources = {
  groups: tokenGroups,
  themesById: new Map(codeThemes.map((t) => [t.id, t])),
  subThemes,
  fixedThemes,
};
const apps = declaredApps
  .filter(({ launch }) => launch === "tab")
  .map(({ app }) => ({
    id: app.id,
    basePath: app.basePath,
    colorMode: "light" as const,
  }));
const baseThemeId = codeThemes[0]!.id;
const scopes = apps.slice(0, themed).map((a, i) => ({
  scopeId: `app:${a.id}`,
  themeId: codeThemes[(i + 1) % codeThemes.length]!.id,
}));

function time(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

let entries = 0;
let digest = "";
const heads = Array.from({ length: runs }, () =>
  time(() => {
    const out = renderThemeHead(sources, apps, {
      baseThemeId,
      colorMode: "light",
      scopes,
    });
    entries = Object.keys(out).length;
    digest = String(Bun.hash(JSON.stringify(out)));
  }),
);
const head = median(heads);
const bare = { ...sources, subThemes: [], fixedThemes: [] };
const scopesOnly = median(
  Array.from({ length: runs }, () =>
    time(() =>
      paintThemeStyles(bare, {
        baseThemeId,
        canvasThemeId: baseThemeId,
        canvasColorMode: "dark",
        appThemes: [],
      }),
    ),
  ),
);
const withSub = median(
  Array.from({ length: runs }, () =>
    time(() =>
      paintThemeStyles(
        { ...bare, subThemes },
        {
          baseThemeId,
          canvasThemeId: baseThemeId,
          canvasColorMode: "dark",
          appThemes: [],
        },
      ),
    ),
  ),
);
const withFixed = median(
  Array.from({ length: runs }, () =>
    time(() =>
      paintThemeStyles(
        { ...bare, fixedThemes },
        {
          baseThemeId,
          canvasThemeId: baseThemeId,
          canvasColorMode: "dark",
          appThemes: [],
        },
      ),
    ),
  ),
);

console.log(
  `${tokenGroups.length} groups, ${codeThemes.length} code themes, ${subThemes.length} sub-themes, ${fixedThemes.length} fixed themes; ${apps.length} tab apps, ${themed} themed`,
);
console.log(
  `renderThemeHead: ${head.toFixed(1)} ms median, ${Math.min(...heads).toFixed(1)} ms min, for ${entries} entries (output hash ${digest})`,
);
console.log(`one entry, split (median of ${runs}):`);
console.log(`  :root group blocks   ${scopesOnly.toFixed(2)} ms`);
console.log(`  + sub-theme blocks   ${(withSub - scopesOnly).toFixed(2)} ms`);
console.log(`  + fixed-theme blocks ${(withFixed - scopesOnly).toFixed(2)} ms`);
