import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useMapProjection, usePlanZoom } from "./projected-zoom";

/** The map handle's reads these hooks make, at a given camera. */
function fakeMap(
  zoom: number | undefined,
  projected: boolean,
): google.maps.Map {
  const projection = {
    fromLatLngToPoint: () => null,
  } as unknown as google.maps.Projection;
  return {
    getProjection: () => (projected ? projection : undefined),
    getZoom: () => zoom,
    addListener: () => ({ remove: () => {} }),
  } as unknown as google.maps.Map;
}

function Probe({ map }: { map: google.maps.Map | null }) {
  const zoom = usePlanZoom(map);
  const projection = useMapProjection(map);
  return (
    <i>{`${String(zoom)},${projection === null ? "none" : "projected"}`}</i>
  );
}

// A static render to HTML (react-dom/server, no DOM) reads the map handle as
// it stands: it must not throw.
describe("map camera reads under a server render", () => {
  it("reads nothing without a map", () => {
    expect(renderToStaticMarkup(<Probe map={null} />)).toBe(
      "<i>undefined,none</i>",
    );
  });

  it("reads nothing before the projection exists", () => {
    expect(renderToStaticMarkup(<Probe map={fakeMap(12.4, false)} />)).toBe(
      "<i>undefined,none</i>",
    );
  });

  it("reads the plan zoom and the projection once it exists", () => {
    expect(renderToStaticMarkup(<Probe map={fakeMap(12.6, true)} />)).toBe(
      "<i>13,projected</i>",
    );
  });
});
