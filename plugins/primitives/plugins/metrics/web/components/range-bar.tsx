import type { ReactNode } from "react";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import {
  SegmentedControl,
  ToggleChip,
} from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { PRESETS, type Preset } from "../../core";

const PRESET_LABEL: Record<Preset, string> = {
  "7d": "7D",
  "30d": "30D",
  "90d": "90D",
  "1y": "1Y",
};

const PRESET_TITLE: Record<Preset, string> = {
  "7d": "The last 7 days",
  "30d": "The last 30 days",
  "90d": "The last 90 days",
  "1y": "The last 53 weeks",
};

const OPTIONS = PRESETS.map((id) => ({
  id,
  label: PRESET_LABEL[id],
  title: PRESET_TITLE[id],
}));

export interface RangeBarProps {
  preset: Preset;
  onPreset: (preset: Preset) => void;
  compare: boolean;
  onCompare: (compare: boolean) => void;
}

/** The board's date range presets, and whether its charts draw the previous period. */
export function RangeBar({
  preset,
  onPreset,
  compare,
  onCompare,
}: RangeBarProps): ReactNode {
  return (
    <Cluster gap="sm" role="group" aria-label="Date range">
      <SegmentedControl options={OPTIONS} value={preset} onChange={onPreset} />
      <ToggleChip
        active={compare}
        variant="tinted"
        onClick={() => onCompare(!compare)}
        tooltip="Draw the previous period as a dashed line"
      >
        Compare to previous
      </ToggleChip>
    </Cluster>
  );
}
