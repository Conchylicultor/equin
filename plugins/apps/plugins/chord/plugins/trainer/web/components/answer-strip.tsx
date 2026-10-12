import type { ChordToken } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import {
  chordDegree,
  chordLabel,
} from "@plugins/apps/plugins/chord/plugins/vocabulary/core";
import {
  isRightAnswer,
  type Answer,
} from "@plugins/apps/plugins/chord/plugins/progress/core";
import {
  useYouTubePlayhead,
  type YouTubePlayerController,
} from "@plugins/integrations/plugins/youtube/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  pct,
  placedClasses,
  placedStyle,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ChordNumeral } from "@plugins/apps/plugins/chord/plugins/vocabulary/web";
import { ChordBox } from "@plugins/music/plugins/chord-box/web";
import {
  gridBeatAt,
  sheetScore,
  type AnswerSheet,
  type Box,
  type Round,
} from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const checkIcon = symbol("check");
const closeIcon = symbol("close");

/** Half the gap between two boxes, in px: each box gives it up on both sides. */
const HALF_GAP = 3;

/** A box's left edge on the strip: its first beat, minus nothing, plus half the gap. */
function beatX(beat: number, beats: number, pxOffset = HALF_GAP): string {
  return `calc(${pct(beat / beats)} + ${String(pxOffset)}px)`;
}

/**
 * The answer strip: one box per chord, as wide as the chord lasts, on a grid
 * of the window's beats, with a ruler of beat and bar ticks under it and a
 * playhead crossing the box that is sounding.
 *
 * Some boxes are **given**: the round is not asking about them, so they show
 * their chord from the start, dimmed and flat, and are not click targets until
 * the check. The heading counts only the boxes the learner has to name.
 *
 * Before the check, a click selects an asked box. After it, every box shows the
 * chord that played — the asked ones marked right or wrong, a wrong one
 * showing the answer given struck through beside it — and a click replays the
 * song over that box, given boxes included: they are part of the loop.
 */
export function AnswerStrip({
  round,
  sheet,
  fills,
  player,
  canReplay,
  soundingPosition,
  nameChord,
  listed,
  onSelect,
  onReplayBox,
  onHearAnswer,
}: {
  round: Round;
  sheet: AnswerSheet;
  /** How many times each box was filled: a new count replays the fill's pop. */
  fills: readonly number[];
  player: YouTubePlayerController;
  /** A box can be replayed now: the player is ready, or the piano is playing them. */
  canReplay: boolean;
  /** The box sounding now, once checked (null otherwise). */
  soundingPosition: number | null;
  /** Names a chord in the song's key. */
  nameChord: (token: ChordToken) => string;
  /** Whether a track lists this chord: when not, Rare is its right answer. */
  listed: (token: ChordToken) => boolean;
  onSelect: (position: number) => void;
  onReplayBox: (box: Box) => void;
  onHearAnswer: (answer: ChordToken) => void;
}) {
  const { beats, beatsPerBar } = round.grid;
  // The heading counts the boxes the learner must name, never the given ones:
  // "Chord 1 of 2" on a four-chord loop where two are given.
  const askedPositions = round.boxes
    .filter((box) => sheet.asked[box.position] === true)
    .map((box) => box.position);
  const total = askedPositions.length;
  const asking =
    sheet.selected === null ? 0 : askedPositions.indexOf(sheet.selected);
  const score = sheet.checked ? sheetScore(sheet, round, listed) : null;

  return (
    <Card className="rounded-2xl">
      <Stack gap="md">
        <Stack gap="2xs">
          <Text variant="caption" tone="faint" className="font-semibold">
            {score === null ? "Which chords?" : "Checked"}
          </Text>
          <Text as="h2" variant="heading" className="font-bold">
            {score === null ? (
              <>
                Chord {Math.max(asking, 0) + 1}{" "}
                <Text tone="faint" className="font-medium">
                  of {total}
                </Text>
              </>
            ) : (
              <>
                {score.right} of {score.total} right{" "}
                <Text tone="faint" className="font-medium">
                  in {(score.totalMs / 1000).toFixed(1)} s
                </Text>
              </>
            )}
          </Text>
        </Stack>
        <Stack gap="xs">
          <div className="chord-strip-boxes relative">
            {round.boxes.map((box) => (
              <AnswerBox
                key={`${String(box.position)}:${String(fills[box.position] ?? 0)}`}
                box={box}
                beats={beats}
                answer={sheet.answers[box.position] ?? null}
                asked={sheet.asked[box.position] === true}
                checked={sheet.checked}
                selected={sheet.selected === box.position}
                sounding={soundingPosition === box.position}
                popped={(fills[box.position] ?? 0) > 0}
                canReplay={canReplay}
                nameChord={nameChord}
                listed={listed}
                onSelect={onSelect}
                onReplay={onReplayBox}
                onHearAnswer={onHearAnswer}
              />
            ))}
            <PlayheadLine player={player} round={round} />
          </div>
          <div className="chord-ruler relative" aria-hidden="true">
            {Array.from({ length: Math.ceil(beats) }, (_, beat) => (
              <RulerTick
                key={beat}
                beat={beat}
                beats={beats}
                bar={beat % beatsPerBar === 0}
              />
            ))}
            <PlayheadTick player={player} round={round} />
          </div>
        </Stack>
      </Stack>
    </Card>
  );
}

