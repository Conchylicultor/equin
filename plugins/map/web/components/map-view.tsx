import { useMemo, useState, type ReactNode } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  readDraft,
  writeDraft,
  type DraftOptions,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import {
  NO_MAP_PADDING,
  resolveCrowd,
  type CameraView,
  type LatLng,
  type MapCrowdRequest,
  type MapOverlay,
  type MapPadding,
  type MapPin,
} from "../../core";
import {
  GeoMap,
  type MapPinState,
  type MapRendererProps,
  type MapRendererReadiness,
} from "../slots";

/** A renderer as the slot hands it back: `component` sealed, everything else readable. */
type RendererItem = ReturnType<typeof GeoMap.Renderer.useContributions>[number];

export interface MapViewProps {
  overlays: readonly MapOverlay[];
  /** The selected overlay's id; its pin renders `active`. */
  activeId?: string | null;
  /** A pin was clicked. */
  onActivate?: (id: string) => void;
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

/** A remembered camera outlives a draft's week: where the user left a map stays theirs. */
const CAMERA_DRAFT: DraftOptions = { ttl: Number.POSITIVE_INFINITY };

function cameraDraftKey(cameraKey: string): string {
  return `map.camera:${cameraKey}`;
}

/** Stored bytes are untrusted (an older shape, a hand edit): only a real view restores. */
function isCameraView(v: unknown): v is CameraView {
  if (typeof v !== "object" || v === null) return false;
  const { center, zoom } = v as Partial<CameraView>;
  return (
    typeof zoom === "number" &&
    Number.isFinite(zoom) &&
    typeof center === "object" &&
    center !== null &&
    Number.isFinite(center.lat) &&
    Number.isFinite(center.lng)
  );
}

/**
 * The remembered camera for `cameraKey`: the view to open at (read once, at
 * mount — a later write must not move a mounted map) and the writer of each
 * view the camera rests at. Nothing without a key.
 */
function useRememberedCamera(cameraKey: string | undefined): {
  initialCamera: CameraView | null;
  onCameraRest: ((view: CameraView) => void) | undefined;
} {
  const [initialCamera] = useState(() => {
    if (cameraKey === undefined) return null;
    const stored = readDraft<unknown>(cameraDraftKey(cameraKey), CAMERA_DRAFT);
    return isCameraView(stored) ? stored : null;
  });
  const onCameraRest = useMemo(
    () =>
      cameraKey === undefined
        ? undefined
        : (view: CameraView) =>
            writeDraft(cameraDraftKey(cameraKey), view, CAMERA_DRAFT),
    [cameraKey],
  );
  return { initialCamera, onCameraRest };
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
  crowd,
  focusId = null,
  fitPadding = NO_MAP_PADDING,
  pick,
  cameraKey,
  empty,
}: MapViewProps) {
  const renderer = GeoMap.Renderer.useContributions()[0];
  const { initialCamera, onCameraRest } = useRememberedCamera(cameraKey);

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
  const props: MapRendererProps = {
    overlays,
    renderPin,
    onActivate,
    activeId,
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
  return <RendererGate renderer={renderer} props={props} notice={notice} />;
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
