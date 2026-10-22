import { useEffect, useRef, useState } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  findLoopsEndpoint,
  type ChordToken,
  type FindLoopsBody,
  type IndexStatus,
  type LoopCandidate,
  type LoopExtras,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import type { Blanks } from "@plugins/apps/plugins/chord/plugins/curriculum/core";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";
import {
  foldResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  SHARE_HISTORY,
  dealLoop,
  pickNext,
  shareDeficits,
  type DealtLoop,
  type DesiredShares,
} from "../../core";

/** How many loops the unfocused query asks for. */
const BATCH = 10;
/** How many loops each focused query asks for. */
const FOCUSED_BATCH = 5;
/** At most this many chords get a focused query of their own per refill. */
const MAX_FOCUSED = 2;
/** The pool is refilled once it holds this many loops or fewer. */
const LOW_WATER = 3;
/** The sections of this many most recent loops are left out of the next query. */
const RECENT_SECTIONS = 20;

/** What the trainer can show where the loop goes. */
export type LoopQueueState =
  /** The first loops are on their way (or the progress is not known yet). */
  | { kind: "loading" }
  /** The loop on screen, dealt once: its asked boxes never change. */
  | { kind: "ready"; dealt: DealtLoop }
  /** The index answered that it is not ready — the gate above should prevent it. */
  | { kind: "not-ready"; status: IndexStatus }
  /** The index is ready and no loop fits the chords on. */
  | { kind: "empty" }
  /** No chord is practised, so there is nothing to ask. */
  | { kind: "nothing-practised" }
  | { kind: "error"; message: string };

export type LoopQueue = {
  state: LoopQueueState;
  /** Drop the current loop and deal the next one. */
  next: () => void;
  /** Drop the current loop and every pooled loop on `videoId` (it cannot play). */
  skipVideo: (videoId: string) => void;
  /** Ask again after `empty`, `not-ready` or `error`. */
  retry: () => void;
};

type SectionId = LoopCandidate["sectionId"];

/** A loop's identity: its section, shape and first beat. */
export function loopKey(loop: LoopCandidate): string {
  return `${loop.sectionId}:${loop.window.shape}:${loop.window.startBeat}`;
}

type Fetch =
  /** Free to ask when the pool runs low. */
  | { kind: "idle" }
  /** The last refill added nothing: once the pool runs out, say so. */
  | { kind: "exhausted" }
  | { kind: "not-ready"; status: IndexStatus }
  | { kind: "error"; message: string };

const IDLE: Fetch = { kind: "idle" };

/**
 * What a pool was drawn for, as one comparable string: the chords a loop may
 * hold, the practised ones, and how many other chords it may hold. Compared by
 * value, so a render that rebuilds the same sets changes nothing.
 */
function paletteKey(
  playable: readonly ChordToken[],
  practised: readonly ChordToken[],
  extras: LoopExtras,
): string {
  return [
    [...playable].sort().join(","),
    [...practised].sort().join(","),
    String(extras),
  ].join("|");
}

/** Everything the queue holds, in one value so each move is one transition. */
type Queue = {
  /** The palette `loops` and `fetch` were found for. */
  palette: string;
  /** The round on screen, dealt once. Survives a palette change. */
  current: DealtLoop | null;
  loops: readonly LoopCandidate[];
  fetch: Fetch;
  /** The chords of the loops dealt this visit, oldest first (the last `SHARE_HISTORY`). */
  history: readonly (readonly ChordToken[])[];
  /** Sections of the loops moved past this visit, most recent last. */
  played: readonly SectionId[];
};

/**
 * The pool as it stands for the palette in force. **A new palette empties
 * it**: its loops were found for the chords the learner had on before, so
 * every one behind the round goes, and so does the last refill's outcome (a
 * palette that just grew may have loops the old one had none of). The round on
 * screen stays. Derived, never written: no render can show a stale loop.
 */
function live(queue: Queue, palette: string): Queue {
  return queue.palette === palette
    ? queue
    : { ...queue, palette, loops: [], fetch: IDLE };
}

/** The dealing context: what a loop is dealt with when it comes up. */
type Deal = {
  practised: ReadonlySet<ChordToken>;
  blanks: Blanks;
  desired: DesiredShares;
};

