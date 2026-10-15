import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { swingRatioLabel, swingUnitLabel } from "../../core";

/**
 * Swing chip — a screen-anchored HUD pill beside the key chip, shown while the
 * song plays swung: "Swing 8ths 2:1". Reads the session Score's `meta.swing`,
 * the feel the audio layer plays (the per-song override already applied).
 */
export function SwingChip() {
  const { score } = useSession();
  const swing = score.meta.swing;
  if (!swing) return null; // straight → no chip.
  return (
    // eslint-disable-next-line text/no-adhoc-typography -- compact HUD pill matching the key chip: leading must stay 1 so the chip stays slim; size via the text-2xs sub-scale
    <div className="pointer-events-none rounded-full border border-border/60 bg-background/90 px-sm py-xs text-2xs font-semibold leading-none text-foreground shadow-sm backdrop-blur-sm">
      <span className="text-muted-foreground">
        Swing {swingUnitLabel(swing.unit)}{" "}
      </span>
      {swingRatioLabel(swing.ratio)}
    </div>
  );
}
