import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { MapClusterProps } from "@plugins/map/web";
import { readPlaceVisual } from "../internal/place-visual";
import { clusterRing, clusterSizePx, conicSlices } from "../internal/pin-paint";

/** The face and its ink are on the map, not the app: fixed, like a map label. */
const FACE = "#ffffff";
const DONE_INK = "#16a34a";

/**
 * Nearby saved places merged into one mark (`GeoMap.Cluster` for
 * `saved-place`): a disc ringed by the colour mix of the places inside (each
 * place one share, split evenly over its colours, heaviest first), a white
 * face with the count, and `✓ n` for how many of them are done. It grows in
 * three steps with the count.
 */
export function SavedPlaceCluster({ pins, count }: MapClusterProps) {
  const { ring, done } = clusterRing(
    pins.map((pin) => {
      const v = readPlaceVisual(pin);
      return { colors: v.colors, done: v.status === "done" };
    }),
  );
  const size = clusterSizePx(count);
  return (
    <Center
      as="span"
      role="img"
      aria-label={`${count} places, ${done} done`}
      className="cursor-pointer rounded-full border-2 border-categorical-foreground p-xs shadow-lg"
      style={{ width: size, height: size, background: conicSlices(ring) }}
    >
      <Stack
        as="span"
        gap="none"
        align="center"
        justify="center"
        className="size-full rounded-full text-black/85"
        style={{ backgroundColor: FACE }}
      >
        <Text variant="count">{count}</Text>
        {done > 0 ? (
          <Text variant="caption" style={{ color: DONE_INK }}>
            ✓ {done}
          </Text>
        ) : null}
      </Stack>
    </Center>
  );
}
