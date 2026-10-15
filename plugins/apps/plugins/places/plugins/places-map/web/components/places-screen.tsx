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
import type { LatLng } from "@plugins/map/core";
import {
  placeFlags,
  placeName,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  useCreateCustomPlace,
  useCreatePlaceTag,
  usePlaces,
  usePlaceTags,
  useUpdatePlace,
} from "@plugins/apps/plugins/places/plugins/places-core/web";
import { TagManagerPanel } from "@plugins/apps/plugins/places/plugins/tag-manager/web";
import { placeFieldDefs, placeSearchText } from "../internal/fields";
import { useClickAway } from "../internal/use-click-away";
import { useCoveredEdges } from "../internal/use-covered-edges";
import { SAVED_PLACE_PIN_TYPE, placeVisual } from "../internal/place-visual";
import { AddPlaceButton } from "./add-place";
import { PLACE_CARD_WIDTH, PlaceCard } from "./place-card";
import { PlaceCover, PlaceGlyph } from "./place-glyph";
import { PinPickBar, dropName, type PinPick } from "./pin-pick-bar";
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

/** The room the place card covers on the right edge (gutter + its width). */
const CARD_REACH = `calc(${spaceLength("md")} + ${PLACE_CARD_WIDTH})`;

/** Past the place card: its reach plus the gutter beside it. */
const PAST_CARD = `calc(${CARD_REACH} + ${spaceLength("md")})`;

/**
 * The Places screen: one full-bleed DataView of every saved place — Map,
 * Gallery and List over the same filtered rows — with its chrome floating on
 * the map (`floatingToolbar`): the tag sidebar as the surface's `aside`, the
 * view tabs top-left, search / filter / Add place top-right. The map is the
 * surface's `backdrop`: Gallery and List float over it as a card (the map
 * behind showing the same places), which steps aside for the place card.
 * Selecting a place (a pin, a card, a row) opens its card on the right, and a click anywhere
 * else on the screen (the map, the sidebar, the toolbar) or Esc closes it; Manage tags
 * lays the tag manager over the map. Dropping a custom pin (from Add place) or
 * moving one (from its card) puts the map in pick mode, with a bar at the
 * bottom: the next click on the map is where the pin goes.
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
  const [pinPick, setPinPick] = useState<PinPick | null>(null);
  const { mutateAsync: createTag } = useCreatePlaceTag();
  const { mutateAsync: createCustomPlace } = useCreateCustomPlace();
  const { mutateAsync: updatePlace } = useUpdatePlace();

  const fields = useMemo(() => placeFieldDefs(tags), [tags]);
  const selected =
    selectedId === null ? undefined : places.find((p) => p.id === selectedId);
  // The card and the tag manager share the right side: the manager, while
  // open, hides the card (the selection is kept and comes back on close). So
  // does pick mode — its click on the map is the answer, not a click away.
  const showCard =
    selected !== undefined && manager === null && pinPick === null;

  const { containerRef, probeRef, padding: fitPadding } = useCoveredEdges();
  const cardRef = useRef<HTMLElement>(null);
  const { claim } = useClickAway({
    active: showCard,
    region: containerRef,
    panel: cardRef,
    onDismiss: () => setSelectedId(null),
  });

  // What a click on the map does in pick mode; undefined = not picking (or a
  // drop with no name yet, which the map must not take).
  const pick = useMemo((): ((at: LatLng) => void) | undefined => {
    if (pinPick === null) return undefined;
    if (pinPick.kind === "move") {
      const { place } = pinPick;
      return (at) => {
        // The click that answered is no click away from the card it reopens.
        claim();
        setPinPick(null);
        setSelectedId(place.id);
        void updatePlace({ params: { id: place.id }, body: { location: at } });
      };
    }
    const name = dropName(pinPick);
    if (name === null) return undefined;
    return (at) => {
      claim();
      // Out of pick mode first: a second click must not drop a second pin.
      setPinPick(null);
      void createCustomPlace({ body: { name, ...at } }).then((place) => {
        setSelectedId(place.id);
      });
    };
  }, [pinPick, createCustomPlace, updatePlace, claim]);

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
        {
          id: "places.cancel-pin-pick",
          keys: "Escape",
          label: "Cancel dropping or moving the pin",
          priority: 2,
          when: () => pinPick !== null,
          handler: () => setPinPick(null),
        },
      ],
      [showCard, pinPick],
    ),
  );

  const viewOptions = useMemo(
    () => ({
      map: {
        pinType: SAVED_PLACE_PIN_TYPE,
        pinData: (p) => placeVisual(p, tags),
        label: (p) => placeName(p),
        // Every place stays on the map (Google's way): far out a round badge,
        // with each spot's size beside its lead — a place still to go to
        // leads, and draws above, one that is not.
        crowd: { kind: "spots" },
        rank: (p) => (placeFlags(p, tags).want ? 1 : 0),
        fitPadding,
        // The map opens where the user left it, as Google Maps does; only a
        // first visit frames every place (which, worldwide, is the globe).
        cameraKey: "places.map",
        ...(pick === undefined ? {} : { pick }),
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
    [tags, fitPadding, pick],
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
        searchAccessor={placeSearchText}
        searchPlaceholder="Search places"
        fields={fields}
        views={["map", "gallery", "list"]}
        toolbar={floatingToolbar}
        backdrop="map"
        reserve={showCard ? { right: CARD_REACH } : undefined}
        aside={
          <TagSidebar
            places={places}
            tags={tags}
            onNewTag={newTag}
            onManageTags={() => setManager({ focusTagId: null })}
          />
        }
        actions={
          <AddPlaceButton
            onSaved={(place) => setSelectedId(place.id)}
            onDropCustom={(name) => setPinPick({ kind: "drop", name })}
          />
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
          // The card hugs its content inside this column: the room below it
          // is the map's, so clicks there pass through.
          className="pointer-events-none"
        >
          <PlaceCard
            key={selected.id}
            place={selected}
            tags={tags}
            onClose={() => setSelectedId(null)}
            onMovePin={() => setPinPick({ kind: "move", place: selected })}
          />
        </Pin>
      ) : null}
      {pinPick !== null ? (
        <Pin to="bottom" offset="lg" layer="float">
          <PinPickBar
            pick={pinPick}
            onNameChange={(name) => setPinPick({ kind: "drop", name })}
            onCancel={() => setPinPick(null)}
          />
        </Pin>
      ) : null}
    </div>
  );
}
