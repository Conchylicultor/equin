import { scopeAppId } from "../../core";
import type { ConfigDescriptor, JsonValue } from "../../core";
import {
  getScopedDescriptors,
  getDescriptorByStorePath,
  getHierarchyPath,
} from "./resource";
import {
  ensureScopeEntry,
  disposeScopeEntry,
  notifyDescriptorScopeChange,
} from "./registry";
import { buildScopeSnapshot } from "./scope-snapshot";
import { ConfigGitLayer, ConfigStore } from "./host-services";
import { documentFiles } from "./scope-paths";
import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";

// A scoped document is addressed by (storePath, scopeId) rather than read off a
// CacheEntry, because a fork writes files BEFORE the entry exists — which is
// exactly the state the store's agent-write ledger has to capture. A fork
// writes the scoped ORIGIN as well as the override, and an unfork deletes both
// and drops the scope — none of which the override alone would capture, which
// is why the ledger always records the whole trio.

// Fork ONE descriptor into a scope: snapshot its scope-effective value set into
// the scope's @app/<id> origin + override files (same content + hash → zero
// conflict at fork time), then build the scoped entry so it resolves live
// afterwards. The snapshot (scope-effective values, redacted secrets) is built
// by the shared buildScopeSnapshot helper — the exact same writer setConfig's
// fork-on-write uses, so the two paths can never drift.
async function forkDescriptor(
  descriptor: ConfigDescriptor,
  hierarchyPath: string,
  scopeId: string,
  writer: WriteOrigin,
): Promise<void> {
  const doc = {
    storePath: `${hierarchyPath}/${descriptor.name}.jsonc`,
    scopeId,
  };
  const files = documentFiles(doc);
  const store = ConfigStore.get();
  store.edit(doc, writer, "fork-descriptor-scope", () => {
    const { snapshot, hash } = buildScopeSnapshot(descriptor, scopeId);
    store.proxy(files.origin).write(snapshot as JsonValue, hash);
    store.proxy(files.override).write(snapshot as JsonValue, hash);
  });

  await ensureScopeEntry(descriptor, scopeId);
}

// Whether a scope's config is backed by a committed git override
// (config/<hier>/@app/<id>/<name>.jsonc in the repo). Such a scope must survive
// un-forking — removal drops only the user's runtime override and falls back
// to the committed scope, not to base.
function gitBacksScope(storePath: string, scopeId: string): boolean {
  const appId = scopeAppId(scopeId);
  if (!appId) return false;
  return ConfigGitLayer.get().hasScope(storePath, appId);
}

// Un-fork ONE descriptor: drop the user's runtime scoped override. For a scope
// WITHOUT a committed git backing, also remove the propagated origin, dispose the
// entry, and rmdir the now-empty @app/<id> dir — the app reverts to tracking base
// live. For a git-backed scope, KEEP the propagated origin and rebuild the entry
// so the app falls back to its committed per-app config (not global); the next
// build re-propagates that origin regardless.
async function removeDescriptor(
  descriptor: ConfigDescriptor,
  hierarchyPath: string,
  scopeId: string,
  writer: WriteOrigin,
): Promise<void> {
  const doc = {
    storePath: `${hierarchyPath}/${descriptor.name}.jsonc`,
    scopeId,
  };
  const files = documentFiles(doc);
  const store = ConfigStore.get();
  const gitBacked = gitBacksScope(doc.storePath, scopeId);
  store.edit(doc, writer, "remove-descriptor-scope", () => {
    store.remove(files.override);
    if (gitBacked) return;
    store.remove(files.origin);
    // Another descriptor may still have files in the scope: dropScope leaves
    // a scope that is not empty.
    store.dropScope(doc.storePath, scopeId);
  });

  // A git-backed scope rebuilds from origin-only (override now gone) so
  // getConfig resolves to the committed scope rather than the stale cached
  // override values; any other scope is gone.
  disposeScopeEntry(descriptor, scopeId);
  if (gitBacked) await ensureScopeEntry(descriptor, scopeId);
}

// Look up a descriptor + its hierarchyPath from a storePath, failing loudly when
// unregistered (a genuine bug, not a benign miss).
function resolveDescriptor(storePath: string): {
  descriptor: ConfigDescriptor;
  hierarchyPath: string;
} {
  const descriptor = getDescriptorByStorePath(storePath);
  if (!descriptor) throw new Error(`No descriptor for "${storePath}"`);
  const hierarchyPath = getHierarchyPath(descriptor);
  if (!hierarchyPath) {
    throw new Error(
      `[config-v2] descriptor "${descriptor.name}" has no registered hierarchy path.`,
    );
  }
  return { descriptor, hierarchyPath };
}

// Fork a SINGLE descriptor into a new scope — bootstrap a brand-new per-app
// customization for one config. After this, the scoped setConfig path works for
// every subsequent edit. Notifies the scopes + conflicts + values + tiers
// resources for this storePath/scope.
export async function forkDescriptorScope(
  storePath: string,
  scopeId: string,
  opts: { writer: WriteOrigin },
): Promise<void> {
  const { descriptor, hierarchyPath } = resolveDescriptor(storePath);
  await forkDescriptor(descriptor, hierarchyPath, scopeId, opts.writer);
  notifyDescriptorScopeChange(storePath, scopeId);
}

// Stop customizing a SINGLE descriptor for an app — the inverse of
// forkDescriptorScope. Distinct from delete-override (which only reverts edits to
// the scoped origin): this removes the scope's own config entirely (unless
// git-backed). Notifies the scopes resource for this storePath.
export async function removeDescriptorScope(
  storePath: string,
  scopeId: string,
  opts: { writer: WriteOrigin },
): Promise<void> {
  const { descriptor, hierarchyPath } = resolveDescriptor(storePath);
  await removeDescriptor(descriptor, hierarchyPath, scopeId, opts.writer);
  notifyDescriptorScopeChange(storePath, scopeId);
}

// Fork all `scope: "app"` descriptors into a new scope. Delegates each descriptor
// to forkDescriptor (which notifies the per-descriptor scopes/values resources via
// ensureScopeEntry's watcher) so the per-descriptor and scope-level paths never
// drift. Membership notify via the per-descriptor scopes resource covers the read
// side — the deleted scope-forked resource is no longer needed.
export async function forkScope(
  scopeId: string,
  opts: { writer: WriteOrigin },
): Promise<void> {
  for (const { descriptor, hierarchyPath } of getScopedDescriptors("app")) {
    await forkDescriptor(descriptor, hierarchyPath, scopeId, opts.writer);
    notifyDescriptorScopeChange(
      `${hierarchyPath}/${descriptor.name}.jsonc`,
      scopeId,
    );
  }
}

// Un-fork all `scope: "app"` descriptors. Delegates each descriptor to
// removeDescriptor and notifies its scopes/values resources so the read side
// (membership) reflects the drop immediately.
export async function deleteScope(
  scopeId: string,
  opts: { writer: WriteOrigin },
): Promise<void> {
  for (const { descriptor, hierarchyPath } of getScopedDescriptors("app")) {
    await removeDescriptor(descriptor, hierarchyPath, scopeId, opts.writer);
    notifyDescriptorScopeChange(
      `${hierarchyPath}/${descriptor.name}.jsonc`,
      scopeId,
    );
  }
}