/**
 * Deal the next loop from the pool onto the screen: `pickNext` against the
 * history, then `dealLoop` with the blanks in force; the pool loses every
 * window of that song section. With an empty pool the screen is left empty
 * (the refill deals when it lands).
 */
function dealNext(queue: Queue, deal: Deal): Queue {
  if (queue.loops.length === 0) return { ...queue, current: null };
  // A pooled loop holds a practised chord of the palette it was found for, and
  // a new palette empties the pool, so `dealLoop` cannot throw here.
  const pick = pickNext(queue.loops, queue.history, deal.desired);
  return {
    ...queue,
    current: dealLoop(pick, { practised: deal.practised, blanks: deal.blanks }),
    loops: queue.loops.filter((l) => l.sectionId !== pick.sectionId),
    history: [...queue.history, pick.window.chordTokens].slice(-SHARE_HISTORY),
  };
}

/** Leave the round on screen: its section joins the played ones. */
function leave(queue: Queue): Queue {
  if (queue.current === null) return queue;
  return {
    ...queue,
    current: null,
    played: [...queue.played, queue.current.candidate.sectionId].slice(
      -RECENT_SECTIONS,
    ),
  };
}

/**
 * The trainer's loops: the round on screen, and a pool to deal the next from.
 *
 * - **The round on screen is frozen.** It is dealt ONCE (`dealLoop`: its asked
 *   boxes decided then, a `random` draw included) and kept as it is until the
 *   learner moves on. A selection change never deals it again — it applies
 *   from the next loop.
 * - **The next loop is the one that best keeps each practised chord at its
 *   share** (`pickNext` over the pool, against the chords of the last
 *   `SHARE_HISTORY` dealt loops and each chord's `desired` share).
 * - **The pool refills when it runs low**, in parallel: one unfocused batch
 *   (`find` over every chord on, the practised ones, the extras), plus one
 *   focused batch for each of the (at most 2) chords furthest below their
 *   share — so the pool always holds loops that can catch them up. The
 *   sections of the last 20 loops moved past, of the round and of the pool are
 *   left out. Nothing is asked while `desired` is unknown (the progress has not
 *   loaded) or no chord is practised.
 * - **Any change of the chords or the extras empties the pool** behind the
 *   round (`live`) and refills it at once.
 */
