import { useEffect, useMemo, useState } from "react";
import {
  chordKeyPlan,
  chordSound,
  songKeyLabel,
  songKeyTonicPc,
  songVocabulary,
  type SongKey,
} from "@plugins/apps/plugins/chord/plugins/vocabulary/core";
import {
  PianoCard,
  usePiano,
  useSoundMix,
} from "@plugins/apps/plugins/chord/plugins/piano/web";
import { MAX_VOLUME } from "@plugins/apps/plugins/chord/plugins/piano/core";
import type { ChordToken } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import {
  listedTokens,
  playableChords,
  practisedChords,
  type Catalog,
  type Selection,
} from "@plugins/apps/plugins/chord/plugins/curriculum/core";
import {
  useCatalog,
  useCurriculum,
} from "@plugins/apps/plugins/chord/plugins/curriculum/web";
import {
  chordProgress,
  encodeProgressParams,
  recordRoundEndpoint,
  type Answer,
} from "@plugins/apps/plugins/chord/plugins/progress/core";
import { reportPlaybackEndpoint } from "@plugins/apps/plugins/chord/plugins/video-availability/core";
import {
  YouTubePlayer,
  useYouTubePlayer,
  useYouTubePlayerState,
} from "@plugins/integrations/plugins/youtube/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  matchResource,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  clearBackward,
  desiredShare,
  emptySheet,
  fillSelected,
  moveSelection,
  recordRoundBody,
  roundFromCandidate,
  selectBox,
  type AnswerSheet,
  type Box,
  type DealtLoop,
  type DesiredShares,
} from "../../core";
import { rareKeyFor, useChordKeys } from "../internal/use-chord-keys";
import { useSoundingBox } from "../internal/use-sounding-box";
import { useHeardClock } from "../internal/use-heard-clock";
import { usePianoFollow } from "../internal/use-piano-follow";
import {
  loopKey,
  useLoopQueue,
  type LoopQueue,
} from "../internal/use-loop-queue";
import { AnswerStrip } from "./answer-strip";
import { ChordButtons } from "./chord-buttons";
import { ProgressPanel } from "./progress-panel";
import { SongCard } from "./song-card";
import "./trainer.css";

/** One round's answers, tied to the loop they belong to. */
type RoundSession = {
  /** The loop: its asked boxes were dealt with it, so nothing else re-deals the round. */
  key: string;
  sheet: AnswerSheet;
  /** How many times each box was filled (a new fill replays its pop). */
  fills: readonly number[];
  /**
   * The last chord HEARD — a chord button after the check, a wrong box's struck answer,
   * a box replaying itself, or the playhead crossing into a box while the
   * checked loop runs. The one chord the piano draws.
   *
   * Every way of sounding a chord writes here, which is what lets a chord
   * clicked DURING playback light the keyboard: the click is simply more recent
   * than the box behind it, and it stays on show until the song reaches the
   * next chord. It lives on the session, rather than as its own state, because
   * a session is already minted fresh per loop: the next song clears it with
   * everything else, and there is no reset to remember.
   */
  lastPlayed: ChordToken | null;
};

/**
 * The trainer: the song card with its player, the answer strip, the chord
 * buttons, and the progress panel beside them (below them under 1200px).
 * Flow and rules: `research/2026-09-18-apps-chord-trainer-app.md`, "How a
 * round works".
 *
 * Which chords play, which are asked, and how much of a loop is blank come
 * from the learner's selection (curriculum); which chords the Rare button
 * answers, from the catalog. Until both have landed the screen shows a loading
 * state: buttons that are about to change would be a claim about what this
 * learner has chosen.
 */
export function TrainerScreen() {
  const curriculum = useCurriculum();
  const catalog = useCatalog();
  return (
    // The pane chrome owns the one scroll viewport; this box only scopes the
    // trainer's CSS variables and its container queries.
    <div className="chord-trainer @container">
      <Inset x="lg" t="lg" b="xl" className="mx-auto max-w-[1280px]">
        {/* eslint-disable-next-line layout/no-adhoc-layout -- the page's two tracks: the main column and the 400px side panel (the Chords section mockup's width), which drops below it when the pane is under 1200px wide: the song card needs ~750px beside the 400px panel (the player, sound control, Play and Next song take ~600px; the title the rest). A container-query track template, which no layout primitive expresses. */}
        <div className="grid items-start gap-lg @[1200px]:grid-cols-[minmax(0,1fr)_400px]">
          {matchResource(curriculum, {
            loading: () => <Loading variant="block" />,
            ready: (c) =>
              matchResource(catalog, {
                loading: () => <Loading variant="block" />,
                // `not-ready`: the index is still loading (the gate above
                // waits for it, so this is the moment the catalog is built).
                ready: (state) =>
                  state.kind === "ready" ? (
                    <TrainerBody selection={c} catalog={state.catalog} />
                  ) : (
                    <Loading variant="block" />
                  ),
              }),
          })}
        </div>
      </Inset>
    </div>
  );
}

