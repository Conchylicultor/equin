import { useCallback, useMemo, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
  useDataViewControls,
  useFlatRows,
  type CoverContent,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { MapBounds } from "@plugins/map/core";
import {
  places as placesCollection,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  PLACE_OVERRIDES,
  placeExtraFields,
  placeSearchText,
} from "../internal/fields";
import type { PanelLayout, PanelScope } from "../internal/layout-stores";
import { scopePlaces } from "../internal/panel-scope";
import { placeVisual } from "../internal/place-visual";
import { PANEL_WIDTH } from "./card-frame";
import { PlaceCover, PlaceGlyph } from "./place-glyph";

/**
 * The side panel's own surface: the active preset's places as a list or a
 * gallery. Config-backed like every DataView — the two views and their
 * fields live in `config/apps/places/places-map/places.panel.jsonc`; the
 * panel pins the one its layout names, so it has no switcher. Neither view
 * sorts: the rows come in the preset's order (its Sort, from the toolbar).
 */
const PANEL_VIEW = defineDataView("places.panel");

const listIcon = symbol("view-list");
const galleryIcon = symbol("grid-view");
const hideIcon = symbol("right-panel-close");
const backIcon = symbol("arrow-back");
const fitIcon = symbol("fit-screen");
const outOfViewIcon = symbol("travel-explore");
const noMatchIcon = symbol("filter-alt-off");

/** The panel's DataView has no band: the panel's header is its chrome. */
function PanelFrame({ body }: HostedToolbarParts): ReactNode {
  return body;
}

const PANEL_TOOLBAR: HostedToolbar = { kind: "hosted", frame: PanelFrame };

// Icon-only segments, named for assistive tech (and scripts) by hidden text.
const LAYOUT_OPTIONS = [
  {
    id: "list",
    label: (
      <>
        <Icon icon={listIcon} />
        <span className="sr-only">List</span>
      </>
    ),
    tooltip: "List",
  },
  {
    id: "gallery",
    label: (
      <>
        <Icon icon={galleryIcon} />
        <span className="sr-only">Gallery</span>
      </>
    ),
    tooltip: "Gallery",
  },
] as const;

export interface PlacesPanelProps {
  /** Every saved place: the active preset's rows are read over them. */
  places: readonly Place[];
  tags: readonly PlaceTag[];
  /** The part of the map the chrome leaves uncovered; null until the camera first rests. */
  visible: MapBounds | null;
  layout: PanelLayout;
  onLayoutChange: (layout: PanelLayout) => void;
  scope: PanelScope;
  onScopeChange: (scope: PanelScope) => void;
  selectedId: string | null;
  onSelect: (place: Place) => void;
  /** The place hovered here or on the map: its row and its pin light together. */
  hoveredId: string | null;
  onHoverChange: (id: string, hovered: boolean) => void;
  /** Frame every place of the preset on the map. */
  onFit: () => void;
  /**
   * A card drilled into the panel (the selected place's, or a Google
   * place's), drawn under the given Back line — or null: the list.
   */
  drill: ((back: ReactNode) => ReactNode) | null;
  /** Back from a drilled card to the list (deselects). */
  onBack: () => void;
}

/**
 * The surface's `asideEnd`: the active preset's places beside the map. The
 * header scopes them — "In view N" (the places inside the part of the map the
 * chrome leaves uncovered, following the camera) or "All M" — and picks the
 * layout (list | gallery) or hides the panel. Hidden, it is a small pill
 * (the preset's name and count) that shows it again. The places are the
 * presets DataView's own rows (`useFlatRows` over its controls: the preset's
 * filter and the search), listed by a second DataView (`places.panel`).
 * Selecting one drills its card into the panel, with Back to the list.
 */
export function PlacesPanel(props: PlacesPanelProps): ReactNode {
  const { places, layout, onLayoutChange, scope, drill, onBack } = props;
  const { fields, activeState, filter, viewModel, activeViewId } =
    useDataViewControls();
  const preset =
    viewModel.instances.find((r) => r.instance.id === activeViewId)?.instance
      .name ?? activeViewId;
  const rows = useFlatRows(
    places,
    fields as FieldDef<Place>[],
    activeState,
    filter.resolveOperatorSet,
    placeSearchText,
  );

  if (layout === "hidden") {
    return (
      <Button
        variant="ghost"
        onClick={() => onLayoutChange("list")}
        aria-label={`Show the list — ${preset}, ${rows.length} places`}
      >
        <Icon icon={listIcon} />
        {preset}
        <Text variant="count" tone="muted">
          {rows.length}
        </Text>
      </Button>
    );
  }

  if (drill !== null) {
    return drill(
      <Line className="border-b p-2xs">
        <Button variant="ghost" onClick={onBack}>
          <Icon icon={backIcon} />
          {`${preset} · ${scope === "in-view" ? "in view" : "all"}`}
        </Button>
      </Line>,
    );
  }

  return <PanelList {...props} layout={layout} rows={rows} preset={preset} />;
}

function PanelList(
  props: PlacesPanelProps & {
    layout: "list" | "gallery";
    /** The active preset's places (filter and search applied). */
    rows: readonly Place[];
    preset: string;
  },
): ReactNode {
  const {
    visible,
    layout,
    onLayoutChange,
    scope,
    onScopeChange,
    rows,
    preset,
    onFit,
  } = props;
  const scoped = useMemo(
    () =>
      visible === null
        ? null
        : scopePlaces(rows, visible, scope, (p) => p.location),
    [rows, visible, scope],
  );

  const showAll = (
    <Button variant="link" onClick={() => onScopeChange("all")}>
      Show all
    </Button>
  );
  const fit = (
    <Button variant="link" onClick={onFit}>
      <Icon icon={fitIcon} />
      Fit map
    </Button>
  );

  let body: ReactNode;
  let footer: ReactNode = null;
  if (scoped === null) {
    // The camera has not rested yet: what is in view is not known.
    body = <Loading variant="block" />;
  } else if (rows.length === 0) {
    body = (
      <PanelEmpty icon={noMatchIcon}>
        No place matches <strong>{preset}</strong>.
      </PanelEmpty>
    );
  } else if (scoped.shown.length === 0) {
    body = (
      <Stack gap="sm" className="p-md">
        <PanelEmpty icon={outOfViewIcon}>
          None of the {rows.length} places of <strong>{preset}</strong> are in
          view.
        </PanelEmpty>
        <Center axis="horizontal">
          <Line className="gap-sm">
            {fit}
            {showAll}
          </Line>
        </Center>
      </Stack>
    );
  } else {
    body = <PanelRows {...props} shown={scoped.shown} />;
    if (scope === "in-view" && scoped.outside > 0) {
      footer = (
        <Line className="gap-xs border-t px-sm py-xs">
          <Fill>
            <Text variant="caption" tone="muted">
              {`${scoped.outside} more outside the map`}
            </Text>
          </Fill>
          {fit}
          {showAll}
        </Line>
      );
    }
  }

  return (
    <Column
      fill
      style={{ width: PANEL_WIDTH }}
      header={
        <Line className="gap-xs border-b p-xs">
          <SegmentedControl<PanelScope>
            label="Which places"
            value={scope}
            onChange={onScopeChange}
            options={[
              {
                id: "in-view",
                label: scoped === null ? "In view" : `In view ${scoped.inView}`,
                tooltip:
                  "The places the map shows — follows the map as you move it",
              },
              {
                id: "all",
                label: `All ${rows.length}`,
                tooltip: `Every place of ${preset}`,
              },
            ]}
          />
          <Fill />
          <SegmentedControl<"list" | "gallery">
            label="Layout"
            value={layout}
            onChange={onLayoutChange}
            options={LAYOUT_OPTIONS}
          />
          <IconButton
            icon={hideIcon}
            label="Hide the list"
            onClick={() => onLayoutChange("hidden")}
          />
        </Line>
      }
      body={body}
      footer={footer}
    />
  );
}

function PanelRows(
  props: PlacesPanelProps & {
    layout: "list" | "gallery";
    shown: readonly Place[];
  },
): ReactNode {
  const {
    tags,
    layout,
    shown,
    selectedId,
    onSelect,
    hoveredId,
    onHoverChange,
  } = props;
  const extraFields = useMemo(() => placeExtraFields(tags), [tags]);
  // A place's picture, as its gallery card's cover. The list keeps its glyph
  // (`list.leading` wins over the cover thumbnail).
  const placeCover = useCallback(
    (p: Place): CoverContent => ({
      kind: "node",
      node: (
        <PlaceCover
          visual={placeVisual(p, tags)}
          googlePlaceId={p.googlePlaceId}
        />
      ),
    }),
    [tags],
  );
  const viewOptions = useMemo(
    () => ({
      list: {
        leading: (p: Place) => <PlaceGlyph visual={placeVisual(p, tags)} />,
        // The panel is narrow: the name on its own line, the address and
        // tags under it.
        lines: 2 as const,
      },
    }),
    [tags],
  );
  return (
    <DataView<Place>
      storageKey={PANEL_VIEW}
      rows={shown}
      collection={placesCollection}
      overrides={PLACE_OVERRIDES}
      extraFields={extraFields}
      rowKey={(p) => p.id}
      views={["list", "gallery"]}
      pinnedView={layout}
      toolbar={PANEL_TOOLBAR}
      viewOptions={viewOptions}
      cover={placeCover}
      onRowActivate={onSelect}
      selectedRowId={selectedId ?? undefined}
      hoveredRowId={hoveredId}
      onRowHoverChange={onHoverChange}
    />
  );
}

function PanelEmpty({
  icon,
  children,
}: {
  icon: IconRef;
  children: ReactNode;
}): ReactNode {
  return (
    <Center className="p-lg">
      <Stack gap="xs" align="center">
        <Icon icon={icon} className="size-6 text-muted-foreground" />
        <Text variant="body" tone="muted" className="text-center">
          {children}
        </Text>
      </Stack>
    </Center>
  );
}
