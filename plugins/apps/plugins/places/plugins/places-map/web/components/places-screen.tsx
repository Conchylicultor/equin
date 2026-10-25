import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import { floatingToolbar } from "@plugins/primitives/plugins/data-view/plugins/floating-toolbar/web";
import type { MapViewOptions } from "@plugins/primitives/plugins/data-view/plugins/map/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Presence } from "@plugins/primitives/plugins/css/plugins/motion/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { spaceLength } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import {
  ResourceView,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import type { LatLng, MapBounds, MapPin } from "@plugins/map/core";
import { useLinkedHover } from "@plugins/map/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  placeFlags,
  placeName,
  places as placesCollection,
  placeTagTree,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  freeSiblingName,
  tagPath,
} from "@plugins/tag-tree/plugins/engine/core";
import { useTagTreeActions } from "@plugins/tag-tree/plugins/engine/web";
import {
  useCreateCustomPlace,
  useDeletePlace,
  usePlaces,
  usePlaceTags,
  useSavePlace,
  useUpdatePlace,
} from "@plugins/apps/plugins/places/plugins/places-core/web";
import { TagManagerPanel } from "@plugins/apps/plugins/places/plugins/tag-manager/web";
import {
  PLACE_OVERRIDES,
  placeExtraFields,
  placeSearchText,
} from "../internal/fields";
import {
  panelLayoutStore,
  panelScopeStore,
  sidebarOpenStore,
} from "../internal/layout-stores";
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
import { PlaceCard } from "./place-card";
import { PANEL_WIDTH, PLACE_CARD_WIDTH, type CardFrame } from "./card-frame";
import { PlacesPanel } from "./places-panel";
import { PinPickBar, dropName, type PinPick } from "./pin-pick-bar";
import { TagSidebar } from "./tag-sidebar";

/**
 * The Places surface id. Config-backed like every DataView: its views are the
 * filter presets, every one a map — authored in
 * `config/apps/places/places-map/places.presets.jsonc` (All places, the home
 * preset); the user's own are added from the sidebar. (The former
 * `places.map` id, whose views were Map / Gallery / List, is retired: its
 * user layer is left orphaned on purpose.)
 */
const PRESETS_VIEW = defineDataView("places.presets");

/** The home preset: always first, never renamed, dragged or deleted. */
const HOME_PRESET = "all";

/**
 * Where floating cards on the right start: below the toolbar's tools card
 * (one gutter, the card's height, one gutter).
 */
const BELOW_TOOLBAR = `calc(${spaceLength("md")} * 2 + 2.75rem)`;

/** The tag sidebar's reach from the left edge (gutter + its `w-72`). */
const PAST_SIDEBAR = `calc(${spaceLength("md")} * 2 + 18rem)`;

/** The room the side panel covers on the right edge (gutter + its width). */
const PANEL_REACH = `calc(${spaceLength("md")} + ${PANEL_WIDTH})`;

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

/** Past the side panel (and the thread beside it, when shown). */
const PAST_PANEL = `calc(${PANEL_REACH} + ${spaceLength("md")})`;
const PAST_PANEL_BESIDE_THREAD = `calc(${THREAD_REACH} + ${PANEL_REACH} + ${spaceLength("md")})`;

const NO_EXPANDED: ReadonlySet<string> = new Set();

/** A card floating on the map (the side panel is hidden). */
const FLOATING: CardFrame = { kind: "floating" };

/** A Google place shown in the detail card: the hit, and Sonnet's words when it is a pick. */
interface GoogleDetail {
  hit: DetailedHit;
  pick: AskPickNote | null;
}

function detailedHit(hit: GoogleHit): DetailedHit | null {
  return hit.result === undefined ? null : { ...hit, result: hit.result };
}

