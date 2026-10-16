import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  MARK_PENDING,
  MARK_SHADOW_PAD,
  dropHeadSvg,
  dropTipPx,
  markIdPrefix,
  markSvg,
} from "@plugins/map/core";
import {
  MapLabel,
  MapMarkImage,
  useMapMarkEnv,
  type MapPinMarkFn,
  type MapPinProps,
} from "@plugins/map/web";
import {
  placeFamilyFill,
  placeKindGlyph,
} from "@plugins/page/plugins/place/web";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import { placePinData } from "../internal/place-layer";

/** The drop's head: a 30px disc. The tip lands 36px below its top (√2·15 + 15). */
const HEAD_PX = 30;
/** 14px: the card tile's 46% glyph share of the 30px head. */
const GLYPH_PX = 14;
/** Air between the head and its label. */
const LABEL_GAP_PX = 4;

/**
 * A place's mark (`GeoMap.Pin`'s `mark` for `place`): a teardrop whose colour
 * and glyph say what KIND of place it is — the same family colour
 * (`placeFamilyFill`, the `place` palette token) and glyph (`placeKindGlyph`)
 * as the /place card's circle, so a place reads as the same thing on the page
 * and on the map — its tip on the point, with the name always beside the
 * head as map-label text (whose paint follows the tiles, not the app theme).
 */
export const placePinMark: MapPinMarkFn = ({ pin }, env) => {
  const { kind, family } = placePinData(pin);
  const icon = env.icon(placeKindGlyph(kind), { active: false });
  if (icon.kind === "pending") return MARK_PENDING;
  const fill = env.color(placeFamilyFill(family));
  const ink = env.color("var(--categorical-foreground)");
  const key = `page-place|${fill}|${ink}|${hash53(icon.viewBox + icon.body).toString(36)}`;
  const id = markIdPrefix(key);
  const { x: px, top, bottom } = MARK_SHADOW_PAD;
  const tip = dropTipPx(HEAD_PX);
  const width = HEAD_PX + 2 * px;
  const height = tip + top + bottom;
  const head = dropHeadSvg({
    shape: "drop",
    sizePx: HEAD_PX,
    fills: [fill],
    ring: ink,
    icon: { markup: icon, sizePx: GLYPH_PX, ink },
    id,
  });
  return {
    kind: "mark",
    key,
    svg: markSvg(
      width,
      height,
      `<g transform="translate(${px} ${top})">${head}</g>`,
    ),
    width,
    height,
    anchor: { x: px + HEAD_PX / 2, y: top + tip },
    labelAt: { x: px + HEAD_PX + LABEL_GAP_PX, centerY: top + HEAD_PX / 2 },
    ...(pin.label
      ? { texts: [{ at: "beside" as const, text: pin.label }] }
      : {}),
  };
};

/**
 * A place lifted into the DOM (hovered or active): its mark, lifted on hover
 * and grown from its tip while active, the label riding along so it stays
 * centred on the head.
 */
export function PlacePin({ pin, active, scale, tiles }: MapPinProps) {
  const env = useMapMarkEnv(tiles);
  if (env === null) return null;
  const mark = placePinMark({ pin, scale }, env);
  if (mark.kind === "pending") return null;
  return (
    <span
      className={cn(
        "group/pin relative block cursor-pointer transition-transform",
        active ? "scale-[1.18]" : "hover:-translate-y-0.5 hover:scale-105",
      )}
      style={{
        width: mark.width,
        height: mark.height,
        transformOrigin: `${mark.anchor.x}px ${mark.anchor.y}px`,
      }}
    >
      <MapMarkImage mark={mark} />
      {pin.label ? (
        <Placed
          x={{ start: mark.labelAt.x }}
          y={{ center: mark.labelAt.centerY }}
          className="max-w-48 whitespace-nowrap"
        >
          <MapLabel tiles={tiles}>{pin.label}</MapLabel>
        </Placed>
      ) : null}
    </span>
  );
}