function AnswerBox({
  box,
  beats,
  answer,
  asked,
  checked,
  selected,
  sounding,
  popped,
  canReplay,
  nameChord,
  listed,
  onSelect,
  onReplay,
  onHearAnswer,
}: {
  box: Box;
  beats: number;
  /** The answer given: a chord, or Rare. */
  answer: Answer | null;
  /** False on a GIVEN box: its chord was handed over, not asked for. */
  asked: boolean;
  checked: boolean;
  selected: boolean;
  sounding: boolean;
  popped: boolean;
  canReplay: boolean;
  /** Names a chord in the song's key. */
  nameChord: (token: ChordToken) => string;
  listed: (token: ChordToken) => boolean;
  onSelect: (position: number) => void;
  onReplay: (box: Box) => void;
  onHearAnswer: (answer: ChordToken) => void;
}) {
  // Before the check a box shows the answer given; after it, the chord that
  // played, with a mark saying whether the answer was right. A given box shows
  // its own chord throughout and is never marked — nobody named it.
  const shown: Answer | null = checked ? box.token : answer;
  // The name follows `shown`, so it leaks nothing: before the check it names
  // what the LEARNER picked, after it the chord that really played. Rare has
  // no name: it is not one chord.
  const name = shown === null || shown === "rare" ? null : nameChord(shown);
  // Right by the server's rule: the chord itself, or Rare for a chord no track
  // lists. A box answered Rare that was a listed chord shows the real chord,
  // as any wrong box does.
  const mark =
    checked && asked && answer !== null
      ? isRightAnswer(box.token, answer, listed)
        ? "ok"
        : "bad"
      : undefined;
  // A wrong box keeps the answer given, struck through, beside the chord that
  // played — so the mistake and its correction read as one pair.
  const missed = mark === "bad" ? answer : null;
  const beatsLabel = `${String(box.gridSpan)} beat${box.gridSpan === 1 ? "" : "s"}`;
  // The box is a painted frame holding two buttons: the whole box replays its
  // stretch of the song (or selects it, before the check), and a wrong box's
  // struck answer plays the answer given. A button cannot hold a button, so
  // the box's own button is the full-bleed layer BEHIND the content (the chord
  // box's `hit`), and the struck answer opts back into clicks above it.
  return (
    <ChordBox
      // Its paint follows its state: the quiet tint for a given box, the tile
      // once filled, the ghost while it waits for an answer. Rare has no chord
      // colour: it paints the neutral grey.
      degree={shown === null || shown === "rare" ? null : chordDegree(shown)}
      state={!asked ? "given" : shown !== null ? "filled" : "empty"}
      selected={selected}
      now={checked && sounding}
      className={placedClasses({})}
      style={placedStyle(
        {
          start: beatX(box.gridStart, beats),
          size: `calc(${pct(box.gridSpan / beats)} - ${String(2 * HALF_GAP)}px)`,
        },
        "fill",
      )}
      data-mark={mark}
      data-pop={popped && !checked ? "" : undefined}
      hit={{
        // A given box is nothing to press before the check; after it, it
        // replays its stretch of the song like any other box.
        disabled: checked ? !canReplay : !asked,
        // The numeral first, then the name, then ", given": the order the
        // e2e script and `ASKED_BOX` read, so the name extends the label
        // instead of moving anything already in it.
        ariaLabel: `Chord ${String(box.position + 1)}, ${beatsLabel}${
          shown === null
            ? ""
            : `: ${answerText(shown)}${name === null ? "" : `, ${name}`}`
        }${asked ? "" : ", given"}${
          mark === undefined ? "" : mark === "ok" ? ", right" : ", wrong"
        }`,
        pressed: checked || !asked ? undefined : selected,
        onClick: () => (checked ? onReplay(box) : onSelect(box.position)),
      }}
      adornment={
        mark !== undefined && (
          <Center
            as="span"
            aria-hidden="true"
            className={cn(placedClasses({}), "chord-badge")}
            style={placedStyle({ end: -9 }, { start: -9 })}
            data-mark={mark}
          >
            {mark === "ok" ? (
              <Icon icon={checkIcon} />
            ) : (
              <Icon icon={closeIcon} />
            )}
          </Center>
        )
      }
    >
      {missed === null ? (
        shown !== null && <AnswerGlyph answer={shown} />
      ) : (
        <Stack
          direction="row"
          gap="xs"
          align="baseline"
          justify="center"
          className="chord-box-pair"
        >
          {missed === "rare" ? (
            // Rare is not one chord: nothing to play, only the mistake.
            <span className="chord-missed">
              <AnswerGlyph answer={missed} />
            </span>
          ) : (
            <Overlay.Interactive>
              <button
                type="button"
                className="chord-missed"
                title="Hear what you picked"
                aria-label={`Hear your answer, ${chordLabel(missed).text}`}
                onClick={() => onHearAnswer(missed)}
              >
                <ChordNumeral token={missed} />
              </button>
            </Overlay.Interactive>
          )}
          {shown !== null && <AnswerGlyph answer={shown} />}
        </Stack>
      )}
      {name !== null && <span className="chord-box-name">{name}</span>}
    </ChordBox>
  );
}

