import { useState } from "react";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  matchResource,
  ResourceErrorInline,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  usePageOptions,
  useBlockActivate,
  PageOptionsList,
  type BlockRendererProps,
} from "@plugins/page/plugins/editor/web";
import {
  PageReferenceRow,
  usePageReferent,
  type PageReferent,
} from "@plugins/page/plugins/page-reference/web";
import { pageLinkBlock } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const linkIcon = symbol("link");

/**
 * A small page-picker popover: filterable list of pages fed by the live
 * `pagesTree` set (via the shared usePageOptions/PageOptionsList). Selecting a
 * page invokes `onSelect(pageId)`.
 *
 * Its open-state is the BLOCK's, not this component's, so the block can open it
 * from its caret activation (Enter) rather than on mount (`autoOpen`).
 */
function PagePicker({
  trigger,
  onSelect,
  open,
  onOpenChange,
}: {
  trigger: React.ReactElement;
  onSelect: (pageId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const pageOptionsResult = usePageOptions(query);

  return (
    <InlinePopover
      resetOnClose
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      padding="sm"
      rows
    >
      <Stack gap="sm">
        <SearchInput
          appearance="menu"
          // NOT redundant, however portaled this looks. This field reads as
          // `local` today only because the popover portals to `document.body`,
          // which severs it from the page body's `surfaceUndoProps` subtree so
          // `resolveUndoOwner`'s `closest()` walk finds nothing. That is an
          // accident: `PortalForwardProvider` re-stamps ancestry-derived `data-*`
          // across portals and already carries four, so the day
          // `data-undo-owner` joins them this flips to `surface` with no test to
          // catch it. Declared, the answer stays true either way.
          {...localUndoProps}
          autoFocus
          placeholder="Search pages…"
          keep={transient(
            "a picker popover's filter: a reload does not reopen the popover, and it resets on close",
          )}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Scroll className="max-h-64">
          {matchResource(pageOptionsResult, {
            loading: () => <Loading variant="rows" />,
            ready: (options) => (
              <PageOptionsList
                options={options}
                activeIndex={activeIndex}
                onHoverIndex={setActiveIndex}
                onSelect={(id) => {
                  onSelect(id);
                  onOpenChange(false);
                  setQuery("");
                }}
              />
            ),
          })}
        </Scroll>
      </Stack>
    </InlinePopover>
  );
}

export function PageLinkBlock({ block, editor }: BlockRendererProps) {
  const { pageId } = pageLinkBlock.parse(block.data);
  const referent = usePageReferent(pageId === "" ? null : pageId);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Which arm below will render, as a UNION that CARRIES the resolved page
  // rather than a flag the resolved arm then has to re-derive. A hook must run
  // before any early return, so the state has to be computed up here; making
  // it a union is what keeps "not known yet" its own answer instead of
  // collapsing into "no such page" on the way — and "in the trash" its own
  // answer instead of "not found".
  const link: { state: "unset" } | PageReferent =
    pageId === "" ? { state: "unset" } : referent;

  // Both arms that render a picker make "open it" the block's primary action, so
  // inserting a page-link and pressing Enter picks a page — the single step
  // `autoOpen` used to buy, without racing the caret host for focus. Neither the
  // pending nor the resolved arm registers one: on a resolved link Enter means
  // "start a paragraph below", which is the host's own answer, and while the
  // page set is still loading there is nothing yet to pick from.
  useBlockActivate(
    link.state === "unset" || link.state === "missing"
      ? () => setPickerOpen(true)
      : null,
  );

  // Freshly inserted (empty) block: render the picker affordance.
  // Show it even while pending — it has its own internal loading state.
  if (link.state === "unset") {
    return (
      <div className="px-md py-xs">
        <PagePicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onSelect={(id) => editor.update({ pageId: id })}
          trigger={
            <Row
              className="text-muted-foreground"
              icon={<Icon icon={linkIcon} />}
            >
              Select a page…
            </Row>
          }
        />
      </div>
    );
  }

  // Which page this links to is not known yet — so say THAT, at the height a
  // page-link row occupies. Rendering nothing was a claim ("no link here") that
  // then reversed itself, and it left a zero-height focusable box the caret host
  // sits in while `rowAtPointer`'s `r.height > 0` guard skips right over it.
  if (link.state === "pending") {
    return (
      <div className="px-md py-xs">
        <Loading variant="text" label="Loading page…" />
      </div>
    );
  }

  if (link.state === "failed") {
    return (
      <div className="px-md py-xs">
        <ResourceErrorInline
          error={link.error}
          refetch={link.refetch}
          variant="inline"
          subject="the linked page"
        />
      </div>
    );
  }

  // Target page was purged (or never was one): offer a muted not-found row
  // that re-opens the picker.
  if (link.state === "missing") {
    return (
      <div className="px-md py-xs">
        <PagePicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onSelect={(id) => editor.update({ pageId: id })}
          trigger={
            <Row
              icon={<Icon icon={linkIcon} className="text-muted-foreground" />}
            >
              <Placeholder>(page not found)</Placeholder>
            </Row>
          }
        />
      </div>
    );
  }

  // Target page is in the trash: still THE page-reference row, its title
  // struck through — it opens the page read-only, where it can be restored.
  if (link.state === "trashed") {
    return (
      <div className="px-md py-xs">
        <PageReferenceRow
          pageId={pageId}
          page={link.data}
          fallbackIcon={linkIcon}
          trashed
        />
      </div>
    );
  }

  // Resolved link: THE page-reference row the sub-page block draws too, so a
  // linked page looks exactly like its original (an instructions page keeps its
  // wash and Global chip). The page's own data rides on the union arm, so there
  // is no second lookup here. A page with no icon shows the link glyph.
  return (
    <div className="px-md py-xs">
      <PageReferenceRow
        pageId={pageId}
        page={link.data}
        fallbackIcon={linkIcon}
      />
    </div>
  );
}
