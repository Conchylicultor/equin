// The upstream half of detection, pure: a group of self-published wrappers
// (`wraps`) is behind when its upstream has tagged a release no member has
// published a wrapper for. The registry cannot show that — we are the ones who
// would publish it — so it is reported here, BLOCKED on publishing the wrapper.

import type { Outdated } from "@plugins/infra/plugins/deps/plugins/updates/core";
import type { Packument } from "./plan";
import type { Agree, Group } from "./policy";
import { agreeKey } from "./spec";

/** The capture groups a `wraps.tags.pattern` has: 1–3 (`major[.minor[.patch]]`). */
export function patternProblem(pattern: string): string | undefined {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    if (err instanceof SyntaxError) return `does not compile: ${err.message}`;
    throw err;
  }
  const groups = new RegExp(`${re.source}|`).exec("")!.length - 1;
  return groups >= 1 && groups <= 3
    ? undefined
    : `has ${groups} capture groups, needs 1–3 (major[.minor[.patch]])`;
}

/** The release versions among `tags` (names, `refs/tags/` stripped) that `pattern` matches. */
export function tagVersions(
  tags: readonly string[],
  pattern: string,
): string[] {
  const re = new RegExp(pattern);
  return tags.flatMap((tag) => {
    const m = re.exec(tag);
    if (m === null) return [];
    const parts = m.slice(1).map((p) => {
      if (p === undefined || !/^\d+$/.test(p))
        throw new Error(
          `Tag ${tag} matches ${pattern} but a capture group is not a number: ${p}`,
        );
      return Number(p);
    });
    while (parts.length < 3) parts.push(0);
    return [parts.join(".")];
  });
}

/** `version` with every part `agree` ignores zeroed, so two keys order as versions. */
function floor(version: string, agree: Agree): string {
  if (agree === "version") return version;
  const key = agreeKey(version, agree).split(".");
  while (key.length < 3) key.push("0");
  return key.join(".");
}

function order(a: string, b: string): number {
  return Bun.semver.order(a, b);
}

/**
 * One BLOCKED row per wrapper group whose upstream's newest release is newer,
 * on the group's `wraps.agree` part, than every release any member has
 * published. A published-but-cooling-down wrapper counts as published: from
 * then on the registry side (`planNpm`) reports the move.
 */
export function upstreamRows(args: {
  groups: readonly Group[];
  packuments: ReadonlyMap<string, Packument>;
  installed: ReadonlyMap<string, string>;
  /** Group id → the upstream release versions its tags name. */
  upstream: ReadonlyMap<string, readonly string[]>;
}): Outdated[] {
  const rows: Outdated[] = [];
  for (const g of args.groups) {
    if (g.wraps === undefined) continue;
    const { wraps } = g;
    const tagged = args.upstream.get(g.id);
    if (tagged === undefined)
      throw new Error(`No upstream tags fetched for group "${g.id}".`);
    if (tagged.length === 0)
      throw new Error(
        `group "${g.id}": no tag of ${wraps.tags.repo} matches ${wraps.tags.pattern} — the pattern no longer fits its releases.`,
      );
    const newest = [...tagged].sort((a, b) => order(b, a))[0]!;
    const published = g.members.flatMap((m) => {
      const pkg = args.packuments.get(m);
      if (pkg === undefined)
        throw new Error(`No registry entry fetched for ${m}.`);
      return [...pkg.published.keys()];
    });
    const wrapped = published.some(
      (v) => order(floor(v, wraps.agree), floor(newest, wraps.agree)) >= 0,
    );
    if (wrapped) continue;
    const current = args.installed.get(g.members[0]!) ?? null;
    rows.push({
      name: `${wraps.name} (upstream of group \`${g.id}\`)`,
      current,
      latest: newest,
      waiting: {
        kind: "blocked",
        prerequisite: wraps.prerequisite.replaceAll("<version>", newest),
      },
    });
  }
  return rows;
}
