import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { clientFields } from "@plugins/network/plugins/live/core";
import { deployments } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { RELEASE_STATE_OPTIONS, type ReleaseState } from "./release-state";

const RELEASE_STATES = RELEASE_STATE_OPTIONS.map((o) => o.value) as [
  ReleaseState,
  ...ReleaseState[],
];

/**
 * The deployments list's `Release` column: what `ship` would pick for each
 * row's (composition, platform), probed live in the browser (`ClientFields.Resolve`
 * in this plugin's web half). An enum, so the filter chip and group-by come
 * with it.
 */
export const releaseFields = clientFields(deployments, "release", {
  fields: {
    release: enumTextField(RELEASE_STATES, {
      label: "Release",
      options: Object.fromEntries(
        RELEASE_STATE_OPTIONS.map((o) => [o.value, { label: o.label }]),
      ) as Record<ReleaseState, { label: string }>,
    }),
  },
});
