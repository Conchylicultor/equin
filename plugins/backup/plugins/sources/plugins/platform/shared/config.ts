import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

/** The source's id, kept: backup run rows and archive layouts carry it. */
export const PLATFORM_SOURCE_ID = LEGACY_IDS.backupPlatformSource;

export const platformSourceConfig = defineConfig({
  fields: {
    enabled: boolField({
      default: true,
      label: "Back up equin platform files",
    }),
  },
});
