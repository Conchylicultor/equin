// The npm updater's decision, pure: given what the workspace declares and
// resolves, its policies, and what the registry offers, which packages move
// where, and which newer releases wait (held) or cannot be reached yet
// (blocked). Every newer release ends up in exactly one of those three, so
// nothing newer is ever silently skipped.

import {
  heldBy,
  heldWaiting,
  type Hold,
  type Move,
  type Outdated,
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
  /** A release published after this instant is not adopted yet (the cooldown). */
  cutoff: string;
  /** `YYYY-MM-DD`: past a hold's `reviewBy` its HELD row says the review is overdue. */
  today: string;
}

export interface Plan {
  moves: Move[];
  /** Every package with something newer: moved, held, or blocked. */
  outdated: Outdated[];
}

function order(a: string, b: string): number {
  return Bun.semver.order(a, b);
}

/**
 * The releases `name` may move to, newest first, the current one included (so
 * a group can always fall back to standing still): published before the
 * cutoff, no newer than `dist-tags.latest`, no prerelease unless the package's
 * own `latest` is one, never older than what is installed.
 */
function candidates(pkg: Packument, current: string, cutoff: string): string[] {
  const pre = isPrerelease(pkg.latest);
  const out = [...pkg.published]
    .filter(
      ([v, at]) =>
        at <= cutoff &&
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

export function planNpm(input: PlanInput): Plan {
  const { installed, packuments, groups, holds, patched, cutoff, today } =
    input;
  const current = new Map(installed.map((i) => [i.name, i.current]));
  const moves: Move[] = [];
  const outdated: Outdated[] = [];

  for (const members of components([...current.keys()].sort(), groups)) {
    const all = new Map<string, string[]>();
    const allowed = new Map<string, string[]>();
    for (const m of members) {
      const pkg = packuments.get(m);
      if (pkg === undefined)
        throw new Error(`No registry entry fetched for ${m}.`);
      const c = candidates(pkg, current.get(m)!, cutoff);
      all.set(m, c);
      allowed.set(
        m,
        c.filter((v) => v === current.get(m) || !heldBy(holds, m, v, order)),
      );
    }
    const chosen = assign(members, allowed, groups);
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
        const mine = memberGroups.filter((x) => x.members.includes(m));
        const g = mine.find((x) => x.prerequisite !== undefined) ?? mine[0];
        outdated.push({
          name: m,
          current: from,
          latest: newestAllowed,
          waiting: {
            kind: "blocked",
            prerequisite:
              g?.prerequisite ??
              `group \`${g?.id ?? "?"}\` (${g?.reason ?? ""}) needs every member at ${newestAllowed}; wait for the lagging members to publish it`,
          },
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
