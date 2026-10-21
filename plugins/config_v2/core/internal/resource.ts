import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

export const configV2ValuesSchema = z.record(z.unknown());
export type ConfigV2Values = z.infer<typeof configV2ValuesSchema>;

// One descriptor's resolved document — `{ path }` is its base (global) document,
// `{ path, scopeId }` a scope's own. `scopeId` is optional: absent (or `""`, the
// server's base scope) names the base tuple, so every spelling of "base" is one
// subscription.
//
// `"boot-and-keep"`: every document a first paint can read — each registered
// `{ path }` plus each `{ path, scopeId }` with its own config — rides the boot
// snapshot (the served half enumerates them) and is hydrated before first
// paint, and every tuple stays resident: config surfaces mount at any point in
// the session (a sidebar toggled open an hour in), and a config read has no
// honest stand-in for "unknown" (its defaults are a legitimate value). Small
// documents, read by everything.
export const configValues = liveValue("config-v2.values", {
  schema: configV2ValuesSchema,
  params: ["path", "scopeId?"],
  preload: "boot-and-keep",
});

// A single structured validation failure. `path` is the zod issue path as an
// array (`["items", 6]`) so consumers can drill the offending value out of the
// stored document and render it inline; `message` is the human zod message.
export const configV2ValidationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});
export type ConfigV2ValidationIssue = z.infer<
  typeof configV2ValidationIssueSchema
>;

export const configV2ConflictEntrySchema = z.object({
  // "hash"    — the override's @hash is stale vs its origin (upstream defaults
  //             moved); the app resolves to origin until reconciled.
  // "invalid" — the stored document fails the current schema even after default
  //             backfill (e.g. a field's type changed under it); the app
  //             resolves to defaults and the user must reset or fix the file.
  kind: z.enum(["hash", "invalid"]),
  // The origin (upstream) document — this is what the running app resolves to
  // while the conflict is unreconciled, since origin takes precedence on conflict.
  originValues: z.record(z.unknown()),
  // The user's override document as written to disk. The settings editor binds
  // to this so the user can see and reconcile what they configured, independent
  // of what the app currently resolves to.
  overrideValues: z.record(z.unknown()),
  // Structured zod issues, present only when kind === "invalid". Each carries the
  // path (as an array) and message so the UI can pinpoint and render the offending
  // value drilled from `overrideValues`.
  issues: z.array(configV2ValidationIssueSchema).optional(),
  // Present only for kind === "hash" when an ancestor snapshot exists (a
  // three-way merge is possible). Lists the fields both the user and upstream
  // changed differently — the true conflicts needing manual attention. An empty
  // array means the merge is fully automatic; absent means no ancestor was
  // captured (a pre-existing conflict) so only the binary Keep/Accept apply.
  trueConflictKeys: z.array(z.string()).optional(),
});
export type ConfigV2ConflictEntry = z.infer<typeof configV2ConflictEntrySchema>;

export const configV2ConflictsSchema = z.record(configV2ConflictEntrySchema);
export type ConfigV2Conflicts = z.infer<typeof configV2ConflictsSchema>;

// Per-descriptor conflict, keyed by `{ path, scopeId? }` (as `configValues`).
// The single descriptor's conflict entry for the selected scope, or null when it
// has no conflict. Keying by path means a change to one descriptor recomputes
// only that descriptor — the detail page subscribes to exactly the path it
// shows, never the whole ~180-descriptor map. Recomputed in lock-step with
// `configValues` (its served half's `recomputeOn`).
export const configConflict = liveValue("config-v2.conflicts", {
  schema: configV2ConflictEntrySchema.nullable(),
  params: ["path", "scopeId?"],
});

export const configV2TiersSchema = z.record(z.enum(["default", "git", "user"]));
export type ConfigV2Tiers = z.infer<typeof configV2TiersSchema>;

// Which layer supplied each field of one descriptor's document for one scope —
// keyed and recomputed exactly like `configConflict`.
export const configTiers = liveValue("config-v2.tiers", {
  schema: configV2TiersSchema,
  params: ["path", "scopeId?"],
});

// The list of scopeIds a single descriptor is customized for (has its own
// config — a propagated git scope or a runtime fork). This is the per-descriptor
// element type; the live resource carries the whole map (see below).
export const configV2ScopesSchema = z.array(z.string());
export type ConfigV2Scopes = z.infer<typeof configV2ScopesSchema>;

