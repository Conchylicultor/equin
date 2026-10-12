import { useEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { pluginChanges } from "../shared/resources";
import { getPluginChanges } from "../core";
import type { PluginChangesResponse } from "../core";

export type PluginChangesResult =
  | { data: undefined; isPending: true; error: Error | null }
  | {
      data: PluginChangesResponse | undefined;
      isPending: false;
      error: Error | null;
    };

export function useWorktreePluginChanges(
  conversationId: string,
): PluginChangesResult {
  // A failed read is settled, not pending: it carries its error (and no data),
  // so the list renders the failure instead of loading forever. Ready carries
  // no `error` — it is structurally null there.
  return foldResource<
    ResourceResult<PluginChangesResponse>,
    PluginChangesResult
  >(useLive(pluginChanges, { conversationId }), {
    loading: () => ({ data: undefined, isPending: true, error: null }),
    error: (error) => ({ data: undefined, isPending: false, error }),
    ready: (data) => ({ data, isPending: false, error: null }),
  });
}

export function usePushPluginChanges(pushId: string): PluginChangesResult {
  const { data, isPending, error } = useEndpoint(
    getPluginChanges,
    {},
    { query: { pushId } },
  );
  if (isPending) return { data: undefined, isPending: true, error };
  return { data, isPending: false, error };
}
