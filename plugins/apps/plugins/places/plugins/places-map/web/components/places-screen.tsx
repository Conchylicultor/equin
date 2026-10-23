import { useCallback, useMemo, useRef, useState } from "react";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  type CoverContent,
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
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import type { LatLng, MapBounds, MapPin } from "@plugins/map/core";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  placeFlags,
  placeName,
  places as placesCollection,
  tagPath,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  useCreateCustomPlace,
  useCreatePlaceTag,
  useDeletePlace,
  usePlaces,
  usePlaceTags,
  useSavePlace,
  useUpdatePlace,
} from "@plugins/apps/plugins/places/plugins/places-core/web";
import { TagManagerPanel } from "@plugins/apps/plugins/places/plugins/tag-manager/web";
import { placeExtraFields, placeSearchText } from "../internal/fields";
import { useClickAway } from "../internal/use-click-away";
import { useCoveredEdges } from "../internal/use-covered-edges";
import { SAVED_PLACE_PIN_TYPE, placeVisual } from "../internal/place-visual";
import {
  GOOGLE_RESULT_PIN_TYPE,
  googlePinId,
  googlePlaceIdOfPin,
} from "../internal/google-result";
import { useGoogleSearch } from "../internal/use-google-search";
import { ASK_PICK_PIN_TYPE } from "../internal/ask-pick";
import {
  useAskMapPicks,
  type AskPick,
  type AskPickNote,
} from "../internal/ask-picks";
import { looksLikeQuestion } from "../internal/question";
import { useAsk } from "../internal/use-ask";
import { AskPill } from "./ask-pill";
import { ASK_THREAD_WIDTH, AskThreadCard } from "./ask-thread";
import type { GoogleHit } from "./google-result-card";
import { GooglePlaceCard, type DetailedHit } from "./google-place-card";
import { UniversalSearchPanel } from "./universal-search";
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
 * The location is the map's axis, not an ordering: it is the one derived
 * field the list does not sort by.
 */
const PLACE_OVERRIDES = fieldOverrides(placesCollection, {
  location: { sortable: false },
});

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

/** The room the docked Sonnet thread covers on the right edge (gutter + its width). */
const THREAD_REACH = `calc(${spaceLength("md")} + ${ASK_THREAD_WIDTH})`;

/** Past the thread: where a card beside it stands off the right edge. */
const PAST_THREAD = `calc(${THREAD_REACH} + ${spaceLength("md")})`;

/** A card beside the thread: the thread's reach, a gutter, the card. */
const CARD_BESIDE_THREAD_REACH = `calc(${PAST_THREAD} + ${PLACE_CARD_WIDTH})`;

/** Past a card beside the thread. */
const PAST_CARD_BESIDE_THREAD = `calc(${CARD_BESIDE_THREAD_REACH} + ${spaceLength("md")})`;

const NO_EXPANDED: ReadonlySet<string> = new Set();

/** A Google place shown in the detail card: the hit, and Sonnet's words when it is a pick. */
interface GoogleDetail {
  hit: DetailedHit;
  pick: AskPickNote | null;
}

function detailedHit(hit: GoogleHit): DetailedHit | null {
  return hit.result === undefined ? null : { ...hit, result: hit.result };
}

