import { createContext, useContext, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
  defineItemActions,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  matchResource,
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import { pageDetailRoute } from "@plugins/apps/plugins/pages/plugins/page-tree/core";
import { pagesApp } from "@plugins/apps/plugins/pages/plugins/shell/core";
import { usePlaceDetails } from "@plugins/apps/plugins/places/plugins/place-details/web";
import {
  isRoleTag,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  pageOverlayItemKind,
  type PageOverlayItem,
} from "@plugins/apps/plugins/places/plugins/page-overlay/core";
import type { PageOverlay } from "@plugins/apps/plugins/places/plugins/page-overlay/web";
import { placeVisual } from "../internal/place-visual";
import { pageItemPinData } from "../internal/page-item";
import { PANEL_WIDTH } from "./card-frame";
import { PlacePhotoWash } from "./place-glyph";
import { RatingLine } from "./place-facts";
import { TagChip } from "./tag-chip";

/**
 * The page's places beside the map: one list (config
 * `config/apps/places/places-map/places.page-overlay.jsonc`), in page order.
 */
const PAGE_OVERLAY_VIEW = defineDataView("places.page-overlay");

/** The page's places' row actions: Save on a place not saved yet. */
export const PageOverlayItemActions = defineItemActions<PageOverlayItem>();

/**
 * Who saves a page's place: the screen around the panel (its Save hands the
 * place to `useSavePlace` and toasts the Undo). An action component receives
 * only its row, so the panel provides the handler around its list.
 */
const PageOverlaySaveContext = createContext<
  ((item: PageOverlayItem) => Promise<void>) | null
>(null);

const closeIcon = symbol("close");
const pageIcon = symbol("description");
const backIcon = symbol("arrow-back");
const fitIcon = symbol("fit-screen");
const addIcon = symbol("add");
const savedIcon = symbol("check");
const saveAllIcon = symbol("bookmark-add");

/** The overlay accent (`place-palette`'s `--place-overlay`) as text, as a wash, as a fill. */
const OVERLAY_TEXT = "text-(--place-overlay)";
const OVERLAY_WASH = "bg-(--place-overlay)/12";
const OVERLAY_FILL =
  "bg-(--place-overlay) text-categorical-foreground hover:bg-(--place-overlay)/90";

/** The list has no band: the panel's header is its chrome. */
function ListFrame({ body }: HostedToolbarParts): ReactNode {
  return body;
}

const LIST_TOOLBAR: HostedToolbar = { kind: "hosted", frame: ListFrame };

/** Save on a page's place not saved yet; a saved one has nothing to offer. */
export function SavePageItemAction({
  row,
}: ItemActionProps<PageOverlayItem>): ReactNode {
  const onSave = useContext(PageOverlaySaveContext);
  if (onSave === null) {
    throw new Error(
      "SavePageItemAction rendered outside the page overlay panel's list",
    );
  }
  if (row.saved !== null) return null;
  return (
    <Button
      variant="outline"
      shape="pill"
      aria-label={`Save ${row.name}`}
      onClick={(e) => {
        e.stopPropagation();
        return onSave(row);
      }}
    >
      <Icon icon={addIcon} />
      Save
    </Button>
  );
}

/**
 * The overlay's read before its reader (mounted only while `;page` is set)
 * has reported anything: loading, by hand — the panel's own state, never the
 * map's.
 */
export const PAGE_OVERLAY_UNREPORTED = { status: "loading" } as const;

/** The page laid over the map, as the panel draws it: its read, or not reported yet. */
export type PageOverlayRead =
  ResourceResult<PageOverlay> | typeof PAGE_OVERLAY_UNREPORTED;

export interface PageOverlayPanelProps {
  /**
   * The page's read: the panel draws its loading and failure itself, inside
   * its own frame — the map around it never waits for the page.
   */
  overlay: PageOverlayRead;
  tags: readonly PlaceTag[];
  /** The page item hovered here or on the map, by block id. */
  hoveredBlockId: string | null;
  onHoverChange: (blockId: string, hovered: boolean) => void;
  /** The open item's block id (its row selected). */
  selectedBlockId: string | null;
  onSelect: (item: PageOverlayItem) => void;
  onSave: (item: PageOverlayItem) => Promise<void>;
  /** Save every page place not saved yet, as one Undo. */
  onSaveAll: (items: readonly PageOverlayItem[]) => Promise<void>;
  /** Frame the page's places on the map. */
  onFit: () => void;
  /** Close the layer (back to the plain map). */
  onClose: () => void;
  /** An item's card drilled into the panel under the given back line, or null: the list. */
  drill: ((back: ReactNode) => ReactNode) | null;
  /** Back from a drilled card to the list. */
  onBack: () => void;
}

/**
 * A page's places laid over the map, as the panel on the right (the side
 * panel's spot and width): "From a page" and × (back to the plain map); the
 * page's icon and title with "← Page" (open it in Pages); "N places · k saved
 * · m not saved" (and the places not on the map); the places as a list —
 * Google's photo, their number, name, rating · type, then ✓ Saved and its tags
 * or the address with Save — hover-linked with their pins; and a footer with
 * Fit and Save all. Selecting one drills its card into the panel, under
 * "← <page> · k of N".
 */
export function PageOverlayPanel(props: PageOverlayPanelProps): ReactNode {
  const { overlay, onClose } = props;
  return matchResource(overlay, {
    ready: (data) => <ReadPanel {...props} overlay={data} />,
    loading: () => (
      <SourceFrame onClose={onClose} body={<Loading variant="block" />} />
    ),
    error: (error) => (
      <SourceFrame
        onClose={onClose}
        body={
          <ResourceErrorInline
            error={error}
            variant="block"
            subject="the page"
            {...(overlay.status === "error"
              ? { refetch: overlay.refetch }
              : {})}
          />
        }
      />
    ),
  });
}

/** The panel with only "From a page" and × over a body: the page not read, or gone. */
function SourceFrame({
  onClose,
  body,
}: {
  onClose: () => void;
  body: ReactNode;
}): ReactNode {
  return (
    <Column
      fill
      style={{ width: PANEL_WIDTH }}
      header={
        <Stack gap="xs" className="border-b px-sm pt-sm pb-xs">
          <SourceLine onClose={onClose} />
        </Stack>
      }
      body={body}
    />
  );
}

function ReadPanel(
  props: Omit<PageOverlayPanelProps, "overlay"> & { overlay: PageOverlay },
): ReactNode {
  const { overlay, onClose, drill, onBack } = props;
  if (overlay.kind === "missing") {
    return (
      <SourceFrame
        onClose={onClose}
        body={
          <Placeholder>
            This page no longer exists — there are no places to show.
          </Placeholder>
        }
      />
    );
  }
  if (drill !== null) {
    const open = overlay.items.find((i) => i.blockId === props.selectedBlockId);
    return drill(
      <Line className="border-b p-2xs">
        <Button variant="ghost" onClick={onBack} className={OVERLAY_TEXT}>
          <Icon icon={backIcon} />
          {overlay.page.title}
          {open === undefined ? null : (
            <Text variant="caption" tone="muted">
              {`· ${open.n} of ${overlay.items.length}`}
            </Text>
          )}
        </Button>
      </Line>,
    );
  }
  return <PanelList {...props} overlay={overlay} />;
}

/** "From a page" and the × that closes the layer. */
function SourceLine({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <Line className="gap-xs">
      <Badge
        shape="pill"
        icon={<Icon icon={pageIcon} />}
        className={cn(OVERLAY_TEXT, OVERLAY_WASH)}
      >
        From a page
      </Badge>
      <Fill />
      <IconButton
        icon={closeIcon}
        label="Close the page — back to your map"
        onClick={onClose}
      />
    </Line>
  );
}

function PanelList(
  props: Omit<PageOverlayPanelProps, "overlay"> & {
    overlay: Extract<PageOverlay, { kind: "page" }>;
  },
): ReactNode {
  const {
    overlay,
    tags,
    hoveredBlockId,
    onHoverChange,
    selectedBlockId,
    onSelect,
    onSave,
    onSaveAll,
    onFit,
    onClose,
  } = props;
  const { page, items, unplaced } = overlay;
  const inAppLinkProps = useAppLinkProps();
  const fresh = items.filter((i) => i.saved === null);
  const saved = items.length - fresh.length;
  return (
    <Column
      fill
      style={{ width: PANEL_WIDTH }}
      header={
        <Stack gap="xs" className="border-b px-sm pt-sm pb-xs">
          <SourceLine onClose={onClose} />
          <Line className="gap-xs">
            <PageIcon icon={page.icon} className="size-5" />
            <Fill>
              <Text variant="heading" tone="strong">
                {page.title}
              </Text>
            </Fill>
            <Button
              variant="ghost"
              className={OVERLAY_TEXT}
              {...inAppLinkProps(
                pageDetailRoute.link(pagesApp, { pageId: page.id }),
              )}
            >
              <Icon icon={backIcon} />
              Page
            </Button>
          </Line>
          <Line className="gap-sm">
            <Text variant="caption" tone="muted">
              <strong className="text-foreground">{items.length}</strong>
              {items.length === 1 ? " place" : " places"}
            </Text>
            <SummaryKey kind="saved">{`${saved} saved`}</SummaryKey>
            {fresh.length > 0 ? (
              <SummaryKey kind="fresh">{`${fresh.length} not saved`}</SummaryKey>
            ) : null}
            {unplaced > 0 ? (
              <Text variant="caption" tone="muted">
                {`${unplaced} not on the map`}
              </Text>
            ) : null}
          </Line>
        </Stack>
      }
      body={
        items.length === 0 ? (
          <Placeholder>
            No Google place on this page has a location yet.
          </Placeholder>
        ) : (
          <PageOverlaySaveContext.Provider value={onSave}>
            <DataView<PageOverlayItem>
              storageKey={PAGE_OVERLAY_VIEW}
              rows={items}
              collection={pageOverlayItemKind}
              rowKey={(i) => i.blockId}
              views={["list"]}
              pinnedView="list"
              toolbar={LIST_TOOLBAR}
              itemActions={PageOverlayItemActions}
              viewOptions={{
                list: {
                  actionsAtRest: true,
                  renderRow: (i: PageOverlayItem) => (
                    <PageItemRow item={i} tags={tags} />
                  ),
                },
              }}
              onRowActivate={onSelect}
              selectedRowId={selectedBlockId ?? undefined}
              hoveredRowId={hoveredBlockId}
              onRowHoverChange={onHoverChange}
            />
          </PageOverlaySaveContext.Provider>
        )
      }
      footer={
        <Line className="gap-xs border-t px-sm py-xs">
          <IconButton
            icon={fitIcon}
            label="Fit the page's places"
            onClick={onFit}
          />
          <Fill>
            <Text variant="caption" tone="muted">
              {fresh.length > 0
                ? `${fresh.length} not in your places yet`
                : "All of them are in your places"}
            </Text>
          </Fill>
          {fresh.length > 0 ? (
            <Button className={OVERLAY_FILL} onClick={() => onSaveAll(fresh)}>
              <Icon icon={saveAllIcon} />
              {`Save all ${fresh.length}`}
            </Button>
          ) : null}
        </Line>
      }
    />
  );
}

/** One summary count with its key: a solid dot (saved) or a dashed ring (not saved). */
function SummaryKey({
  kind,
  children,
}: {
  kind: "saved" | "fresh";
  children: ReactNode;
}): ReactNode {
  return (
    <Line className="gap-2xs">
      <span
        aria-hidden
        className={cn(
          "block size-2 rounded-full",
          rigidClass(),
          kind === "saved"
            ? "bg-(--place-overlay)"
            : "border-[1.5px] border-dashed border-(--place-overlay) bg-background",
        )}
      />
      <Text variant="caption" tone="muted">
        {children}
      </Text>
    </Line>
  );
}

/**
 * One page place's row body: Google's photo (else its colours' wash) with its
 * number on the corner, its name, Google's rating and its type, then ✓ Saved
 * and its tags — or, not saved yet, its address (Save is the row's action).
 */
function PageItemRow({
  item,
  tags,
}: {
  item: PageOverlayItem;
  tags: readonly PlaceTag[];
}): ReactNode {
  const details = usePlaceDetails(item.googlePlaceId);
  const facts =
    details.status === "ready" &&
    details.data.kind === "ok" &&
    details.data.tier !== "photos"
      ? details.data.details
      : null;
  const pin = pageItemPinData(item);
  const visual =
    item.saved !== null
      ? placeVisual(item.saved, tags)
      : { colors: [pin.color], mainColor: pin.color, icon: pin.icon };
  const type = item.category ?? item.saved?.primaryType ?? null;
  const ownTags =
    item.saved === null
      ? []
      : item.saved.tags
          .filter((id) => !isRoleTag(id, tags))
          .flatMap((id) => tags.filter((t) => t.id === id))
          .slice(0, 2);
  return (
    // The row's one flexible cell: the body below truncates in it, so its
    // text never runs under the row's Save.
    <Fill>
      <Line className="gap-sm py-2xs">
        <span className={cn("relative block size-14 rounded-lg", rigidClass())}>
          <span
            className={cn(
              "block size-full rounded-lg",
              clipClasses({ axis: "both", fill: false }),
            )}
          >
            <PlacePhotoWash
              visual={visual}
              googlePlaceId={item.googlePlaceId}
              iconClassName={cn("size-6")}
            />
          </span>
          <Pin to="top-left" offset="2xs" outset>
            <Badge
              shape="pill"
              className={cn(OVERLAY_FILL, "ring-2 ring-background")}
            >
              {String(item.n)}
            </Badge>
          </Pin>
        </span>
        <Fill>
          <Stack gap="none">
            <Text variant="label" tone="strong" className="truncate">
              {item.name}
            </Text>
            <Line className="gap-2xs">
              {facts?.rating !== undefined ? (
                <RatingLine details={{ rating: facts.rating }} />
              ) : null}
              {type !== null ? (
                <Text variant="caption" tone="muted">
                  {facts?.rating !== undefined ? `· ${type}` : type}
                </Text>
              ) : null}
            </Line>
            {item.saved !== null ? (
              <Line className="gap-2xs">
                <Icon
                  icon={savedIcon}
                  className={cn("size-3.5", rigidClass(), OVERLAY_TEXT)}
                />
                <Text variant="caption" className={OVERLAY_TEXT}>
                  Saved
                </Text>
                {ownTags.map((t) => (
                  <TagChip key={t.id} tag={t} tags={tags} tinted />
                ))}
              </Line>
            ) : item.address !== undefined ? (
              <Text variant="caption" tone="muted" className="truncate">
                {item.address}
              </Text>
            ) : null}
          </Stack>
        </Fill>
      </Line>
    </Fill>
  );
}
