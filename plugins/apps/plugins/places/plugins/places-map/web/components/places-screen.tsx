import { useCallback, useMemo, useRef, useState } from "react";
import {
  DataView,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import { floatingToolbar } from "@plugins/primitives/plugins/data-view/plugins/floating-toolbar/web";
import type { MapViewOptions } from "@plugins/primitives/plugins/data-view/plugins/map/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { spaceLength } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import {
  ResourceView,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import type {
  Place,
  PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  useCreatePlaceTag,
  usePlaces,
  usePlaceTags,
} from "@plugins/apps/plugins/places/plugins/places-core/web";
import { TagManagerPanel } from "@plugins/apps/plugins/places/plugins/tag-manager/web";
import { placeFieldDefs } from "../internal/fields";
import { useClickAway } from "../internal/use-click-away";
import { useCoveredEdges } from "../internal/use-covered-edges";
import { SAVED_PLACE_PIN_TYPE, placeVisual } from "../internal/place-visual";
import { AddPlaceButton } from "./add-place";
import { PLACE_CARD_WIDTH, PlaceCard } from "./place-card";
import { PlaceCover, PlaceGlyph } from "./place-glyph";
import { TagSidebar } from "./tag-sidebar";

/**
 * The Places surface id. Config-backed like every DataView: its views (All
 * places on the map, Gallery, List) live in
 * `config/apps/places/places-map/places.map.jsonc`.
 */
const PLACES_VIEW = defineDataView("places.map");

/**
 * Where floating cards on the right start: below the toolbar's tools card
 * (one gutter, the card's height, one gutter).
 */
const BELOW_TOOLBAR = `calc(${spaceLength("md")} * 2 + 2.75rem)`;

/** The tag sidebar's reach from the left edge (gutter + its `w-72`). */
const PAST_SIDEBAR = `calc(${spaceLength("md")} * 2 + 18rem)`;

/** The place card's reach from the right edge (gutter + its width + gutter). */
const PAST_CARD = `calc(${spaceLength("md")} * 2 + ${PLACE_CARD_WIDTH})`;

/**
 * The Places screen: one full-bleed DataView of every saved place — Map,
 * Gallery and List over the same filtered rows — with its chrome floating on
 * the map (`floatingToolbar`): the tag sidebar as the surface's `aside`, the
 * view tabs top-left, search / filter / Add place top-right. Selecting a place
 * (a pin, a card, a row) opens its card on the right, and a click anywhere
 * else on the screen (the map, the sidebar, the toolbar) or Esc closes it; Manage tags
 * lays the tag manager over the map.
 *
 * The places and the tag tree are two live reads, and every part of the
 * screen (pins, sidebar counts, card) needs both — so the screen waits for
 * both and never draws an empty map, or a tree of zero counts, for a read
 * that has not landed.
 */
export function PlacesScreen() {
  const readiness = useCombinedResources({
    places: usePlaces(),
    tags: usePlaceTags(),
  });
  return (
    <ResourceView resource={readiness} fallback={<Loading variant="block" />}>
      {({ places, tags }) => <PlacesSurface places={places} tags={tags} />}
    </ResourceView>
  );
}

function PlacesSurface({
  places,
  tags,
}: {
  places: readonly Place[];
  tags: readonly PlaceTag[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manager, setManager] = useState<{ focusTagId: string | null } | null>(
    null,
  );
  const { mutateAsync: createTag } = useCreatePlaceTag();

  const fields = useMemo(() => placeFieldDefs(tags), [tags]);
  const selected =
    selectedId === null ? undefined : places.find((p) => p.id === selectedId);
  // The card and the tag manager share the right side: the manager, while
  // open, hides the card (the selection is kept and comes back on close).
  const showCard = selected !== undefined && manager === null;
  const { containerRef, probeRef, padding: fitPadding } = useCoveredEdges();
  const cardRef = useRef<HTMLElement>(null);
  const { claim } = useClickAway({
    active: showCard,
    region: containerRef,
    panel: cardRef,
    onDismiss: () => setSelectedId(null),
  });
  useSurfaceShortcuts(
    useMemo(
      () => [
        {
          id: "places.close-card",
          keys: "Escape",
          label: "Close the place card",
          // Above the solo surface's Esc (exit fullscreen): the card is the
          // nearer thing to close. A popover open in the card owns its Esc.
          priority: 1,
          when: () => showCard,
          handler: () => setSelectedId(null),
        },
      ],
      [showCard],
    ),
  );

  const viewOptions = useMemo(
    () => ({
      map: {
        pinType: SAVED_PLACE_PIN_TYPE,
        pinData: (p) => placeVisual(p, tags),
        label: (p) => p.name,
        fitPadding,
      } satisfies MapViewOptions<Place>,
      gallery: {
        cover: (p: Place) => ({
          kind: "node" as const,
          node: <PlaceCover visual={placeVisual(p, tags)} />,
        }),
      },
      list: {
        leading: (p: Place) => <PlaceGlyph visual={placeVisual(p, tags)} />,
      },
    }),
    [tags, fitPadding],
  );

  const newTag = useCallback(async () => {
    const tag = await createTag({ body: { name: "New tag", parentId: null } });
    setManager({ focusTagId: tag.id });
  }, [createTag]);

  return (
    <div ref={containerRef} className="relative h-full">
      {/* The probe: an invisible box inset exactly as the chrome covers the
          map (toolbar on top, sidebar on the left, the card on the right when
          shown) — its offsets are the map's fit padding. */}
      <Layer
        ref={probeRef}
        decorative
        aria-hidden
        style={{
          top: BELOW_TOOLBAR,
          left: PAST_SIDEBAR,
          right: showCard ? PAST_CARD : 0,
        }}
      />
      <DataView<Place>
        storageKey={PLACES_VIEW}
        rows={places}
        rowKey={(p) => p.id}
        searchAccessor={(p) => `${p.name} ${p.address} ${p.note}`}
        searchPlaceholder="Search places"
        fields={fields}
        views={["map", "gallery", "list"]}
        toolbar={floatingToolbar}
        aside={
          <TagSidebar
            places={places}
            tags={tags}
            onNewTag={newTag}
            onManageTags={() => setManager({ focusTagId: null })}
          />
        }
        actions={
          <AddPlaceButton onSaved={(place) => setSelectedId(place.id)} />
        }
        viewOptions={viewOptions}
        onRowActivate={(p) => {
          // Selecting another place swaps the card; it is not a click away.
          claim();
          setSelectedId(p.id);
        }}
        selectedRowId={selected?.id}
        emptyState={
          <Placeholder>
            No places yet — Add place searches Google and saves one here.
          </Placeholder>
        }
      />
      {manager !== null ? (
        <Pin
          to="right"
          stretch
          offset="md"
          spanOffset="md"
          layer="float"
          style={{ top: BELOW_TOOLBAR, left: PAST_SIDEBAR }}
        >
          <TagManagerPanel
            places={places}
            tags={tags}
            focusTagId={manager.focusTagId}
            onClose={() => setManager(null)}
          />
        </Pin>
      ) : null}
      {showCard && selected !== undefined ? (
        <Pin
          ref={cardRef}
          to="right"
          stretch
          offset="md"
          spanOffset="md"
          layer="float"
          style={{ top: BELOW_TOOLBAR }}
        >
          <PlaceCard
            key={selected.id}
            place={selected}
            tags={tags}
            onClose={() => setSelectedId(null)}
          />
        </Pin>
      ) : null}
    </div>
  );
}
