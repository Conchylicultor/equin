import { useEffect, useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import type {
  ChordLoopsAnswer,
  ChordToken,
  IndexStatus,
  LoopCandidate,
  LoopExtras,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import {
  chordCurriculumLoops,
  type Blanks,
  type CurriculumLoopsQueryInput,
} from "@plugins/apps/plugins/chord/plugins/curriculum/core";
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
 * One refill, frozen when it is asked: the palette it was found for and its
 * finds (`chord.curriculum.loops` questions — over the learner's stored
 * selection, which the server reads, so a question never carries the chords),
 * each carrying the refill's own `round` nonce — the answer is a random sample, so the next refill must be a new
 * tuple, never a cached answer to the same question.
 */
type Request = {
  palette: string;
  queries: readonly CurriculumLoopsQueryInput[];
};

/** No refill out: the list read reads nothing. */
const NO_QUERIES: readonly CurriculumLoopsQueryInput[] = [];

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
  /** The palette `loops`, `fetch` and `request` were found for. */
  palette: string;
  /** The round on screen, dealt once. Survives a palette change. */
  current: DealtLoop | null;
  loops: readonly LoopCandidate[];
  fetch: Fetch;
  /** The refill out, read until every find answers: one at a time. */
  request: Request | null;
  /** The chords of the loops dealt this visit, oldest first (the last `SHARE_HISTORY`). */
  history: readonly (readonly ChordToken[])[];
  /** Sections of the loops moved past this visit, most recent last. */
  played: readonly SectionId[];
};

/**
 * The pool as it stands for the palette in force. **A new palette empties
 * it**: its loops were found for the chords the learner had on before, so
 * every one behind the round goes, and so does the last refill's outcome (a
 * palette that just grew may have loops the old one had none of) and the
 * refill still out (found for the old chords: it is dropped unread, and the
 * new palette asks its own). The round on screen stays. Derived, never
 * written: no render can show a stale loop.
 */
function live(queue: Queue, palette: string): Queue {
  return queue.palette === palette
    ? queue
    : { ...queue, palette, loops: [], fetch: IDLE, request: null };
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
    request: null,
    history: [],
    played: [],
  }));

  const queue = live(stored, palette);
  const { played, loops, current, history, request } = queue;

  /** Change the queue as it stands for the palette in force now. */
  const update = useEventCallback((fn: (q: Queue) => Queue) =>
    setStored((q) => fn(live(q, paletteRef.current))),
  );

  const wantsMore =
    queue.fetch.kind === "idle" &&
    loops.length <= LOW_WATER &&
    practised.length > 0 &&
    desired !== null;

  // Ask: freeze one refill when the pool runs low and none is out. Its nonce
  // and the rare chord a focused find picks are drawn here, once, never in
  // render.
  useEffect(() => {
    // `wantsMore` holds only with `desired` known (tsc narrows it through).
    if (!wantsMore || request !== null) return;
    const exclude = [
      ...new Set([
        ...played.slice(-RECENT_SECTIONS),
        ...loops.map((l) => l.sectionId),
        ...(current === null ? [] : [current.candidate.sectionId]),
      ]),
    ];
    const round = crypto.randomUUID();
    // The chords are not asked: the server reads them from the stored
    // selection this palette was drawn from (a selection that moves since
    // moves the palette, which drops this refill).
    const base: Omit<CurriculumLoopsQueryInput, "limit" | "focus"> = {
      shape: "phrase",
      round,
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
    const asked: Request = {
      palette,
      queries: [
        { ...base, limit: BATCH },
        ...focus.map((token) => ({
          ...base,
          focus: token,
          limit: FOCUSED_BATCH,
        })),
      ],
    };
    // Applied to the queue as it stands for the palette in force NOW: a
    // refill frozen for a palette that has since moved is dropped (the effect
    // re-runs for the new one).
    update((q) =>
      q.palette === asked.palette &&
      q.request === null &&
      q.fetch.kind === "idle"
        ? { ...q, request: asked }
        : q,
    );
  }, [
    wantsMore,
    request,
    desired,
    palette,
    played,
    loops,
    current,
    history,
    update,
  ]);

  // Read: every find of the refill out, as one list read (nothing when none
  // is out).
  const answers = useLive(chordCurriculumLoops, request?.queries ?? NO_QUERIES);

  // Land: once every find has answered (or one failed), fold the answers into
  // the pool and clear the request — the read then drops its tuples.
  useEffect(() => {
    if (request === null) return;
    const outcome = refillOutcome(answers);
    if (outcome.kind === "pending") return;
    update((q) =>
      // Only the refill this read was for: a palette change has already
      // dropped it (`live`), and a second landing of the same one is a no-op.
      q.request !== request ? q : land(q, outcome, dealRef.current),
    );
  }, [answers, request, update, dealRef]);

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

/** Where a refill's reads stand, all finds together. */
type RefillOutcome =
  /** A find has not answered yet. */
  | { kind: "pending" }
  /** A find failed (or was refused): the refill is an error. */
  | { kind: "error"; message: string }
  /** Every find answered. */
  | { kind: "answered"; answers: readonly ChordLoopsAnswer[] };

function refillOutcome(
  results: readonly ResourceResult<ChordLoopsAnswer>[],
): RefillOutcome {
  const answers: ChordLoopsAnswer[] = [];
  let pending = false;
  for (const result of results) {
    switch (result.status) {
      // One failed find fails the refill at once: waiting for the others
      // would only delay the error the learner can retry.
      case "error":
        return { kind: "error", message: result.error.message };
      case "loading":
        pending = true;
        break;
      case "ready":
        answers.push(result.data);
        break;
    }
  }
  return pending ? { kind: "pending" } : { kind: "answered", answers };
}

/**
 * Land a refill: a `not-ready` answer wins; otherwise the loops not already
 * pooled or on screen (by `loopKey`) join the pool — none new means the
 * chords are exhausted — and an empty screen is dealt at once. Clears the
 * request either way.
 */
function land(
  q: Queue,
  outcome: Exclude<RefillOutcome, { kind: "pending" }>,
  deal: Deal | null,
): Queue {
  const settled = { ...q, request: null };
  if (outcome.kind === "error") {
    return { ...settled, fetch: { kind: "error", message: outcome.message } };
  }
  for (const answer of outcome.answers) {
    if (answer.kind === "not-ready") {
      return {
        ...settled,
        fetch: { kind: "not-ready", status: answer.status },
      };
    }
  }
  const known = new Set(q.loops.map(loopKey));
  if (q.current !== null) known.add(loopKey(q.current.candidate));
  const fresh: LoopCandidate[] = [];
  for (const answer of outcome.answers) {
    if (answer.kind !== "ready") continue;
    for (const loop of answer.candidates) {
      if (known.has(loopKey(loop))) continue;
      known.add(loopKey(loop));
      fresh.push(loop);
    }
  }
  const filled: Queue = {
    ...settled,
    loops: [...q.loops, ...fresh],
    fetch: fresh.length === 0 ? { kind: "exhausted" } : q.fetch,
  };
  // Nothing on screen yet (the first loops, or the round ran out while the
  // pool was empty): deal at once.
  return filled.current === null && deal !== null
    ? dealNext(filled, deal)
    : filled;
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
