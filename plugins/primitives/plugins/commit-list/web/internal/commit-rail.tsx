import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  useControlSize,
  type ControlSize,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * How tall one commit row is, per ambient control density.
 *
 * The row's height cannot be a constant: the rail is an SVG, so it has to be
 * told the number the row is laid out at, and the two are only guaranteed to
 * agree if they read the SAME function. A dense readout (the Build popover's
 * deployment chain, which declares `xs`) gets a shorter row; a full pane leaves
 * the density alone and keeps the comfortable one.
 */
const ROW_HEIGHT: Record<ControlSize, number> = {
  xs: 26,
  sm: 30,
  md: 36,
  lg: 40,
};

/** The row height for a density — the one number the row and its rail share. */
export function commitRowHeight(density: ControlSize): number {
  return ROW_HEIGHT[density];
}

const RAIL_X = 14;
const DOT_RADIUS = 5;

interface Props {
  isFirst: boolean;
  isLast: boolean;
  color: string;
}

// Single-rail SVG. Top of rail extends above the first row to suggest the
// branch continuing upward; bottom of the last row connects into the
// merge-base marker below the list.
export function CommitRail({ isFirst, isLast, color }: Props) {
  // Height from the ambient density, exactly as the row itself reads it — so
  // the rail can never be drawn at a height the row is not laid out at.
  const height = commitRowHeight(useControlSize());
  const top = isFirst ? height / 2 : 0;
  const bottom = isLast ? height / 2 : height;
  return (
    <svg
      width={28}
      height={height}
      viewBox={`0 0 28 ${height}`}
      aria-hidden="true"
    >
      <line
        x1={RAIL_X}
        y1={top}
        x2={RAIL_X}
        y2={bottom}
        stroke={color}
        strokeWidth={2}
      />
      <circle cx={RAIL_X} cy={height / 2} r={DOT_RADIUS} fill={color} />
    </svg>
  );
}

// Marker rendered below the last commit row, at the merge-base point. Shows
// the rail terminating into a smaller "main" dot, mirroring VSCode Git Graph.
export function MergeBaseMarker({
  color,
  mainColor,
  shortSha,
  hasPending,
}: {
  color: string;
  mainColor: string;
  shortSha: string | null;
  hasPending: boolean;
}) {
  const row = commitRowHeight(useControlSize());
  return (
    <Stack
      as="li"
      direction="row"
      align="center"
      gap="sm"
      className="text-muted-foreground"
    >
      <svg width={28} height={row} viewBox={`0 0 28 ${row}`} aria-hidden="true">
        {hasPending && (
          <line
            x1={RAIL_X}
            y1={0}
            x2={RAIL_X}
            y2={row / 2}
            stroke={color}
            strokeWidth={2}
          />
        )}
        <line
          x1={RAIL_X}
          y1={row / 2}
          x2={RAIL_X}
          y2={row}
          stroke={mainColor}
          strokeWidth={2}
          strokeDasharray="3 3"
        />
        <circle cx={RAIL_X} cy={row / 2} r={DOT_RADIUS - 1} fill={mainColor} />
      </svg>
      <Text as="span" variant="caption">
        <Inline gap="sm">
          <span className="font-mono">{shortSha ?? "main"}</span>
          <span>merge-base</span>
        </Inline>
      </Text>
    </Stack>
  );
}
