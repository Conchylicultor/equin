import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Presence } from "@plugins/primitives/plugins/css/plugins/motion/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  legacyDraftKeys,
  readDraft,
  writeDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import {
  defineStore,
  useStore,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { LinkedHoverChange } from "@plugins/primitives/plugins/data-view/core";
import {
  MARK_PENDING,
  NO_MAP_PADDING,
  densestPinIds,
  framingOverlays,
  resolveCrowd,
  type CameraRest,
  type CameraView,
  type LatLng,
  type MapCrowdRequest,
  type MapOverlay,
  type MapPadding,
  type MapMarkResult,
  type MapPin,
  type MapTileScheme,
} from "../../core";
import {
  GeoMap,
  type MapPinScale,
  type MapPinState,
  type MapRendererProps,
  type MapRendererReadiness,
} from "../slots";
import { defaultPinMark } from "./default-pin";
import { defaultClusterMark } from "./default-cluster";
import { MarkHostProvider, useMapMarkEnv } from "./mark-env";
import { MapChrome, MapTilesProvider } from "./map-chrome";

/** A renderer as the slot hands it back: `component` sealed, everything else readable. */
type RendererItem = ReturnType<typeof GeoMap.Renderer.useContributions>[number];

export interface MapViewProps {
  overlays: readonly MapOverlay[];
  /** The selected overlay's id; its pin renders `active`. */
  activeId?: string | null;
  /** A pin was clicked. */
  onActivate?: (id: string) => void;
  /**
   * A pin to draw hovered though the pointer is not on it: the hover of
   * whatever outside the map stands for it (a result card beside the map).
   */
  hoveredId?: string | null;
  /**
   * The pointer entered (`true`) or left (`false`) a pin — to link it back.
   * Reported as claims and releases (`nextLinkedHover`; data-view's `useLinkedHover`
   * holds the shared state), never a bare "none".
   */
  onHoverChange?: LinkedHoverChange;
  /**
   * The camera came to rest (and once when the map first settles): where it
   * is, and the area it shows — what a search biased to "this map area" reads.
   */
  onCameraRest?: (rest: CameraRest) => void;
  /**
   * No map can be drawn here — no renderer is installed, or the renderer is
   * blocked (no key) — so no camera will rest until one can: what the map
   * shows is not "nothing", it is no map. Called once each time the host
   * lands on that state; a camera rest follows if the map becomes drawable.
   */
  onNoMap?: () => void;
  /**
   * Re-frame on demand: each time the number changes (not its value at
   * mount), the map frames its framed overlays as its Fit control does —
   * a caller's own "Fit map" button bumps it.
   */
  fitRequest?: number;
  /**
   * The overlay ids the camera frames, when set and non-empty: the map's own
   * first framing, its Fit control and each {@link fitRequest} frame only
   * these — a caller showing one set among others (a page's places among the
   * user's saved ones). Ids are the overlays' own `id`s. A `frame: false`
   * overlay stays out even when named. Absent or empty: every framed overlay.
   */
  focusIds?: readonly string[];
  /**
   * How pins that crowd each other on screen are drawn: merged into clusters
   * (`GeoMap.Cluster`) or kept as spots (see `MapRendererProps.crowd`).
   * Omitted numbers take the map's defaults. Absent = every pin on its own.
   */
  crowd?: MapCrowdRequest;
  /**
   * The pin to bring into view (a selected row, say). The map pans to it when
   * it changes and it is off-screen; it never refits or zooms for it.
   */
  focusId?: string | null;
  /**
   * The room chrome floating over the map covers on each edge, in px (a
   * sidebar, a toolbar, a card): fitting keeps pins out of it, and a focused
   * pin under it counts as off-screen. Default: none.
   */
  fitPadding?: MapPadding;
  /**
   * Pick mode: while set, the cursor is a crosshair and a click on the map
   * (not on a pin) reports its position — how a caller asks "where?" (drop a
   * pin, move one). Absent = clicking the map does nothing.
   */
  pick?: (position: LatLng) => void;
  /**
   * Remembers the camera on this device under this key: the map opens where
   * the user last left it (centre and zoom), and frames the overlays only on
   * a first visit. Name one key per map the user thinks of as one place
   * (`"places.map"`). Absent: every visit frames the overlays.
   */
  cameraKey?: string;
  /**
   * Where a map with a {@link cameraKey} opens: where the user left it
   * (`"remembered"`, the default), or framed on its overlays as a first visit
   * is (`"framed"`) — while still remembering each rest under the key, so the
   * next map opening `"remembered"` opens where this one was left. For a view
   * that must open on what it was opened for (a page's places laid over the
   * user's map) but hands its camera back when it closes.
   */
  cameraOpen?: "remembered" | "framed";
  /**
   * What the map's first framing frames (not the Fit control, which always
   * frames every overlay): every overlay (`"all"`, the default), or
   * `"densest"` — the area holding the most pins (`densestPinIds`: a fixed
   * ~50 km grid, the densest 3×3 block, less its outlying pins), so a set
   * spread over a home city, its day trips and a few trips opens on the city,
   * not on its region or the world. The user zooms out or
   * presses Fit for the rest. With `focusIds`, those are framed instead.
   */
  opening?: "all" | "densest";
  /**
   * The host's own words for "nothing to show", floated on a card over the
   * map while there are no overlays — or `null` for a bare map (a host that
   * already says the count elsewhere). The map itself stays mounted either
   * way: an overlay set that empties (a filter matching nothing) and fills
   * again keeps the user's pan and zoom.
   */
  empty: ReactNode;
  /**
   * The host's own controls floated over the map's tiles (an "Open in…"
   * button) — placed by the host (a `Pin` to a corner of the map), drawn
   * inside the map's chrome boundary ({@link MapChrome}), so they wear the
   * tiles' scheme as the map's own Fit control does: light over light tiles,
   * whatever the app's scheme. Drawn only over a mounted map, never over a
   * set-up or loading state.
   */
  controls?: ReactNode;
}

function ignoreActivate(): void {}

/**
 * A remembered camera outlives a draft's week: where the user left a map stays
 * theirs. Stored bytes are untrusted (an older shape, a hand edit): the schema
 * drops anything that is not a real view.
 */
const cameraStore = defineStore({
  owner: "map.camera",
  label: "Map positions",
  area: "local",
  cap: "64 KB",
  ttl: Number.POSITIVE_INFINITY,
  whenFull: "evict-oldest",
  schema: z.object({
    center: z.object({ lat: z.number().finite(), lng: z.number().finite() }),
    zoom: z.number().finite(),
  }),
  legacy: legacyDraftKeys("map.camera"),
});

/**
 * The remembered camera for `cameraKey`: the view to open at (read once, at
 * mount — a later write must not move a mounted map) and the writer of each
 * view the camera rests at — only while there is something the camera frames,
 * so a map showing nothing of its own never remembers its world view as where
 * the user left it. Nothing without a key.
 */
function useRememberedCamera(
  cameraKey: string | undefined,
  cameraOpen: "remembered" | "framed",
  framesSomething: boolean,
): {
  initialCamera: CameraView | null;
  remember: ((view: CameraView) => void) | undefined;
} {
  const cameras = useStore(cameraStore);
  const [initialCamera] = useState(() => {
    if (cameraKey === undefined || cameraOpen === "framed") return null;
    return readDraft(cameras, { scope: cameraKey });
  });
  const framing = useLatestRef(framesSomething);
  const remember = useMemo(
    () =>
      cameraKey === undefined
        ? undefined
        : ({ center, zoom }: CameraView) => {
            if (!framing.current) return;
            writeDraft(cameras, { center, zoom }, { scope: cameraKey });
          },
    [cameras, cameraKey, framing],
  );
  return { initialCamera, remember };
}

/**
 * The map host. Fills its parent: the caller owns the size.
 *
 * Picks the first `GeoMap.Renderer`, renders that renderer's set-up action while
 * it says it is blocked, and otherwise mounts it with every pin already routed
 * through `GeoMap.Pin` — so neither the caller nor the renderer ever styles a
 * pin, and neither names the other. The renderer is mounted whatever the
 * overlays: an empty set floats `empty` over the map rather than replacing it.
 */
export function MapView({
  overlays,
  activeId = null,
  onActivate = ignoreActivate,
  hoveredId = null,
  onHoverChange,
  onCameraRest: reportRest,
  onNoMap,
  crowd,
  focusId = null,
  fitPadding = NO_MAP_PADDING,
  pick,
  cameraKey,
  cameraOpen = "remembered",
  opening = "all",
  fitRequest,
  focusIds,
  empty,
  controls,
}: MapViewProps) {
  const renderer = GeoMap.Renderer.useContributions()[0];
  const { initialCamera, remember } = useRememberedCamera(
    cameraKey,
    cameraOpen,
    framingOverlays(overlays).length > 0,
  );
  // The first framing's set, when it narrows: read by the renderer once, so
  // computing it for each overlay set is O(pins) and nothing more.
  const openingIds = useMemo(
    () =>
      opening === "densest" && (focusIds === undefined || focusIds.length === 0)
        ? densestPinIds(framingOverlays(overlays))
        : null,
    [opening, focusIds, overlays],
  );
  // The caller's report through a ref, keyed on its presence only: a new
  // closure each render must not re-subscribe the renderer.
  const latestReport = useLatestRef(reportRest);
  const reports = reportRest !== undefined;
  const onCameraRest = useMemo(
    () =>
      remember === undefined && !reports
        ? undefined
        : (rest: CameraRest) => {
            remember?.(rest);
            latestReport.current?.(rest);
          },
    [remember, reports, latestReport],
  );

  if (renderer === undefined) {
    return (
      <Center className="size-full">
        <ReportNoMap onNoMap={onNoMap} />
        <Placeholder tone="error">
          No map renderer is installed, so there is nothing to draw this map
          with.
        </Placeholder>
      </Center>
    );
  }

  const tiles = renderer.tiles;
  const renderPin = (pin: MapPin, state: MapPinState) => (
    <GeoMap.Pin.Dispatch pin={pin} tiles={tiles} {...state} />
  );
  const renderCluster = (pins: readonly MapPin[]) => (
    <GeoMap.Cluster.Dispatch pins={pins} count={pins.length} tiles={tiles} />
  );
  const props: UnmarkedProps = {
    overlays,
    renderPin,
    onActivate,
    activeId,
    hoveredId,
    ...(onHoverChange === undefined ? {} : { onHoverChange }),
    ...(crowd === undefined ? {} : { crowd: resolveCrowd(crowd) }),
    renderCluster,
    focusId,
    fitPadding,
    ...(pick === undefined ? {} : { pick }),
    ...(initialCamera === null ? {} : { initialCamera }),
    ...(onCameraRest === undefined ? {} : { onCameraRest }),
    ...(fitRequest === undefined ? {} : { fitRequest }),
    ...(focusIds === undefined ? {} : { focusIds }),
    ...(openingIds === null ? {} : { openingIds }),
  };
  // Drawn over the tiles, so in the map's chrome theme, not the app's.
  const notice = (
    <MapChrome>
      <Presence>
        {overlays.length === 0 && empty !== null ? (
          <Pin key="notice" to="center" layer="raised" decorative>
            <Surface level="overlay" className="p-md">
              {empty}
            </Surface>
          </Pin>
        ) : null}
      </Presence>
      {controls}
    </MapChrome>
  );
  return (
    <MapTilesProvider tiles={tiles}>
      <MarkHostProvider>
        <MarkedRenderer
          renderer={renderer}
          props={props}
          notice={notice}
          tiles={tiles}
          onNoMap={onNoMap}
        />
      </MarkHostProvider>
    </MapTilesProvider>
  );
}

type UnmarkedProps = Omit<MapRendererProps, "markPin" | "markCluster">;

/**
 * Hands the renderer every pin's and cluster's mark: the contribution
 * `GeoMap.Pin` / `GeoMap.Cluster` dispatches to (`useMatch`, the same match
 * its component is rendered from), else the fallback's. Inside the mark host,
 * so marks resolve colours and icons in the map's scope; pending until it has
 * mounted.
 */
function MarkedRenderer({
  renderer,
  props,
  notice,
  tiles,
  onNoMap,
}: {
  renderer: RendererItem;
  props: UnmarkedProps;
  notice: ReactNode;
  tiles: MapTileScheme;
  onNoMap: (() => void) | undefined;
}) {
  const env = useMapMarkEnv(tiles);
  const matchPin = GeoMap.Pin.useMatch();
  const matchCluster = GeoMap.Cluster.useMatch();
  const markPin = (pin: MapPin, scale: MapPinScale): MapMarkResult => {
    if (env === null) return MARK_PENDING;
    const mark =
      matchPin({ pin, tiles, active: false, hovered: false, scale })?.mark ??
      defaultPinMark;
    return mark({ pin, scale }, env);
  };
  const markCluster = (pins: readonly MapPin[]): MapMarkResult => {
    if (env === null) return MARK_PENDING;
    const count = pins.length;
    const mark =
      matchCluster({ pins, count, tiles })?.mark ?? defaultClusterMark;
    return mark({ pins, count }, env);
  };
  return (
    <RendererGate
      renderer={renderer}
      props={{ ...props, markPin, markCluster }}
      notice={notice}
      onNoMap={onNoMap}
    />
  );
}

interface GateProps {
  renderer: RendererItem;
  props: MapRendererProps;
  /** Floated over the mounted map (the empty notice, the host's controls), never over a set-up state. */
  notice: ReactNode;
  /** `MapViewProps.onNoMap`: told when the renderer is blocked. */
  onNoMap: (() => void) | undefined;
}

/**
 * `renderIsolated` rather than the sealed component by hand: the host picks
 * the contribution itself (first wins), which `.Render` / `.Dispatch` cannot
 * express, and this still puts it through the slot's middleware chain — so a
 * renderer crash is contained to the map.
 */
function renderRenderer({
  renderer,
  props,
  notice,
}: Omit<GateProps, "onNoMap">): ReactNode {
  return (
    <div className="relative size-full">
      {renderIsolated(
        GeoMap.Renderer,
        renderer as unknown as Contribution,
        props,
      )}
      {notice}
    </div>
  );
}

/**
 * `useReadiness` presence is stable per contribution (it is declared in the
 * contribution literal), so branching on it keeps both arms rules-of-hooks
 * clean — the shape the place block's provider gate uses.
 */
function RendererGate({ renderer, props, notice, onNoMap }: GateProps) {
  if (renderer.useReadiness) {
    return (
      <GatedRenderer
        renderer={renderer}
        props={props}
        notice={notice}
        onNoMap={onNoMap}
        useReadiness={renderer.useReadiness}
      />
    );
  }
  return renderRenderer({ renderer, props, notice });
}

function GatedRenderer({
  renderer,
  props,
  notice,
  onNoMap,
  useReadiness,
}: GateProps & { useReadiness: Hook<() => MapRendererReadiness> }) {
  const readiness = useReadiness();
  switch (readiness) {
    case "pending":
      return (
        <Center className="size-full">
          <Loading variant="spinner" />
        </Center>
      );
    case "ready":
      return renderRenderer({ renderer, props, notice });
    case "blocked": {
      const Action = renderer.AccessAction;
      return (
        <Center className="size-full">
          <ReportNoMap onNoMap={onNoMap} />
          {Action ? (
            <Action />
          ) : (
            // A renderer that says it is blocked but offers no fix: say so
            // plainly rather than mounting a map whose every tile would fail.
            <Placeholder tone="error">
              {renderer.label} is not set up yet.
            </Placeholder>
          )}
        </Center>
      );
    }
  }
}

/**
 * Tells the caller, once per mount, that no map is drawn where this renders
 * (`MapViewProps.onNoMap`). Renders nothing.
 */
function ReportNoMap({ onNoMap }: { onNoMap: (() => void) | undefined }) {
  const report = useLatestRef(onNoMap);
  useEffect(() => {
    report.current?.();
  }, [report]);
  return null;
}
