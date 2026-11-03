import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { mapResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import { configScopes } from "@plugins/config_v2/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";
import { useStorePath } from "./use-store-path";

// Whether the given scope has its OWN config for this descriptor — a committed
// git scope, a runtime fork, OR a plain scoped write. This is the single
// membership signal `useConfig` keys off (`configScopes`, one global map,
// recomputed server-side from `scopeHasOwnConfig`), so read and theme share one
// source of truth and can never disagree.
//
// `loading` while the map is not known: a scope's membership decides which
// document a surface edits, so "not a member" is not a stand-in for "unknown".
// The map is preloaded and kept (`"boot-and-keep"`), so after a successful boot
// it is settled on the first frame, whenever the reader mounts. A `scopeId` of
// `undefined` (base/global) is never "a member of itself": settled `false` once
// the map is known.
export function useScopeMembership<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  scopeId?: string,
): ResourceResult<boolean> {
  const path = useStorePath(descriptor);
  const scopes = useLive(configScopes);
  return useMemo(
    () =>
      mapResource(
        scopes,
        (map) => scopeId !== undefined && (map[path] ?? []).includes(scopeId),
      ),
    [scopes, path, scopeId],
  );
}
