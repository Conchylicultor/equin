import { liveValue } from "@plugins/network/plugins/live/core";
import { DeploymentStateSchema } from "./model";

/**
 * The one description of what is deployed: this checkout's HEAD, and where each
 * deployable carrier stands relative to it. Both the Build button's chain and
 * the auto-build decision read it, so a wrong badge and a missed rebuild are the
 * same bug.
 *
 * preloaded because it replaces two resources that were
 * (`build.mainAheadCount` and `build.frontendHash`): the Build button's chain
 * and the stale-tab reload dot are both first-paint chrome.
 *
 * A scalar `push` resource, explicitly exempt from the membership-bounded rule
 * for DB-backed collections — see
 * `research/2026-07-18-global-bounded-working-set-resource-contract.md:225`,
 * which names `mainAheadCount` (this resource's direct ancestor) as the
 * precedent for "schema-bounded scalar push ticks". Its value is one degenerate
 * row: two carriers, and a commit chain bounded by how far a checkout can drift
 * between two builds. There is no collection to window here, so do not "fix"
 * this into a windowed resource.
 *
 * No placeholder: before the first load the server has not vouched for
 * anything, and that is `pending` — never a fabricated state. Preloaded, so a
 * tab normally never sees it.
 */
export const deployment = liveValue("build.deployment", {
  schema: DeploymentStateSchema,
  preload: "boot",
  // Read with git from this checkout and its served dist.
  needsMachine: { feature: "Reading what is deployed" },
});
