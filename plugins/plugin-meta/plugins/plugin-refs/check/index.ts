import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  COMPOSITIONS_MANIFEST,
  COMPOSITIONS_SOURCE,
  findPluginRefs,
  resolveRelativeRef,
} from "../core";
import type { RelativeRef } from "../core";

const MAX_SHOWN = 50;

/**
 * Every relative link in a tracked markdown file, and every relative CSS
 * `@source` / `@import`, points at something that exists. A CSS glob's static
 * prefix (the directory before its first glob segment) must exist — a glob
 * whose prefix is gone matches nothing and fails silently otherwise.
 */
const relativeLinksResolve: Check = {
  id: "plugin-refs:relative-links-resolve",
  description:
    "relative markdown links and CSS @source/@import paths resolve to an existing file or directory",
  // Dated research records are a log, not live docs: what they link to is
  // legitimately deleted later. Their OWN links are not checked; a link INTO
  // research from anywhere else is.
  outOfScope: ["research"],
  async run(ctx: CheckContext): Promise<CheckResult> {
    const repo = await ctx.repo();
    const exists = (path: string) =>
      path === "" || repo.has(path) || repo.under(path).length > 0;

    const broken: Array<{ ref: RelativeRef; why: string }> = [];
    for (const ref of await findPluginRefs(repo, { kinds: ["relative"] })) {
      if (ref.kind !== "relative") continue;
      if (!ctx.inScope(ref.file)) continue;
      const resolved = resolveRelativeRef(ref);
      if (resolved.kind === "outside") {
        broken.push({ ref, why: "climbs out of the repo" });
      } else if (!exists(resolved.staticPath)) {
        broken.push({
          ref,
          why: ref.glob
            ? `glob prefix "${resolved.staticPath}" does not exist`
            : `"${resolved.target}" does not exist`,
        });
      }
    }

    if (broken.length === 0) return { ok: true };
    const shown = broken
      .slice(0, MAX_SHOWN)
      .map(
        ({ ref, why }) => `  ${ref.file}:${ref.line} — ${ref.value} (${why})`,
      );
    const more =
      broken.length > MAX_SHOWN
        ? `\n  … +${broken.length - MAX_SHOWN} more`
        : "";
    return {
      ok: false,
      message: `${broken.length} broken relative link(s):\n${shown.join("\n")}${more}`,
      hint:
        "Point each link at the file's current location (paths are relative to the file the link is in). " +
        "If the target is truly gone, drop the link and keep its text.",
    };
  },
};

/**
 * Every plugin id the generated compositions origin names is also found in its
 * `defineConfig` source. The origin is derived — a move rewrites the source and
 * the build regenerates the origin from it — so an id the source spells in a
 * shape the locator cannot read (a helper argument, a const array) would survive
 * a rename in the source and come back in the origin. This fails first.
 */
const compositionsSourceCoversOrigin: Check = {
  id: "plugin-refs:compositions-source-covers-origin",
  description:
    "every plugin id in the compositions origin is written where the plugin-refs locator reads it in the compositions source",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const refs = await findPluginRefs(await ctx.repo(), { kinds: ["dot"] });
    const inSource = new Set<string>();
    for (const r of refs) {
      if (r.kind === "dot" && r.site === "composition-source")
        inSource.add(r.id);
    }
    const unread = new Set<string>();
    for (const r of refs) {
      if (
        r.kind === "dot" &&
        r.site === "composition-manifest" &&
        !inSource.has(r.id)
      ) {
        unread.add(r.id);
      }
    }
    if (unread.size === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${unread.size} plugin id(s) in ${COMPOSITIONS_MANIFEST} are not found in ${COMPOSITIONS_SOURCE}:\n` +
        [...unread]
          .sort()
          .map((id) => `  ${id}`)
          .join("\n"),
      hint:
        "Write each id inside an `entryPoints: [...]` / `selectedContributors: [...]` array literal in the source " +
        "(pass helpers an object with that property, not a bare string or array) — the only spelling " +
        "`./equin plugin move` rewrites there. If the source no longer names it, run `./equin build` to regenerate the origin.",
    };
  },
};

export default [relativeLinksResolve, compositionsSourceCoversOrigin];
