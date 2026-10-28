// The npm updater's decision, pure: given what the workspace declares and
// resolves, its policies, and what the registry offers, which packages move
// where, and which newer releases wait: on a hold (held), on work an upgrade
// task can do (blocked — a prerequisite, a patch to port), or on someone else
// publishing first (awaiting — a lockstep partner that has not released it
// yet, or has and is cooling down). Every newer release ends up in exactly one
// of those four, so nothing newer is ever silently skipped.

import {
  heldBy,
  heldWaiting,
  utcDay,
  type Hold,
  type Move,
  type Outdated,
  type OutdatedWaiting,
} from "@plugins/infra/plugins/deps/plugins/updates/core";
import type { Group } from "./policy";
import { agreeKey, isPrerelease } from "./spec";

/** What the registry says about one package. */
export interface Packument {
  /** `dist-tags.latest`: the newest release its publisher calls current. */
  latest: string;
  /** Every published version, with the instant it was published. */
  published: ReadonlyMap<string, string>;
}

/** One directly declared package and the version the lock gives it. */
export interface Installed {
  name: string;
  current: string;
}

export interface PlanInput {
  installed: readonly Installed[];
  packuments: ReadonlyMap<string, Packument>;
  groups: readonly Group[];
  holds: readonly Hold[];
  /** Patched packages (`patchedDependencies`): a move must port the patch first. */
  patched: ReadonlyMap<string, { version: string; patch: string }>;
  /** ISO instant the plan is made at: the cooldown and the holds' review are measured from it. */
  now: string;
  /** A release published less than this long before `now` is not adopted yet. */
  cooldownDays: number;
}

const DAY_MS = 86_400_000;

export interface Plan {
  moves: Move[];
  /** Every package with something newer: moved, held, blocked, or awaiting. */
  outdated: Outdated[];
}

function order(a: string, b: string): number {
  return Bun.semver.order(a, b);
}

/**
 * The releases `name` may move to, newest first, the current one included (so
 * a group can always fall back to standing still): published before the
 * cutoff (`null`: whenever), no newer than `dist-tags.latest`, no prerelease
 * unless the package's own `latest` is one, never older than what is installed.
 */
function candidates(
  pkg: Packument,
  current: string,
  cutoff: string | null,
): string[] {
  const pre = isPrerelease(pkg.latest);
  const out = [...pkg.published]
    .filter(
      ([v, at]) =>
        (cutoff === null || at <= cutoff) &&
        order(v, pkg.latest) <= 0 &&
        order(v, current) >= 0 &&
        (pre || !isPrerelease(v)),
    )
    .map(([v]) => v);
  if (!out.includes(current)) out.push(current);
  return out.sort((a, b) => order(b, a));
}

/** Packages joined by any group, transitively: what must be decided together. */
function components(
  names: readonly string[],
  groups: readonly Group[],
): string[][] {
  const parent = new Map(names.map((n) => [n, n]));
  const find = (n: string): string => {
    const p = parent.get(n)!;
    if (p === n) return n;
    const r = find(p);
    parent.set(n, r);
    return r;
  };
  for (const g of groups) {
    const members = g.members.filter((m) => parent.has(m));
    for (const m of members.slice(1)) parent.set(find(m), find(members[0]!));
  }
  const by = new Map<string, string[]>();
  for (const n of names) by.set(find(n), [...(by.get(find(n)) ?? []), n]);
  return [...by.values()];
}

/**
 * The newest versions of a component's members on which every group agrees,
 * trying the first member's releases newest first and fitting each other member
 * to it (its newest release consistent with everything chosen so far).
 */
function assign(
  members: readonly string[],
  allowed: ReadonlyMap<string, readonly string[]>,
  groups: readonly Group[],
): Map<string, string> {
  const consistent = (
    chosen: ReadonlyMap<string, string>,
    name: string,
    v: string,
  ): boolean =>
    groups.every(
      (g) =>
        !g.members.includes(name) ||
        g.members.every((other) => {
          const ov = chosen.get(other);
          return (
            ov === undefined || agreeKey(ov, g.agree) === agreeKey(v, g.agree)
          );
        }),
    );
  for (const lead of allowed.get(members[0]!)!) {
    const chosen = new Map([[members[0]!, lead]]);
    let ok = true;
    for (const m of members.slice(1)) {
      const v = allowed.get(m)!.find((c) => consistent(chosen, m, c));
      if (v === undefined) {
        ok = false;
        break;
      }
      chosen.set(m, v);
    }
    if (ok) return chosen;
  }
  throw new Error(
    `No consistent versions for ${members.join(", ")} — not even the installed ones agree. ` +
      "Run the `deps-npm:groups-coherent` check.",
  );
}

/**
 * How a member whose own newest allowed release (`target`) is out of its
 * group's reach waits. `published` is the component's assignment over every
 * release published so far, cooldown ignored: if it reaches `target`, every
 * partner has published one that agrees and is only cooling down (awaiting).
 * Otherwise a partner has not published it: the group's `prerequisite` is the
 * work that makes it (BLOCKED), and without one it is upstream's to make
 * (awaiting the lagging partners).
 */
