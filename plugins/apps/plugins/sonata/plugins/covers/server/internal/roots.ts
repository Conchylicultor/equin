import { defineFileRoot } from "@plugins/infra/plugins/paths/plugins/data-files/server";

/**
 * Rendered covers, over the host-global `cache/sonata-covers` dir: the
 * computer's disk on the desktop (bound by this plugin's `machine/`), memory
 * in a browser host.
 */
export const scoreCoverFiles = defineFileRoot({
  id: "apps.sonata.covers",
  dir: "cache/sonata-covers",
});
