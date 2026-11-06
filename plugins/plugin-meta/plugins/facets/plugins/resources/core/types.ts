import { defineFacet } from "@plugins/plugin-meta/plugins/facets/core";
import type {
  DescriptorInfo,
  ResourceMembership,
} from "@plugins/network/plugins/live/plugins/resource-vocabulary/core";

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
   * The list bounds the DECLARATION's schema writes (`list-bound`'s markers):
   * `whole: <reason>` / `capped: <max>`, each once. Absent when it writes none.
   */
  lists?: string[];
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
  /**
   * Join inputs for `relate`, cleared there (never rendered). A register call
   * serving a descriptor imported from ANOTHER plugin cannot be resolved in
   * `extract`: its record is keyed by this plugin's files only, so reading the
   * other plugin's would make it depend on files its key does not name (the
   * strict snapshot throws). `extract` records the call unresolved and each
   * plugin's own descriptor index; `relate`, which sees every plugin's data,
   * resolves the one against the other — or throws.
   */
  raw?: ResourcesRaw;
}

export interface ResourcesRaw {
  /** This plugin's descriptor index (declared const name → what it mints), when it declares any. */
  descriptors?: Record<string, DescriptorInfo[]>;
  /** Register calls naming a descriptor imported from another plugin's barrel. */
  imported?: DeferredRegisterCall[];
}

/** One register call left for `relate`: everything it needs to resolve it, as data. */
export interface DeferredRegisterCall {
  runtime: "server" | "central";
  marker: string;
  argsText: string;
  /** Repo-relative file and line, for the error message. */
  file: string;
  line: number;
  /** The file's bindings of the imported descriptor: `[local, exported, specifier]`. */
  bindings: [local: string, exported: string, specifier: string][];
}

export const resourcesFacetDef = defineFacet<ResourceFacetData>("resources");
