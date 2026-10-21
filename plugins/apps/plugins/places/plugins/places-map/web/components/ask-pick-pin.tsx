import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  MARK_SHADOW_PAD,
  escapeSvg,
  markIdPrefix,
  markShadow,
  markSvg,
  type MapMarkResult,
  type MapPin,
} from "@plugins/map/core";
import {
  MapLabel,
  MapMarkImage,
  useMapMarkEnv,
  type MapMarkEnv,
  type MapPinMarkFn,
  type MapPinProps,
} from "@plugins/map/web";
import { readAskPickData } from "../internal/ask-pick";

/** The disc's box, px — a ghost pin's, so a pick reads as the same kind of proposal. */
const DISC_PX = 26;
const RING_PX = 2;
const LABEL_GAP_PX = 4;
/** Sonnet's colour: the app accent, as on the Ask row and the "why" boxes. */
const AI_FILL = "var(--primary)";
const AI_TEXT = "var(--primary-foreground)";

/**
 * One of Sonnet's picks: a disc in the accent, ringed white, holding its rank
 * (1 = best) — numbered like the cards in the thread. Hovered, it grows and
 * its name shows beside it.
 */
function pickMark(pin: MapPin, env: MapMarkEnv): MapMarkResult {
  const { n } = readAskPickData(pin);
  const fill = env.color(AI_FILL);
  const text = env.color(AI_TEXT);
  const key = ["ask-pick", fill, text].join("|");
  const id = markIdPrefix(key);
  const { x: px, top, bottom } = MARK_SHADOW_PAD;
  const c = DISC_PX / 2;
  const r = c - RING_PX / 2;
  const body =
    `<defs>${markShadow(`${id}s`)}</defs>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="${escapeSvg(fill)}" stroke="#fff" stroke-width="${RING_PX}" filter="url(#${id}s)"/>`;
  const width = DISC_PX + 2 * px;
  const height = DISC_PX + top + bottom;
  return {
    kind: "mark",
    // The rank is text the map draws, not pixels: every pick shares one sprite.
    key,
    svg: markSvg(
      width,
      height,
      `<g transform="translate(${px} ${top})">${body}</g>`,
    ),
    width,
    height,
    anchor: { x: px + c, y: top + c },
    labelAt: { x: px + DISC_PX + LABEL_GAP_PX, centerY: top + c },
    texts: [{ at: "center", text: String(n), color: text }],
  };
}

/** `GeoMap.Pin`'s mark for a pick: the numbered accent disc. */
export const askPickMark: MapPinMarkFn = ({ pin }, env) => pickMark(pin, env);

/** A pick lifted into the DOM while hovered (its pin, or its card): grown, numbered, named. */
export function AskPickPin({ pin, tiles }: MapPinProps) {
  const env = useMapMarkEnv(tiles);
  if (env === null) return null;
  const mark = pickMark(pin, env);
  if (mark.kind === "pending") return null;
  const { n } = readAskPickData(pin);
  const { top } = MARK_SHADOW_PAD;
  const name = pin.label ?? "Sonnet's pick";
  return (
    <span
      role="img"
      aria-label={`${n}. ${name}`}
      className="relative block cursor-pointer"
      style={{ width: mark.width, height: mark.height }}
    >
      <span
        className="block scale-[1.25] transition-transform"
        style={{ transformOrigin: `${mark.anchor.x}px ${mark.anchor.y}px` }}
      >
        <MapMarkImage mark={mark} />
        <Layer style={{ top, height: DISC_PX, bottom: "auto" }}>
          <Center className="size-full text-primary-foreground">
            <Text variant="count">{n}</Text>
          </Center>
        </Layer>
      </span>
      <Placed
        x={{ start: mark.labelAt.x + 4 }}
        y={{ center: mark.labelAt.centerY }}
        className="max-w-48 whitespace-nowrap"
      >
        <MapLabel tiles={tiles}>{name}</MapLabel>
      </Placed>
    </span>
  );
}