function laggingWaiting(args: {
  m: string;
  target: string;
  published: ReadonlyMap<string, string>;
  /** Per member: every release it may move to, cooldown ignored. */
  everAllowed: ReadonlyMap<string, readonly string[]>;
  /** Per member: the releases it may move to now. */
  allowed: ReadonlyMap<string, readonly string[]>;
  /** The groups `m` is a member of. */
  mine: readonly Group[];
  members: readonly string[];
  packuments: ReadonlyMap<string, Packument>;
  cooldownMs: number;
}): OutdatedWaiting {
  const { m, target, published, everAllowed, allowed, mine, members } = args;
  const publishedAt = (name: string, version: string): string => {
    const at = args.packuments.get(name)!.published.get(version);
    if (at === undefined)
      throw new Error(
        `${name}@${version} has no publish time in its packument.`,
      );
    return at;
  };
  const partners = [
    ...new Set(
      mine.flatMap((g) =>
        g.members.filter((p) => p !== m && members.includes(p)),
      ),
    ),
  ];
  if (order(published.get(m)!, target) >= 0) {
    const cooling = partners.filter(
      (p) => !allowed.get(p)!.includes(published.get(p)!),
    );
    if (cooling.length === 0)
      throw new Error(
        `${m}@${target}: every partner has published a release agreeing with it and none is cooling down, yet the group cannot reach it.`,
      );
    // The cooldown ends with the last partner's: its publish plus the cooldown.
    const last = Math.max(
      ...cooling.map((p) => Date.parse(publishedAt(p, published.get(p)!))),
    );
    return {
      kind: "awaiting",
      on: {
        kind: "cooldown",
        of: cooling,
        until: new Date(last + args.cooldownMs).toISOString(),
      },
    };
  }
  const g = mine.find((x) => x.prerequisite !== undefined);
  if (g?.prerequisite !== undefined)
    return { kind: "blocked", prerequisite: g.prerequisite };
  // The partners with no release agreeing with `target` on a group they share.
  const lagging = partners.filter((p) =>
    mine.some(
      (x) =>
        x.members.includes(p) &&
        !everAllowed
          .get(p)!
          .some((v) => agreeKey(v, x.agree) === agreeKey(target, x.agree)),
    ),
  );
  return {
    kind: "awaiting",
    on: {
      kind: "publish",
      by: lagging.length > 0 ? lagging : partners,
      release: target,
      // Waiting since `m` published the release its partners have not.
      since: publishedAt(m, target),
    },
  };
}

export function planNpm(input: PlanInput): Plan {
  const { installed, packuments, groups, holds, patched } = input;
  const cooldownMs = input.cooldownDays * DAY_MS;
  const now = Date.parse(input.now);
  if (Number.isNaN(now))
    throw new Error(`planNpm: now is not an instant: ${input.now}`);
  const cutoff = new Date(now - cooldownMs).toISOString();
  const today = utcDay(new Date(now));
  const current = new Map(installed.map((i) => [i.name, i.current]));
  const moves: Move[] = [];
  const outdated: Outdated[] = [];

  for (const members of components([...current.keys()].sort(), groups)) {
    const all = new Map<string, string[]>();
    const allowed = new Map<string, string[]>();
    const everAllowed = new Map<string, string[]>();
    const unheld = (m: string, vs: readonly string[]): string[] =>
      vs.filter((v) => v === current.get(m) || !heldBy(holds, m, v, order));
    for (const m of members) {
      const pkg = packuments.get(m);
      if (pkg === undefined)
        throw new Error(`No registry entry fetched for ${m}.`);
      const c = candidates(pkg, current.get(m)!, cutoff);
      all.set(m, c);
      allowed.set(m, unheld(m, c));
      everAllowed.set(m, unheld(m, candidates(pkg, current.get(m)!, null)));
    }
    const chosen = assign(members, allowed, groups);
    // What the component would reach once every cooldown has passed: computed
    // once, only for a component with a lagging member.
    let published: Map<string, string> | undefined;
    const memberGroups = groups.filter((g) =>
      g.members.some((m) => members.includes(m)),
    );

    for (const m of members) {
      const from = current.get(m)!;
      const to = chosen.get(m)!;
      const newest = all.get(m)![0]!;
      const newestAllowed = allowed.get(m)![0]!;
      const patch = patched.get(m);
      if (to !== from && patch !== undefined) {
        // A patch names the exact version it applies to; the move is the port.
        outdated.push({
          name: m,
          current: from,
          latest: to,
          waiting: {
            kind: "blocked",
            prerequisite: `port ${patch.patch} to ${m}@${to} (bun patch ${m}), then upgrade`,
          },
        });
        continue;
      }
      if (to !== from) {
        // A component lands whole: the runner never splits a unit.
        moves.push(
          members.length > 1
            ? { name: m, from, to, unit: members[0]! }
            : { name: m, from, to },
        );
        outdated.push({ name: m, current: from, latest: to });
      }
      if (order(newestAllowed, to) > 0) {
        // Its own newest release is out of the group's reach: a partner lags.
        published ??= assign(members, everAllowed, groups);
        outdated.push({
          name: m,
          current: from,
          latest: newestAllowed,
          waiting: laggingWaiting({
            m,
            target: newestAllowed,
            published,
            everAllowed,
            allowed,
            mine: memberGroups.filter((x) => x.members.includes(m)),
            members,
            packuments,
            cooldownMs,
          }),
        });
      } else if (order(newest, newestAllowed) > 0) {
        const hold = heldBy(holds, m, newest, order)!;
        outdated.push({
          name: m,
          current: from,
          latest: newest,
          waiting: heldWaiting(hold, today),
        });
      }
    }
  }
  return { moves, outdated };
}
