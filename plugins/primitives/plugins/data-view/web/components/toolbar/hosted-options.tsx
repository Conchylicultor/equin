import type { ReactNode } from "react";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { CompactControls } from "./compact-controls";
import { useToolbarControls } from "./use-toolbar-controls";
import { QuickFilters } from "./quick-filters";
import type { QuickFilter } from "../../../core";

/**
 * A hosted surface's options trigger (`HostedToolbarParts.options`): the
 * compact fold's one `MdTune` trigger — search on its first page, then one row
 * per applicable control — standing on its own in the frame's header instead of
 * at the end of a band.
 *
 * The same `CompactControls` the band's fold renders, so the two cannot drift:
 * the same panel, the same badge (controls + a non-empty query), and the same
 * hover reveal — keyed off the DataView root, which the shell marks as the
 * reveal group when the toolbar is hosted, since there is no band to point at.
 * Must render inside the body's `DataViewControlsProvider`.
 */
export function HostedOptions({
  query,
  onQueryChange,
  searchPlaceholder = "Search…",
  revealOnHover = true,
  quickFilters,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  searchPlaceholder?: string;
  /** `false`: visible at rest — the frame's `forms.options: "visible"`. */
  revealOnHover?: boolean;
  /** `DataViewProps.quickFilters`, on the first page under the search. */
  quickFilters?: readonly QuickFilter[] | undefined;
}): ReactNode {
  const controls = useToolbarControls();
  const searching = query.length > 0;
  return (
    <CompactControls
      search={
        <SearchInput
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={searchPlaceholder}
          appearance="menu"
        />
      }
      quickFilters={
        quickFilters === undefined || quickFilters.length === 0 ? null : (
          <QuickFilters quickFilters={quickFilters} layout="column" />
        )
      }
      controls={controls}
      searching={searching}
      revealOnHover={revealOnHover}
    />
  );
}
