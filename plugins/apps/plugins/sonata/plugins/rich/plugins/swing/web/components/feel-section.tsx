import { useId } from "react";
import type { Swing } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Slider } from "@plugins/primitives/plugins/css/plugins/slider/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  Button,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  MAX_SWING_RATIO,
  MIN_SWING_RATIO,
  SWING_STOPS,
  swingFeelName,
  swingLabel,
  swingRatioLabel,
  swingSplit,
  swingStopAt,
  swingUnitLabel,
} from "../../core";
import { swingDisplayConfig } from "../../shared/config";
import { useSwing } from "../use-swing";
import { SwingPicture } from "./swing-picture";

/** Offered for a library song: a file document has nowhere to keep a feel. */
export function useFeelAvailable(): boolean {
  return useSwing().kind !== "none";
}

/**
 * Header action: the feel playing now, and swing on / off. Off plays straight
 * but keeps the feel; on plays it again — the last one chosen, else the song's
 * own, else 8ths 2:1. The section's only header item, so the inspector chrome
 * shows it collapsed and open alike — the switch never hides behind a click.
 */
export function FeelSwitch() {
  const swing = useSwing();
  if (swing.kind === "none") return null;
  if (swing.kind === "pending") return <Loading variant="spinner" />;
  if (swing.kind === "failed")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the song's swing"
        error={swing.error}
        refetch={swing.refetch}
      />
    );
  const { on, feel } = swing;
  return (
    <Stack direction="row" gap="sm" align="center">
      <Text variant="caption" tone="muted">
        {on ? swingLabel(feel) : "Straight"}
      </Text>
      <WithTooltip
        content={
          on
            ? "Playing swung. Turn off to hear the song straight."
            : "Swing the off-beats when playing. The notation stays straight."
        }
      >
        <Switch
          checked={on}
          onCheckedChange={(next) => swing.set(next, feel)}
          aria-label="Swing"
        />
      </WithTooltip>
    </Stack>
  );
}

const UNIT_OPTIONS = [
  { id: "8", label: "8th notes" },
  { id: "16", label: "16th notes" },
] as const;

const NO_STOP = "custom";

/**
 * The Feel body: a picture of two beats as played, the ratio in numbers and
 * words, the swung unit, the ratio (a slider plus the named stops), and where
 * the feel comes from. Changing the unit or ratio while off turns swing on.
 */
export function FeelSection() {
  const swing = useSwing();
  if (swing.kind === "none") return null;
  if (swing.kind === "pending") return <Loading variant="rows" count={3} />;
  if (swing.kind === "failed")
    return (
      <ResourceErrorInline
        variant="block"
        subject="the song's swing"
        error={swing.error}
        refetch={swing.refetch}
      />
    );
  // Off, the controls show the feel turning it on would play.
  const { on, feel } = swing;
  // Playing something other than what the content marks. (Off on a song that
  // marks no swing plays as the content does, whatever feel it remembers.)
  const changed = on ? swing.override.kind !== "score" : !!swing.authored;
  const [long, short] = on ? swingSplit(feel.ratio) : [50, 50];
  const change = (patch: Partial<Swing>) =>
    swing.set(true, { ...feel, ...patch });

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <SwingPicture swing={feel} dim={!on} />
        <Stack direction="row" gap="sm" align="baseline">
          <Text variant="heading" tone={on ? "default" : "muted"}>
            {on ? swingRatioLabel(feel.ratio) : "1:1"}
          </Text>
          <Text variant="body" tone={on ? "default" : "muted"}>
            {on ? swingFeelName(feel.ratio) : "Straight"}
          </Text>
          <Fill />
          <Text variant="count" tone="muted">
            {long}% · {short}%
          </Text>
        </Stack>
      </Stack>
      <Stack gap="xs">
        <Text variant="eyebrow" tone="muted">
          Swing the
        </Text>
        <SegmentedControl
          label="Swung note value"
          options={UNIT_OPTIONS}
          value={feel.unit === 16 ? "16" : "8"}
          onChange={(id) => change({ unit: id === "16" ? 16 : 8 })}
        />
      </Stack>
      <Stack gap="xs">
        <Text variant="eyebrow" tone="muted">
          Feel
        </Text>
        <Slider
          aria-label="Swing ratio"
          min={MIN_SWING_RATIO}
          max={MAX_SWING_RATIO}
          step={0.05}
          detent={2}
          value={feel.ratio}
          onValueChange={(ratio) => change({ ratio })}
        />
        <SegmentedControl<string>
          label="Named feels"
          options={SWING_STOPS.map((s) => ({
            id: s.id,
            label: `${s.name} ${swingRatioLabel(s.ratio)}`,
          }))}
          value={on ? (swingStopAt(feel.ratio)?.id ?? NO_STOP) : NO_STOP}
          onChange={(id) => {
            const stop = SWING_STOPS.find((s) => s.id === id);
            if (stop) change({ ratio: stop.ratio });
          }}
        />
      </Stack>
      <Stack gap="xs">
        <Stack direction="row" gap="sm" align="center">
          <Fill>
            <Text variant="caption" tone="muted">
              <FeelSource on={on} changed={changed} authored={swing.authored} />
            </Text>
          </Fill>
          {changed && (
            <Button variant="ghost" onClick={swing.reset}>
              Reset
            </Button>
          )}
        </Stack>
      </Stack>
      {on ? (
        <SwingFallingNotesRow />
      ) : (
        <Text variant="caption" tone="faint">
          The notation stays straight.
        </Text>
      )}
    </Stack>
  );
}

/**
 * Whether the falling notes (and the key lights, effects and pedal lane with
 * them) draw the swung timing the audio plays, or the straight grid. A per-user
 * view preference, not part of the song's feel — so it is config, not the
 * song's swing row. Shown only while the song swings: off, both draw the same.
 */
function SwingFallingNotesRow() {
  const labelId = useId();
  const { swingFallingNotes } = useConfig(swingDisplayConfig);
  const setConfig = useSetConfig(swingDisplayConfig);
  return (
    <Stack direction="row" gap="sm" align="center">
      <Fill>
        <Stack gap="2xs">
          <Text id={labelId} variant="body">
            Swing the falling notes
          </Text>
          <Text variant="caption" tone="faint">
            The notation stays straight.
          </Text>
        </Stack>
      </Fill>
      <Switch
        checked={swingFallingNotes}
        onCheckedChange={(next) => setConfig("swingFallingNotes", next)}
        aria-labelledby={labelId}
      />
    </Stack>
  );
}

/** Where the feel playing now comes from. */
function FeelSource({
  on,
  changed,
  authored,
}: {
  on: boolean;
  changed: boolean;
  authored: Swing | undefined;
}) {
  if (!changed)
    return authored ? (
      <>From the score</>
    ) : (
      <>Not marked in this song — plays straight</>
    );
  if (authored)
    return (
      <>
        Changed by you · the score says swing {swingUnitLabel(authored.unit)}{" "}
        {swingRatioLabel(authored.ratio)}
      </>
    );
  return on ? <>Added by you — not marked in this song</> : null;
}
