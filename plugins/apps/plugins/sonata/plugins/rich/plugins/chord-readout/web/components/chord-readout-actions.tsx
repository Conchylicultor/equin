import { useMemo } from "react";
import { chordPitches } from "@plugins/apps/plugins/sonata/plugins/theory/core";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  useCurrentChord,
  useShowInversions,
} from "../internal/use-current-chord";

/**
 * Header-right control for the "Current chord" section: the Inversions toggle.
 * Lives in the contribution's `actions` (not the body) so it stays reachable
 * while the section is collapsed. Rendered disabled rather than hidden when
 * there is nothing to invert (a gap, or a chord of fewer than two notes), so
 * the header doesn't reflow at every gap between chords.
 */
export function ChordReadoutActions() {
  const current = useCurrentChord();
  const [showInversions, setShowInversions] = useShowInversions();
  const invertible = useMemo(
    () => current !== undefined && chordPitches(current.data).length >= 2,
    [current],
  );

  return (
    <ToggleChip
      active={showInversions}
      variant="ghost"
      disabled={!invertible}
      onClick={() => setShowInversions((v) => !v)}
      tooltip="Show one keyboard per inversion of the chord"
    >
      Inversions
    </ToggleChip>
  );
}