/** The two tracks of the page, once the selection and the catalog are known. */
function TrainerBody({
  selection,
  catalog,
}: {
  selection: Selection;
  catalog: Catalog;
}) {
  const listedSet = useMemo(() => listedTokens(catalog), [catalog]);
  const listed = useMemo(
    () => (token: ChordToken) => listedSet.has(token),
    [listedSet],
  );
  const playable = useMemo(() => playableChords(selection), [selection]);
  const practised = useMemo(() => practisedChords(selection), [selection]);
  // The practised chords no track lists: answered by the Rare button.
  const rare = useMemo(
    () => practised.filter((token) => !listedSet.has(token)),
    [practised, listedSet],
  );
  // EVERY listed chord, whatever the learner has on: the subscription then
  // depends on the catalog alone, so toggling a chord never re-keys it (a new
  // key would be a pending read — the panel's loading state, and no `desired`
  // for the queue — on every chip click). The server pools every unlisted
  // chord as Rare itself.
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    [],
  );
  const progressParams = useMemo(
    () => encodeProgressParams({ timeZone, tokens: [...listedSet] }),
    [timeZone, listedSet],
  );
  const progress = useLive(chordProgress, progressParams);
  // How often each practised chord should turn up, from its mastery: unknown
  // (so nothing is dealt) until the progress has loaded.
  const desired = useMemo(
    () =>
      mapResource(progress, (p): DesiredShares => {
        const byToken = new Map(p.chords.map((c) => [c.token, c] as const));
        return {
          byChord: new Map(
            practised
              .filter((token) => listedSet.has(token))
              .map((token) => [
                token,
                desiredShare(byToken.get(token) ?? null),
              ]),
          ),
          // The practised rare chords share one Rare share, from the pooled
          // standing of every rare chord (the Rare button answers them all).
          rare:
            rare.length === 0
              ? null
              : { tokens: new Set(rare), share: desiredShare(p.rare) },
        };
      }),
    [progress, practised, rare, listedSet],
  );
  const queue = useLoopQueue({
    playable,
    practised,
    extras: selection.extras,
    blanks: selection.blanks,
    desired,
  });
  // Kept above the round, which unmounts when the queue runs dry.
  const session = useSessionMemory();

  return (
    <>
      <Stack gap="md" className={yieldClass("x")}>
        <LoopArea
          queue={queue}
          memory={session}
          selection={selection}
          listed={listed}
        />
      </Stack>
      <ProgressPanel
        progress={progress}
        selection={selection}
        catalog={catalog}
        listed={listed}
      />
    </>
  );
}

/**
 * What the trainer remembers for the whole visit: whether the page has been
 * used (browsers block sound until it has, so the first loop waits for Play
 * and every loop after a Play or a Next starts by itself), and which videos
 * have been reported playing.
 */
type SessionMemory = {
  interacted: boolean;
  markInteracted: () => void;
  /** Videos reported `playing` this visit: each is reported once. */
  reportedPlaying: Set<string>;
};

function useSessionMemory(): SessionMemory {
  const [interacted, setInteracted] = useState(false);
  const [reportedPlaying] = useState(() => new Set<string>());
  return useMemo(
    () => ({
      interacted,
      markInteracted: () => setInteracted(true),
      reportedPlaying,
    }),
    [interacted, reportedPlaying],
  );
}

