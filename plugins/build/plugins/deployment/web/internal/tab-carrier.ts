import {
  resolved,
  unresolved,
  type Resolvable,
} from "@plugins/primitives/plugins/live-state/core";
import type { Carrier } from "../../core";

/**
 * The `tab` carrier — which bundle THIS browser tab is actually running.
 *
 * It is composed client-side and is deliberately absent from the server's
 * `deployable` list, because the server genuinely cannot know it: two tabs open
 * against one backend can be running two different bundles, and only each tab
 * can name its own. It is also not a thing a build can move — a reload is — so
 * keeping it out of `deployable` is what stops a tab nobody reloads from
 * minting builds for ever.
 *
 * Both pins come from globals the build bakes into `index.html`
 * (`compose.ts` → the graph and commit globals, which
 * `import.meta.env.VITE_BUILD_GRAPH` / `VITE_BUILD_COMMIT` compile to). Neither
 * is baked into a hashed artifact: either would churn every artifact hash on
 * every build.
 */

/**
 * A baked global has three states, and collapsing any two of them is a lie:
 *
 * - **absent** (`undefined`) — no build stamped this page at all, i.e. a dev
 *   server. This is the case `use-stale-frontend` guards with its `"dev"`
 *   sentinel, and for the same reason: an absent pin means *unknown*, and must
 *   never read as a mismatch against whatever the server reports.
 * - **empty** (`""`) — a build stamped the page but could not name the value
 *   (compose injects `""` rather than omitting the global, so a consumer reads
 *   "unknown" instead of throwing on an undeclared identifier).
 * - **a value** — the bundle can name itself.
 *
 * The first two are `unresolved`, with distinct reasons: they are different
 * facts about the world, and the reason is what a user reads on the chain.
 */
function tabPin(baked: string | undefined, what: string): Resolvable<string> {
  if (baked === undefined)
    return unresolved(`served by a dev server, which bakes in no ${what}`);
  if (baked === "")
    return unresolved(
      `the build that produced this bundle could not name its ${what}`,
    );
  return resolved(baked);
}

function readTabCarrier(): Carrier {
  const bakedCommit: string | undefined = import.meta.env.VITE_BUILD_COMMIT;
  const bakedGraph: string | undefined = import.meta.env.VITE_BUILD_GRAPH;
  return {
    id: "tab",
    commit: tabPin(bakedCommit, "commit"),
    graph: tabPin(bakedGraph, "graph"),
    // Ancestry is git's answer, and there is no git in a browser. Unresolved is
    // the honest value rather than a guess — and it is inert either way, since
    // the tab never enters `convergenceOf` (it is not a deployable carrier).
    ancestorOfTarget: unresolved(
      "only the server can place a commit in this checkout's history",
    ),
  };
}

// The globals are fixed for the lifetime of the page — a tab cannot start
// running different bytes without a reload — so this is read once and cached.
// Lazily, not at module eval, so importing this module never depends on the
// inline script in `<head>` having run.
let cached: Carrier | null = null;

/** This tab's own pin, as a `Carrier` alongside the server's two. */
export function tabCarrier(): Carrier {
  return (cached ??= readTabCarrier());
}
