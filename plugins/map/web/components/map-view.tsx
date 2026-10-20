import { useMemo, useState, type ReactNode } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  legacyDraftKeys,
  readDraft,
  writeDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import {
  MARK_PENDING,
  NO_MAP_PADDING,
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
  /** The pin under the pointer changed (`null`: none) — to link it back. */
  onHoverChange?: (id: string | null) => void;
  /**
   * The camera came to rest (and once when the map first settles): where it
   * is, and the area it shows — what a search biased to "this map area" reads.
   */
  onCameraRest?: (rest: CameraRest) => void;
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
   * The host's own words for "nothing to show", floated on a card over the
   * map while there are no overlays — or `null` for a bare map (a host that
   * already says the count elsewhere). The map itself stays mounted either
   * way: an overlay set that empties (a filter matching nothing) and fills
   * again keeps the user's pan and zoom.
   */
  empty: ReactNode;
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
  framesSomething: boolean,
): {
  initialCamera: CameraView | null;
  remember: ((view: CameraView) => void) | undefined;
} {
  const [initialCamera] = useState(() => {
    if (cameraKey === undefined) return null;
    return readDraft(cameraStore, { scope: cameraKey });
  });
  const framing = useLatestRef(framesSomething);
  const remember = useMemo(
    () =>
      cameraKey === undefined
        ? undefined
        : ({ center, zoom }: CameraView) => {
            if (!framing.current) return;
            writeDraft(cameraStore, { center, zoom }, { scope: cameraKey });
          },
    [cameraKey, framing],
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
  crowd,
  focusId = null,
  fitPadding = NO_MAP_PADDING,
  pick,
  cameraKey,
  empty,
}: MapViewProps) {
  const renderer = GeoMap.Renderer.useContributions()[0];
  const { initialCamera, remember } = useRememberedCamera(
    cameraKey,
    framingOverlays(overlays).length > 0,
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
  };
  const notice =
    overlays.length === 0 && empty !== null ? (
      <Pin to="center" layer="raised" decorative>
        <Surface level="overlay" className="p-md">
          {empty}
        </Surface>
      </Pin>
    ) : null;
  return (
    <MarkHostProvider>
      <MarkedRenderer
        renderer={renderer}
        props={props}
        notice={notice}
        tiles={tiles}
      />
    </MarkHostProvider>
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
}: {
  renderer: RendererItem;
  props: UnmarkedProps;
  notice: ReactNode;
  tiles: MapTileScheme;
}) {
  const env = useMapMarkEnv(tiles);
  const matchPin = GeoMap.Pin.useMatch();
  const matchCluster = GeoMap.Cluster.useMatch();
  const markPin = (pin: MapPin, scale: MapPinScale): MapMarkResult => {
    if (env === null) return MARK_PENDING;
    const mark =
      matchPin({ pin, tiles, active: false, scale })?.mark ?? defaultPinMark;
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
    />
  );
}

interface GateProps {
  renderer: RendererItem;
  props: MapRendererProps;
  /** Floated over the mounted map (the empty notice), never over a set-up state. */
  notice: ReactNode;
}

/**
 * `renderIsolated` rather than the sealed component by hand: the host picks
 * the contribution itself (first wins), which `.Render` / `.Dispatch` cannot
 * express, and this still puts it through the slot's middleware chain — so a
 * renderer crash is contained to the map.
 */
function renderRenderer({ renderer, props, notice }: GateProps): ReactNode {
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
function RendererGate({ renderer, props, notice }: GateProps) {
  if (renderer.useReadiness) {
    return (
      <GatedRenderer
        renderer={renderer}
        props={props}
        notice={notice}
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
