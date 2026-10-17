import { useEffect } from "react";
import {
  APIProvider,
  Map as GoogleMap,
  useMap,
} from "@vis.gl/react-google-maps";
import { type MapIdPreviewProps } from "@plugins/integrations/plugins/google-maps/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { GOOGLE_COLOR_SCHEME, GOOGLE_TILES } from "../internal/tiles";
import { useGoogleAuthRefused } from "../internal/auth-failure";

/** Central Paris: dense with the shops, museums and restaurants Google's style must hide. */
const PREVIEW_CENTER = { lat: 48.8606, lng: 2.3376 };
const PREVIEW_ZOOM = 16;

/**
 * A bare map for the Live map setup's Map ID check: the same Map ID, key and
 * interaction flags as the real map (no pins, no styles — a vector map is
 * styled by its Map ID), centred where Google's own places are densest so the
 * user sees whether they are hidden. Reports how Google drew it.
 */
export function MapIdPreview({
  browserKey,
  mapId,
  onResult,
}: MapIdPreviewProps) {
  const report = useLatestRef(onResult);
  const refused = useGoogleAuthRefused();
  useEffect(() => {
    if (refused) {
      report.current({
        kind: "error",
        message: "Google refused the browser key.",
      });
    }
  }, [refused, report]);

  return (
    <APIProvider
      apiKey={browserKey}
      onError={(err) =>
        report.current({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        })
      }
    >
      <GoogleMap
        mapId={mapId}
        tiltInteractionEnabled={false}
        headingInteractionEnabled={false}
        colorScheme={GOOGLE_COLOR_SCHEME[GOOGLE_TILES]}
        defaultCenter={PREVIEW_CENTER}
        defaultZoom={PREVIEW_ZOOM}
        // The preview sits in a scrolling pane: the wheel must scroll it.
        gestureHandling="cooperative"
        streetViewControl={false}
        mapTypeControl={false}
        fullscreenControl={false}
      >
        <ReportRendering onResult={onResult} />
      </GoogleMap>
    </APIProvider>
  );
}

/** Reads `getRenderingType()` once it is past UNINITIALIZED, and again when it changes. */
function ReportRendering({
  onResult,
}: {
  onResult: MapIdPreviewProps["onResult"];
}) {
  const map = useMap();
  const report = useLatestRef(onResult);
  useEffect(() => {
    if (map === null) return;
    const read = () => {
      const type = map.getRenderingType();
      if (type === "UNINITIALIZED") return;
      report.current({ kind: type === "VECTOR" ? "vector" : "raster" });
    };
    read();
    const listener = map.addListener("renderingtype_changed", read);
    return () => listener.remove();
  }, [map, report]);
  return null;
}