export function useLoopQueue(opts: {
  /** Every chord a loop may hold without counting as an extra: practised and heard. */
  playable: readonly ChordToken[];
  /** The chords a round can ask: every loop holds one. */
  practised: readonly ChordToken[];
  extras: LoopExtras;
  blanks: Blanks;
  /** Each practised chord's share of the loops, from the progress (nothing is dealt until it is ready). */
  desired: ResourceResult<DesiredShares>;
}): LoopQueue {
  const { playable, practised, extras, blanks } = opts;
  const fetchEndpoint = useFetchEndpoint();
  // Nothing is asked or dealt until each chord's share is known: while the
  // progress loads, or after its read failed (the panel shows that failure).
  const desired = foldResource(opts.desired, {
    loading: () => null,
    error: () => null,
    ready: (shares) => shares,
  });
  const palette = paletteKey(playable, practised, extras);
  const paletteRef = useLatestRef(palette);
  const dealRef = useLatestRef<Deal | null>(
    desired === null
      ? null
      : { practised: new Set(practised), blanks, desired },
  );

  const [stored, setStored] = useState<Queue>(() => ({
    palette,
    current: null,
    loops: [],
    fetch: IDLE,
    history: [],
    played: [],
  }));
  /** The palette a refill is out for: one at a time. */
  const inFlight = useRef<string | null>(null);

  const queue = live(stored, palette);
  const { played, loops, current, history } = queue;

  /** Change the queue as it stands for the palette in force now. */
  const update = useEventCallback((fn: (q: Queue) => Queue) =>
    setStored((q) => fn(live(q, paletteRef.current))),
  );

  const wantsMore =
    queue.fetch.kind === "idle" &&
    loops.length <= LOW_WATER &&
    practised.length > 0 &&
    desired !== null;

  useEffect(() => {
    if (!wantsMore || desired === null || inFlight.current === palette) return;
    const askedFor = palette;
    inFlight.current = askedFor;
    const exclude = [
      ...new Set([
        ...played.slice(-RECENT_SECTIONS),
        ...loops.map((l) => l.sectionId),
        ...(current === null ? [] : [current.candidate.sectionId]),
      ]),
    ];
    const base: Omit<FindLoopsBody, "limit" | "focus"> = {
      playable: [...playable],
      practised: [...practised],
      extras,
      shape: "phrase",
      ...(exclude.length > 0 ? { excludeSectionIds: exclude } : {}),
    };
    // The chords furthest below their share get a batch of their own. The
    // rare chords count as one; their batch focuses on one of them at random.
    const focus = shareDeficits(history, desired)
      .slice(0, MAX_FOCUSED)
      .map(({ key }) => {
        if (key !== "rare") return key;
        const rare = [...(desired.rare?.tokens ?? [])];
        return rare[Math.floor(Math.random() * rare.length)] ?? null;
      })
      .filter((token): token is ChordToken => token !== null);
    const bodies: FindLoopsBody[] = [
      { ...base, limit: BATCH },
      ...focus.map((token) => ({
        ...base,
        focus: token,
        limit: FOCUSED_BATCH,
      })),
    ];
    const settle = (fn: (q: Queue) => Queue) => {
      if (inFlight.current === askedFor) inFlight.current = null;
      // Found for a palette no longer in force: stale. The effect has already
      // asked again for the new one (it re-ran when the palette moved).
      if (paletteRef.current !== askedFor) return;
      update(fn);
    };
    void Promise.all(
      bodies.map((body) => fetchEndpoint(findLoopsEndpoint, {}, { body })),
    ).then(
      (answers) =>
        settle((q) => {
          for (const answer of answers) {
            if (answer.kind === "not-ready") {
              return {
                ...q,
                fetch: { kind: "not-ready", status: answer.status },
              };
            }
          }
          const known = new Set(q.loops.map(loopKey));
          if (q.current !== null) known.add(loopKey(q.current.candidate));
          const fresh: LoopCandidate[] = [];
          for (const answer of answers) {
            if (answer.kind !== "ready") continue;
            for (const loop of answer.candidates) {
              if (known.has(loopKey(loop))) continue;
              known.add(loopKey(loop));
              fresh.push(loop);
            }
          }
          const filled: Queue = {
            ...q,
            loops: [...q.loops, ...fresh],
            fetch: fresh.length === 0 ? { kind: "exhausted" } : q.fetch,
          };
          // Nothing on screen yet (the first loops, or the round ran out
          // while the pool was empty): deal at once.
          const deal = dealRef.current;
          return filled.current === null && deal !== null
            ? dealNext(filled, deal)
            : filled;
        }),
      (err: unknown) =>
        settle((q) => ({
          ...q,
          fetch: {
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          },
        })),
    );
    // `inFlight` gates a second refill while one is out; the pool growing (or
    // its fetch leaving `idle`) turns `wantsMore` off when it lands.
  }, [
    fetchEndpoint,
    wantsMore,
    desired,
    palette,
    paletteRef,
    dealRef,
    played,
    loops,
    current,
    history,
    playable,
    practised,
    extras,
    update,
  ]);

  /** Move past the round on screen: deal the next one from the pool, or wait for the refill. */
  const moveOn = (keep: (loop: LoopCandidate) => boolean) =>
    update((q) => {
      const left = { ...leave(q), loops: q.loops.filter(keep) };
      const deal = dealRef.current;
      return deal === null ? left : dealNext(left, deal);
    });

  const next = useEventCallback(() => moveOn(() => true));
  const skipVideo = useEventCallback((videoId: string) =>
    moveOn((loop) => loop.videoId !== videoId),
  );
  const retry = useEventCallback(() => update((q) => ({ ...q, fetch: IDLE })));

  const state: LoopQueueState =
    current !== null
      ? { kind: "ready", dealt: current }
      : practised.length === 0
        ? { kind: "nothing-practised" }
        : stateOf(queue.fetch);
  return { state, next, skipVideo, retry };
}

function stateOf(fetchState: Fetch): LoopQueueState {
  switch (fetchState.kind) {
    case "idle":
      return { kind: "loading" };
    case "exhausted":
      return { kind: "empty" };
    case "not-ready":
      return { kind: "not-ready", status: fetchState.status };
    case "error":
      return { kind: "error", message: fetchState.message };
  }
}
