import type { Swing } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

const W = 268;
const H = 40;
const BEATS = 2;
const GAP = 2;

/**
 * Two beats of the swung subdivision as note bars: each pair split long–short
 * at `ratio / (1 + ratio)`, over the straight grid (dashed) it is swung away
 * from. `swing` absent = straight (even pairs, no grid). `dim` while the feel
 * is off.
 */
export function SwingPicture({ swing, dim }: { swing: Swing; dim: boolean }) {
  const beatW = W / BEATS;
  const pairs = swing.unit === 8 ? 1 : 2;
  const pairW = beatW / pairs;
  const split = dim ? 0.5 : swing.ratio / (1 + swing.ratio);
  const bars = [];
  for (let b = 0; b < BEATS; b++) {
    for (let k = 0; k < pairs; k++) {
      const x = b * beatW + k * pairW;
      bars.push(
        <g key={`${b}-${k}`}>
          {!dim && (
            <line
              x1={x + pairW / 2}
              x2={x + pairW / 2}
              y1={6}
              y2={H - 6}
              className="stroke-muted-foreground/50"
              strokeDasharray="2 3"
            />
          )}
          <rect
            x={x + GAP}
            y={12}
            width={pairW * split - GAP * 2}
            height={16}
            rx={3}
            className={dim ? "fill-muted-foreground/40" : "fill-primary"}
          />
          <rect
            x={x + pairW * split + GAP}
            y={12}
            width={pairW * (1 - split) - GAP * 2}
            height={16}
            rx={3}
            className={dim ? "fill-muted-foreground/30" : "fill-primary/60"}
          />
        </g>,
      );
    }
  }
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("block h-10 w-full")}
      role="img"
      aria-label={dim ? "Two beats played straight" : "Two beats as swung"}
    >
      {Array.from({ length: BEATS + 1 }, (_, b) => (
        <line
          key={b}
          x1={Math.min(Math.max(b * beatW, 0.5), W - 0.5)}
          x2={Math.min(Math.max(b * beatW, 0.5), W - 0.5)}
          y1={4}
          y2={H - 4}
          className="stroke-border"
        />
      ))}
      {bars}
    </svg>
  );
}
