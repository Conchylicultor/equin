import type { ViewTypeMeta } from "../../core";
import type { ResolvedViewInstance } from "./resolve-instances";

/**
 * Which view instance is active: the one the URL names, else the persisted
 * device-local selection, else the caller's default, else the first authored
 * one. Each candidate counts only when it names an AUTHORED instance — a stale
 * link or a deleted view falls through to the next, never to an empty surface.
 *
 * `pinned` short-circuits all of them. A pinned host shows one named instance
 * and is deliberately NOT part of the surface's shared selection, so neither
 * the URL, the persisted id nor the default may reach it.
 *
 * **A pinned id that is not authored resolves to the empty string, and the host
 * must render that as "this instance is not authored".** Falling back to
 * another instance is the failure this exists to prevent: a mis-pinned host
 * silently renders someone else's tab, which looks like a working list and is a
 * different list. That claim is only true if the host does not re-add a
 * fallback of its own — see `DataViewShellFrame`, and the suite beside this file.
 *
 * Its own module (rather than a local function in `use-view-model.ts`) so it can
 * be tested without a DOM: `useActiveViewId` reaches Web Storage at module eval.
 */
export function resolveActiveId<T extends ViewTypeMeta>(
  instances: ResolvedViewInstance<T>[],
  candidates: {
    fromUrl: string | undefined;
    persisted: string | null;
    defaultView: string | undefined;
    pinned: string | undefined;
  },
): string {
  const { fromUrl, persisted, defaultView, pinned } = candidates;
  if (pinned !== undefined) {
    return instances.find((r) => r.instance.id === pinned)?.instance.id ?? "";
  }
  for (const id of [fromUrl, persisted, defaultView]) {
    const found = instances.find((r) => r.instance.id === id);
    if (found) return found.instance.id;
  }
  return instances[0]?.instance.id ?? "";
}
