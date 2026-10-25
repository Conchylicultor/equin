import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
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
import {
  buildInstanceFromRow,
  type ResolvedViewInstance,
} from "./resolve-instances";
import { useViewsConfig, type ViewsConfigHandle } from "./use-views-config";
import { cleanView, type DraftMap, sameView, withDraft } from "./draft-values";
import { readDrafts, subscribeDrafts, writeDrafts } from "./view-drafts";
import {
  useActiveViewId,
  type ActiveViewUrl,
} from "@plugins/primitives/plugins/view-switcher/web";
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
  /** Append a view of `type` (bound to `sourceId`) and make it the active
   *  one. */
  addView: (type: string, sourceId?: string) => void;
  renameView: (id: string, name: string) => void;
  /** Set the switcher glyph; `null` reverts to the view-type's own icon. */
  setViewIcon: (id: string, icon: SavedSymbolName | null) => void;
  /** Insert a copy of the view (its working copy, when drafted) after it and
   *  make the copy the active view. */
  duplicateView: (id: string) => void;
  /** Delete the view (and drop its draft). */
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
  /** Raw `view` value for one instance (the variant blob) — its working copy
   *  while it is drafted, else the saved row's. `undefined` only for an unknown
   *  id. Returns stored objects, so a value keeps its identity until a write to
   *  that view replaces it. */
  viewFor: (id: string) => VariantValue | undefined;
  /** The saved row's `view` value, whatever its draft. Equal to `viewFor`
   *  without drafts. */
  savedViewFor: (id: string) => VariantValue | undefined;
  /** Whether the view has unsaved edits (a working copy differing from the
   *  saved row). Always `false` without drafts. */
  dirtyFor: ViewGetter<boolean>;
  /** Write a view's `view` value — into its working copy while drafts are on
   *  (a write equal to the saved value drops the copy), else to the config. */
  updateView: (
    id: string,
    view: VariantValue,
    opts?: { merge?: boolean },
  ) => void;
  /** The working-copy actions, or `null` when the surface did not opt into
   *  drafts (`useViewModel(…, { drafts: true })`). */
  drafts: ViewDrafts | null;
  actions: ViewActionsCore;
  /** Capability-gated add menu, grouped per source entry. */
  availableSources: AddableSource[];
}

/**
 * What a drafted surface does with a view's working copy. Every write to a
 * drafted view's `view` value (`updateView`, and so a host's sort / filter /
 * group-by setters) lands in its working copy; renaming, icons, reordering,
 * adding and deleting stay durable. A view's working copy lives per browser tab
 * (sessionStorage), like a search query.
 */
export interface ViewDrafts {
  /** Write the view's working copy to its config row and drop the copy. */
  save: (id: string) => void;
  /** Drop the view's working copy and return it (`null` when it had none), so
   *  a caller can offer to `restore` it. */
  discard: (id: string) => VariantValue | null;
  /** Make `view` the view's working copy again (an Undo of `discard`). */
  restore: (id: string, view: VariantValue) => void;
  /** Save the view's working copy as a NEW view right after it — named `name`,
   *  with `icon` (else the source's) — drop the source's copy, make the new
   *  view the active one and return its id. The source keeps its saved value. */
  saveAsNew: (
    id: string,
    row: { name: string; icon?: SavedSymbolName },
  ) => string;
}

/** `useViewModel`'s options. */
export interface ViewModelOptions {
  /** Edits to a view's `view` value go to a per-tab working copy — see
   *  {@link ViewDrafts}. Default off: every write is durable. */
  drafts?: boolean;
  /**
   * The projection under which two `view` values are the same view (a write
   * equal to the saved value drops the draft; `dirtyFor` compares under it).
   * Compared as canonical JSON (key order and `undefined` members ignored).
   * For a consumer whose values carry identities that do not make two views
   * different (data-view's filter-node ids). Pass a module-level function.
   */
  canonical?: (view: VariantValue) => unknown;
  /**
   * Where the URL holds the active view (a pane's `;view`), when it does: a
   * URL-named view outranks the device-local selection, and selecting writes
   * both. `null`/absent keeps the selection device-local only.
   */
  activeViewUrl?: ActiveViewUrl | null;
}