/** Where the loop goes: the round, or why there is none yet. */
function LoopArea({
  queue,
  memory,
  selection,
  listed,
}: {
  queue: LoopQueue;
  memory: SessionMemory;
  selection: Selection;
  listed: (token: ChordToken) => boolean;
}) {
  const { state } = queue;
  switch (state.kind) {
    case "ready":
      return (
        <Trainer
          dealt={state.dealt}
          queue={queue}
          memory={memory}
          selection={selection}
          listed={listed}
        />
      );
    case "loading":
      return <Loading variant="block" />;
    case "empty":
      return (
        <Notice
          title="No song fits these chords yet"
          detail="Every loop is made only of the chords you have on. None is left to play right now — turn more chords on, or practise one you only hear."
          onRetry={queue.retry}
        />
      );
    case "nothing-practised":
      return (
        <Card className="rounded-2xl">
          <Stack gap="sm" align="start">
            <Text variant="heading" className="font-bold">
              No chord is practised
            </Text>
            <Text variant="body" tone="muted" className="break-words">
              Set at least one chord to Practise in the Chords section: those
              are the chords you name.
            </Text>
          </Stack>
        </Card>
      );
    case "not-ready":
      return (
        <Notice
          title="The songs are not ready"
          detail={`The song index answered “${state.status.kind}”.`}
          onRetry={queue.retry}
        />
      );
    case "error":
      return (
        <Notice
          title="The next songs could not be found"
          detail={state.message}
          onRetry={queue.retry}
        />
      );
  }
}

function Notice({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <Card className="rounded-2xl">
      <Stack gap="sm" align="start">
        <Text variant="heading" className="font-bold">
          {title}
        </Text>
        <Text variant="body" tone="muted" className="break-words">
          {detail}
        </Text>
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </Stack>
    </Card>
  );
}

/**
 * The round on screen. The player lives here and stays mounted from loop to
 * loop (a new video loads in place), so after the first Play every loop starts
 * by itself.
 */
