import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  groupProblems,
  policyProblems,
  readWorkspace,
  unrangedSpecs,
} from "@plugins/infra/plugins/deps/plugins/npm/core";
import { utcDay } from "@plugins/infra/plugins/deps/plugins/updates/core";

function verdict(problems: readonly string[], hint: string): CheckResult {
  return problems.length === 0
    ? { ok: true }
    : { ok: false, message: problems.join("\n"), hint };
}

/**
 * No exact pin, dist-tag or open range: every dependency is a `^`/`~` range (or
 * a workspace link). The lock is what fixes a version and the npm updater is
 * what moves it, so an exact spec only says "never move" — the thing this repo
 * does not allow to be said silently.
 */
const ranges: Check = {
  id: "deps-npm:ranges",
  description:
    "every package.json dependency is a ^/~ range or a workspace link — bun.lock fixes the version, the npm updater moves it",
  async run() {
    const ws = await readWorkspace(await getWorktreeRoot());
    return verdict(
      unrangedSpecs(ws.declared),
      "Write a range (`^<locked version>` keeps today's lock). Packages that must move together are a lockstep group, a release that must wait is a hold — both in the package.json's `dependencyPolicy` (plugins/infra/plugins/deps/plugins/npm/CLAUDE.md).",
    );
  },
};

/**
 * Every `dependencyPolicy` parses, names only declared packages, and every hold
 * ends within 90 days of today — a hold can be set or renewed, never set for good.
 */
const policy: Check = {
  id: "deps-npm:policy",
  description:
    "every package.json dependencyPolicy is well-formed, names declared packages, and holds no release longer than 90 days from today",
  async run() {
    const ws = await readWorkspace(await getWorktreeRoot());
    return verdict(
      policyProblems({ ...ws, today: utcDay(new Date()) }),
      "See plugins/infra/plugins/deps/plugins/npm/CLAUDE.md for the dependencyPolicy shape.",
    );
  },
};

/** Every lockstep group is ONE copy per member, agreeing on its declared part of the version. */
const groupsCoherent: Check = {
  id: "deps-npm:groups-coherent",
  description:
    "every lockstep group in a dependencyPolicy resolves in bun.lock to one copy per member, the members agreeing on the group's version part",
  async run() {
    const ws = await readWorkspace(await getWorktreeRoot());
    return verdict(
      groupProblems(ws.policies, ws.lock),
      "Move a group's members together: `./singularity deps upgrade npm --only <member>` moves the whole group.",
    );
  },
};

export default [ranges, policy, groupsCoherent];