/**
 * The Places screen: one full-bleed DataView of every saved place on the map,
 * its views the filter PRESETS (every one a map; edits are drafts until the
 * preset is saved), with its chrome floating on the map (`floatingToolbar`):
 * the tag sidebar as the surface's `aside` (the presets, the tag filter, the
 * tree) — collapsed, a preset pill top-left stands in for it — the "Search or
 * add places" bar and the filter top-right, and the side panel as its
 * `asideEnd`: the preset's places in view (or all of them) as a list or a
 * gallery, hover-linked with their pins. The bar filters your places (and
 * their pins) and, in its panel, proposes Google's hits around the map's view
 * as cards to save and as ghost pins on the map, hover-linked both ways, never
 * moving the camera. Selecting a place (a pin, a row) opens its card — drilled
 * into the side panel while it is shown, else floating on the right — and a
 * click anywhere else on the screen (the map, the sidebar, the toolbar), Back
 * or Esc closes it; Manage tags lays the tag manager over the map. Dropping a
 * custom pin (from the search panel) or moving one (from its card) puts the
 * map in pick mode, with a bar at the bottom: the next click on the map is
 * where the pin goes.
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
  const { create: createTag } = useTagTreeActions(placeTagTree);
  const { mutateAsync: createCustomPlace } = useCreateCustomPlace();
  const { mutateAsync: updatePlace } = useUpdatePlace();
  const { mutateAsync: savePlace } = useSavePlace();
  const { mutateAsync: deletePlace } = useDeletePlace();

  // The search bar: one query for both halves — the view's own search (your
  // places, and their pins) and Google's hits around the map's view.
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [bounds, setBounds] = useState<MapBounds | null>(null);
  // The part of the map the chrome leaves uncovered: what the side panel's
  // "In view" lists.
  const [visible, setVisible] = useState<MapBounds | null>(null);
  // The panel's Fit map: each bump frames the preset's places.
  const [fitRequest, setFitRequest] = useState(0);
  // One hovered place, lit on both sides: its pin and its row in the panel.
  const { hoveredId: hoveredPlaceId, onHoverChange: setHoveredPlaceId } =
    useLinkedHover();
  const [sidebarOpen, setSidebarOpen] = useDraft(sidebarOpenStore, true);
  const [panelLayout, setPanelLayout] = useDraft(panelLayoutStore, "list");
  const [panelScope, setPanelScope] = useDraft(panelScopeStore, "in-view");
  const panelOpen = panelLayout !== "hidden";
  // One session per search round: an autocomplete answer (the ladder's last
  // rung) and the save it ends in are billed together.
  const [session, setSession] = useState(() => crypto.randomUUID());
  const { hoveredId: hoveredGoogleId, onHoverChange: setHoveredGoogleId } =
    useLinkedHover();
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
  // The place card or the detail card: one at a time, in the same spot —
  // drilled into the side panel while it is shown, else floating.
  const cardOpen = showCard || showDetail;
  const floatingCard = cardOpen && !panelOpen;
  const closeCards = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
  }, []);
  // What the surface's own right-hand chrome covers (the side panel stands a
  // gutter in from it): the thread, and a floating card beside it.
  const rightReach = floatingCard
    ? ask.shown
      ? CARD_BESIDE_THREAD_REACH
      : CARD_REACH
    : ask.shown
      ? THREAD_REACH
      : null;
  // Where the map's uncovered area ends on the right: past the panel (the
  // hidden panel's pill is too small to count), the floating card, the
  // thread, or nothing.
  const pastRight = panelOpen
    ? ask.shown
      ? PAST_PANEL_BESIDE_THREAD
      : PAST_PANEL
    : floatingCard
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
        onHoverChange: (id, hovered) => {
          const placeId = googlePlaceIdOfPin(id);
          if (placeId !== null) setHoveredGoogleId(placeId, hovered);
        },
        onCameraRest: (rest) => {
          setBounds(rest.bounds);
          setVisible(rest.visible);
        },
        fitRequest,
      } satisfies MapViewOptions<Place>,
    }),
    [
      tags,
      fitPadding,
      pick,
      keepIds,
      ghostPins,
      hoveredGoogleId,
      setHoveredGoogleId,
      activateGhost,
      fitRequest,
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

  /** Save the detail card's place: it is one of your places now — its own card. */
  const saveDetail = async (d: GoogleDetail): Promise<void> => {
    const place = await saveHit(d.hit);
    if (place !== null) {
      setDetail(null);
      setSelectedId(place.id);
    }
  };

  // The open card drilled into the side panel, under the panel's Back line.
  const drilledCard = (back: ReactNode): ReactNode => {
    const frame = { kind: "panel", back } as const;
    if (showCard && selected !== undefined) {
      return (
        <PlaceCard
          key={selected.id}
          ref={cardRef}
          place={selected}
          places={places}
          tags={tags}
          frame={frame}
          onClose={() => setSelectedId(null)}
          onMovePin={() => setPinPick({ kind: "move", place: selected })}
        />
      );
    }
    if (showDetail && detail !== null) {
      return (
        <GooglePlaceCard
          key={detail.hit.placeId}
          ref={cardRef}
          hit={detail.hit}
          pick={detail.pick}
          frame={frame}
          onClose={() => setDetail(null)}
          onSave={() => saveDetail(detail)}
        />
      );
    }
    throw new Error(
      "PlacesSurface: a card is drilled into the panel with none open",
    );
  };

  // The open card floating over the map (when the side panel is hidden),
  // keyed by what it shows so a different one cross-fades in.
  const floatingCardNode =
    showCard && selected !== undefined ? (
      <PlaceCard
        key={`place:${selected.id}`}
        place={selected}
        places={places}
        tags={tags}
        frame={FLOATING}
        onClose={() => setSelectedId(null)}
        onMovePin={() => setPinPick({ kind: "move", place: selected })}
      />
    ) : showDetail && detail !== null ? (
      <GooglePlaceCard
        key={`google:${detail.hit.placeId}`}
        hit={detail.hit}
        pick={detail.pick}
        frame={FLOATING}
        onClose={() => setDetail(null)}
        onSave={() => saveDetail(detail)}
      />
    ) : null;

  const newTag = useCallback(async () => {
    const tag = await createTag({
      name: freeSiblingName("New tag", null, tags),
      parentId: null,
    });
    setManager({ focusTagId: tag.id });
  }, [createTag, tags]);

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
        storageKey={PRESETS_VIEW}
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
        views={["map"]}
        viewEdits={{ mode: "draft", home: HOME_PRESET }}
        viewShortcuts
        switcherForm="none"
        toolbar={floatingToolbar}
        backdrop="map"
        reserve={rightReach === null ? undefined : { right: rightReach }}
        aside={
          <TagSidebar
            places={places}
            tags={tags}
            onNewTag={newTag}
            onManageTags={() => setManager({ focusTagId: null })}
            open={sidebarOpen}
            onOpenChange={setSidebarOpen}
          />
        }
        {...(floatingCard
          ? {}
          : {
              asideEnd: (
                <PlacesPanel
                  places={places}
                  tags={tags}
                  visible={visible}
                  layout={panelLayout}
                  onLayoutChange={setPanelLayout}
                  scope={panelScope}
                  onScopeChange={setPanelScope}
                  selectedId={selected?.id ?? null}
                  onSelect={openPlace}
                  hoveredId={hoveredPlaceId}
                  onHoverChange={setHoveredPlaceId}
                  onFit={() => setFitRequest((n) => n + 1)}
                  drill={cardOpen ? drilledCard : null}
                  onBack={closeCards}
                />
              ),
            })}
        hoveredRowId={hoveredPlaceId}
        onRowHoverChange={setHoveredPlaceId}
        viewOptions={viewOptions}
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
      <Presence>
        {manager !== null ? (
          <Pin
            key="manager"
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
      </Presence>
      {/* The floating card's column: it fades in and out as a whole, and a
          card swapped for another (a different place, a Google result saved
          as a place) cross-fades inside it. */}
      <Presence>
        {floatingCard && floatingCardNode !== null ? (
          <Pin
            key="card"
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
            <Presence>{floatingCardNode}</Presence>
          </Pin>
        ) : null}
      </Presence>
      <Presence>
        {ask.conversationId !== null && ask.shown ? (
          <Pin
            key="thread"
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
      </Presence>
      <Presence>
        {pinPick !== null ? (
          <Pin key="pin-pick" to="bottom" offset="lg" layer="float">
            <PinPickBar
              pick={pinPick}
              onNameChange={(name) => setPinPick({ kind: "drop", name })}
              onCancel={() => setPinPick(null)}
            />
          </Pin>
        ) : null}
      </Presence>
    </div>
  );
}