const NO_DRAFTS: DraftMap = Object.freeze({});
const noSubscription = () => () => {};

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
  opts?: ViewModelOptions,
): ViewModelCore<T> {
  const draftsOn = opts?.drafts === true;
  const canonical = opts?.canonical;
  // Config is the single source of truth — no synthesized defaults. The instance
  // list comes only from the authored config rows (terse `{ name, view }`,
  // normalized on read). The addable-types menu (`availableSources`, below) is
  // derived straight from each entry's contributions — that is "what view-types
  // exist per source", not "default instances".
  const cfg = useViewsConfig(storageKey, descriptorMap, entries);
  const active = useActiveViewId(storageKey, opts?.activeViewUrl);

  // The surface's working copies — the tab's shared map (every mount of this
  // surface reads the same one), or none without drafts.
  const drafted = useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        draftsOn ? subscribeDrafts(storageKey, onChange) : noSubscription(),
      [draftsOn, storageKey],
    ),
    () => (draftsOn ? readDrafts(storageKey) : NO_DRAFTS),
  );

  // A drafted view renders its working copy: its instance is rebuilt from the
  // copy (so a drafted option or type change shows), every other one is the
  // config's own (identity kept).
  const instances = useMemo(() => {
    const saved = cfg.instances as ResolvedViewInstance<T>[];
    if (drafted === NO_DRAFTS || Object.keys(drafted).length === 0) {
      return saved;
    }
    return saved.map((r) => {
      const draft = drafted[r.instance.id];
      if (draft === undefined) return r;
      const { instance } = r;
      return (
        buildInstanceFromRow(
          {
            id: instance.id,
            name: instance.name,
            ...(instance.pickedIcon !== null
              ? { icon: instance.pickedIcon }
              : {}),
            view: draft,
            ...(instance.source !== undefined
              ? { source: instance.source }
              : {}),
          },
          entries,
        ) ?? r
      );
    });
  }, [cfg.instances, drafted, entries]);

  const savedViewFor = cfg.viewFor;
  const viewFor = useCallback(
    (id: string): VariantValue | undefined => {
      const saved = savedViewFor(id);
      return saved === undefined ? undefined : (drafted[id] ?? saved);
    },
    [savedViewFor, drafted],
  );

  // Set (or, with `null`, drop) one view's working copy against the tab's
  // CURRENT map — not this render's — so two writes in one tick compose.
  const setDraft = useCallback(
    (id: string, view: VariantValue | null) => {
      const current = readDrafts(storageKey);
      const next = withDraft(current, id, view);
      if (next !== current) writeDrafts(storageKey, next);
    },
    [storageKey],
  );

  // A drafted write: over the working copy (else the saved value), dropped
  // when it lands back on the saved value. Without drafts, the config's own.
  const { updateView: saveView } = cfg;
  const updateView = useCallback(
    (id: string, view: VariantValue, o?: { merge?: boolean }) => {
      if (!draftsOn) {
        saveView(id, view, o);
        return;
      }
      const saved = savedViewFor(id);
      if (saved === undefined) return;
      const base = readDrafts(storageKey)[id] ?? saved;
      const next = cleanView(o?.merge ? { ...base, ...view } : view);
      setDraft(id, sameView(next, saved, canonical) ? null : next);
    },
    [draftsOn, saveView, savedViewFor, storageKey, setDraft, canonical],
  );

  const deriveDirty = useCallback(
    (draft: VariantValue | undefined, saved: VariantValue | undefined) =>
      draft !== undefined &&
      saved !== undefined &&
      !sameView(draft, saved, canonical),
    [canonical],
  );
  const dirtyFor = useViewGetter(
    useCallback(
      (id: string) => [drafted[id], savedViewFor(id)] as const,
      [drafted, savedViewFor],
    ),
    deriveDirty,
  );

  const activeId = resolveActiveId(instances, {
    fromUrl: active.urlViewId,
    persisted: active.activeViewId,
    defaultView,
    pinned: pinnedView,
  });

  // A view the URL opened becomes this device's selection too: should the
  // address later stop naming it (a link opened beside it), the surface keeps
  // showing it rather than jumping back to the previous device-local pick.
  const { urlViewId, activeViewId: persistedId, setActiveView: adopt } = active;
  useEffect(() => {
    if (activeId !== "" && activeId === urlViewId && persistedId !== activeId) {
      adopt(activeId);
    }
  }, [activeId, urlViewId, persistedId, adopt]);

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
        const resolved = instances.find((r) => r.instance.id === id);
        return [
          resolved && entries.find((e) => e.id === resolved.instance.source),
          resolved?.viewType,
        ] as const;
      },
      [instances, entries],
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
        // What you see is what you copy: a drafted view's working copy.
        const draft = draftsOn ? readDrafts(storageKey)[id] : undefined;
        setActiveView(
          cfg.duplicateView(
            id,
            draft === undefined ? undefined : { view: draft },
          ),
        );
      },
      deleteView: (id) => {
        cfg.deleteView(id);
        if (draftsOn) setDraft(id, null);
      },
      reorderView: cfg.reorderView,
      updateView,
    }),
    [
      availableSources,
      variantsFor,
      cfg,
      setActiveView,
      draftsOn,
      storageKey,
      setDraft,
      updateView,
    ],
  );

  const drafts = useMemo<ViewDrafts | null>(
    () =>
      draftsOn
        ? {
            save: (id) => {
              const draft = readDrafts(storageKey)[id];
              if (draft === undefined) return;
              saveView(id, draft);
              setDraft(id, null);
            },
            discard: (id) => {
              const draft = readDrafts(storageKey)[id] ?? null;
              setDraft(id, null);
              return draft;
            },
            restore: (id, view) => {
              const saved = savedViewFor(id);
              if (saved === undefined) return;
              setDraft(id, sameView(view, saved, canonical) ? null : view);
            },
            saveAsNew: (id, row) => {
              const view = readDrafts(storageKey)[id] ?? savedViewFor(id);
              if (view === undefined) {
                throw new Error(
                  `view-core(${storageKey}): saveAsNew("${id}") names no view`,
                );
              }
              const newId = cfg.duplicateView(id, {
                name: row.name,
                ...(row.icon !== undefined ? { icon: row.icon } : {}),
                view,
              });
              setDraft(id, null);
              setActiveView(newId);
              return newId;
            },
          }
        : null,
    [
      draftsOn,
      storageKey,
      saveView,
      setDraft,
      savedViewFor,
      canonical,
      cfg,
      setActiveView,
    ],
  );

  return useMemo(
    () => ({
      ready: cfg.ready,
      failure: cfg.failure,
      instances,
      activeId,
      setActiveView: active.setActiveView,
      viewFor,
      savedViewFor,
      dirtyFor,
      updateView,
      drafts,
      actions,
      availableSources,
    }),
    [
      cfg.ready,
      cfg.failure,
      instances,
      activeId,
      active.setActiveView,
      viewFor,
      savedViewFor,
      dirtyFor,
      updateView,
      drafts,
      actions,
      availableSources,
    ],
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
