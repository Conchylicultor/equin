import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import {
  BoxBeatSchema,
  BoxHelloInfoSchema,
  LinkStateSchema,
} from "@plugins/apps/plugins/deploy/plugins/box-link/core";

/**
 * The row of `deploy_deployments_ext_box_link`: a deployment's link as it
 * stood at its last state CHANGE — written on a change only (never per beat),
 * read once at boot, so a restart of this computer still knows when the box
 * was last heard and what its meters said. Outside `live` that is exactly
 * what the UI shows (the value captured at the change).
 */
export const boxLinkRowShape = defineExtensionShape({
  key: "deploymentId",
  fields: {
    state: jsonField({ schema: LinkStateSchema }),
    since: dateField(),
    lastHeardAt: nullable(dateField()),
    lastBeat: nullable(jsonField({ schema: BoxBeatSchema })),
    lastError: nullable(textField()),
    hello: nullable(jsonField({ schema: BoxHelloInfoSchema })),
  },
});
