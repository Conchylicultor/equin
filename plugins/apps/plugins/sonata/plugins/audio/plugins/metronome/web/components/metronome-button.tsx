import { scoreEndBeat } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Slider } from "@plugins/primitives/plugins/css/plugins/slider/web";
import { metronomeConfig } from "../../shared/config";
import { TempoBand } from "./tempo-band";
import { sonataIcons } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/icons/core";

const metronomeIcon = sonataIcons.icon("metronome");

// Count-in lengths as a single-select segmented control. The ids are strings
// (SegmentedControl is keyed by string); they map 1:1 to the `countInBars` int.
const COUNT_IN_OPTIONS = [
  { id: "0", label: "Off" },
  { id: "1", label: "1 bar" },
  { id: "2", label: "2 bars" },
] as const;

// Clicks-per-beat, presented as the standard musical subdivisions. The id maps
// 1:1 to the `subdivision` int; the `title` names the note value on hover.
const SUBDIVISION_OPTIONS = [
  { id: "1", label: "1", title: "Quarter notes (one click per beat)" },
  { id: "2", label: "2", title: "Eighth notes (two per beat)" },
  { id: "3", label: "3", title: "Triplets (three per beat)" },
  { id: "4", label: "4", title: "Sixteenth notes (four per beat)" },
] as const;

/**
 * The metronome header control (`sonataPlayerPane.Actions`): a single button that opens
 * the metronome control panel. The button itself reflects the click-track state
 * (filled = on, like the Loop toggle) at a glance; opening it reveals the live
 * tempo the click follows (`TempoBand` — the player bar carries no BPM label of
 * its own), a master on/off switch, plus the count-in length, click volume, and
 * downbeat-accent settings. All values are the `sonata.metronome` config (read via
 * `useConfig`, written via `useSetConfig`), so they persist and stay in sync with
 * the Settings pane.
 *
 * The panel is a `ControlPanelPopover`: the two on/off controls speak the ONE
 * switch language (`select="switch"` — they used to be a `ToggleChip` reading
 * "On"/"Off" and another reading its own label), each setting is a BAND so the
 * hairlines between them are the container's, and the width is the `menu` role
 * rather than whatever the widest segmented control happened to measure.
 */
export function MetronomeButton() {
  const { score } = useSession();
  const { continuous, countInBars, volume, accentDownbeat, subdivision } =
    useConfig(metronomeConfig);
  const setConfig = useSetConfig(metronomeConfig);
  const hasScore = scoreEndBeat(score) > 0;

  return (
    <ControlPanelPopover
      align="end"
      label="Metronome"
      trigger={
        // The trigger owns its own tooltip (`label`), which is why the panel has
        // no tooltip prop to duplicate it with.
        <IconButton
          icon={metronomeIcon}
          label="Metronome"
          variant={continuous ? "default" : "ghost"}
          disabled={!hasScore}
        />
      }
    >
      <TempoBand />

      <ControlPanel.Section>
        <ControlPanel.Row
          select="switch"
          checked={continuous}
          onSelect={() => setConfig("continuous", !continuous)}
        >
          Metronome
        </ControlPanel.Row>
      </ControlPanel.Section>

      <ControlPanel.Section label="Subdivision">
        <SegmentedControl
          options={SUBDIVISION_OPTIONS}
          value={String(subdivision)}
          onChange={(id) => setConfig("subdivision", Number(id))}
          variant="ghost"
        />
      </ControlPanel.Section>

      <ControlPanel.Section label="Count-in">
        <SegmentedControl
          options={COUNT_IN_OPTIONS}
          value={String(countInBars)}
          onChange={(id) => setConfig("countInBars", Number(id))}
          variant="ghost"
        />
      </ControlPanel.Section>

      <ControlPanel.Section label="Click volume">
        <Slider
          value={volume}
          min={0}
          max={1}
          step={0.01}
          onValueChange={(v) => setConfig("volume", v)}
          aria-label="Click volume"
          // Full width of the panel's content box: the panel's width is a role
          // now, so the slider follows it instead of naming its own measurement.
          className="w-full"
        />
      </ControlPanel.Section>

      <ControlPanel.Section>
        <ControlPanel.Row
          select="switch"
          checked={accentDownbeat}
          onSelect={() => setConfig("accentDownbeat", !accentDownbeat)}
        >
          Accent downbeat
        </ControlPanel.Row>
      </ControlPanel.Section>
    </ControlPanelPopover>
  );
}
