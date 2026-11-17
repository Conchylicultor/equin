import { z, type ZodType } from "zod";
import {
  defineStore,
  type LegacyKeys,
  type ScopedStore,
  type StoreSpec,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import type { StorageSize } from "@plugins/primitives/plugins/dom/plugins/web-storage/core";
import { DEFAULT_DRAFT_TTL } from "./draft-storage";
import { recordKeptWork } from "../core";

/**
 * Work: what the user made and the server does not have yet (composer text,
 * form fields, chosen options). Its own local store per owner, refused — never
 * evicted — when full, kept for `DEFAULT_DRAFT_TTL`, one entry per subject.
 */
export interface KeptWorkSpec<T> {
  /** `[a-z0-9.-]`, a literal: the budget-fits check reads it. */
  owner: string;
  /** Plural, read by the user (a refused-write toast, the health row). */
  label: string;
  tier: "work";
  /** A literal ("64 KB"): the budget-fits check sums it into the local area. */
  cap: StorageSize;
  schema: ZodType<T>;
  /**
   * `schemaStamp(schema)` (web-storage core), as a literal: the
   * `kept-state:work-schema-migrates` check verifies it and reads main's from
   * main's source, to tell a changed schema. When it fails, it names the value.
   */
  stamp: string;
  /**
   * How a draft an older schema wrote is read now, keyed by that schema's
   * stamp — so an upgrade reload into a build that changed the schema gives
   * the user's work back instead of hiding it. The result is parsed with
   * `schema`. Changing `schema` requires an entry for main's stamp (the
   * `work-schema-migrates` check); for an added optional field it is the
   * identity, `(old) => old`.
   */
  migrate?: Readonly<Record<string, (old: unknown) => unknown>>;
  /** Drafts written before this owner existed, carried over. */
  legacy?: LegacyKeys;
}

/**
 * View: where the user was looking (expanded, sub-tab, query, selection). No
 * store of its own — every owner shares one pooled session store, keyed by
 * the place it renders in (the ambient `KeepScope`). Best effort: an entry its
 * schema no longer reads is dropped.
 */
export interface KeptViewSpec<T> {
  /** `[a-z0-9.-]`; unique among view owners (part of the pooled id). */
  owner: string;
  tier: "view";
  schema: ZodType<T>;
}

export interface KeptWork<T> {
  readonly tier: "work";
  readonly owner: string;
  readonly store: ScopedStore<T>;
}

export interface KeptView<T> {
  readonly tier: "view";
  readonly owner: string;
  readonly schema: ZodType<T>;
}

const OWNER = /^[a-z0-9.-]+$/;
const viewOwners = new Set<string>();

/**
 * The pooled store all view state lives in: one session budget line however
 * many owners, oldest evicted when full (view state is a convenience, never
 * what the user made). Each entry is parsed with its owner's schema on read.
 */
const viewPool = defineStore<unknown>({
  owner: "kept.view",
  label: "Kept view state",
  area: "session",
  cap: "256 KB",
  ttl: 7 * 24 * 60 * 60 * 1000,
  whenFull: "evict-oldest",
  schema: z.unknown(),
});

/** The view pool — for `useKept` only (not in the barrel). */
export function viewPoolStore(): ScopedStore<unknown> {
  return viewPool;
}

/**
 * Declare a piece of kept state, once, at module scope.
 *
 * ```ts
 * export const linkDraft = defineKept({
 *   owner: "page.link-form", label: "Link drafts", tier: "work", cap: "64 KB",
 *   schema: z.object({ url: z.string(), text: z.string() }), stamp: "1x2y3z",
 * });
 * export const pickerQuery = defineKept({ owner: "icon-picker.query", tier: "view", schema: z.string() });
 * ```
 *
 * Read with `useKept`. The work tier's owner, cap, tier and stamp must be
 * literals: web-storage's `budget-fits` check and kept-state's
 * `work-schema-migrates` check read them from the source.
 */
export function defineKept<T>(spec: KeptWorkSpec<T>): KeptWork<T>;
export function defineKept<T>(spec: KeptViewSpec<T>): KeptView<T>;
export function defineKept<T>(
  spec: KeptWorkSpec<T> | KeptViewSpec<T>,
): KeptWork<T> | KeptView<T> {
  if (!OWNER.test(spec.owner))
    throw new Error(
      `defineKept: owner "${spec.owner}" must match ${OWNER.source}`,
    );
  if (spec.tier === "view") {
    if (viewOwners.has(spec.owner))
      throw new Error(`defineKept: view owner "${spec.owner}" declared twice`);
    viewOwners.add(spec.owner);
    return { tier: "view", owner: spec.owner, schema: spec.schema };
  }
  // Bound per composition scope (no `pageWide`): work typed inside an
  // embedded demo is the demo's.
  const storeSpec: StoreSpec<T> & { pageWide?: undefined } = {
    owner: spec.owner,
    label: spec.label,
    area: "local",
    cap: spec.cap,
    ttl: DEFAULT_DRAFT_TTL,
    whenFull: "refuse",
    schema: spec.schema,
    migrate: spec.migrate,
    legacy: spec.legacy,
  };
  recordKeptWork({
    owner: spec.owner,
    stamp: spec.stamp,
    schema: spec.schema,
    migrateFrom: Object.keys(spec.migrate ?? {}),
  });
  return {
    tier: "work",
    owner: spec.owner,
    store: defineStore(storeSpec),
  };
}
