import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { voicingConfig } from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { WithTooltip } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";

import { symbol } from "@plugins/ui/plugins/icons/core";

const removeIcon = symbol("remove");
const addIcon = symbol("add");

/** Octave clamp for the chord voicing (C4 = middle C). */
const MIN_OCTAVE = 1;
const MAX_OCTAVE = 7;

/** Both settings are global config, so each label says so on hover. */
const GLOBAL_HINT = "Applies to every song";

/**
 * The block-chord voicing PART of the Accompaniment section, shown while the
 * groove is off (with a groove, each hand carries its own octave and
 * voice-leading): two rows over the GLOBAL chord-voicing config — "Voice-leading" (realistic voice-leading on/off) and
 * "Octave" (a − C4 + stepper, 1–7). Writes go to `voicingConfig`, so the
 * shell's `baseScore` re-derives the chord notes from the chord annotations.
 * The tone-order (which figuration each hand plays) is per-song and lives in
 * the rhythm groove panel, not here.
 *
 * Renders no chrome and no gate of its own: the composing section paints the
 * header and decides when the part applies (`useHasVoicedChords`, from the
 * song document).
 */
export function VoicingControls() {
  const cfg = useConfig(voicingConfig);
  const setCfg = useSetConfig(voicingConfig);

  return (
    <Stack gap="sm">
      <Stack direction="row" gap="md" justify="between" align="center">
        <WithTooltip content={GLOBAL_HINT}>
          <Text as="span" variant="body">
            Voice-leading
          </Text>
        </WithTooltip>
        <Switch
          checked={cfg.realistic}
          onCheckedChange={(next) => setCfg("realistic", next)}
          aria-label="Voice-leading"
        />
      </Stack>

      <Stack direction="row" gap="md" justify="between" align="center">
        <WithTooltip content={GLOBAL_HINT}>
          <Text as="span" variant="body">
            Octave
          </Text>
        </WithTooltip>
        <Stack
          direction="row"
          gap="none"
          align="center"
          className="rounded-md bg-muted"
        >
          <IconButton
            icon={removeIcon}
            label="Lower octave"
            disabled={cfg.octave <= MIN_OCTAVE}
            onClick={() =>
              setCfg("octave", Math.max(MIN_OCTAVE, cfg.octave - 1))
            }
          />
          <Text
            as="span"
            variant="body"
            className="min-w-10 text-center tabular-nums"
          >
            C{cfg.octave}
          </Text>
          <IconButton
            icon={addIcon}
            label="Raise octave"
            disabled={cfg.octave >= MAX_OCTAVE}
            onClick={() =>
              setCfg("octave", Math.min(MAX_OCTAVE, cfg.octave + 1))
            }
          />
        </Stack>
      </Stack>
    </Stack>
  );
}
