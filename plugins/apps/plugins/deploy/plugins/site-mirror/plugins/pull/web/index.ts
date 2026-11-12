import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { MirrorFreshness } from "./components/mirror-freshness";

export default {
  description:
    "MirrorFreshness({ deploymentId, setId, subject }): how fresh this computer's copy of a deployed site's mirrored set is — Synced N ago with Sync now, Copying… / Reconciling… while a pass runs, a failed pull in host-query's failure vocabulary (a site whose release predates the set: redeploy it) above the still-readable older data — asking for a pull on open when the copy is a few minutes old or missing.",
  contributions: [],
} satisfies PluginDefinition;
