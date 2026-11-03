import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import { configTiers } from "@plugins/config_v2/core";
import type { ConfigV2Tiers } from "@plugins/config_v2/core";

// Raw gateable result — never collapse `pending` into `{}`. Callers gate.
// `scopeId` selects which scope's tiers to read (undefined = Base).
export function useTiers(
  storePath: string,
  scopeId?: string,
): ResourceResult<ConfigV2Tiers> {
  return useLive(configTiers, { path: storePath, scopeId });
}
