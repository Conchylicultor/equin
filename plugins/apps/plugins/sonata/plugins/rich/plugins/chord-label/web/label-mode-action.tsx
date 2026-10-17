import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import type { ChordDisplayMode } from "@plugins/apps/plugins/sonata/plugins/theory/core";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { chordLabelConfig } from "../shared/config";

/** Each mode's button face, its tooltip name and the mode a click moves to. */
const LABEL_MODES: Record<
  ChordDisplayMode,
  { face: string; name: string; next: ChordDisplayMode }
> = {
  symbol: { face: "C", name: "Symbols", next: "roman" },
  roman: { face: "I", name: "Roman numerals", next: "both" },
  both: { face: "C·I", name: "Both", next: "symbol" },
};

function isChordDisplayMode(value: string): value is ChordDisplayMode {
  return Object.hasOwn(LABEL_MODES, value);
}

/**
 * Header action for a chord surface's section: a small text button cycling the
 * global chord-label mode symbol → roman → both. Its face IS the current mode
 * (`C` / `I` / `C·I`), so it reads as a label sample, not a setting. Writes the
 * same `chordLabelConfig` the View popover edits, so every chord surface
 * relabels at once. While the config is not yet known it is a loading
 * placeholder — the default mode would be a claim about the user's choice.
 */
export function ChordLabelModeAction() {
  const result = useConfigResult(chordLabelConfig);
  const setConfig = useSetConfig(chordLabelConfig);

  if (result.status === "loading") return <Loading variant="spinner" />;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the chord-label mode"
        error={result.error}
        refetch={result.refetch}
      />
    );

  const mode = result.data.mode;
  if (!isChordDisplayMode(mode))
    throw new Error(`[chord-label] unknown chord-label mode "${mode}"`);
  const current = LABEL_MODES[mode];
  const next = LABEL_MODES[current.next];

  return (
    <Button
      tooltip={`Chord labels: ${current.name} — click for ${next.name.toLowerCase()}`}
      variant="ghost"
      aspect="text"
      aria-label={`Chord labels: ${current.name}`}
      className="font-semibold tabular-nums"
      onClick={() => setConfig("mode", current.next)}
    >
      {current.face}
    </Button>
  );
}
