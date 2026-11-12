// Times the server's first-frame theme render (renderThemeHead) over the real
// declarations — every token group and code theme the build generated — and
// every tab app, `--themed` of them with a theme of their own (the rest follow
// the desktop), and reports the bytes each entry adds to a page's head.
//
//   ./equin run plugins/ui/plugins/theme-engine/scripts/measure-theme-head.ts [--themed 4] [--runs 10]
//
// Research: research/2026-11-08-infra-file-watcher-close-stall.md (§ theme)
import { declaredApps } from "@plugins/apps-core/server";
import {
  codeThemes,
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

let out: Record<string, string> = {};
const heads = Array.from({ length: runs }, () =>
  time(() => {
    out = renderThemeHead(sources, apps, {
      baseThemeId,
      colorMode: "light",
      scopes,
    });
  }),
);
const head = median(heads);
const sizes = Object.values(out).map((html) => html.length);

console.log(
  `${tokenGroups.length} groups, ${codeThemes.length} code themes; ${apps.length} tab apps, ${themed} themed`,
);
console.log(
  `renderThemeHead: ${head.toFixed(1)} ms median, ${Math.min(...heads).toFixed(1)} ms min, for ${sizes.length} entries (output hash ${Bun.hash(JSON.stringify(out))})`,
);
console.log(
  `head bytes per entry: min ${Math.min(...sizes)}, max ${Math.max(...sizes)}`,
);
