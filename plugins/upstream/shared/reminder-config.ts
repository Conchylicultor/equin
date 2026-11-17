import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

/**
 * Whether, and when, this clone reminds its user that a new release is out
 * (`shared/reminder.ts` decides from it). Two surfaces write it: the bell on
 * the health report's updates row (`enabled`, in every state, so the user can
 * turn reminders off before there is anything to be reminded of) and the
 * reminder notification's "Remind me later" menu (all three). Stored as
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
    snoozedUntil: dateField({
      // The epoch: never snoozed.
      default: new Date(0),
      label: "Snoozed until",
      description:
        "No update reminder before this instant — set by the reminder's Remind me later (Tomorrow / In a week / In a month).",
    }),
    skippedRelease: textField({
      default: "",
      label: "Skipped release",
      description:
        "The release tag the user chose to skip (Remind me later → Skip this release): no reminder about it. A newer release reminds again.",
    }),
  },
});
