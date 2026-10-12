import { defineFacet } from "@plugins/plugin-meta/plugins/facets/core";
import type { ResourceMembership } from "@plugins/framework/plugins/tooling/plugins/resource-vocabulary/core";

export interface ResourceDef {
  key: string;
  mode: string;
  /**
   * The bounded working-set membership the resource's descriptor declares —
   * `"window"` (ordered `LIMIT`) or `"point"` (explicit id set) — absent for a
   * global or legacy-unbounded one.
   *
   * Worth its own field rather than folding into `mode`: a window and a point
   * resource are both `mode: "keyed"` at runtime, so without this the docs
   * cannot tell a bounded resource from the legacy unbounded keyed form that
   * `query-resource/CLAUDE.md` says not to copy. See
   * `research/2026-07-18-global-bounded-working-set-resource-contract.md`.
   */
  membership?: ResourceMembership;
  /**
   * Where a `serveValue`'s truth lives — `"db"` (change-feed driven) or
   * `"external"` (hand-notified). Absent for every other register call.
   */
  source?: "db" | "external";
  /**
   * The recorded reason a Postgres-backed, collection-shaped `serveValue` is not
   * a `liveCollection` (`unbounded: { reason }`) — the one unbounded spelling,
   * listed so it stays visible.
   */
  unbounded?: string;
  /**
   * How an external `serveValue`'s answer changes — its declared `changes`:
   * `"notified"` (something notifies it), or the arm of `{ immutable }` /
   * `{ fixed }` / `{ snapshot }` (nothing ever does, and the declaration says
   * why that is honest). Absent for a db value and every other register call.
   */
  changes?: ResourceChanges;
}

/** The freshness arms an external value declares (`LiveValueChanges`). */
export type ResourceChanges = "notified" | "immutable" | "fixed" | "snapshot";

export interface ResourceFacetData {
  server: ResourceDef[];
  central: ResourceDef[];
}

export const resourcesFacetDef = defineFacet<ResourceFacetData>("resources");
