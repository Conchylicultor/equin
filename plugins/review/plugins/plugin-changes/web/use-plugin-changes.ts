import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { pluginChanges, pushPluginChanges } from "../shared/resources";
import type { PluginChangesResponse } from "../core";

export type PluginChangesResult =
  | { data: undefined; isPending: true; error: Error | null }
  | {
      data: PluginChangesResponse | undefined;
      isPending: false;
      error: Error | null;
    };

// A failed read is settled, not pending: it carries its error (and no data),
// so the list renders the failure instead of loading forever. Ready carries
// no `error` — it is structurally null there.
function foldPluginChanges(
  result: ResourceResult<PluginChangesResponse, string>,
): PluginChangesResult {
  return foldResource<
    ResourceResult<PluginChangesResponse, string>,
    PluginChangesResult
  >(result, {
    loading: () => ({ data: undefined, isPending: true, error: null }),
    error: (error) => ({ data: undefined, isPending: false, error }),
    ready: (data) => ({ data, isPending: false, error: null }),
  });
}

export function useWorktreePluginChanges(
  conversationId: string,
): PluginChangesResult {
  return foldPluginChanges(useLive(pluginChanges, { conversationId }));
}

/** One push's plugin changes, by its id. */
export function usePushPluginChanges(pushId: string): PluginChangesResult {
  return foldPluginChanges(useLive(pushPluginChanges, { pushId }));
}
