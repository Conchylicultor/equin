import { useCallback, useMemo } from "react";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import type { VariantEntry } from "@plugins/fields/plugins/variant/plugins/config/core";
import type {
  AddableSource,
  AddableViewType,
  ViewSourceEntry,
  ViewTypeMeta,
} from "../../core";
import type { ResolvedViewInstance } from "./resolve-instances";
import { useViewsConfig, type ViewsConfigHandle } from "./use-views-config";
import { useActiveViewId } from "@plugins/primitives/plugins/view-switcher/web";
import { resolveActiveId } from "./resolve-active-id";
import { usableTypes } from "./usable-types";
import {
  type AssertStableGetters,
  type ViewGetter,
  useViewGetter,
} from "./view-getter";

/**
 * Instance actions for the editable view-switcher (every view surface has
 * these). `updateView` is opaque about the variant value — the host layers
 * sort/filter on top of it.
 */
export interface ViewActionsCore {
  /** Add-menu groups, one per source entry (each entry's registered
   *  contributions ∩ `views` whitelist). A single-source
   *  surface yields exactly one untitled group — the flat-menu fast path. */
  availableSources: AddableSource[];
  /**
   * The type-switcher registry for ONE instance's settings popover: the types
   * that instance's own source can render (the same gate the add menu uses),
   * each paired with its options sub-form. Per-instance, never global — a
   * view can only switch into a type its own source entry offers.
   *
   * Stable per view: the same Map until THAT view's source entry or type
   * changes — renaming it, editing its options, or touching another view
   * leaves it alone, so a consumer can key a memo on it directly.
   */
  variantsFor: ViewGetter<Map<string, VariantEntry>>;
  addView: (type: string, sourceId?: string) => void;
  renameView: (id: string, name: string) => void;
  /** Set the switcher glyph; `null` reverts to the view-type's own icon. */
  setViewIcon: (id: string, icon: SavedSymbolName | null) => void;
  duplicateView: (id: string) => void;
  deleteView: (id: string) => void;
  reorderView: (id: string, toIndex: number) => void;
  updateView: (
    id: string,
    view: VariantValue,
    opts?: { merge?: boolean },
  ) => void;
}

/**
 * Every value-returning member of `ViewActionsCore` must be a `ViewGetter` — a
 * new `fooFor: (id) => Foo` minting per call fails here; mint it with
 * `useViewGetter`.
 */
export const actionsGettersAreStable: AssertStableGetters<ViewActionsCore> = true;

/**
 * The generic, type-agnostic view model. Owns the instance list, active-id
 * resolution, and raw `view` read/write — but knows NOTHING about
 * sort/filter/query/expand. A consumer (e.g. data-view) wraps it to layer those
 * render concerns on top.
 */
export interface ViewModelCore<T extends ViewTypeMeta = ViewTypeMeta> {
  /** Is the authored config known yet? See `ViewsConfigHandle.ready` — while
   *  `false`, `instances` is "we don't know", never "there are none". */
  ready: boolean;
  /** Why `ready` is false when waiting will not fix it — see
   *  `ViewsConfigHandle.failure`. The host renders it (with Retry), never a
   *  loading state. `null` while loading, ready, or failed-with-a-held-value. */
  failure: ViewsConfigHandle["failure"];
  instances: ResolvedViewInstance<T>[];
  activeId: string;
  setActiveView: (id: string) => void;
  /** Raw `view` value for one instance (the variant blob), or the seed `{type}`
   *  for a not-yet-materialized default. `undefined` only for an unknown id. */
  viewFor: (id: string) => VariantValue | undefined;
  updateView: (
    id: string,
    view: VariantValue,
    opts?: { merge?: boolean },
  ) => void;
  actions: ViewActionsCore;
  /** Capability-gated add menu, grouped per source entry. */
  availableSources: AddableSource[];
}

/**
 * The single generic view model: config-authored instances, raw view read/write,
 * full instance actions. active-id stays device-local via `useActiveViewId`.
 * Opaque about per-instance options (`sort`/`filter`/query/expand are the host's
 * concern).
 *
 * `entries` is the ordered source-entry list; single-source consumers pass one
 * implicit entry (`id`/`title` undefined). Pass a referentially-stable array —
 * the instance list and add menu memoize on it.
 */
