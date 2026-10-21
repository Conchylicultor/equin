import { computeHash } from "../../core";
import type { ConfigDescriptor, JsonValue } from "../../core";
import { ConfigStore } from "./host-services";
import { getConfig } from "./registry";
import { hasFieldStorageProvider } from "./field-storage-providers";

// THE single snapshot-origin writer shared by scope-fork (forkDescriptor) and
// registry (setConfig fork-on-write), so the two paths can never drift. It
// snapshots the descriptor's SCOPE-effective value set (for a fresh scope this
// resolves to base — preserving any committed git scope for the app instead of
// resetting it to global), stripping provider-backed (secret) fields — we never
// write redacted secret values into JSONC.
//
// Import direction: this module imports getConfig from ./registry, and
// registry.ts imports buildScopeSnapshot from here. That is a module-level
// cycle at the *type/value* level, but it is cycle-SAFE at runtime because
// buildScopeSnapshot is only ever *called* (never invoked at module-eval time):
// by the time either function runs, both modules are fully initialized. ESM
// resolves the bindings lazily for call sites, so no temporal-dead-zone hazard
// exists here. scope-fork.ts (which already imports from ./registry) likewise
// imports from here.
//
// Returns the redacted snapshot and its content hash so callers can write origin
// only (setConfig) or origin + override (forkDescriptor) from the exact same
// bytes + hash.
export function buildScopeSnapshot(
  descriptor: ConfigDescriptor,
  scopeId: string,
): { snapshot: Record<string, unknown>; hash: string } {
  const resolved = getConfig(descriptor, scopeId) as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(descriptor.fields)) {
    if (hasFieldStorageProvider(field.type.id)) continue;
    snapshot[key] = resolved[key];
  }

  const hash = computeHash(snapshot as JsonValue);
  return { snapshot, hash };
}

// Write ONLY the scoped origin (`<name>.origin.jsonc`) from the shared snapshot.
// Used by setConfig fork-on-write, where the override is then written by the
// normal setConfig path (reading this origin as its base). forkDescriptor writes
// both origin AND override and so calls buildScopeSnapshot directly.
export function writeScopedOriginSnapshot(
  descriptor: ConfigDescriptor,
  storePath: string,
  scopeId: string,
): void {
  const { snapshot, hash } = buildScopeSnapshot(descriptor, scopeId);
  ConfigStore.get()
    .proxy({ storePath, scopeId, file: "origin" })
    .write(snapshot as JsonValue, hash);
}
