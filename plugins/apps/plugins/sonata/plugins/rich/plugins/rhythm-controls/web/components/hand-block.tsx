import type { ReactNode } from "react";
import {
  effectiveOnsets,
  patternFromPreset,
  resample,
  rotate,
  RHYTHMS,
  type RhythmPattern,
} from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import {
  figurationsForHand,
  MAX_HAND_OCTAVE,
  MIN_HAND_OCTAVE,
  type HandVoicing,
} from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import {
  cn,
  ControlSizeProvider,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { HANDS, type Hand, type HandTrack } from "./hands";

const addIcon = symbol("add");
const removeIcon = symbol("remove");

/** Subdivision clamp mirrors `resample`'s own [1, 48] bound. */
const MIN_STEPS = 1;
const MAX_STEPS = 48;

/** The Rhythm select's value while the hand's necklace matches no rhythm. */
const CUSTOM = "custom";

/** What each hand's voice-leading does, on hover. */
const VOICE_LEAD_HINT: Record<Hand, string> = {
  chord: "Move each chord to the inversion nearest the last one",
  bass: "Move each bass note to the octave nearest the last one",
};

const DOUBLE_HINT: Record<Hand, string> = {
  chord: "Play every note with its octave above, in any pattern",
  bass: "Play every bass note with its octave above (C1 + C2), in any pattern",
};

/**
 * Whether `pattern` still strikes exactly its rhythm's own necklace — same
 * pulse count, same effective onsets. A bead toggle (no rhythm), a rotation or
 * a step change each make it "Custom".
 */
function matchesRhythm(pattern: RhythmPattern): boolean {
  if (pattern.presetId === null) return false;
  const native = patternFromPreset(pattern.presetId);
  if (native.subdivisions !== pattern.subdivisions) return false;
  const a = effectiveOnsets(native);
  const b = effectiveOnsets(pattern);
  return a.length === b.length && a.every((o, i) => o === b[i]);
}

export interface HandBlockProps {
  hand: Hand;
  /** The generated track the hand plays on: its name and colour. */
  track: HandTrack;
  pattern: RhythmPattern;
  onChange: (next: RhythmPattern) => void;
  /** The hand's tone-order figuration id (the *what*). */
  figurationId: string;
  onFigurationChange: (id: string) => void;
  /** The hand's voicing: on/off, octave, voice-leading, octave doubling. */
  voicing: HandVoicing;
  onVoicingChange: (next: HandVoicing) => void;
}

/**
 * One hand's controls, expanded. Its header: the hand's colour chip (its
 * track's colour — the ring it owns on the circle; click to turn the hand off
 * or on), its name and its track's name. Below, while the hand is on: the
 * **Pattern** select (the figuration — *what*) and the **Rhythm** select (the
 * necklace — *when*; it snaps the ring to the rhythm's native length, and
 * reads "Custom" once the necklace no longer matches), then the hand's own
 * dials: Octave, Voice-leading, Rotate, Steps and Octave doubling. A hand that
 * is off folds to its header.
 */
export function HandBlock({
  hand,
  track,
  pattern,
  onChange,
  figurationId,
  onFigurationChange,
  voicing,
  onVoicingChange,
}: HandBlockProps) {
  const { label } = HANDS[hand];
  const custom = !matchesRhythm(pattern);
  const rhythmValue =
    !custom && pattern.presetId !== null ? pattern.presetId : CUSTOM;

  // base-ui resolves the collapsed trigger label from `items`, not the option list.
  const rhythmItems: Record<string, string> = {
    ...(custom ? { [CUSTOM]: "Custom" } : {}),
    ...Object.fromEntries(RHYTHMS.map((r) => [r.id, r.label])),
  };
  const figurations = figurationsForHand(hand);
  const figurationItems: Record<string, string> = Object.fromEntries(
    figurations.map((f) => [f.id, f.label]),
  );
  const setVoicing = (patch: Partial<HandVoicing>) =>
    onVoicingChange({ ...voicing, ...patch });

  return (
    <ControlSizeProvider size="sm">
      <Stack gap="xs">
        <Stack direction="row" gap="sm" align="center">
          <HandChip
            color={track.color}
            enabled={voicing.enabled}
            label={label}
            onToggle={() => setVoicing({ enabled: !voicing.enabled })}
          />
          <Fill>
            <Stack direction="row" gap="xs" align="baseline">
              <Text
                as="span"
                variant="label"
                tone={voicing.enabled ? "default" : "muted"}
              >
                {label}
              </Text>
              <Text as="span" variant="caption" tone="muted">
                {track.name}
              </Text>
            </Stack>
          </Fill>
          {!voicing.enabled && (
            <Text as="span" variant="caption" tone="faint">
              Off
            </Text>
          )}
        </Stack>
        {voicing.enabled && (
          <Inset l="lg">
            <Stack gap="xs">
              <Stack direction="row" gap="xs" align="center">
                <Fill>
                  <Select
                    items={figurationItems}
                    value={figurationId}
                    onValueChange={(v: string | null) => {
                      if (v) onFigurationChange(v);
                    }}
                  >
                    <SelectTrigger
                      aria-label={`${label} pattern`}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {figurations.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Fill>
                <Fill>
                  <Select
                    items={rhythmItems}
                    value={rhythmValue}
                    onValueChange={(v: string | null) => {
                      if (v && v !== CUSTOM) onChange(patternFromPreset(v));
                    }}
                  >
                    <SelectTrigger
                      aria-label={`${label} rhythm`}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {custom && (
                        <SelectItem value={CUSTOM} disabled>
                          Custom
                        </SelectItem>
                      )}
                      {RHYTHMS.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Fill>
              </Stack>
              <Grid cols={2} gap="xs" align="center">
                <Dial label="Octave">
                  <Stepper
                    value={voicing.octave}
                    format={(o) => `C${o}`}
                    lessLabel={`Lower the ${label.toLowerCase()}`}
                    moreLabel={`Raise the ${label.toLowerCase()}`}
                    min={MIN_HAND_OCTAVE}
                    max={MAX_HAND_OCTAVE}
                    onStep={(delta) =>
                      setVoicing({ octave: voicing.octave + delta })
                    }
                  />
                </Dial>
                <Dial label="Voice-leading" hint={VOICE_LEAD_HINT[hand]}>
                  <Switch
                    checked={voicing.voiceLead}
                    onCheckedChange={(voiceLead) => setVoicing({ voiceLead })}
                    aria-label={`${label} voice-leading`}
                  />
                </Dial>
                <Dial label="Rotate">
                  <Stepper
                    value={pattern.rotation}
                    lessLabel="Rotate left"
                    moreLabel="Rotate right"
                    onStep={(delta) => onChange(rotate(pattern, delta))}
                  />
                </Dial>
                <Dial label="Steps">
                  <Stepper
                    value={pattern.subdivisions}
                    lessLabel="Fewer steps"
                    moreLabel="More steps"
                    min={MIN_STEPS}
                    max={MAX_STEPS}
                    onStep={(delta) =>
                      onChange(resample(pattern, pattern.subdivisions + delta))
                    }
                  />
                </Dial>
                <Dial label="Octave doubling" hint={DOUBLE_HINT[hand]}>
                  <Switch
                    checked={voicing.doubleOctave}
                    onCheckedChange={(doubleOctave) =>
                      setVoicing({ doubleOctave })
                    }
                    aria-label={`${label} octave doubling`}
                  />
                </Dial>
              </Grid>
            </Stack>
          </Inset>
        )}
      </Stack>
    </ControlSizeProvider>
  );
}

/**
 * The hand's colour chip — its track's colour, with a soft halo of itself like
 * the mixer's swatch — that turns the hand on and off. Off, it is a hollow ring
 * of the same colour. The colour is track data (the user's pick), not a theme
 * token — hence inline.
 */
function HandChip({
  color,
  enabled,
  label,
  onToggle,
}: {
  color: string;
  enabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  const action = `Turn the ${label.toLowerCase()} ${enabled ? "off" : "on"}`;
  return (
    <WithTooltip content={action}>
      <button
        type="button"
        aria-label={action}
        aria-pressed={enabled}
        onClick={onToggle}
        className={cn(
          "size-3.5 rounded-full transition-transform hover:scale-110",
          rigidClass(),
        )}
        style={
          enabled
            ? {
                background: color,
                boxShadow: `0 0 0 3px color-mix(in oklab, ${color} 20%, transparent)`,
              }
            : { boxShadow: `inset 0 0 0 1.5px ${color}` }
        }
      />
    </WithTooltip>
  );
}

/** One of a hand's dials: its label (with an optional hover hint), then its control. */
function Dial({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const text = (
    <Text as="span" variant="body" tone="muted">
      {label}
    </Text>
  );
  return (
    <Stack direction="row" gap="xs" align="center" justify="between">
      {hint ? <WithTooltip content={hint}>{text}</WithTooltip> : text}
      {children}
    </Stack>
  );
}

/** `− n +`, each button disabled at its bound (when one is given). */
function Stepper({
  value,
  format = String,
  lessLabel,
  moreLabel,
  min,
  max,
  onStep,
}: {
  value: number;
  format?: (value: number) => string;
  lessLabel: string;
  moreLabel: string;
  min?: number;
  max?: number;
  onStep: (delta: -1 | 1) => void;
}) {
  return (
    <Stack direction="row" gap="none" align="center" className={rigidClass()}>
      <IconButton
        icon={removeIcon}
        label={lessLabel}
        disabled={min !== undefined && value <= min}
        onClick={() => onStep(-1)}
      />
      <Text
        as="span"
        variant="body"
        className="min-w-[3ch] text-center tabular-nums"
      >
        {format(value)}
      </Text>
      <IconButton
        icon={addIcon}
        label={moreLabel}
        disabled={max !== undefined && value >= max}
        onClick={() => onStep(1)}
      />
    </Stack>
  );
}