// The whole membership map: EVERY server-registered storePath → the scopeIds it
// has its own config for (`[]` for none). Two answers in one value:
// - which paths the server registered (a path missing here is a web-only
//   half-registration — `useConfigResult` throws on it);
// - the scoped-vs-global decision every `useConfig` read keys off.
// Param-less (one global subscription, shared per tab) rather than per-`{ path }`,
// so the many useConfig/useScopeMembership consumers (the theme injector
// subscribes one per token descriptor) collapse to a single sub. Computed
// server-side from an in-memory map (no per-load filesystem walk). Changes only
// when a scope is forked, unforked, or first written.
export const configV2ScopesMapSchema = z.record(configV2ScopesSchema);
export type ConfigV2ScopesMap = z.infer<typeof configV2ScopesMapSchema>;

// `"boot-and-keep"` for the same reason as `configValues`: hydrated before first
// paint and never evicted, so a scoped reader paints its scope on the first
// frame (no global→scoped flash) whenever it mounts.
export const configScopes = liveValue("config-v2.scopes", {
  schema: configV2ScopesMapSchema,
  preload: "boot-and-keep",
});

// WHERE one descriptor conflicts: its base document, and/or the named app scopes
// it is customized for. Never a bare boolean — a warning badge that cannot say
// which scope it is about sends the user to a detail pane that opens on Base and
// shows nothing, which is exactly the dead end this shape exists to prevent.
// `base: false` with a non-empty `scopeIds` is the scoped-only case.
export const configV2ConflictLocationsSchema = z.object({
  base: z.boolean(),
  scopeIds: z.array(z.string()),
});
export type ConfigV2ConflictLocations = z.infer<
  typeof configV2ConflictLocationsSchema
>;

// storePath → where it conflicts. Only conflicting paths are present, so
// membership answers "does this row warn?" and the value answers "about what?".
// Powers the nav-row warning badge, the scope-tab dots and the rail/sidebar
// attention dots — distinct from configConflict, which carries ONE
// descriptor's conflict entry (the full origin/override documents) for ONE scope.
export const configV2ConflictMapSchema = z.record(
  configV2ConflictLocationsSchema,
);
export type ConfigV2ConflictMap = z.infer<typeof configV2ConflictMapSchema>;

// The whole map, one param-less live value served from the external arm (its
// truth is the config files on disk). Bounded by the registered descriptors
// (~250), of which only the conflicting ones are present. Not preloaded: the
// attention dots paint nothing until it lands.
export const configConflictLocations = liveValue(
  "config-v2.conflict-locations",
  {
    schema: configV2ConflictMapSchema,
  },
);

// storePaths whose BASE config the USER LAYER has changed, mapped to the count of
// such fields (only paths with ≥1 are present). Powers the config nav-row
// modified count badge AND the "Modified only" filter without any per-row
// reactive read.
//
// "Modified" is measured against the GIT LAYER — the generated origin ⊕ any
// committed authored override, as propagated by `./singularity build` — not
// against `descriptor.defaults`. A value the repo commits is not something the
// user changed. Same basis as the per-field `config-v2.tiers` attribution the
// detail pane's stripes and Reset buttons read, so badge and pane agree.
export const configV2ModifiedCountsSchema = z.record(z.number());
export type ConfigV2ModifiedCounts = z.infer<
  typeof configV2ModifiedCountsSchema
>;

// The whole map, one param-less live value served from the external arm (disk is
// the truth). Bounded by the registered descriptors. Not preloaded.
export const configModifiedCounts = liveValue("config-v2.modified-counts", {
  schema: configV2ModifiedCountsSchema,
});

// The raw text of one config document's four layered files: the user layer
// (~/.singularity/state/config/<wt>/) override + origin (what the running app
// resolves to), and the git layer (<repo>/config/) override + origin (the
// defaults). The settings raw view surfaces them as User → Git → Origin, and the
// conflict / invalid diffs compare two of them. `*Path` is the on-disk location,
// relative to its layer root (always present, even when the file is absent and its
// content is null), so the UI labels each layer with its real path.
const configV2RawFileSchema = z.object({
  override: z.string().nullable(),
  overridePath: z.string(),
  origin: z.string().nullable(),
  originPath: z.string(),
  gitOverride: z.string().nullable(),
  gitOverridePath: z.string(),
  gitOrigin: z.string().nullable(),
  gitOriginPath: z.string(),
});

// Keyed `{ path, scopeId? }` exactly like `configValues`, so the registry's one
// document fan-out (`onDocumentChange`) moves it with the document, its
// conflicts and its tiers — the user-layer half. The git-layer half (repo files
// only a build propagates) is watched while subscribed. A path no descriptor is
// registered for — or a scope with no document of its own loaded — is refused
// `missing`. The files are the desktop's (served by `machine/`): a reader under
// an in-browser server gets `unavailable`.
export const configRawFile = liveValue("config-v2.raw-file", {
  schema: configV2RawFileSchema,
  params: ["path", "scopeId?"],
  refusals: ["missing"],
  needsMachine: { feature: "Reading config files" },
});
