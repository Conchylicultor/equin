import type { FieldOptionMeta } from "@plugins/fields/core";
import type { BuildStatus } from "./build-status";

/**
 * How each build status reads — its label and chip tint — as data, so a field
 * declared in core (the build arm of the runs union) and the web chips
 * (`BUILD_STATUS_META`) share one spelling of it.
 *
 * Colour carries the one distinction that matters: `failed` is destructive
 * because it is the only status a human must act on. `superseded`,
 * `interrupted` and `killed` are muted — none of them is a code defect, so none
 * of them should draw the eye the way a real failure must.
 *
 * Declaration order is the order a filter dropdown offers.
 */
export const BUILD_STATUS_OPTIONS_META = {
  running: { label: "Running", variant: "warning" },
  success: { label: "Success", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  superseded: { label: "Superseded", variant: "muted" },
  interrupted: { label: "Interrupted", variant: "muted" },
  killed: { label: "Killed externally", variant: "muted" },
} as const satisfies Record<BuildStatus, FieldOptionMeta>;
