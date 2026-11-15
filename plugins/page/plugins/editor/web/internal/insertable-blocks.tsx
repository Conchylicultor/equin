import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { useReorderedEntries } from "@plugins/reorder/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { Editor } from "../slots";
import { entriesToSections, type BlockSection } from "./block-sections";

/**
 * The editor's insertable block types, grouped — derived ONCE per editor and
 * read by every line's menus (`/`, gutter `+`, the rail's Turn into).
 *
 * The list is a fact of the editor (the `Editor.Block` registry, the
 * `page.editor.block` layout config, the editor's allowlist), never of a line.
 * Derived per line, a long page paid it once per block, twice (the `/` menu and
 * the rail menu are mounted on every line, open or not): ~85 ms of a 294-block
 * page's opening commit, all of it the same answer.
 */
const InsertableBlocksContext = createContext<ResourceResult<
  BlockSection[]
> | null>(null);

export function InsertableBlocksProvider({
  enabledBlockTypes,
  children,
}: {
  enabledBlockTypes: readonly string[] | undefined;
  children: ReactNode;
}) {
  const contributions = Editor.Block.useContributions();
  // The clean contributions carry `_pluginId` + `id`, which is all the reorder
  // entryKey needs; they lack `_slot`, so widen through `unknown`. A read: the
  // grouping is not known until the layout loads, and the raw registration
  // order never stands in for it (it would list hidden types, ungrouped).
  const order = useReorderedEntries(
    "page.editor.block",
    contributions as unknown as Contribution[],
  );
  const sections = useMemo(
    () =>
      mapResource(order, ({ entries }) =>
        entriesToSections(entries, enabledBlockTypes),
      ),
    [order, enabledBlockTypes],
  );
  return (
    <InsertableBlocksContext.Provider value={sections}>
      {children}
    </InsertableBlocksContext.Provider>
  );
}

/** The nearest editor's grouped insertable block types (see the provider). */
export function useEditorInsertableBlocks(): ResourceResult<BlockSection[]> {
  const sections = useContext(InsertableBlocksContext);
  if (sections === null) {
    throw new Error(
      "the insertable block types are read inside a BlockEditor surface, which derives them once for its rows",
    );
  }
  return sections;
}
