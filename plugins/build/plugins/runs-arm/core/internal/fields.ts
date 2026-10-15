import { z } from "zod";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { liveArm } from "@plugins/network/plugins/live/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  BUILD_STATUS_OPTIONS_META,
  type BuildStatus,
} from "@plugins/build/plugins/build-status/core";
import { BUILD_RUN_KIND } from "@plugins/build/plugins/run-ledger/core";
import { runs } from "@plugins/runs/core";

/**
 * The six build statuses, as a schema. A `Record`-checked list rather than a
 * free `z.enum`: a seventh `BuildStatus` fails to compile here.
 */
const BUILD_STATUS_VALUES = {
  running: true,
  success: true,
  superseded: true,
  interrupted: true,
  killed: true,
  failed: true,
} satisfies Record<BuildStatus, true>;

const BUILD_STATUSES = Object.keys(BUILD_STATUS_VALUES) as [
  BuildStatus,
  ...BuildStatus[],
];

export const BuildStatusSchema: ZodParser<BuildStatus> = z.enum(BUILD_STATUSES);

/**
 * The fields only a build row has — its slice of the `runs` union
 * (`$columns.build`), ids and wire names `build.<field>`, listed under the
 * "Build" band of every list of the union.
 *
 * `status` is the whole point of the arm. The shared `outcome` axis
 * deliberately collapses `superseded` / `interrupted` / `killed` into one
 * `canceled`, because those three distinctions are not true of every kind of
 * run — but they are exactly the distinctions a person reading a build list
 * needs. Keeping the six-way taxonomy as an arm field is how precision
 * survives the collapse: filter `outcome is canceled` across every ledger, then
 * `build.status is superseded` when the question is about builds.
 *
 * `targets` is a list: one build carries N target chips, and filtering
 * "contains sonata" means one chip of the list, not a substring of a joined
 * string.
 *
 * `exitCode` is the one fact that separates two builds sharing a status, and
 * what makes drift between `buildStatusOf` and the SQL `CASE` observable from
 * the surface itself.
 */
export const buildRunArm = liveArm(runs, BUILD_RUN_KIND, {
  label: "Build",
  // First: the merged run surface's primary hosts ARE the build popover and
  // /debug/build (`runs` core, "Arm order").
  order: 10,
  fields: {
    status: enumTextField(BUILD_STATUSES, {
      label: "Build status",
      options: BUILD_STATUS_OPTIONS_META,
    }),
    targets: stringListField({ label: "Targets" }),
    commitHash: nullable(textField({ label: "Commit" })),
    exitCode: nullable(intField({ label: "Exit code" })),
  },
  sortable: ["status", "exitCode"],
});
