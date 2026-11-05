import { defineFacet } from "@plugins/plugin-meta/plugins/facets/core";
import {
  asPath,
  type PluginId,
  type RuntimeFolder,
} from "@plugins/framework/plugins/plugin-id/core";
import type { KeySpace } from "@plugins/framework/plugins/slot-declaration/core";

/** One cross-plugin import: the target plugin id, the target's barrel folder
 *  it reaches (`@plugins/<target>/<barrel>`), plus the imported symbol for
 *  named imports (absent for namespace/default/side-effect imports).
 *
 *  Filed under the IMPORTING folder (`apiUses[rt]`), whatever barrel it
 *  reaches: a `machine/` file importing `@plugins/x/server` is a `machine` use
 *  with `barrel: "server"`. That is what lets the closure engine ask which
 *  host executes the import (`HOST_RUNTIMES`). */
export interface ApiUse {
  plugin: PluginId;
  barrel: RuntimeFolder;
  symbol?: string;
}

/** Transient raw import recorded by extract() (which has no tree); relate()
 *  resolves these to ApiUse via resolvePluginSpecifier and clears the field. */
export interface RawUse {
  specifier: string;
  symbol?: string;
}

/** A token group this plugin declares (`defineTokenGroup` in its `core/`). */
export interface DeclaredTokenGroup {
  id: string;
  /** The CSS custom properties the group supplies, sorted. */
  vars: string[];
}

/**
 * Theme tokens this plugin reads that another plugin's token group supplies —
 * a literal `var(--x)` or a Tailwind class compiling to one. A dependency like
 * an import: without the owner's group registered the var is never painted.
 */
export interface TokenUse {
  /** The plugin declaring the group. */
  plugin: PluginId;
  group: string;
  /** The vars read, sorted. */
  vars: string[];
}

/**
 * One key of a {@link KeySpace} — a field type's id, a DataView view type —
 * that a plugin defines or references. What decides whether a KEYED companion
 * ships (the date cell, the map view renderer): see `SlotCompanions`.
 */
export interface KeyRef {
  space: KeySpace;
  key: string;
}

export interface CrossRefsData {
  /** Every cross-plugin import, keyed by the folder that WRITES it (see
   *  {@link ApiUse}) — cross-runtime ones included (`web/` → `x/core`). */
  apiUses: Record<RuntimeFolder, ApiUse[]>;
  importedBy: PluginId[];
  raw?: Record<RuntimeFolder, RawUse[]>;
  tokenGroups: DeclaredTokenGroup[];
  tokenUses: TokenUse[];
  /** The reverse of `tokenUses`: the plugins reading this plugin's token groups. */
  tokenUsedBy: PluginId[];
  /** Transient: every var this plugin's shipped source reads, set by
   *  prepareRelate(); relate() resolves the token-group ones and clears it. */
  rawVars?: string[];
  /** The keys this plugin DEFINES (`defineFieldType("date")` in its `core/`). */
  keyDefs: KeyRef[];
  /**
   * The keys this plugin's shipped code USES, sorted: the field types it
   * defines or spells (`type: "date"`, kept only when some plugin defines that
   * type), and the view types its DataViews author (`config/<plugin>/<id>.jsonc`
   * rows) or whitelist (`views={["map"]}`). A keyed companion serving one of
   * them ships in every bundle holding this plugin and the companion's owner.
   */
  keyRefs: KeyRef[];
  /** Transient: this plugin's `defineDataView("<id>")` ids, set by extract();
   *  relate() reads their authored config rows into `keyRefs` and clears it. */
  rawDataViews?: string[];
}

export const crossRefsFacetDef = defineFacet<CrossRefsData>("cross-refs");

/**
 * One use as the surfaces print it, under the folder `rt` that writes it:
 * `x/y.sym` when it reaches `rt`'s own barrel, `x/y/core.sym` when it crosses
 * into another (`web/` → `x/y/core`). Unique within a folder's uses — the
 * facet dedupes on (plugin, barrel, symbol) — so it is also a row key.
 */
export function apiUseLabel(u: ApiUse, rt: RuntimeFolder): string {
  const barrel = u.barrel === rt ? "" : `/${u.barrel}`;
  return `${asPath(u.plugin)}${barrel}${u.symbol ? "." + u.symbol : ""}`;
}
