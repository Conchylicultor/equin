import { useState } from "react";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  matchResource,
  ResourceErrorInline,
  type ResourceError,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { type LiveRowResult, useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  pagesTree,
  pageData,
  type PageRow,
} from "@plugins/page/plugins/editor/core";
import {
  usePageOptions,
  useBlockActivate,
  PageOptionsList,
  type BlockRendererProps,
} from "@plugins/page/plugins/editor/web";
import { PageReferenceRow } from "@plugins/page/plugins/page-reference/web";
import { pageLinkBlock } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const linkIcon = symbol("link");

/**
 * The five states a page-link row can be in.
 *
 * A union rather than "the page, or undefined", because two of the four —
 * *loading* and *no such page* — would otherwise both spell themselves
 * `undefined`, and they mean opposite things to the reader: one is a promise
 * that an answer is coming, the other is the answer. The resolved arm carries
 * the page it resolved to, so the render cannot look it up a second time (nor
 * assert it away with a `!`).
 */
type PageLinkState =
  | { state: "unset"; data?: undefined }
  | { state: "pending"; data?: undefined }
  | {
      state: "failed";
      data?: undefined;
      error: ResourceError;
      refetch: () => Promise<void>;
    }
  | { state: "missing"; data?: undefined }
  | { state: "resolved"; data: ReturnType<typeof pageData> };

function resolvedOrMissing(row: PageRow | undefined): PageLinkState {
  return row === undefined
    ? { state: "missing" }
    : { state: "resolved", data: pageData(row) };
}

/** A linked page's row read, as the row's state. */
function linkStateOf(result: LiveRowResult<PageRow>): PageLinkState {
  switch (result.status) {
    case "loading":
      return { state: "pending" };
    // A failed read that once had the page keeps resolving from it; without
    // one, the row says the read failed.
    case "error":
      return result.stale === undefined
        ? { state: "failed", error: result.error, refetch: result.refetch }
        : resolvedOrMissing(result.stale);
    case "ready":
      return resolvedOrMissing(result.found ? result.row : undefined);
  }
}

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
  const result = useLive(pagesTree, { id: pageId === "" ? null : pageId });
  const [pickerOpen, setPickerOpen] = useState(false);

  // Which of the five arms below will render, as a UNION that CARRIES the
  // resolved page rather than a flag the resolved arm then has to re-derive. A
  // hook must run before any early return, so the state has to be computed up
  // here; making it a union is what keeps "not known yet" its own answer instead
  // of collapsing into "no such page" on the way.
  const link: PageLinkState =
    pageId === "" ? { state: "unset" } : linkStateOf(result);

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

  // Target page was deleted: offer a muted not-found row that re-opens the picker.
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