/**
 * The Places screen: one full-bleed DataView of every saved place — Map,
 * Gallery and List over the same filtered rows — with its chrome floating on
 * the map (`floatingToolbar`): the tag sidebar as the surface's `aside`, the
 * view tabs top-left, the "Search or add places" bar and the filter top-right.
 * The bar filters your places (and their pins) and, in its panel, proposes
 * Google's hits around the map's view as cards to save and as ghost pins on
 * the map, hover-linked both ways, never moving the camera. The map is the
 * surface's `backdrop`: Gallery and List float over it as a card (the map
 * behind showing the same places), which steps aside for the place card.
 * Selecting a place (a pin, a card, a row) opens its card on the right, and a click anywhere
 * else on the screen (the map, the sidebar, the toolbar) or Esc closes it; Manage tags
 * lays the tag manager over the map. Dropping a custom pin (from the search panel) or
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
  // A Google place not saved yet, in the detail card (exclusive with the
  // selection: opening one closes the other).
  const [detail, setDetail] = useState<GoogleDetail | null>(null);
  const [manager, setManager] = useState<{ focusTagId: string | null } | null>(
    null,
  );
  const [pinPick, setPinPick] = useState<PinPick | null>(null);
  const { mutateAsync: createTag } = useCreatePlaceTag();
  const { mutateAsync: createCustomPlace } = useCreateCustomPlace();
  const { mutateAsync: updatePlace } = useUpdatePlace();
  const { mutateAsync: savePlace } = useSavePlace();
  const { mutateAsync: deletePlace } = useDeletePlace();

  // The search bar: one query for both halves — the view's own search (your
  // places, and their pins) and Google's hits around the map's view.
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [bounds, setBounds] = useState<MapBounds | null>(null);
  // One session per search round: an autocomplete answer (the ladder's last
  // rung) and the save it ends in are billed together.
  const [session, setSession] = useState(() => crypto.randomUUID());
  const [hoveredGoogleId, setHoveredGoogleId] = useState<string | null>(null);
  const [saveNotConfigured, setSaveNotConfigured] = useState(false);
  // Ask Sonnet: the question's background run, docked on the right as a
  // thread card the bar's pill shows and hides; its picks are on the map while
  // it is in hand — the current result's, plus every earlier one unfolded in
  // the thread (unfolded per run, so another run starts folded).
  const ask = useAsk(bounds);
  const google = useGoogleSearch({ text: query, bounds, session, tags });
  const [expanded, setExpanded] = useState<{
    conversationId: string | null;
    ids: ReadonlySet<string>;
  }>({ conversationId: null, ids: NO_EXPANDED });
  const expandedIds =
    expanded.conversationId === ask.conversationId ? expanded.ids : NO_EXPANDED;
  const toggleExpanded = (toolUseId: string) => {
    const next = new Set(expandedIds);
    if (next.has(toolUseId)) next.delete(toolUseId);
    else next.add(toolUseId);
    setExpanded({ conversationId: ask.conversationId, ids: next });
  };
  const askPicks = useAskMapPicks(
    ask.conversationId,
    expandedIds,
    bounds,
    tags,
  );
  const savedByGoogleId = useMemo(
    () =>
      new Map(
        places.flatMap((p) =>
          p.googlePlaceId === null ? [] : [[p.googlePlaceId, p] as const],
        ),
      ),
    [places],
  );
  const googleHits = useMemo(
    () => (google.kind === "answer" ? google.hits : []),
    [google],
  );
  // Each hit not saved yet is proposed on the map; a saved one is its own pin,
  // kept on the map (`keepIds`) even where the view's search or filter hides
  // it: Google matches names the view's substring search misses (a typo), and
  // a hit the panel lists must be on the map.
  // Sonnet's picks first: a place both picked and searched is drawn as the
  // pick (one pin per place).
  const ghostPins = useMemo((): MapPin[] => {
    const pinned = new Set<string>();
    const pins: MapPin[] = [];
    for (const p of askPicks) {
      const { result } = p.hit;
      if (result === undefined || savedByGoogleId.has(p.hit.placeId)) continue;
      pinned.add(p.hit.placeId);
      pins.push({
        kind: "pin",
        id: googlePinId(p.hit.placeId),
        position: { lat: result.lat, lng: result.lng },
        pinType: ASK_PICK_PIN_TYPE,
        label: p.hit.name,
        data: { n: p.n },
        frame: false,
      });
    }
    for (const hit of googleHits) {
      if (
        hit.result === undefined ||
        savedByGoogleId.has(hit.placeId) ||
        pinned.has(hit.placeId)
      )
        continue;
      pins.push({
        kind: "pin",
        id: googlePinId(hit.placeId),
        position: { lat: hit.result.lat, lng: hit.result.lng },
        pinType: GOOGLE_RESULT_PIN_TYPE,
        label: hit.name,
        data: hit.visual,
        // A proposal: the camera never moves to it.
        frame: false,
      });
    }
    return pins;
  }, [askPicks, googleHits, savedByGoogleId]);
  const keepIds = useMemo(
    (): ReadonlySet<string> =>
      new Set(
        [...askPicks.map((p) => p.hit), ...googleHits].flatMap((hit) => {
          const saved = savedByGoogleId.get(hit.placeId);
          return saved === undefined ? [] : [saved.id];
        }),
      ),
    [askPicks, googleHits, savedByGoogleId],
  );

  const extraFields = useMemo(() => placeExtraFields(tags), [tags]);
  const selected =
    selectedId === null ? undefined : places.find((p) => p.id === selectedId);
  // The card and the tag manager share the right side: the manager, while
  // open, hides the card (the selection is kept and comes back on close). So
  // does pick mode — its click on the map is the answer, not a click away.
  const showCard =
    selected !== undefined && manager === null && pinPick === null;
  const showDetail =
    detail !== null && !showCard && manager === null && pinPick === null;
  // The place card or the detail card: one at a time, in the same spot.
  const cardOpen = showCard || showDetail;
  const closeCards = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
  }, []);
  // Where the right-hand chrome ends: the card beside the thread, the card,
  // the thread, or nothing.
  const rightReach = cardOpen
    ? ask.shown
      ? CARD_BESIDE_THREAD_REACH
      : CARD_REACH
    : ask.shown
      ? THREAD_REACH
      : null;
  const pastRight = cardOpen
    ? ask.shown
      ? PAST_CARD_BESIDE_THREAD
      : PAST_CARD
    : ask.shown
      ? PAST_THREAD
      : 0;

  const { containerRef, probeRef, padding: fitPadding } = useCoveredEdges();
  const cardRef = useRef<HTMLElement>(null);
  const threadRef = useRef<HTMLElement>(null);
  // The thread is the card's companion: working in it (replying, unfolding
  // an earlier answer) is no click away from the pick it shows.
  const clickAwayPanels = useMemo(() => [cardRef, threadRef], []);
  const { claim } = useClickAway({
    active: cardOpen,
    region: containerRef,
    panels: clickAwayPanels,
    onDismiss: closeCards,
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
        setDetail(null);
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
        setDetail(null);
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
          // The open search panel owns its own Esc.
          when: () => cardOpen && !searchOpen,
          handler: closeCards,
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
      [cardOpen, pinPick, searchOpen, closeCards],
    ),
  );

  // A pick's or a ghost's click opens its detail card.
  const activateGhost = useEventCallback((id: string) => {
    const placeId = googlePlaceIdOfPin(id);
    if (placeId === null) return;
    const pick = askPicks.find((p) => p.hit.placeId === placeId);
    if (pick !== undefined) {
      openPick(pick);
      return;
    }
    const hit = googleHits.find((h) => h.placeId === placeId);
    if (hit !== undefined) openHit(hit, null);
  });

  // A place's picture, as its gallery card's cover (and its list thumbnail).
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
        keep: keepIds,
        overlays: {
          items: ghostPins,
          onActivate: activateGhost,
        },
        hoveredId:
          hoveredGoogleId === null ? null : googlePinId(hoveredGoogleId),
        onHoverChange: (id) =>
          setHoveredGoogleId(id === null ? null : googlePlaceIdOfPin(id)),
        onCameraRest: (rest) => setBounds(rest.bounds),
      } satisfies MapViewOptions<Place>,
      list: {
        leading: (p: Place) => <PlaceGlyph visual={placeVisual(p, tags)} />,
      },
    }),
    [
      tags,
      fitPadding,
      pick,
      keepIds,
      ghostPins,
      hoveredGoogleId,
      activateGhost,
    ],
  );

  function openPlace(place: Place) {
    claim();
    setSearchOpen(false);
    setDetail(null);
    setSelectedId(place.id);
  }

  /** A Google place's card: the place card once it is saved, else the detail card. */
  function openHit(hit: GoogleHit, note: AskPickNote | null) {
    const saved = savedByGoogleId.get(hit.placeId);
    if (saved !== undefined) {
      openPlace(saved);
      return;
    }
    const detailed = detailedHit(hit);
    if (detailed === null) return;
    claim();
    setSearchOpen(false);
    setSelectedId(null);
    setDetail({ hit: detailed, pick: note });
  }

  function openPick(p: AskPick) {
    openHit(p.hit, { n: p.n, why: p.why, about: p.about, sources: p.sources });
  }

  /** Save a Google hit; resolves the saved place (an earlier save too), or null when Maps is not set up. */
  const saveHit = async (hit: GoogleHit): Promise<Place | null> => {
    const result = await savePlace({
      body: {
        googlePlaceId: hit.placeId,
        // An autocomplete name ends its session with this save.
        ...(hit.result === undefined ? { session } : {}),
      },
    });
    if (result.kind === "maps-not-configured") {
      setSaveNotConfigured(true);
      return null;
    }
    if (hit.result === undefined) setSession(crypto.randomUUID());
    if (result.kind === "already-saved") return result.place;
    const place = result.place;
    const tagged = [
      ...place.autoTags.flatMap((id) => tagPath(id, tags).slice(-1)),
      ...tags.filter((t) => t.role === "want"),
    ].map((t) => t.name);
    // Saved where it is: no selection, no camera move — the ghost becomes
    // the place's own pin and the card says Saved.
    showToast({
      title: `Saved ${placeName(place)}`,
      description: `Tagged ${tagged.join(", ")}`,
      action: {
        label: "Undo",
        onClick: () => void deletePlace({ params: { id: place.id } }),
      },
    });
    return place;
  };
  const saveCard = async (hit: GoogleHit): Promise<void> => {
    await saveHit(hit);
  };

  const askQuestion = (q: string) => {
    const question = q.trim();
    if (question === "") return;
    void ask.start(question).then((started) => {
      if (!started) return;
      // The question is the thread's first bubble now, not a filter; the
      // thread card shows it.
      setQuery("");
      setSearchOpen(false);
    });
  };

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
          right: pastRight,
        }}
      />
      <DataView<Place>
        storageKey={PLACES_VIEW}
        rows={places}
        collection={placesCollection}
        overrides={PLACE_OVERRIDES}
        extraFields={extraFields}
        rowKey={(p) => p.id}
        searchAccessor={placeSearchText}
        searchPlaceholder="Search or add places"
        search={{
          query,
          // Typing searches; the thread card is untouched by it.
          onQueryChange: setQuery,
          onSubmit: (q, { mod }) => {
            if (mod || looksLikeQuestion(q)) askQuestion(q);
          },
          ...(ask.conversationId === null
            ? {}
            : {
                trailing: (
                  <AskPill
                    conversationId={ask.conversationId}
                    shown={ask.shown}
                    onToggle={ask.toggle}
                  />
                ),
              }),
          suggestions: {
            open: searchOpen && pinPick === null,
            onOpenChange: setSearchOpen,
            content: (
              <UniversalSearchPanel
                places={places}
                tags={tags}
                query={query}
                google={google}
                savedByGoogleId={savedByGoogleId}
                hoveredGoogleId={hoveredGoogleId}
                onHoverGoogle={setHoveredGoogleId}
                onOpenPlace={openPlace}
                onOpenHit={(hit) => openHit(hit, null)}
                onSave={saveCard}
                saveNotConfigured={saveNotConfigured}
                onDropCustom={(name) => {
                  setSearchOpen(false);
                  setPinPick({ kind: "drop", name });
                }}
                onAsk={askQuestion}
                askBlocked={ask.blocked}
                onOpenRun={(id) => {
                  setSearchOpen(false);
                  ask.open(id);
                }}
              />
            ),
          },
        }}
        views={["map", "gallery", "list"]}
        toolbar={floatingToolbar}
        backdrop="map"
        reserve={rightReach === null ? undefined : { right: rightReach }}
        aside={
          <TagSidebar
            places={places}
            tags={tags}
            onNewTag={newTag}
            onManageTags={() => setManager({ focusTagId: null })}
          />
        }
        viewOptions={viewOptions}
        cover={placeCover}
        onRowActivate={(p) => {
          // Selecting another place swaps the card; it is not a click away.
          claim();
          setDetail(null);
          setSelectedId(p.id);
        }}
        selectedRowId={selected?.id}
        emptyState={
          <Placeholder>
            No places yet — search above to find one on Google and save it.
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
          style={{
            top: BELOW_TOOLBAR,
            left: PAST_SIDEBAR,
            ...(ask.shown ? { right: PAST_THREAD } : {}),
          }}
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
          style={{
            top: BELOW_TOOLBAR,
            ...(ask.shown ? { right: PAST_THREAD } : {}),
          }}
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
      {showDetail && detail !== null ? (
        <Pin
          ref={cardRef}
          to="right"
          stretch
          offset="md"
          spanOffset="md"
          layer="float"
          style={{
            top: BELOW_TOOLBAR,
            ...(ask.shown ? { right: PAST_THREAD } : {}),
          }}
          className="pointer-events-none"
        >
          <GooglePlaceCard
            key={detail.hit.placeId}
            hit={detail.hit}
            pick={detail.pick}
            onClose={() => setDetail(null)}
            onSave={async () => {
              const place = await saveHit(detail.hit);
              // Saved: it is one of your places now — its own card.
              if (place !== null) {
                setDetail(null);
                setSelectedId(place.id);
              }
            }}
          />
        </Pin>
      ) : null}
      {ask.conversationId !== null && ask.shown ? (
        <Pin
          ref={threadRef}
          to="right"
          stretch
          offset="md"
          spanOffset="md"
          layer="float"
          style={{ top: BELOW_TOOLBAR }}
        >
          <AskThreadCard
            conversationId={ask.conversationId}
            tags={tags}
            bounds={bounds}
            savedByGoogleId={savedByGoogleId}
            hoveredGoogleId={hoveredGoogleId}
            onHoverGoogle={setHoveredGoogleId}
            onSave={saveCard}
            onOpenPick={openPick}
            expanded={expandedIds}
            onToggleExpanded={toggleExpanded}
            onHide={ask.hide}
            onEnded={() => {
              ask.release();
              setDetail(null);
            }}
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
