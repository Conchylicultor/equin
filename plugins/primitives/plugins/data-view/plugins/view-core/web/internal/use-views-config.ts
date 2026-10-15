import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  foldResource,
  type ResourceError,
} from "@plugins/primitives/plugins/live-state/web";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import {
  viewIdKind,
  type ViewConfigRow,
  type ViewSourceEntry,
  type ViewTypeMeta,
} from "../../core";
import { buildInstanceFromRow } from "./resolve-instances";
import type { ResolvedViewInstance } from "./resolve-instances";
import { normalizeRows, shareRows, type RawViewRow } from "./normalize-rows";

/** Trailing-edge debounce for config writes — `setConfig` POSTs the whole doc. */
const WRITE_DEBOUNCE_MS = 400;

/** What the config engine exposes to the host. Opaque about the per-instance
 *  `options` blob — it never names `sort`/`filter`; the host layers those on. */
export interface ViewsConfigHandle {
  /**
   * Is the authored config KNOWN yet? `false` means the document has not
   * arrived — `instances` is empty because we cannot say what is in it, NOT
   * because the surface has no views. The two are indistinguishable in the row
   * list itself, so the host must branch on this before rendering an empty
   * state (see `DataViewShellFrame`).
   */
  ready: boolean;
  /**
   * The config document failed to load and no earlier value is held — so
   * `ready` is `false` for a reason that waiting will not fix. The host renders
   * this (with its `refetch`) instead of a loading state. `null` otherwise
   * (loading, ready, or failed while a last-known value is still shown).
   */
  failure: { error: ResourceError; refetch: () => Promise<void> } | null;
  /** Resolved, ordered instances (fail-soft skip of orphan rows). */
  instances: ResolvedViewInstance[];
  /** The RAW `view` value for one instance (the variant blob `{ type, ...opts }`),
   *  read straight off the config row (NOT the merged code+config options). For a
   *  not-yet-materialized default it returns the seed `{ type }` so callers always
   *  have a `type` to merge over. `undefined` only when the id is unknown. */
  viewFor: (id: string) => VariantValue | undefined;
  /** Write a new `view` value for one instance. `{ merge: true }` shallow-merges
   *  over the existing raw view (`{ ...prev, ...view }`), preserving any
   *  host-injected keys the caller didn't carry; default replaces wholesale. */
  updateView: (
    id: string,
    view: VariantValue,
    opts?: { merge?: boolean },
  ) => void;
  /** Append a new instance of `type`, bound to `sourceId` when given (the seed
   *  row is stamped with `source: sourceId`; absent = the implicit sole source). */
  addView: (type: string, sourceId?: string) => string;
  renameView: (id: string, name: string) => void;
  /** Set the switcher glyph; `null` reverts to the view-type's own icon. */
  setViewIcon: (id: string, icon: SavedSymbolName | null) => void;
  duplicateView: (id: string) => string;
  deleteView: (id: string) => void;
  reorderView: (id: string, toIndex: number) => void;
}

/** Stable random id for new config rows (the listField also injects one on the
 *  server, but we need one client-side for the optimistic mirror). */
function newId(): string {
  return viewIdKind.mint();
}

/**
 * Generic opaque-options config engine. Reads the supplied descriptor
 * (app-scoped), keeps an optimistic mirror, and debounces
 * `setConfig("views", next)`. Mirrors the proven pendingRef / timerRef / flush /
 * scheduleWrite / flush-on-unmount pattern.
 *
 * **Config is the single source of truth.** There is NO code synthesis of
 * default view-instances: the displayed instances come *only* from the authored
 * `config.views` rows. Authored rows may be **terse** (`{ name, view }`); `id`
 * is derived on read (`normalizeRows`) and order is the array position. When
 * config has zero rows the
 * engine returns an empty instance list and the host renders a placeholder. The
 * forcing function that an agent author the config is the descriptor's
 * `requiresAuthoredOverride` opt-in: `./singularity build` seeds the config file
 * with a `// @review` marker, and `config:overrides-authored` fails until the
 * rows are reviewed and the marker deleted.
 *
 * The engine treats each row's `view` as an **opaque `VariantValue`** — it never
 * reads or writes `sort`/`filter`. The host layers those on through `viewFor` +
 * `updateView({ merge: true })`.
 *
 * `entries` is the ordered source-entry list (per-source contributions /
 * hierarchy / whitelist / options). Single-source consumers pass one implicit
 * entry (`id` undefined); each row resolves through the entry matching its
 * `source` key (`buildInstanceFromRow` — unknown source fail-softs).
 */
