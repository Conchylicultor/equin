import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ComponentType, ReactNode } from "react";
import {
  defineRenderSlot,
  type RenderSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import type { DataViewSourceBundle } from "./body-types";

/**
 * Props a contributed source component receives. The component owns its data
 * hooks (rows, live resources, fields, …) and hands the resulting bundle back
 * through `render` — the render-callback shape of `FieldExtensionProps`.
 */
export interface DataViewSourceProps<THostProps> {
  /** The host surface's own props, threaded verbatim to every source (ids,
   *  callbacks, selection — whatever the consumer's sources need). */
  hostProps: THostProps;
  /**
   * Hand the host this source's data bundle. **MUST always be called** — while
   * data is loading pass `{ rows: [], loading: true, … }`; never early-return
   * `null` instead (the toolbar/switcher chrome the host renders through this
   * callback would vanish with it).
   */
  render: <TRow>(bundle: DataViewSourceBundle<TRow>) => ReactNode;
}

/**
 * One contributed source of a merged DataView surface. `views` is **static
 * contribution metadata** (not part of the render-time bundle) on purpose: the
 * view model must resolve *every* config row — switcher chips, add-menu gating
 * — before any source component mounts,
 * and only the ACTIVE source ever mounts. Everything dynamic (rows, fields,
 * rowKey, the actual `hierarchy` accessors, viewOptions, source, …) stays
 * in the bundle.
 */
export interface DataViewSourceContribution<THostProps> {
  /** The config row's `source` key (stable — renaming it orphans authored rows). */
  id: string;
  /** Add-menu group label. */
  title: string;
  icon: IconRef;
  order?: number;
  /** STATIC view-type whitelist for this source's add-menu group. */
  views?: string[];
  component: ComponentType<DataViewSourceProps<THostProps>>;
}

/**
 * The minted value. Like `FieldExtensions`, the surface the host reads (`id` +
 * `useContributions`) is ALREADY provided by `RenderSlot`, so this only extends
 * `RenderSlot`.
 */
export interface DataViewSources<THostProps> extends RenderSlot<
  DataViewSourceContribution<THostProps>
> {}

/**
 * Mint a per-consumer data-view source slot. The returned value is **callable
 * for contributions** (`MySources({ id, title, icon, component })`, like any
 * `defineRenderSlot` result). Mirrors `defineItemActions` /
 * `defineFieldExtensions`: disjoint host-prop types per consumer → a factory,
 * not a global slot.
 *
 * Pass the result to `<MergedDataView sources={MySources} />`; the host builds
 * one `ViewSourceEntry` per contribution from the static metadata, resolves the
 * unified view model over ONE config file, and mounts only the active
 * instance's source component.
 */
export function defineDataViewSources<
  THostProps,
>(): DataViewSources<THostProps> {
  return defineRenderSlot<DataViewSourceContribution<THostProps>>({
    docLabel: (p) => p.title,
  });
}
