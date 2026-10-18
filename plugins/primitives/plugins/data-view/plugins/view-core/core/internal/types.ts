import type { IconRef, SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { FieldsRecord } from "@plugins/fields/core";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";

/**
 * The type-agnostic metadata every view-type carries. A consumer of the engine
 * (e.g. data-view) extends this with its own render-contract field (the
 * `component`). The engine only ever reads these five fields — it never knows
 * about `FieldDef`/rows/sort/filter.
 */
export interface ViewTypeMeta {
  /** Registry id of this view-type (e.g. "table", "gallery"). Instances
   *  reference it via `ViewInstance.type`. */
  type: string;
  title: string;
  icon: IconRef;
  order?: number;
  /** Per-instance `options` sub-form schema, type-dispatched by `type`. Drives
   *  the settings popover's options sub-form (via a web-side `variantField`). */
  configSchema?: FieldsRecord;
}

/**
 * A named instance of a registered view-type. The host renders view-instances —
 * a named, individually-configured *use* of a view-type, carrying
 * `{ id, name, type, options }`. In the un-materialized default case the engine
 * synthesizes one default instance per resolved view-type (id === type,
 * name === title); otherwise the instance list is config-authored.
 */
export interface ViewInstance {
  /** Instance identity — the localStorage active-id + switcher selection key.
   *  Default-instances set this equal to the view-type `type`. */
  id: string;
  /** Switcher display label. Default-instances use the view-type `title`. */
  name: string;
  /** Switcher glyph: the row's own `icon` when it picked one, else the
   *  view-type's `icon`. Resolved once in `buildInstanceFromRow`, so every
   *  switcher reads this and none re-derives the fallback. */
  icon: IconRef;
  /** The row's own picked glyph (what the settings picker edits), or `null`
   *  when the instance falls back to the view-type's icon. */
  pickedIcon: SavedSymbolName | null;
  /** Registry id (`ViewTypeMeta.type`) this instance renders. */
  type: string;
  /** Opaque source key this instance binds to (`ViewSourceEntry.id`). Absent =
   *  the implicit sole source (every single-source surface). The engine only
   *  ever matches it against the entry list — it never knows what a source IS. */
  source?: string;
  /** Opaque per-instance options forwarded to the view-type component. */
  options?: unknown;
}

/**
 * One config row of `viewsDescriptor.views`: the `listField` auto-injects `id`;
 * order is the array position (no `rank`). `name` is the switcher label; `view`
 * is the `variantField` value `{ type, ...options }` where `type` selects the
 * view-type and the rest is that type's saved options (including host-injected
 * keys such as `sort`/`filter`).
 */
export interface ViewConfigRow {
  id: string;
  name: string;
  /** The user-picked switcher glyph. Absent = the view-type's own icon. Carried
   *  by conditional spread like `source`, so an icon-less row's JSON stays
   *  byte-identical. */
  icon?: SavedSymbolName;
  view: VariantValue;
  /** Opaque source key (`ViewSourceEntry.id`) this row binds to. Absent = the
   *  implicit sole source. Carried verbatim through every read/write —
   *  `normalizeRows` preserves it via conditional spread so source-less rows
   *  stay byte-identical (the JSON-identity reconcile depends on that). */
  source?: string;
}

/**
 * One data source a view surface can bind its instances to. The engine treats
 * `id` as an **opaque lookup key** matched against `ViewConfigRow.source`
 * (`undefined` = the implicit sole source — the single-source case) — it never
 * knows what a source renders; the consumer (e.g. data-view's `DataViewSwitcher`)
 * owns that. Each entry carries the per-source capability surface that used to
 * be the flat `(contributions, viewOptions)` pair.
 */
export interface ViewSourceEntry<T extends ViewTypeMeta = ViewTypeMeta> {
  /** Matched against `ViewConfigRow.source`; `undefined` = the implicit sole
   *  source. */
  id?: string;
  /** Add-menu group label; omitted for the implicit source (flat menu). */
  title?: string;
  icon?: IconRef;
  contributions: readonly SealContributions<T>[];
  /** Type whitelist for the add menu (gates addability, NOT authored rows —
   *  mirroring the single-source `views` prop semantics). */
  views?: string[];
  /** Code-supplied per-type options merged under each row's `view` blob. */
  viewOptions?: Record<string, unknown>;
  /**
   * Called for an authored row whose `view.type` no contribution renders,
   * before that row is skipped. A surface whose view types are companions
   * throws here when the repo provides the renderer and the bundle lacks it
   * (data-view's `useCompanionLookup`); a type nothing provides stays a skip.
   */
  onOrphanType?: (type: string) => void;
}

/** A view-type the add-menu offers (capability-gated). */
export interface AddableViewType {
  type: string;
  title: string;
  icon: IconRef;
}

/** One add-menu group: the addable view-types of one source entry. A surface
 *  with a single untitled source renders the types as today's flat menu. */
export interface AddableSource {
  /** `ViewSourceEntry.id` — threaded back into `addView(type, sourceId)`. */
  sourceId?: string;
  /** Menu group label; absent only for the implicit sole source. */
  title?: string;
  icon?: IconRef;
  /** Per entry: contributions ∩ `views` whitelist. */
  types: AddableViewType[];
}
