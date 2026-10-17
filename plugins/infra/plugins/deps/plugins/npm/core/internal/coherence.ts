// The invariants the `deps-npm:*` checks hold, as pure functions over the
// workspace read: specs are ranges, policies are well-formed and bounded, and
// every lockstep group resolves to versions its members agree on.

import { holdProblems } from "@plugins/infra/plugins/deps/plugins/updates/core";
import type { Agree } from "./policy";
import { versionParts } from "./spec";
import type { Declared, DeclaredPolicy, Lock, PolicyError } from "./workspace";

/** Every declared spec that is not a `^`/`~` range or a workspace link. */
export function unrangedSpecs(declared: readonly Declared[]): string[] {
  return declared
    .filter((d) => d.spec.kind === "exact" || d.spec.kind === "other")
    .map(
      (d) =>
        `${d.manifest}: ${d.section}.${d.name} is "${d.raw}"` +
        (d.spec.kind === "exact" ? ` — write "^${d.raw}"` : ""),
    );
}

/**
 * Policy problems: unparsable policies, a hold set past its bound
 * (`holdProblems`), a group or hold naming a package nothing declares, two groups
 * with one id.
 */
export function policyProblems(args: {
  policies: readonly DeclaredPolicy[];
  policyErrors: readonly PolicyError[];
  declared: readonly Declared[];
  today: string;
}): string[] {
  const { policies, policyErrors, declared, today } = args;
  const names = new Set(declared.map((d) => d.name));
  const problems = policyErrors.map(
    (e) => `${e.manifest}: dependencyPolicy does not parse — ${e.message}`,
  );
  const ids = new Map<string, string>();
  for (const { manifest, policy } of policies) {
    for (const g of policy.groups ?? []) {
      const seen = ids.get(g.id);
      if (seen !== undefined)
        problems.push(
          `${manifest}: group "${g.id}" is also declared in ${seen}`,
        );
      ids.set(g.id, manifest);
      for (const m of g.members)
        if (!names.has(m))
          problems.push(
            `${manifest}: group "${g.id}" names ${m}, which no package.json declares`,
          );
    }
    problems.push(...holdProblems(policy.holds ?? [], today, manifest));
    for (const h of policy.holds ?? []) {
      for (const p of h.names)
        if (!names.has(p))
          problems.push(
            `${manifest}: a hold names ${p}, which no package.json declares`,
          );
    }
  }
  return problems;
}

function key(version: string, agree: Agree): string {
  const [major, minor] = versionParts(version);
  return agree === "version"
    ? version
    : agree === "major.minor"
      ? `${major}.${minor}`
      : `${major}`;
}

/**
 * Lockstep-group violations in the lock: a member installed as two copies, or
 * members whose versions disagree on the group's `agree` part.
 */
export function groupProblems(
  policies: readonly DeclaredPolicy[],
  lock: Lock,
): string[] {
  const problems: string[] = [];
  for (const { manifest, policy } of policies) {
    for (const g of policy.groups ?? []) {
      const versions = new Map<string, string>();
      for (const m of g.members) {
        const copies = [...lock.copies(m)];
        if (copies.length > 1)
          problems.push(
            `group "${g.id}" (${manifest}): ${m} is locked at ${copies.length} versions (${copies.join(", ")}) — one copy only`,
          );
        if (copies.length > 0) versions.set(m, copies[0]!);
      }
      const keys = new Set([...versions.values()].map((v) => key(v, g.agree)));
      if (keys.size > 1)
        problems.push(
          `group "${g.id}" (${manifest}) must agree on ${g.agree}: ${[...versions].map(([m, v]) => `${m}@${v}`).join(", ")}`,
        );
    }
  }
  return problems;
}
