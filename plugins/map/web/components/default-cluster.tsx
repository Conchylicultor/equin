import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { MARK_SHADOW_PAD, markIdPrefix, markShadow, markSvg } from "../../core";
import type { MapClusterMarkFn, MapClusterProps } from "../slots";
import { MapMarkImage, useMapMarkEnv } from "./mark-env";

const DISC_PX = 28;
/** How much wider the pill grows per digit past the second. */
const DIGIT_PX = 7;
const BORDER_PX = 2;

/**
 * The mark of a cluster of a type nobody claimed (or of mixed types): a disc
 * (a pill for long counts) in the default pin's paint; the map draws the count
 * in its middle (`MapMark.texts`).
 */
export const defaultClusterMark: MapClusterMarkFn = ({ count }, env) => {
  const digits = String(count).length;
  const w = DISC_PX + Math.max(0, digits - 2) * DIGIT_PX;
  const fill = env.color("var(--primary)");
  const ring = env.color("var(--background)");
  const ink = env.color("var(--primary-foreground)");
  const key = `default-cluster:${w}:${fill}:${ring}`;
  const id = markIdPrefix(key);
  const { x: px, top, bottom } = MARK_SHADOW_PAD;
  const width = w + 2 * px;
  const height = DISC_PX + top + bottom;
  const r = DISC_PX / 2;
  const body =
    `<defs>${markShadow(`${id}s`)}</defs>` +
    `<rect x="${px + BORDER_PX / 2}" y="${top + BORDER_PX / 2}" width="${w - BORDER_PX}" height="${DISC_PX - BORDER_PX}" rx="${r - BORDER_PX / 2}" fill="${fill}" stroke="${ring}" stroke-width="${BORDER_PX}" filter="url(#${id}s)"/>`;
  return {
    kind: "mark",
    key,
    svg: markSvg(width, height, body),
    width,
    height,
    anchor: { x: px + w / 2, y: top + r },
    labelAt: { x: px + w + 4, centerY: top + r },
    texts: [{ at: "center", text: String(count), color: ink }],
  };
};

/** A cluster of a type nobody claimed, lifted into the DOM (hovered): its mark with its count. */
export function DefaultCluster({ pins, count, tiles }: MapClusterProps) {
  const env = useMapMarkEnv(tiles);
  if (env === null) return null;
  const mark = defaultClusterMark({ pins, count }, env);
  if (mark.kind === "pending") return null;
  const { top } = MARK_SHADOW_PAD;
  return (
    <span
      role="img"
      aria-label={`${count} pins`}
      className="relative block"
      style={{ width: mark.width, height: mark.height }}
    >
      <MapMarkImage mark={mark} />
      <Layer style={{ top, height: DISC_PX, bottom: "auto" }}>
        <Center className={cn("size-full text-primary-foreground")}>
          <Text variant="count">{count}</Text>
        </Center>
      </Layer>
    </span>
  );
}
