import { defineFacet } from "@plugins/plugin-meta/plugins/facets/core";
import type {
  PluginId,
  RuntimeFolder,
} from "@plugins/framework/plugins/plugin-id/core";

/** One cross-plugin import: the target plugin id, plus the imported symbol for
 *  named imports (absent for namespace/default/side-effect imports). */
export interface ApiUse {
  plugin: PluginId;
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

export interface CrossRefsData {
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
}

export const crossRefsFacetDef = defineFacet<CrossRefsData>("cross-refs");