function Trainer({
  dealt,
  queue,
  memory,
  selection,
  listed,
}: {
  /** The loop on screen and the boxes it asks, dealt once. */
  dealt: DealtLoop;
  queue: LoopQueue;
  memory: SessionMemory;
  selection: Selection;
  listed: (token: ChordToken) => boolean;
}) {
  const loop = dealt.candidate;
  // The words to say a chord with. One speller per loop, shared by every box,
  // button and lit key, so nothing on screen can name a chord against a
  // different key from its neighbour — and one tonic under it, so nothing
  // sounds a chord built on a different one.
  const songKey = useMemo<SongKey>(
    () => ({ tonic: loop.window.keyTonic, mode: loop.window.keyMode }),
    [loop],
  );
  const words = useMemo(() => songVocabulary(songKey), [songKey]);
  const tonicPc = useMemo(() => songKeyTonicPc(songKey), [songKey]);
  // What the loop is heard with: the song (muted, never paused, when off) and
  // the piano following it, each at its own level.
  const mix = useSoundMix();

  const player = useYouTubePlayer();
  const playerState = useYouTubePlayerState(player);
  const playerReady = playerState.kind === "ready";
  const playing = playerState.kind === "ready" && playerState.playing;
  const piano = usePiano(mix.piano.volume / MAX_VOLUME);

  // The video's length from the player, for a video-fraction alignment only
  // (a beat-times round never reads it, so it is not rebuilt when it lands).
  const [playerDuration, setPlayerDuration] = useState<{
    videoId: string;
    seconds: number;
  } | null>(null);
  const durationForRound =
    loop.alignment.kind === "video-fraction" &&
    playerDuration?.videoId === loop.videoId
      ? playerDuration.seconds
      : null;
  const roundResult = useMemo(
    () => roundFromCandidate(loop, { videoDurationSeconds: durationForRound }),
    [loop, durationForRound],
  );
  const round = roundResult.kind === "round" ? roundResult.round : null;

  // Which boxes the round asks about was decided when the loop was dealt
  // (`dealLoop`), so a selection change mid-round never deals it again: the
  // round's key is the loop alone.
  const key = loopKey(loop);
  const [stored, setStored] = useState<RoundSession | null>(null);
  const session: RoundSession | null =
    round === null
      ? null
      : stored?.key === key
        ? stored
        : {
            key,
            sheet: emptySheet(round, dealt.asked),
            fills: round.boxes.map(() => 0),
            lastPlayed: null,
          };
  const checked = session?.sheet.checked ?? false;

  const heardAt = useHeardClock(player, round);
  const sounding = useSoundingBox(player, round, checked);

  // The playhead crossing into a box is a chord sounding, so it is recorded
  // like every other way of sounding one. That is the whole rule behind "the
  // piano shows what you are hearing": there is one memory, and the most recent
  // writer wins — a click during playback holds the keyboard until the song
  // reaches the next chord, and then the song takes it back.
  //
  // The session is read through a ref because it is DERIVED (a fresh object
  // until the first write of a loop), so depending on it would re-run this
  // effect on renders where nothing sounded.
  const sessionRef = useLatestRef(session);
  useEffect(() => {
    if (round === null || sounding === null) return;
    const token = round.boxes[sounding]?.token ?? null;
    const current = sessionRef.current;
    if (token === null || current === null) return;
    if (current.lastPlayed === token) return;
    setStored({ ...current, lastPlayed: token });
  }, [round, sounding, sessionRef]);

  const record = useEndpointMutation(recordRoundEndpoint);
  const report = useEndpointMutation(reportPlaybackEndpoint);

  const updateSheet = (fn: (sheet: AnswerSheet) => AnswerSheet) => {
    if (session === null || round === null) return;
    const sheet = fn(session.sheet);
    if (sheet === session.sheet) return;
    setStored({ ...session, sheet });
  };

  // The two ways the screen sounds something, both through the one piano: a
  // set of notes (a key the learner pressed) and a chord (its whole sound,
  // doubled bass included — `chordSound` is the same call the keyboard lights).
  const playNotes = useEventCallback(
    (pitches: readonly number[], ringSeconds?: number) => {
      void piano.play(pitches, { ringSeconds }).catch((err: unknown) => {
        showToast({
          title: "The piano could not play",
          description: err instanceof Error ? err.message : String(err),
          variant: "error",
        });
        throw err;
      });
    },
  );
  const playChord = useEventCallback(
    (token: ChordToken, ringSeconds?: number) =>
      playNotes(chordSound(token, tonicPc).pitches, ringSeconds),
  );

  // With the piano on, it plays along with the song: each box's chord struck
  // as the playhead enters it, held for the rest of the box. It sounds before
  // the check too — hearing the bare chords is the point — but writes nothing
  // the keyboard reads, so it gives no answer away.
  usePianoFollow({
    player,
    round,
    enabled: mix.piano.on,
    strike: (box, remaining) => playChord(box.token, remaining),
    silence: piano.silence,
  });

  const pick = useEventCallback((answer: Answer) => {
    if (session === null || round === null) return;
    if (session.sheet.checked) {
      // Rare is not one chord: there is nothing to play.
      if (answer === "rare") return;
      // Always the piano, whatever the sound toggle says: this chord need not
      // be in the loop at all, so there may be no song to play it with.
      playChord(answer);
      setStored({ ...session, lastPlayed: answer });
      return;
    }
    const at = session.sheet.selected;
    if (at === null) return;
    const heard = heardAt(at);
    const sheet = fillSelected(
      session.sheet,
      answer,
      heard === null ? 0 : performance.now() - heard,
    );
    const fills = session.fills.map((n, i) => (i === at ? n + 1 : n));
    setStored({ ...session, sheet, fills });
    // The last fill checks the round: saved once, in one call.
    if (sheet.checked) {
      record.mutate({ body: recordRoundBody(sheet, round, dealt.blanks) });
    }
  });

  // One button per practised listed chord — the chords a blank can hold —
  // and one Rare button for the practised chords no track lists. The keys:
  // the chord's digit, a second key when several chords share it, and the
  // next digit for Rare.
  const practised = useMemo(() => practisedChords(selection), [selection]);
  const plan = useMemo(
    () => chordKeyPlan(practised.filter((token) => listed(token))),
    [practised, listed],
  );
  const rareKey = useMemo(
    () => (practised.some((token) => !listed(token)) ? rareKeyFor(plan) : null),
    [practised, listed, plan],
  );
  const keys = useChordKeys({ plan, rareKey, onPick: pick });
  const { cancel } = keys;

  const togglePlay = useEventCallback(() => {
    cancel();
    if (!playerReady) return;
    memory.markInteracted();
    if (player.isPlaying) player.pause();
    else player.play();
  });

  const nextSong = useEventCallback(() => {
    cancel();
    memory.markInteracted();
    queue.next();
  });

  // A box plays its bars of the song, heard through whichever channels are on
  // — the record, the piano following it, or both. It is the chord the learner
  // is now listening to, so the keyboard shows it.
  const onReplayBox = useEventCallback((box: Box) => {
    memory.markInteracted();
    if (session !== null) setStored({ ...session, lastPlayed: box.token });
    player.playRange(box.startSec, box.endSec);
  });

  // The answer the learner gave, which the song never played: the piano only.
  const onHearAnswer = useEventCallback((answer: ChordToken) => {
    playChord(answer);
    if (session !== null) setStored({ ...session, lastPlayed: answer });
  });

  const onSelect = useEventCallback((position: number) =>
    updateSheet((s) => selectBox(s, position)),
  );
  const onMove = useEventCallback((delta: -1 | 1) => {
    cancel();
    updateSheet((s) => moveSelection(s, delta));
  });
  const onClear = useEventCallback(() => {
    cancel();
    updateSheet(clearBackward);
  });

  // The first time a video plays this session it is reported playing; a
  // player error is reported with its code, and the trainer moves on.
  const onPlaying = useEventCallback(() => {
    if (memory.reportedPlaying.has(loop.videoId)) return;
    memory.reportedPlaying.add(loop.videoId);
    report.mutate({
      params: { videoId: loop.videoId },
      body: { outcome: "playing" },
    });
  });
  const onError = useEventCallback((code: number) => {
    report.mutate({
      params: { videoId: loop.videoId },
      body: { outcome: "error", code },
    });
    showToast({
      description: "This video can't play here — next song",
    });
    queue.skipVideo(loop.videoId);
  });
  const onReady = useEventCallback((seconds: number) =>
    setPlayerDuration({ videoId: loop.videoId, seconds }),
  );

  const shortcuts = useMemo(
    () => [
      {
        id: "chord.play-pause",
        keys: "space",
        label: "Play / pause",
        group: "Chord",
        handler: togglePlay,
      },
      {
        id: "chord.next-song",
        keys: "enter",
        label: "Next song",
        group: "Chord",
        handler: nextSong,
      },
      {
        id: "chord.previous-box",
        keys: "arrowleft",
        label: "Previous box",
        group: "Chord",
        handler: () => onMove(-1),
      },
      {
        id: "chord.next-box",
        keys: "arrowright",
        label: "Next box",
        group: "Chord",
        handler: () => onMove(1),
      },
      {
        id: "chord.clear-box",
        keys: "backspace",
        label: "Clear the box",
        group: "Chord",
        handler: onClear,
      },
      ...keys.shortcuts,
    ],
    [togglePlay, nextSong, onMove, onClear, keys.shortcuts],
  );
  useSurfaceShortcuts(shortcuts);

  // The ONE chord on show, fed to the lit button, the piano and its header, so
  // the three can never disagree: the last chord heard, whatever sounded it.
  // Null before the check BY CONSTRUCTION — nothing writes `lastPlayed` until
  // the round is checked — which is what stops the keyboard giving the answer
  // away, rather than a guard somewhere that could be forgotten.
  const shownChord = !checked || session === null ? null : session.lastPlayed;

  return (
    <>
      <SongCard
        loop={loop}
        playing={playing}
        keyName={songKeyLabel(songKey)}
        canPlay={playerReady}
        checked={checked}
        onTogglePlay={togglePlay}
        onNext={nextSong}
        player={
          <YouTubePlayer
            controller={player}
            videoId={loop.videoId}
            loop={
              round === null
                ? null
                : { start: round.loop.startSec, end: round.loop.endSec }
            }
            autoplay={memory.interacted}
            audio={{ volume: mix.song.volume, muted: !mix.song.on }}
            onReady={onReady}
            onPlaying={onPlaying}
            onError={onError}
          />
        }
      />
      {round === null || session === null ? (
        <Loading variant="block" />
      ) : (
        <AnswerStrip
          round={round}
          sheet={session.sheet}
          fills={session.fills}
          player={player}
          canReplay={playerReady}
          soundingPosition={sounding}
          nameChord={words.nameChord}
          listed={listed}
          onSelect={onSelect}
          onReplayBox={onReplayBox}
          onHearAnswer={onHearAnswer}
        />
      )}
      <ChordButtons
        plan={plan}
        rareKey={rareKey}
        lit={shownChord}
        picking={keys.picking}
        nameChord={words.nameChord}
        onPick={pick}
      />
      <PianoCard
        token={shownChord}
        songKey={songKey}
        tonicPc={tonicPc}
        play={playNotes}
      />
    </>
  );
}
