import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { createSignedMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import {
  resolved,
  unresolved,
  type Resolvable,
} from "@plugins/primitives/plugins/live-state/core";
import { tryRunGit } from "@plugins/primitives/plugins/commit-list/server";
import { chainTo, isAncestor, readTarget } from "./git-chain";
import {
  getServerCommit,
  getServerGraphHash,
} from "@plugins/build/plugins/server-build-id/server";
import {
  convergenceOf,
  deploymentOf,
  NO_CHAIN,
  type Carrier,
  type Deployment,
  type DeploymentState,
} from "../../core";
import { serverPin } from "./server-pin";

/** Attach the ancestry fact to a carrier whose pin has just been read. */
async function withAncestry(
  carrier: Omit<Carrier, "ancestorOfTarget">,
  target: Resolvable<string>,
): Promise<Carrier> {
  if (!target.resolved)
    return { ...carrier, ancestorOfTarget: unresolved("no target") };
  if (!carrier.commit.resolved)
    return {
      ...carrier,
      ancestorOfTarget: unresolved(carrier.commit.reason),
    };
  return {
    ...carrier,
    ancestorOfTarget: await isAncestor(carrier.commit.value, target.value),
  };
}

/**
 * The raw facts: where this checkout's HEAD is, and where each DEPLOYABLE
 * carrier — the backend process and the frontend bundle it serves — stands
 * relative to it. The `tab` carrier is deliberately absent: only a browser can
 * report which bundle it is running, and only a reload can move it.
 */
async function readCarriers(): Promise<Deployment> {
  const target = await readTarget();

  const distCommit = getServerCommit();
  const distGraph = getServerGraphHash();

  const [server, web] = await Promise.all([
    withAncestry(
      {
        id: "server",
        commit: serverPin(),
        // Not a failure: a server process carries no web module graph, so the
        // determinate answer is "there is nothing to determine".
        graph: unresolved("a backend process carries no web graph"),
      },
      target,
    ),
    withAncestry(
      {
        id: "web",
        commit:
          distCommit === null
            ? unresolved("the served dist carries no .build-commit")
            : resolved(distCommit),
        graph:
          distGraph === null
            ? unresolved("the served dist carries no .build-graph")
            : resolved(distGraph),
      },
      target,
    ),
  ]);

  return { target, deployable: [server, web] };
}

/**
 * Among the deployable pins, the one furthest back. On a `behind` deployment
 * every pin is an ancestor of the same target, so they are totally ordered and
 * one `merge-base --is-ancestor` per extra pin settles it. If two pins turn out
 * not to be comparable the first is kept — the deployment is already `diverged`
 * in that case and this chain is not what gets rendered.
 */
async function oldestPin(shas: string[]): Promise<string | null> {
  let oldest = shas[0] ?? null;
  if (oldest === null) return null;
  for (const sha of shas.slice(1)) {
    const result = await tryRunGit(
      ["merge-base", "--is-ancestor", sha, oldest],
      REPO_ROOT,
    );
    if (result.ok) oldest = sha;
  }
  return oldest;
}

/**
 * The wire payload: `readDeployment`'s facts, plus the one derived answer and
 * the evidence that answer's arm carries. The `kind` IS `convergenceOf`'s
 * verdict, so the badge a user sees and the decision the reconciler makes are
 * the same function of the same state.
 *
 * The expensive half — up to three `merge-base --is-ancestor` probes and a
 * `git log` walk capped at `CHAIN_CAP`. Always reached through the memo below,
 * never called directly.
 */
async function computeDeploymentState(): Promise<DeploymentState> {
  const deployment = await readCarriers();
  const { deployable } = deployment;
  const kind = convergenceOf(deployment);

  if (kind === "unknown" || !deployment.target.resolved) {
    return {
      kind: "unknown",
      reason: deployment.target.resolved
        ? "no deployable carrier"
        : deployment.target.reason,
      deployable,
    };
  }

  const target = deployment.target.value;
  // No line to draw: a carrier is off the way to the target entirely, so there
  // is no range whose walk would mean anything.
  if (kind === "diverged") return { kind, target, deployable };

  // Converged walks `target..target` — one row, for HEAD. It would be cheaper to
  // send the bare sha and let the client draw a row for it, and that is exactly
  // what used to happen: a second row renderer, a second copy of "which carrier
  // sits where", and the two drifted. One `git log -1` per recompute buys one
  // rendering path.
  if (kind === "converged")
    return { kind, target, deployable, chain: await chainTo(target, target) };

  const pins = deployable.flatMap((c) =>
    c.commit.resolved ? [c.commit.value] : [],
  );
  const base = await oldestPin(pins);
  return {
    kind: "behind",
    target,
    deployable,
    // No readable pin at all (a fresh checkout with no dist, or a mixed boot on
    // both carriers) means there is no commit to draw a line FROM — behind is
    // still the right verdict, but there is no walk to make.
    chain: base === null ? NO_CHAIN : await chainTo(base, target),
  };
}

/**
 * The cheap, ungated signature: the four inputs the whole answer is a function
 * of. One `git rev-parse` plus a module constant and two tiny dotfile reads —
 * the ~sub-millisecond probe `createGitStateMemo` asks for.
 *
 * It is a conservative over-approximation by construction, because it is not an
 * approximation at all: `computeDeploymentState` reads exactly these four values
 * and nothing else (the ancestry probes and the log walk are pure functions of
 * the target and the pins over immutable history). An unresolved input is folded
 * in by its REASON, so "no checkout" and "mixed boot" are distinct signatures —
 * a pin that changes only its reason still invalidates.
 */
async function deploymentSignature(): Promise<string> {
  const target = await readTarget();
  const pin = serverPin();
  return [
    target.resolved ? target.value : `!${target.reason}`,
    pin.resolved ? pin.value : `!${pin.reason}`,
    getServerCommit() ?? "!no-commit",
    getServerGraphHash() ?? "!no-graph",
  ].join("\0");
}

/**
 * `refHeadServed` fires in EVERY backend on every advance of a ref it tracks,
 * and `refs/heads/main` is tracked everywhere — so on this host a single push to
 * main wakes this loader in 100+ worktree backends at once. In all but one of
 * them the target is that worktree's OWN branch, which did not move, so the
 * signature is unchanged and the recompute collapses to the one `rev-parse` the
 * probe already costs. That is what makes the fan-out affordable: the resource
 * this replaced ran a full `git log` in every one of those backends.
 *
 * Deliberately NOT behind `withHeavyReadSlot`. Post-memo the compute runs at
 * most once per distinct (target, pins) tuple per backend — i.e. once per build
 * or per advance of this checkout's own branch — and its body is two
 * `merge-base` probes plus a log walk bounded by how far a checkout drifts
 * between builds (single digits). `host-read-pool` deliberately leaves cheap
 * interactive git ungated, and this is on the path that paints the Build button.
 *
 * `signature` also feeds the resource's `revalidate`, which is the point of
 * `createSignedMemo`: bound together at construction, the ETag and the loader
 * cannot come to disagree about what "current" means.
 */
const deploymentMemo = createSignedMemo<DeploymentState>({
  name: "build:deployment",
  signature: deploymentSignature,
  compute: computeDeploymentState,
});

// One backend serves exactly one namespace, so the memo holds a single entry.
// It is still keyed (rather than a bare module variable) because that is what
// buys the per-key single-flight: the boot snapshot, a subscriber's first read
// and a post-build notify can land together, and only one of them does the git
// work.
const MEMO_KEY = runtimeNamespace();

/** The bound signature probe, for the resource's `revalidate`. */
export function deploymentEtag(): Promise<string> {
  return deploymentMemo.signature(MEMO_KEY);
}

/** The wire payload, memoized. Feeds the resource loader. */
export function readDeploymentState(): Promise<DeploymentState> {
  return deploymentMemo.get(MEMO_KEY);
}

/**
 * The raw facts, for the reconciler — which passes them straight to
 * `wantsBuild`. Projected back out of the same memoized state the resource
 * serves, so the decision and the badge are literally one read: the reconciler
 * pays no git at all when nothing has moved since the last recompute.
 *
 * Takes no baseline and remembers nothing across calls — that is the whole
 * point: a build that kills this process cannot lose a request that was never
 * held anywhere.
 */
export async function readDeployment(): Promise<Deployment> {
  return deploymentOf(await readDeploymentState());
}