/** How an answer reads in a label: the chord's numeral text, or "Rare". */
function answerText(answer: Answer): string {
  return answer === "rare" ? "Rare" : chordLabel(answer).text;
}

/** An answer drawn in a box: the chord's numeral, or the word Rare. */
function AnswerGlyph({ answer }: { answer: Answer }) {
  return answer === "rare" ? (
    <span className="chord-box-rare">Rare</span>
  ) : (
    <ChordNumeral token={answer} />
  );
}

function RulerTick({
  beat,
  beats,
  bar,
  on = false,
}: {
  beat: number;
  beats: number;
  bar: boolean;
  on?: boolean;
}) {
  return (
    <span
      className={cn(placedClasses({ decorative: true }), "chord-tick")}
      style={placedStyle({ start: beatX(beat, beats) }, { start: 4 })}
      data-bar={bar ? "" : undefined}
      data-on={on ? "" : undefined}
    />
  );
}

/**
 * The playhead: a line over the box that is sounding, at the beat the song is
 * on. Re-renders once per animation frame while the video plays, so it is its
 * own small component.
 */
function PlayheadLine({
  player,
  round,
}: {
  player: YouTubePlayerController;
  round: Round;
}) {
  const t = useYouTubePlayhead(player, true);
  const beat = t === null ? null : gridBeatAt(round.boxes, t);
  if (beat === null) return null;
  const box = round.boxes.find(
    (b) => beat >= b.gridStart && beat < b.gridStart + b.gridSpan,
  );
  const fraction =
    box === undefined ? 0 : (beat - box.gridStart) / box.gridSpan;
  return (
    <span
      className={cn(
        placedClasses({ decorative: true, layer: "raised" }),
        "chord-playhead",
      )}
      style={placedStyle(
        {
          start: beatX(
            beat,
            round.grid.beats,
            HALF_GAP - 2 * HALF_GAP * fraction,
          ),
        },
        { start: 10, end: 10 },
      )}
    />
  );
}

/** The ruler tick of the beat the song is on, lit. */
function PlayheadTick({
  player,
  round,
}: {
  player: YouTubePlayerController;
  round: Round;
}) {
  const t = useYouTubePlayhead(player, true);
  const beat = t === null ? null : gridBeatAt(round.boxes, t);
  if (beat === null) return null;
  const whole = Math.floor(beat);
  return (
    <RulerTick
      beat={whole}
      beats={round.grid.beats}
      bar={whole % round.grid.beatsPerBar === 0}
      on
    />
  );
}
