import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import { runtimeSymbol } from "@plugins/ui/plugins/icons/core";
import type {
  ViewInstance,
  ViewConfigRow,
  ViewSourceEntry,
  ViewTypeMeta,
} from "../../core";

/** A resolved view-instance paired with the view-type that renders it. */
export interface ResolvedViewInstance<T extends ViewTypeMeta = ViewTypeMeta> {
  instance: ViewInstance;
  viewType: SealContributions<T>;
}

/**
 * Build a resolved instance from a config row. Resolves the row's `source` key
 * against the supplied entry list (both possibly `undefined` — the implicit
 * sole source), then looks up the contribution by `view.type` within that
 * entry. **Fail-soft** returns `null` when:
 *   - no entry matches `row.source` (an *unknown-source* row — a renamed /
 *     removed source id; the row stays in config, it just isn't rendered until
 *     its source returns — mirroring the orphan view-type hazard below), or
 *   - no view-type is registered for `view.type` (an *orphan* row — a renamed /
 *     removed view-type id, same documented hazard as reorder node-type ids).
 *
 * The entry's `views` whitelist is deliberately NOT applied here — it gates
 * the add menu only, never authored rows (matching the single-source `views`
 * prop semantics: an authored row of a non-whitelisted type still renders).
 *
 * The instance's `icon` is the row's picked one, else the view-type's.
 *
 * The row's whole `view` value is layered **over** the entry's code-supplied
 * `viewOptions[type]` to become the instance `options`: config-authored keys
 * (`sort`/`filter`/`coverField`/…) override, while non-serializable code-only
 * options (e.g. `renderBody`, `cover`) — which can never live in a config row —
 * survive. The view-type component reads its own keys off the merged result.
 */
export function buildInstanceFromRow<T extends ViewTypeMeta>(
  row: ViewConfigRow,
  entries: ViewSourceEntry<T>[],
): ResolvedViewInstance<T> | null {
  const entry = entries.find((e) => e.id === row.source);
  if (!entry) return null;
  const viewType = entry.contributions.find((c) => c.type === row.view.type);
  if (!viewType) return null;
  const instance: ViewInstance = {
    id: row.id,
    name: row.name,
    // `viewType.icon` is the generic `T["icon"]`; widen to the concrete shape.
    icon:
      row.icon !== undefined
        ? runtimeSymbol(row.icon)
        : (viewType.icon as ViewTypeMeta["icon"]),
    pickedIcon: row.icon ?? null,
    type: row.view.type,
    ...(row.source !== undefined ? { source: row.source } : {}),
    options: {
      ...((entry.viewOptions?.[row.view.type] as object | undefined) ?? {}),
      ...(row.view as object),
    },
  };
  return { instance, viewType };
}