export function useViewModel<T extends ViewTypeMeta>(
  storageKey: string,
  descriptorMap: Map<string, ConfigDescriptor>,
  entries: ViewSourceEntry<T>[],
  defaultView: string | undefined,
  pinnedView?: string,
): ViewModelCore<T> {
  // Config is the single source of truth — no synthesized defaults. The instance
  // list comes only from the authored config rows (terse `{ name, view }`,
  // normalized on read). The addable-types menu (`availableSources`, below) is
  // derived straight from each entry's contributions — that is "what view-types
  // exist per source", not "default instances".
  const cfg = useViewsConfig(storageKey, descriptorMap, entries);
  const active = useActiveViewId(storageKey);

  const activeId = resolveActiveId(
    cfg.instances as ResolvedViewInstance<T>[],
    active.activeViewId,
    defaultView,
    pinnedView,
  );

  // Capability-gated add menu, grouped per source entry: each group is that
  // entry's registered contributions ∩ `views` whitelist (if present). The `views` whitelist gates ADDABILITY only — authored
  // rows of a non-whitelisted type still resolve (see `buildInstanceFromRow`).
  // Generic — driven by the entries, never by a named view child.
  const availableSources = useMemo<AddableSource[]>(() => {
    return entries.map((entry) => {
      const types = usableTypes(entry).map<AddableViewType>((c) => ({
        type: c.type,
        title: c.title,
        icon: c.icon,
      }));
      return {
        sourceId: entry.id,
        title: entry.title,
        icon: entry.icon,
        types,
      };
    });
  }, [entries]);

  // The settings popover's type list, derived per instance from that instance's
  // OWN source entry through the same `usableTypes` gate the add menu uses.
  // The instance's current type is always listed even when the entry's `views`
  // whitelist excludes it: the whitelist gates addability, not authored rows
  // (`buildInstanceFromRow` renders them), so the picker must be able to show
  // the value it is bound to. Its inputs are the instance's source entry (from
  // the caller's stable `entries`) and resolved `viewType` (the registered
  // contribution — it changes exactly when the view's type does), so a rename
  // or an options edit hands back the same Map.
  const variantsFor = useViewGetter(
    useCallback(
      (id: string) => {
        const resolved = cfg.instances.find((r) => r.instance.id === id);
        return [
          resolved && entries.find((e) => e.id === resolved.instance.source),
          resolved?.viewType,
        ] as const;
      },
      [cfg.instances, entries],
    ),
    deriveVariants,
  );

  // Adding or duplicating a view makes the new view the active one — every
  // surface that creates a view (the strip's `+`, the chip's "Add view", the
  // settings popover's Duplicate) lands on it, rather than each caller having
  // to remember to select the id it gets back.
  const { setActiveView } = active;
  const actions = useMemo<ViewActionsCore>(
    () => ({
      availableSources,
      variantsFor,
      addView: (type, sourceId) => {
        setActiveView(cfg.addView(type, sourceId));
      },
      renameView: cfg.renameView,
      setViewIcon: cfg.setViewIcon,
      duplicateView: (id) => {
        setActiveView(cfg.duplicateView(id));
      },
      deleteView: cfg.deleteView,
      reorderView: cfg.reorderView,
      updateView: cfg.updateView,
    }),
    [availableSources, variantsFor, cfg, setActiveView],
  );

  return useMemo(
    () => ({
      ready: cfg.ready,
      failure: cfg.failure,
      instances: cfg.instances as ResolvedViewInstance<T>[],
      activeId,
      setActiveView: active.setActiveView,
      viewFor: cfg.viewFor,
      updateView: cfg.updateView,
      actions,
      availableSources,
    }),
    [cfg, activeId, active.setActiveView, actions, availableSources],
  );
}

/**
 * One instance's type-switcher registry from its source `entry` and resolved
 * `viewType` (both `undefined` for an unknown id → an empty Map). Module-level
 * so `useViewGetter` re-runs it only when one of the two changes identity.
 */
function deriveVariants<T extends ViewTypeMeta>(
  entry: ViewSourceEntry<T> | undefined,
  viewType: SealContributions<T> | undefined,
): Map<string, VariantEntry> {
  if (!viewType) return new Map();
  const usable = entry ? usableTypes(entry) : [];
  const listed = usable.some((c) => c.type === viewType.type)
    ? usable
    : [...usable, viewType];
  return new Map(
    listed.map((c) => [
      c.type,
      { label: c.title, fields: c.configSchema ?? {} },
    ]),
  );
}
