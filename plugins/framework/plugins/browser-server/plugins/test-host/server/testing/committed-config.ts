import type { ServerContribution } from "@plugins/framework/plugins/server-core/core";
import { diskConfigGitLayer } from "@plugins/config_v2/server/testing";

/**
 * The committed config layer, read off disk — what the bundled layer
 * (`config_v2/bundled-layer`) inlines with `import.meta.glob`. Imported lazily
 * by `portable-host.ts`: loading config_v2 declares its host services, which a
 * graph without config_v2 would then have to provide.
 */
export function committedConfig(): ServerContribution {
  return diskConfigGitLayer();
}
