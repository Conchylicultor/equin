import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  groupProblems,
  policyProblems,
  readWorkspace,
  unrangedSpecs,
  wrappersUndeclared,
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
  wholeTreeRead: {
    kind: "debt",
    task: "task-1794579727-rjy6wx",
    reason: "reads every package.json (1.8k)",
  },
  description:
    "every package.json dependency is a ^/~ range or a workspace link — bun.lock fixes the version, the npm updater moves it",
  async run(ctx: CheckContext) {
    const ws = await readWorkspace(await ctx.repo());
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
  wholeTreeRead: {
    kind: "debt",
    task: "task-1794579727-rjy6wx",
    reason: "reads every package.json (1.8k)",
  },
  description:
    "every package.json dependencyPolicy is well-formed, names declared packages, and holds no release longer than 90 days from today",
  async run(ctx: CheckContext) {
    const ws = await readWorkspace(await ctx.repo());
    return verdict(
      policyProblems({ ...ws, today: utcDay(new Date()) }),
      "See plugins/infra/plugins/deps/plugins/npm/CLAUDE.md for the dependencyPolicy shape.",
    );
  },
};

/** Every lockstep group is ONE copy per member, agreeing on its declared part of the version. */
const groupsCoherent: Check = {
  id: "deps-npm:groups-coherent",
  wholeTreeRead: {
    kind: "debt",
    task: "task-1794579727-rjy6wx",
    reason: "reads every package.json (1.8k)",
  },
  description:
    "every lockstep group in a dependencyPolicy resolves in bun.lock to one copy per member, the members agreeing on the group's version part",
  async run(ctx: CheckContext) {
    const ws = await readWorkspace(await ctx.repo());
    return verdict(
      groupProblems(ws.policies, ws.lock),
      "Move a group's members together: `./equin deps upgrade npm --only <member>` moves the whole group.",
    );
  },
};

/**
 * Every package in a scope we publish (root `dependencyPolicy.ownScopes`)
 * belongs to a group that declares the upstream it `wraps` — the registry never
 * shows an upstream release we have not wrapped yet, so only that declaration
 * lets detection ask for the publish.
 */
const wrappersDeclared: Check = {
  id: "deps-npm:wrappers-declared",
  wholeTreeRead: {
    kind: "debt",
    task: "task-1794579727-rjy6wx",
    reason: "reads every package.json (1.8k)",
  },
  description:
    "every dependency in a scope we publish belongs to a dependencyPolicy group declaring the upstream it wraps",
  async run(ctx: CheckContext) {
    const ws = await readWorkspace(await ctx.repo());
    return verdict(
      wrappersUndeclared(ws.policies, ws.declared),
      "Add `wraps` (the upstream's release tags and the publish prerequisite) to the package's lockstep group — plugins/infra/plugins/deps/plugins/npm/CLAUDE.md.",
    );
  },
};

export default [ranges, policy, groupsCoherent, wrappersDeclared];
