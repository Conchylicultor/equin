import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

/**
 * Whether this clone reminds its user that a new release is out. The bell on
 * the health report's updates row writes it (in every state, so the user can
 * turn reminders off before there is anything to be reminded of). Stored as
 * `config/upstream/reminders.jsonc`.
 */
export const upstreamReminderConfig = defineConfig({
  name: "reminders",
  fields: {
    enabled: boolField({
      default: true,
      label: "Update reminders",
      description: `Remind me when a new ${PRODUCT_NAME} release is out. The bell on the health report's update row turns this on and off.`,
    }),
  },
});
