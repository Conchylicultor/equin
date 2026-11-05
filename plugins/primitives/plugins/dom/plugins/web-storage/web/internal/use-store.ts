import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";
import {
  storageScope,
  type ScopedStore,
  type Store,
  type StorageScope,
} from "./store";

/**
 * The storage scope of where this renders: the innermost `PluginScope`'s
 * composition, or the page's own deploy outside every scope. The only way to
 * mint a `StorageScope` — for an imperative caller that binds a scoped store
 * later (`store.in(scope)`, in an event handler).
 */
export function useStorageScope(): StorageScope {
  const id = usePluginScopeId();
  return storageScope(id);
}

/**
 * `store`, bound to the storage scope of where this renders
 * (`useStorageScope`). A `pageWide` store is its own handle, handed back — so
 * a primitive over stores (`useDraft`) takes either kind.
 */
export function useStore<T>(store: ScopedStore<T> | Store<T>): Store<T> {
  const scope = useStorageScope();
  return "in" in store ? store.in(scope) : store;
}
