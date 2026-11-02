import type { MapMarkResult, MapPin } from "@plugins/map/core";
import {
  useMapMarkEnv,
  type MapMarkEnv,
  type MapPinMarkFn,
  type MapPinProps,
} from "@plugins/map/web";
import { readPageItemPinData } from "../internal/page-item";
import { washInk } from "../internal/pin-paint";
import { GhostPin, ghostDiscMark } from "./google-result-pin";
import { PAGE_OVERLAY_FILL, PAGE_OVERLAY_TEXT } from "./saved-place-pin";

/**
 * A page's place not saved yet: the ghost disc of a Google result — its ring
 * dashed in the overlay accent, its kind's glyph in its family's darkened
 * colour — with its number on the page on a badge.
 */
function pageItemMark(
  pin: MapPin,
  env: MapMarkEnv,
  on: boolean,
): MapMarkResult {
  const { n, icon, color } = readPageItemPinData(pin);
  return ghostDiscMark(
    {
      kind: "page-item",
      icon,
      ink: washInk(color),
      ring: PAGE_OVERLAY_FILL,
      on,
      badge: { n, text: PAGE_OVERLAY_TEXT },
    },
    env,
  );
}

/** `GeoMap.Pin`'s mark for a page's place not saved yet. */
export const pageItemPinMark: MapPinMarkFn = ({ pin }, env) =>
  pageItemMark(pin, env, false);

/** A page's place lifted into the DOM (hovered on the map or in the panel, or open). */
export function PageItemPin({ pin, active, hovered, tiles }: MapPinProps) {
  const env = useMapMarkEnv(tiles);
  if (env === null) return null;
  const on = active || hovered;
  const mark = pageItemMark(pin, env, on);
  if (mark.kind === "pending") return null;
  const { n } = readPageItemPinData(pin);
  return (
    <GhostPin
      mark={mark}
      on={on}
      name={`${n}. ${pin.label ?? "Place"}`}
      tiles={tiles}
    />
  );
}