export function useViewsConfig<T extends ViewTypeMeta>(
  storageKey: string,
  descriptorMap: Map<string, ConfigDescriptor>,
  entries: ViewSourceEntry<T>[],
): ViewsConfigHandle {
  // Resolve the descriptor via the supplied map (reference identity against the
  // registered `ConfigV2.WebRegister` descriptor). A missing id means the marker
  // wasn't scraped into the consumer's manifest — fail loud rather than hand
  // `useConfig` an undefined descriptor (which throws opaquely downstream).
  const descriptor = descriptorMap.get(storageKey);
  if (!descriptor) {
    throw new Error(
      `view-core: no registered descriptor for storageKey "${storageKey}". ` +
        `Declare it (e.g. defineDataView("${storageKey}")) under the plugin's ` +
        `web/ and run \`./singularity build\` to regenerate the manifest.`,
    );
  }
  // No `scopeId`: runtime per-instance edits write to the user-global layer
  // (mirroring reorder's `setConfig("items", …)`). view-core is a PRIMITIVE and
  // stays app-agnostic — it never reaches for the current appId. The
  // per-`storageKey` descriptor already scopes views to one surface; if per-app
  // config is ever wanted, thread a `scopeId` in as a prop (config_v2 scoped
  // read/write is symmetric now — fork-on-write makes the scope exist on first
  // write — so a threaded scopeId would persist and read back correctly).
  // READINESS-CARRYING read (`useConfigResult`, not `useConfig`): this document
  // decides whether the surface has any views AT ALL, and `useConfig` answers
  // the not-yet-known window with the descriptor's defaults — an empty `views`
  // list, indistinguishable from a genuinely unconfigured surface. That is what
  // made a DataView flash "No views configured" for the seconds before its
  // config arrived. Here the unknown window is reported as `ready: false` and
  // the host renders a loading state instead of an answer.
  //
  // `stale` (a value the server previously vouched for, held through a
  // transient error) counts as KNOWN — showing the last-known views beats
  // showing a skeleton over data we still have.
  //
  // A failure with nothing held is NOT loading: it is reported as `failure`,
  // so the host can say so rather than spin forever.
  const configRes = useConfigResult(descriptor);
  const knownConfig = foldResource(configRes, {
    loading: () => undefined,
    error: (_error, stale) => stale,
    ready: (data) => data,
  });
  const ready = knownConfig !== undefined;
  const failure = useMemo(
    () =>
      configRes.status === "error" && configRes.stale === undefined
        ? { error: configRes.error, refetch: configRes.refetch }
        : null,
    [configRes],
  );
  const setConfig = useSetConfig(descriptor);

  // Raw (possibly terse) rows straight off the config doc. `id` is derived on
  // read so the authored file can stay terse (`{ name, view }`); order is the
  // array position.
  const configRows = (knownConfig?.views as RawViewRow[] | undefined) ?? [];

  // Optimistic mirror of the normalized persisted rows. Config is the single
  // source — an empty config means **no views** (the host renders a
  // placeholder), never synthesized defaults.
  const [mirror, setMirror] = useState<ViewConfigRow[]>(() =>
    normalizeRows(configRows),
  );

  // Freshest setConfig + key for the debounced flush.
  const setConfigRef = useLatestRef(setConfig);

  const pendingRef = useRef<ViewConfigRow[] | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `flush` stays referentially stable (scheduleWrite + the unmount effect depend
  // on it) and writes through the freshest setConfig off the stable
  // `setConfigRef.current`.
  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const next = pendingRef.current;
    if (next === null) return;
    pendingRef.current = null;
    setConfigRef.current("views", next);
  }, []);

  const scheduleWrite = useCallback(
    (next: ViewConfigRow[]) => {
      pendingRef.current = next;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, WRITE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Reconcile the mirror from config when external truth advances and we have no
  // pending write. Incoming rows are normalized (terse → full) — an empty config
  // normalizes to `[]` — and shared row-by-row with the mirror (`shareRows`), so
  // an unchanged row (or list) keeps its identity: no re-render thrash, and an
  // edit to one view leaves the others' raw values untouched.
  const configJson = JSON.stringify(configRows);
  useEffect(() => {
    if (pendingRef.current !== null) return;
    setMirror((prev) =>
      shareRows(prev, normalizeRows(JSON.parse(configJson) as RawViewRow[])),
    );
    // configRows is derived from configJson; depend on the string only.
  }, [configJson]);

  // Flush any pending durable write on unmount.
  useEffect(() => () => flush(), [flush]);

  /** Apply `mutate` against the current (normalized) rows, then optimistically
   *  mirror + schedule the write. The first UI edit thus materializes from the
   *  authored rows (or empty) — never from code. */
  const applyMutation = useCallback(
    (mutate: (rows: ViewConfigRow[]) => ViewConfigRow[]) => {
      setMirror((prev) => {
        const next = mutate(prev);
        scheduleWrite(next);
        return next;
      });
    },
    [scheduleWrite],
  );

  // The rows actually displayed: the normalized mirror (config is the only
  // source — no synthesized seed).
  const displayRows = mirror;

  // Render in array order, resolving each row through its source entry's
  // contribution registry (unknown source / orphan type → fail-soft skip).
  const instances = useMemo<ResolvedViewInstance<T>[]>(() => {
    return displayRows
      .map((row) => buildInstanceFromRow(row, entries))
      .filter((r): r is ResolvedViewInstance<T> => r !== null);
  }, [displayRows, entries]);

  const rowById = useCallback(
    (id: string): ViewConfigRow | undefined =>
      displayRows.find((r) => r.id === id),
    [displayRows],
  );

  // The RAW view value off the config row (NOT the merged code+config options),
  // so writes never persist code-only `viewOptions` keys (e.g. gallery's
  // `renderBody`). For an unknown id → undefined; the row always has a `type`
  // (the seed sets `{ type }`), so a merge spread always carries a type.
  const viewFor = useCallback(
    (id: string): VariantValue | undefined => rowById(id)?.view,
    [rowById],
  );

  const mergeView = useCallback(
    (id: string, patch: (view: VariantValue) => VariantValue) => {
      applyMutation((rows) =>
        rows.map((r) => {
          if (r.id !== id) return r;
          const next = patch(r.view);
          // Drop keys whose value is `undefined` so a host can signal "remove
          // this key" by passing `undefined`. JSON.stringify already omits
          // undefined on write, but the in-memory optimistic mirror must match
          // so the JSON-identity reconcile stays stable.
          const cleaned = Object.fromEntries(
            Object.entries(next).filter(([, v]) => v !== undefined),
          ) as VariantValue;
          return { ...r, view: cleaned };
        }),
      );
    },
    [applyMutation],
  );

  const updateView = useCallback(
    (id: string, view: VariantValue, opts?: { merge?: boolean }) => {
      // merge → shallow-merge over the existing raw view, preserving any
      // host-injected keys (sort/filter/future) the caller didn't carry. The
      // incoming `view` always carries `type`, so a type change overwrites
      // `type` + its options; stale old-type keys linger inert (same as before).
      // Default → replace wholesale.
      mergeView(id, (prev) => (opts?.merge ? { ...prev, ...view } : view));
    },
    [mergeView],
  );

  const renameView = useCallback(
    (id: string, name: string) => {
      applyMutation((rows) =>
        rows.map((r) => (r.id === id ? { ...r, name } : r)),
      );
    },
    [applyMutation],
  );

  const setViewIcon = useCallback(
    (id: string, icon: SavedSymbolName | null) => {
      applyMutation((rows) =>
        rows.map((r) =>
          r.id !== id
            ? r
            : // Rebuilt in `normalizeRows`' key order, with its conditional
              // spreads (no icon = no key), so the JSON-identity reconcile
              // sees the echoed config row as equal.
              {
                id: r.id,
                name: r.name,
                ...(icon !== null ? { icon } : {}),
                view: r.view,
                ...(r.source !== undefined ? { source: r.source } : {}),
              },
        ),
      );
    },
    [applyMutation],
  );

  const addView = useCallback(
    (type: string, sourceId?: string): string => {
      const id = newId();
      applyMutation((rows) => {
        // Seed title resolved from the target source's own contributions (both
        // possibly the implicit `undefined` entry — the single-source case).
        const entry = entries.find((e) => e.id === sourceId);
        const contribution = entry?.contributions.find((c) => c.type === type);
        // Append to the end — array position is the order. The seed row is
        // stamped with `source` only when bound to a named source, so
        // single-source rows stay byte-identical.
        return [
          ...rows,
          {
            id,
            name: contribution?.title ?? type,
            view: { type } as VariantValue,
            ...(sourceId !== undefined ? { source: sourceId } : {}),
          },
        ];
      });
      return id;
    },
    [applyMutation, entries],
  );

  const duplicateView = useCallback(
    (id: string): string => {
      const newRowId = newId();
      applyMutation((rows) => {
        const idx = rows.findIndex((r) => r.id === id);
        if (idx < 0) return rows;
        const src = rows[idx]!;
        const clone: ViewConfigRow = {
          id: newRowId,
          name: `${src.name} copy`,
          ...(src.icon !== undefined ? { icon: src.icon } : {}),
          // Deep-ish clone of the variant value (JSON-safe by construction).
          view: JSON.parse(JSON.stringify(src.view)) as VariantValue,
          // Copy the source binding explicitly (conditional spread keeps
          // source-less clones byte-identical — no `source` key).
          ...(src.source !== undefined ? { source: src.source } : {}),
        };
        // Insert immediately after the source row — array position is the order.
        return [...rows.slice(0, idx + 1), clone, ...rows.slice(idx + 1)];
      });
      return newRowId;
    },
    [applyMutation],
  );

  const deleteView = useCallback(
    (id: string) => {
      applyMutation((rows) => rows.filter((r) => r.id !== id));
    },
    [applyMutation],
  );

  const reorderView = useCallback(
    (id: string, toIndex: number) => {
      applyMutation((rows) => {
        const fromIndex = rows.findIndex((r) => r.id === id);
        if (fromIndex < 0 || fromIndex === toIndex) return rows;
        const moved = rows[fromIndex]!;
        // Remove from its current slot, then insert at the target index —
        // array position IS the order (no rank math).
        const without = rows.filter((r) => r.id !== id);
        const clamped = Math.max(0, Math.min(toIndex, without.length));
        return [...without.slice(0, clamped), moved, ...without.slice(clamped)];
      });
    },
    [applyMutation],
  );

  return useMemo(
    () => ({
      ready,
      failure,
      instances,
      viewFor,
      updateView,
      addView,
      renameView,
      setViewIcon,
      duplicateView,
      deleteView,
      reorderView,
    }),
    [
      ready,
      failure,
      instances,
      viewFor,
      updateView,
      addView,
      renameView,
      setViewIcon,
      duplicateView,
      deleteView,
      reorderView,
    ],
  );
}
