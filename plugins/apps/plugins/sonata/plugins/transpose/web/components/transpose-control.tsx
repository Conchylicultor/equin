import { useMemo } from "react";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  transposeSetting,
  useLibrarySong,
  useSongSetting,
  useWriteSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  collectKeyEntries,
  scoreEndBeat,
  type KeySignature,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  tonicName,
  tonicPc,
  transposeKey,
} from "@plugins/apps/plugins/sonata/plugins/theory/core";
import { saveTranspose } from "../actions";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const removeIcon = symbol("remove");
const swapVertIcon = symbol("swap-vert");
const undoIcon = symbol("undo");

/** Transpose bounds — a full octave each way (matches the endpoint clamp). */
const MIN_SEMITONES = -12;
const MAX_SEMITONES = 12;

/** The "Play in" grid: the 12 tonics from a fourth below to a tritone above. */
const PLAY_IN_OFFSETS = Array.from({ length: 12 }, (_, i) => i - 5);

/** Signed offset: `0`, `+N`, or `−N` (true minus glyph). */
function formatOffset(semitones: number): string {
  if (semitones === 0) return "0";
  return semitones > 0 ? `+${semitones}` : `−${Math.abs(semitones)}`;
}

/**
 * A tonic name for reading: the theory table's ASCII accidentals (`Bb`, `F#`)
 * drawn as the glyphs the rest of the player shows (`B♭`, `F♯`).
 */
function prettyTonic(tonic: string): string {
  return (
    tonic.slice(0, 1) + tonic.slice(1).replace(/#/g, "♯").replace(/b/g, "♭")
  );
}

/** `B major` / `A minor`. */
function keyName(key: KeySignature): string {
  return `${prettyTonic(key.tonic)} ${key.mode}`;
}

/**
 * The transpose control pinned into the Sonata player pane's header
 * (`sonataPlayerPane.Actions`): a `swap-vert` icon button, badged `+N` / `−N`
 * while the song is shifted, that opens the transpose panel. Like the other
 * header controls it owns no score state — it reads the loaded song's
 * `transposeSetting` + the loaded library song from `useLibrarySong`, writes
 * the setting optimistically for instant re-render, and persists via
 * `saveTranspose`. It is disabled when there is no song (no score span).
 *
 * Until the open song's offset is known the trigger is disabled with a loading
 * badge: a step needs a known base, and a bare (un-badged) button meanwhile
 * would claim the song is in its original key. A failed read shows the
 * failure with Retry in the trigger's place.
 *
 * The settled trigger carries `data-transpose-offset` — the offset the badge
 * shows, as a number — so a script can read it without opening the panel.
 */
export function TransposeControl() {
  const song = useLibrarySong();
  const transpose = useSongSetting(transposeSetting);
  const { score } = useSession();
  const hasScore = scoreEndBeat(score) > 0;
  // A file document's transpose is its read-only default: no control.
  if (song.kind === "none") return null;

  if (transpose.kind === "failed") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={swapVertIcon}
        subject="the song's transpose"
        error={transpose.error}
        refetch={transpose.refetch}
      />
    );
  }
  if (transpose.kind === "pending") {
    return (
      <span className="relative inline-block">
        <IconButton icon={swapVertIcon} label="Transpose" disabled />
        <Pin to="top-right" outset decorative style={BADGE_OFFSET}>
          <Loading variant="block" className="h-3 w-4 rounded-full" />
        </Pin>
      </span>
    );
  }

  return (
    <TransposePopover
      songId={song.songId}
      semitones={transpose.value}
      disabled={!hasScore}
    />
  );
}

/** The badge hangs just off the button's top-right corner. */
const BADGE_OFFSET = { top: "-0.125rem", right: "-0.25rem" } as const;

