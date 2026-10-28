// The upstream half of detection, pure: a group of self-published wrappers
// (`wraps`) is behind when its upstream has tagged a release no member has
// published a wrapper for. The registry cannot show that — we are the ones who
// would publish it — so it is reported here: BLOCKED on publishing the wrapper,
// or, for a wrapper built `after` another group that has not published the
// release either, awaiting that group.

import {
  heldBy,
  heldWaiting,
  type Hold,
  type Outdated,
} from "@plugins/infra/plugins/deps/plugins/updates/core";
import type { Packument } from "./plan";
import type { Agree, Group, Wraps } from "./policy";
import { agreeKey, publishers } from "./spec";

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

/**
 * The newest release among `tags` that `wraps.tags.pattern` matches, with the
 * tag naming it. Throws when none matches: the pattern no longer fits.
 */
export function newestTag(
  groupId: string,
  wraps: Wraps,
  tags: readonly string[],
): { tag: string; version: string } {
  const matched = tags.flatMap((tag) =>
    tagVersions([tag], wraps.tags.pattern).map((version) => ({ tag, version })),
  );
  if (matched.length === 0)
    throw new Error(
      `group "${groupId}": no tag of ${wraps.tags.repo} matches ${wraps.tags.pattern} — the pattern no longer fits its releases.`,
    );
  return matched.sort((a, b) => order(b.version, a.version))[0]!;
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

/** Every release any of `members` has published, cooling down or not. */
function publishedBy(
  members: readonly string[],
  packuments: ReadonlyMap<string, Packument>,
): string[] {
  return members.flatMap((m) => {
    const pkg = packuments.get(m);
    if (pkg === undefined)
      throw new Error(`No registry entry fetched for ${m}.`);
    return [...pkg.published.keys()];
  });
}

/** Whether any of `published` names `release` (or newer) on `agree`. */
function reaches(
  published: readonly string[],
  release: string,
  agree: Agree,
): boolean {
  return published.some(
    (v) => order(floor(v, agree), floor(release, agree)) >= 0,
  );
}

/**
 * One row per wrapper group whose upstream's newest release is newer, on the
 * group's `wraps.agree` part, than every release any member has published. A
 * published-but-cooling-down wrapper counts as published: from then on the
 * registry side (`planNpm`) reports the move. A hold naming a member of the
 * group and covering the release makes the row HELD. Otherwise it is BLOCKED
 * on `wraps.prerequisite` — unless the wrapper is built `after` another group:
 * while no member of that one has published the release it is awaited (no
 * task, until it has waited too long: `boundedRows`), since the upstream tag;
 * once one has, there is no row here, since the lockstep group spanning both
 * reports the lag from the registry.
 */
export function upstreamRows(args: {
  groups: readonly Group[];
  packuments: ReadonlyMap<string, Packument>;
  installed: ReadonlyMap<string, string>;
  /** Group id → its upstream's newest release (`newestTag`) and when its tag was made (ISO instant). */
  upstream: ReadonlyMap<string, { release: string; taggedAt: string }>;
  holds: readonly Hold[];
  /** `YYYY-MM-DD`: past a hold's `reviewBy` its HELD row says the review is overdue. */
  today: string;
}): Outdated[] {
  const rows: Outdated[] = [];
  for (const g of args.groups) {
    if (g.wraps === undefined) continue;
    const { wraps } = g;
    const tagged = args.upstream.get(g.id);
    if (tagged === undefined)
      throw new Error(`No upstream release fetched for group "${g.id}".`);
    const newest = tagged.release;
    if (reaches(publishedBy(g.members, args.packuments), newest, wraps.agree))
      continue;
    const row = {
      name: `${wraps.name} (upstream of group \`${g.id}\`)`,
      current: args.installed.get(g.members[0]!) ?? null,
      latest: newest,
    };
    const hold = g.members
      .map((m) => heldBy(args.holds, m, newest, order))
      .find((h) => h !== undefined);
    if (hold !== undefined) {
      rows.push({ ...row, waiting: heldWaiting(hold, args.today) });
      continue;
    }
    if (wraps.after === undefined) {
      rows.push({
        ...row,
        waiting: {
          kind: "blocked",
          prerequisite: wraps.prerequisite.replaceAll("<version>", newest),
        },
      });
      continue;
    }
    const after = args.groups.find((x) => x.id === wraps.after);
    if (after === undefined)
      throw new Error(
        `group "${g.id}": wraps.after names group "${wraps.after}", which no dependencyPolicy declares (\`./equin check deps-npm:policy\`).`,
      );
    if (
      reaches(publishedBy(after.members, args.packuments), newest, wraps.agree)
    )
      continue;
    rows.push({
      ...row,
      waiting: {
        kind: "awaiting",
        on: {
          kind: "publish",
          by: publishers(after.members),
          release: `${wraps.name} ${agreeKey(newest, wraps.agree)}`,
          since: tagged.taggedAt,
        },
      },
    });
  }
  return rows;
}
