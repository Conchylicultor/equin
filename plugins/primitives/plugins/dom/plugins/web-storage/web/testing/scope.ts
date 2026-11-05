import { storageScope, type StorageScope } from "../internal/store";

/**
 * The storage scope a component would read with `useStorageScope()` — `null`
 * for the page's own, a composition id for a `PluginScope` — for a test that
 * reads or writes a scoped store outside React.
 */
export function storageScopeOf(id: string | null): StorageScope {
  return storageScope(id);
}
