import type TS from "typescript";
import type {
  Check,
  CheckContext,
  RepoFiles,
} from "@plugins/framework/plugins/tooling/core";

// The root base config is the single owner of repo-wide path aliases. Every
// other tsconfig must inherit them via `extends`, never redeclare a local copy
// (a child's `paths` fully replaces the parent's, and the per-config relative
// target silently rots when files move or a new config is added).
const BASE = "tsconfig.base.json";

let tsPromise: Promise<typeof TS> | undefined;
function loadTypescript(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

/** Every tsconfig of the run's file set (the git pathspec `*tsconfig*.json`: `*` spans `/`). */
function listTsconfigs(repo: RepoFiles): string[] {
  return (
    repo
      .glob("*tsconfig*.json")
      // Sidequests are independent projects with their own tsconfigs.
      .filter((p) => !p.startsWith("sidequests/"))
  );
}

// Raw (single-file) `paths` keys — `readConfigFile` parses JSONC but does NOT
// resolve `extends`, so this is exactly the literal declaration, which is what
// we want to forbid in non-base configs.
function declaredPathAliases(
  ts: typeof TS,
  root: string,
  rel: string,
): string[] {
  const { config } = ts.readConfigFile(`${root}/${rel}`, ts.sys.readFile);
  const paths = config?.compilerOptions?.paths;
  return paths && typeof paths === "object" ? Object.keys(paths) : [];
}

const check: Check = {
  id: "tsconfig-alias-single-owner",
  description:
    "Path aliases (e.g. @plugins/*) must be declared once in tsconfig.base.json and inherited via `extends` — no tsconfig may redeclare a base-owned alias",
  async run(ctx: CheckContext) {
    const ts = await loadTypescript();
    const repo = await ctx.repo();
    const { root } = repo;
    const owned = new Set(declaredPathAliases(ts, root, BASE));
    if (owned.size === 0) {
      return {
        ok: false,
        message: `${BASE} declares no path aliases — it must own the repo-wide aliases (e.g. "@plugins/*": ["./plugins/*"]).`,
        hint: `Add the shared aliases to ${BASE} so every other tsconfig can inherit them via \`extends\`.`,
      };
    }

    const offenders: string[] = [];
    for (const rel of listTsconfigs(repo)) {
      if (rel === BASE) continue;
      const dupes = declaredPathAliases(ts, root, rel).filter((a) =>
        owned.has(a),
      );
      if (dupes.length > 0) offenders.push(`  ${rel} → ${dupes.join(", ")}`);
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `${offenders.length} tsconfig(s) redeclare a base-owned path alias:\n${offenders.join("\n")}`,
      hint: `Remove the local \`paths\` entry; it is inherited from ${BASE} (which resolves it relative to the base file, i.e. <repo-root>/plugins/*, correct at every depth). If a config doesn't yet \`extends\` ${BASE}, add that instead of redeclaring the alias.`,
    };
  },
};

export default check;
