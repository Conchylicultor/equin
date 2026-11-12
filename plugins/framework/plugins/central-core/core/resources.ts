import { createResourceRuntime } from "@plugins/network/plugins/live/plugins/resource-runtime/core";
import type {
  Resource as RtResource,
  ExternalResource as RtExternalResource,
  ResourceDefinition as RtDef,
  ResourceMode as RtMode,
  ResourceParams as RtParams,
  DependsOnEntry as RtDep,
} from "@plugins/network/plugins/live/plugins/resource-runtime/core";

// Live-state primitive — central side. This is now a thin instantiation of the
// shared runtime (@plugins/network/plugins/live/plugins/resource-runtime/core), not a
// hand-maintained mirror of server-core. central instantiates the runtime with
// no hooks (console.error-only on failure, no profiler, no declare-based debug
// owners), and re-presents the runtime types as central-core's public surface.
// See research/2026-06-08-global-unify-live-state-resource-runtime.md.
//
// Browsers reach this side via /ws/central-notifications (gateway routes the
// path to central regardless of host) and the /api/central-resources/:key
// HTTP fallback.

// Re-present the runtime types as central-core's stable public surface. central's
// ResourceMode is now the full superset (incl. "keyed") — kept dormant; central's
// lone auth-state resource uses none of the keyed/scoped/batch machinery.
export type ResourceParams = RtParams;
export type ResourceMode = RtMode;
export type Resource<T, P extends ResourceParams = ResourceParams> = RtResource<
  T,
  P
>;
export type ExternalResource<
  T,
  P extends ResourceParams = ResourceParams,
> = RtExternalResource<T, P>;
export type ResourceDefinition<
  T,
  P extends ResourceParams = ResourceParams,
> = RtDef<T, P>;
export type DependsOnEntry<P extends ResourceParams = ResourceParams> =
  RtDep<P>;

// Native wyhash for keyed snapshots, as the server (the runtime's portable
// default is plain-JS `hash64`).
// Central's code build — what shapes every value it serves, named on its ack
// frames and read envelopes as `graph` (`ResourceRuntimeOptions.serverBuildGraph`)
// so a tab whose schema rejects a central value judges it by build: another
// build is skew (the tab is out of date), the same build a real bug. Central
// serves worktrees on many builds, so this is central's OWN code — the source
// digest of its entry closure — and a tab compares it against the central
// build its bundle was built against, never its web graph. Boot-injected by
// `build/central-build-id` (central-core imports no build plugin — the
// server's `setClientBuildIdentity` pattern). Unknown (`null`) until injected →
// every verdict `unknown` → a decode failure stays loud.
let centralBuildIdentity: () => string | null = () => null;
export function setCentralBuildIdentity(fn: () => string | null): void {
  centralBuildIdentity = fn;
}

const runtime = createResourceRuntime({
  snapHash: (json) => Bun.hash.wyhash(json) ^ BigInt(json.length),
  // Read at call time (see `setCentralBuildIdentity`).
  serverBuildGraph: () => centralBuildIdentity(),
});
export const {
  defineResource,
  defineExternalResource,
  handleResourceHttp,
  notificationsWsHandler,
} = runtime;
// withNotifyBatch is available from the runtime but central need not export it.