/** Trigger + panel over a KNOWN offset. */
function TransposePopover({
  songId,
  semitones,
  disabled,
}: {
  songId: string;
  semitones: number;
  disabled: boolean;
}) {
  const setStore = useWriteSongSetting(transposeSetting);
  const { score } = useSession();

  // The score is already shifted (the document's pipeline applies the offset
  // first), so its opening key is the key the song now plays in; the original
  // is that key shifted back. `collectKeyEntries` is the same source the key
  // chip and the progress bar's key flags read.
  const currentKey = useMemo(() => collectKeyEntries(score)[0]?.key, [score]);
  const originalKey =
    currentKey === undefined
      ? undefined
      : semitones === 0
        ? currentKey
        : transposeKey(currentKey, -semitones);

  // Write the loaded song's setting optimistically (instant re-render of every
  // lens + audio), then persist for this song. Clamp to the octave range.
  const setTranspose = (next: number) => {
    const clamped = Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, next));
    setStore(songId, clamped);
    saveTranspose(songId, clamped);
  };

  const label =
    semitones === 0
      ? "Transpose"
      : `Transpose (${formatOffset(semitones)} semitones)`;

  return (
    <ControlPanelPopover
      align="end"
      label="Transpose"
      trigger={
        <span
          className="relative inline-block"
          data-transpose-offset={semitones}
        >
          <IconButton
            icon={swapVertIcon}
            label={label}
            tooltip="Transpose — shift the whole song by semitones"
            active={semitones !== 0}
            disabled={disabled}
          />
          {semitones !== 0 && (
            <Pin to="top-right" outset decorative style={BADGE_OFFSET}>
              <Center className="h-4 min-w-4 rounded-full bg-primary px-2xs text-3xs font-bold tabular-nums text-primary-foreground">
                {formatOffset(semitones)}
              </Center>
            </Pin>
          )}
        </span>
      }
    >
      <ControlPanel.Section>
        <Stack direction="col" align="center" gap="xs">
          <ControlSizeProvider size="lg">
            <Stack direction="row" align="center" justify="center" gap="md">
              <IconButton
                icon={removeIcon}
                label="Transpose down a semitone"
                variant="outline"
                disabled={disabled || semitones <= MIN_SEMITONES}
                onClick={() => setTranspose(semitones - 1)}
              />
              <Text
                as="span"
                variant="title"
                aria-live="polite"
                className={cn(
                  "min-w-[5ch] text-center tabular-nums",
                  semitones === 0 && "text-muted-foreground",
                )}
              >
                {formatOffset(semitones)}
                <Text as="span" variant="caption" tone="muted">
                  {" "}
                  st
                </Text>
              </Text>
              <IconButton
                icon={addIcon}
                label="Transpose up a semitone"
                variant="outline"
                disabled={disabled || semitones >= MAX_SEMITONES}
                onClick={() => setTranspose(semitones + 1)}
              />
            </Stack>
          </ControlSizeProvider>
          {originalKey !== undefined && currentKey !== undefined && (
            <Text variant="caption" tone="muted">
              {semitones === 0
                ? `${keyName(originalKey)} (original)`
                : `${keyName(originalKey)} → ${keyName(currentKey)}`}
            </Text>
          )}
        </Stack>
      </ControlPanel.Section>

      <ControlPanel.Section needs="picker" label="Play in">
        <PlayInGrid
          originalKey={originalKey}
          semitones={semitones}
          disabled={disabled}
          onPick={setTranspose}
        />
      </ControlPanel.Section>

      <ControlPanel.Footer>
        <ControlPanel.Row
          icon={<Icon icon={undoIcon} />}
          disabled={semitones === 0}
          onSelect={() => setTranspose(0)}
        >
          Reset to original key
        </ControlPanel.Row>
      </ControlPanel.Footer>
    </ControlPanelPopover>
  );
}

/**
 * The 12 tonics a fourth below to a tritone above the original, as a
 * single-select grid: the original is marked (a trailing dot), the current one is
 * selected, and a click sets the offset. A keyless score names the cells by
 * their offset instead.
 */
function PlayInGrid({
  originalKey,
  semitones,
  disabled,
  onPick,
}: {
  originalKey: KeySignature | undefined;
  semitones: number;
  disabled: boolean;
  onPick: (semitones: number) => void;
}) {
  const originalPc =
    originalKey === undefined ? undefined : tonicPc(originalKey.tonic);
  return (
    <Grid cols={6} gap="xs" role="radiogroup" aria-label="Play in">
      {PLAY_IN_OFFSETS.map((offset) => {
        const name =
          originalKey === undefined || originalPc === undefined
            ? formatOffset(offset)
            : prettyTonic(
                tonicName(
                  (((originalPc + offset) % 12) + 12) % 12,
                  originalKey.mode,
                ),
              ) + (originalKey.mode === "minor" ? "m" : "");
        const isOriginal = offset === 0;
        return (
          <Center key={offset}>
            <ToggleChip
              role="radio"
              aria-checked={offset === semitones}
              aria-label={
                isOriginal
                  ? `${name} (original key)`
                  : `${name} (${formatOffset(offset)} st)`
              }
              tooltip={
                isOriginal ? "Original key" : `${formatOffset(offset)} st`
              }
              active={offset === semitones}
              variant="ghost"
              disabled={disabled}
              onClick={() => onPick(offset)}
            >
              <Stack direction="row" align="center" gap="2xs">
                {name}
                {isOriginal && (
                  <span
                    aria-hidden
                    className="size-1 rounded-full bg-current opacity-70"
                  />
                )}
              </Stack>
            </ToggleChip>
          </Center>
        );
      })}
    </Grid>
  );
}
