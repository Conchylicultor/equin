// The caret authority: input follows the MODEL, not the DOM.
//
// > The editor holds ONE authoritative caret location. It moves synchronously
// > with the keystroke that moves it. DOM focus is a PROJECTION of it — never
// > the source of truth, and never consulted to decide where input goes.
//
// Before this module the editor only ever *requested* focus (`pendingFocusRef`)
// and waited for the browser to agree. A block created by Enter does not exist
// yet, so the caret landed only when the new editor's PASSIVE effect registered
// its handle — a separate React scheduler task — while keydowns arrive from the
// browser's higher-priority user-interaction source. Every keystroke in that gap
// was delivered to the ORIGIN's contenteditable, already truncated, caret at the
// cut point: typing "alpha" Enter "bravo" produced `["alphab", "ravo"]`. The gap
// is not bounded by anything; it just usually loses the race to human fingers.
//
// So the registry of `BlockFocusHandle`s lives HERE and is unreachable from the
// provider: there is no way to focus a block except `land()`, which means a
// future caller cannot reintroduce the gap. That is the enforcement — a
// type-level fact, not a lint rule.
//
// See `research/2026-07-31-page-caret-authority.md` and the CLAUDE.md section
// "The caret authority (input follows the model, not the DOM)".

import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { RichText } from "../../core";
import type { CaretLandOptions, CaretSurface } from "../caret-surface";
import type { KeystrokeKey } from "./keystroke-intent";

/**
 * Content surgery on a block's BOUND Lexical editor — the members only a block
 * bound to a content doc can implement. Split/merge/forward-delete reach a
 * mounted block's live content through this, which is deliberately the WHOLE of
 * what the authority hands back to the provider ({@link CaretAuthority.surgeryOf}):
 * it carries no `focus`, so it cannot be used to place a caret behind the
 * authority's back.
 *
 * (`appendRunsAtEnd` does land the caret, at the join — but the position is
 * defined by the content edit itself and it only ever runs against an
 * already-mounted editor, so it reintroduces no mount gap.)
 */
export interface BlockTextSurgery {
  /**
   * Delete the LIVE content from linear `offset` to the end. Enter-split uses it
   * to leave the head in the origin block — the reducer's row-level truncation
   * is ignored by a bound editor.
   */
  truncateAt?: (offset: number) => void;
  /**
   * Append `runs` to the LIVE content's end, focus, and land the caret at the
   * join offset. Backspace-merge drives the target block's editor with it
   * (through Lexical, so the collab binding syncs the concatenation into the
   * target's content doc with marks/tokens intact).
   */
  appendRunsAtEnd?: (runs: RichText) => void;
  /**
   * Delete the LIVE content in the linear range `[from, to)`. The non-tail
   * sibling of `truncateAt` — a slash-menu commit strips its `/query`, a
   * markdown shortcut its `> ` prefix — and the ONLY way to strip text a type
   * change consumed, since `page_blocks.data.text` is a projection of the doc
   * this edits, not a place text can be removed from.
   */
  deleteRange?: (from: number, to: number) => void;
  /** Serialize this block's LIVE runs (the read dual of `appendRunsAtEnd`). */
  readRuns?: () => RichText;
  /**
   * The linear offset (in `readRuns`' basis) of the insertion point under the
   * viewport point `(x, y)`, or null when the point is not in this block's
   * text. Moves no caret: a drop into a block's text reads where it lands with
   * it, and splices there.
   */
  offsetAtPoint?: (x: number, y: number) => number | null;
  /**
   * The linear offset of the NATIVE selection's anchor in this block, or null
   * when it holds no range selection. Read once, when a text drag leaves its
   * origin row and becomes an editor-owned span — BEFORE the container takes
   * the keyboard and drops the native selection, which is what makes it the
   * span's anchor. Reads only.
   */
  nativeAnchorOffset?: () => number | null;
  /**
   * The DOM `Range` over linear `[from, to)` of this block's text, offsets
   * clamped into what the editor holds NOW. For PAINTING an editor-owned span
   * (the CSS Custom Highlight API) — it selects nothing, and a span is never
   * cached as one: the offsets are the truth, a Range is derived per paint.
   * Null when the editor has no content to map.
   */
  domRangeOf?: (from: number, to: number) => Range | null;
  /**
   * Subscribe to every committed update of this block's editor, local or
   * remote — what keeps a painted span over this block current. Returns the
   * unsubscribe.
   */
  onTextUpdate?: (listener: () => void) => () => void;
}

/**
 * The READ half of {@link BlockTextSurgery}: what the block list needs to build
 * and paint an editor-owned text span across blocks — and nothing that edits
 * content or places a caret.
 */
export type BlockTextReads = Pick<
  BlockTextSurgery,
  | "readRuns"
  | "offsetAtPoint"
  | "nativeAnchorOffset"
  | "domRangeOf"
  | "onTextUpdate"
>;

/**
 * A block's focus capabilities, registered by its renderer. It is the block-side
 * `CaretSurface`: every focusable block provides `focus`; text editors
 * additionally provide caret-precise placement so the coordinator can land the
 * caret at a pixel column or boundary. Void/textarea blocks (divider, code)
 * register `focus` only.
 */
export interface BlockFocusHandle extends CaretSurface, BlockTextSurgery {
  /** Place the caret at a linear character offset (the merge join point). */
  focusOffset?: (offset: number, opts?: CaretLandOptions) => void;
  /**
   * Apply input the authority buffered while this block's editor was still
   * mounting, in order. Registered by bound text editors only — and a handle
   * that omits it can never be a flight's target (see {@link CaretAuthority.land}),
   * because there would be nowhere to put the user's keystrokes.
   */
  replayInput?: (entries: readonly FlightInput[]) => void;
}

/** One buffered unit of user input, captured while the caret is in flight. */
export type FlightInput =
  | { kind: "text"; text: string }
  | { kind: "key"; key: KeystrokeKey; shift: boolean };

/**
 * A caller's landing policy — plain focus / offset / boundary / column — so
 * every existing caret caller keeps its exact semantics. `land` carries the
 * authority's own bookkeeping (`onLanded`); spread it into whatever
 * `CaretLandOptions` the policy passes on, or the flight never completes.
 */
export type LandPolicy = (
  handle: BlockFocusHandle,
  land: CaretLandOptions,
) => void;

/** Why a claimed landing was given up on. Never silent — see the sink below. */
export type CaretFlightAbortReason =
  /** The target never appeared among the lines the surface RENDERS. Either the
   *  op that would have created it was refused/dropped, or it landed somewhere
   *  unrenderable (inside a collapsed ancestor), so no editor will ever mount
   *  for it and the landing cannot happen. */
  | "target-never-rendered"
  /** The user (or a stray focus move) took the keyboard out of the block list. */
  | "focus-left-surface"
  /** The target mounted but registered no `replayInput` — a void block, which
   *  has nowhere to put typed characters. */
  | "target-cannot-hold-input"
  /** The target's landing policy accepted the caret and then reported the
   *  landing LOST (`CaretLandOptions.onLandingLost`): a hydrating editor took
   *  DOM focus, and by the time its content arrived focus had moved off its
   *  root, so the caret is not there and never will be. Distinct from
   *  `focus-left-surface`, which is the authority observing focus leave the
   *  block list — this one is a steal that stayed INSIDE the surface (or left
   *  `document.activeElement` on `<body>`), which `focusout` cannot see. */
  | "landing-focus-lost"
  /** The interaction surface was detached (the editor unmounted mid-flight). */
  | "surface-detached";

export interface CaretFlightAbortReport {
  reason: CaretFlightAbortReason;
  targetId: string;
  originId: string | null;
  /** How many input units were buffered when the flight was given up on. */
  buffered: number;
  /** Where the buffer was replayed, or null when nothing could take it. */
  replayedInto: string | null;
}

/**
 * A failed landing is a STATE, not a silence: the buffered keystrokes go back
 * into the block the user was standing in, and the failure is reported. The
 * editor must not import `reports`, so a domain plugin registers the mapping
 * (the sink is inert — a no-op — until one does). `emit` never throws.
 */
export const caretFlightReportSink = defineReportSink<CaretFlightAbortReport>();

/**
 * The keys the authority buffers AS KEYS rather than as text: exactly the set
 * `resolveKeystroke` understands, so a replayed one re-enters the same intent
 * step a real keystroke does. `satisfies` makes a drift from `KeystrokeKey` a
 * tsc error rather than a silently unbuffered key.
 */
const KEYSTROKE_KEYS = {
  Enter: true,
  Backspace: true,
  Delete: true,
  Tab: true,
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
} satisfies Record<KeystrokeKey, true>;

function keystrokeKey(key: string): KeystrokeKey | null {
  return Object.hasOwn(KEYSTROKE_KEYS, key) ? (key as KeystrokeKey) : null;
}

/**
 * How many consecutive commits may render no line for a flight's target before
 * the landing is declared failed.
 *
 * A claim is always made in the SAME synchronous turn as the op that creates the
 * target (`focusNew` runs immediately before `dispatchOp`), so in the healthy
 * case the very next commit already renders it. Two is one commit of slack — the
 * claim's own `container.focus()` dispatches a discrete `focusin`, which React
 * may flush as a commit before the op's dispatch lands.
 */
const FLIGHT_MISS_LIMIT = 2;

/**
 * Drop the text caret when the authority (or block-selection mode) takes the
 * keyboard.
 *
 * Moving DOM focus to the container does NOT move the DOM selection: the caret
 * stays parked in the text node of the block the user just left. That residue is
 * not cosmetic — it is what lets a blurred block steal focus back:
 *
 * Lexical re-derives every commit's pending selection from the DOM selection
 * (`$internalCreateSelection` reads it whenever the update has no originating
 * event, i.e. any async/microtask-scheduled commit). Reconciling a selection whose
 * DOM position is unchanged while `document.activeElement` is outside the editor
 * root reads to Lexical as "the caret didn't move, so my root should have focus" —
 * and it calls `rootElement.focus()`. Lexical guards that steal for its own remote
 * collab updates (`COLLABORATION_TAG`), but `@lexical/yjs` issues an UNTAGGED
 * follow-up commit (`$ensureEditorNotEmpty`) deliberately outside the tagged block,
 * which the guard therefore never sees. So any Yjs update landing on a just-blurred
 * block — a content-doc hydration echo, another client's edit — pulls focus back
 * into that block a beat later, with no user input.
 *
 * We cannot tag that commit — it is issued inside the library, with no
 * update-options seam to reach it (unlike the app's own split-truncation, which
 * tags itself with `SKIP_DOM_SELECTION_TAG` in `collab-text-surgery.ts`). So drop
 * the DOM selection instead: with no caret in the block, a reconcile has nothing to
 * restore and no reason to reclaim focus. That holds against ANY async refocus, not
 * just this one trigger.
 *
 * Only ever clears a selection inside the container — a selection elsewhere on the
 * page is not ours to drop. See `research/2026-07-17-page-block-selection-focus-steal.md`.
 */
export function releaseCaret(container: HTMLElement): void {
  const sel = container.ownerDocument.defaultView?.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  if (!container.contains(sel.anchorNode)) return;
  sel.removeAllRanges();
}

/**
 * The one way to put the caret in a block, and the one owner of the handle
 * registry. Two states:
 *
 * - **idle** — model and DOM agree. The authority does nothing and the browser
 *   types natively, which is what keeps IME, dictation and autocorrect working:
 *   they need a real focused editing host.
 * - **in flight** — the model moved, the DOM hasn't. The authority owns the
 *   keyboard until the target's caret is ready.
 */
export interface CaretAuthority {
  /**
   * Land the caret in `blockId`. Synchronous when its host is mounted; a CLAIM
   * (the authority takes the keyboard and buffers input) when the block does not
   * exist yet — i.e. the caller just created it. A block that exists but has no
   * mounted handle (a void row, a collapsed-away editor) is queued best-effort
   * WITHOUT taking the keyboard: the caret never moved off the origin, so there
   * is nothing to route.
   */
  land: (blockId: string, policy: LandPolicy) => void;
  /**
   * Land the caret in an EXISTING block and replay `input` there once it is
   * caret-ready — typing over an editor-owned text span. The key that replaces
   * the span reached the CONTAINER (a span holds the keyboard there, like a
   * block selection), so it is input with no editing host to land in: exactly
   * what a flight buffers. This is a flight whose buffer starts non-empty, and
   * everything typed before the landing joins the same buffer — so typing over
   * a span needs no input path of its own, and IME / autocorrect are untouched
   * once the caret has landed.
   *
   * Unlike {@link land} it ALWAYS claims, mounted target or not: the input must
   * be routed, and a flight is the one owner of routed input. The landing is
   * bounded exactly as any flight's is (`reconcile`, focus leaving the surface).
   */
  landWithInput: (
    blockId: string,
    policy: LandPolicy,
    input: readonly FlightInput[],
  ) => void;
  /**
   * Land only if the block's host is mounted right now; `false` means it has no
   * caret host. The empty-background click uses the answer to fall back to
   * selecting the row instead.
   */
  landIfMounted: (blockId: string, policy: LandPolicy) => boolean;
  /** Whether the block currently has a caret host (arrow-nav skips those without). */
  hasHandle: (blockId: string) => boolean;
  /** A mounted block's content surgery — never a way to place a caret. */
  surgeryOf: (blockId: string) => BlockTextSurgery | null;
  registerHandle: (id: string, handle: BlockFocusHandle) => () => void;
  /** The block list hands the authority its interaction surface. */
  attachContainer: (el: HTMLElement | null) => void;
  /**
   * Push-based flight bound, called on every commit with a predicate over the
   * lines the surface actually RENDERS. Only consulted while a flight is live,
   * so an idle editor pays nothing.
   *
   * The driving relation is deliberately the rendered (visible) set, not
   * anything server-side: under never-revert a block created by a still-pending
   * op is real and rendered long before any push confirms it, so bounding on
   * server truth would abort every normal split during exactly the window the
   * flight exists to cover. It is also strictly tighter than "the row exists" —
   * a row nothing renders (inside a collapsed ancestor) mounts no editor, so its
   * landing can never happen and must be a named failure rather than a hang.
   */
  reconcile: (isRendered: (blockId: string) => boolean) => void;
}

interface Flight {
  targetId: string;
  /** The block the caret left — where the buffer goes if the landing fails. */
  originId: string | null;
  policy: LandPolicy;
  buffer: FlightInput[];
  misses: number;
}

export function createCaretAuthority({
  getOriginId,
  isLiveRow,
}: {
  /** The block that currently holds the caret, for the abort replay. */
  getOriginId: () => string | null;
  /** Whether a block already exists in the editor's rows — the claim discriminator. */
  isLiveRow: (id: string) => boolean;
}): CaretAuthority {
  const handles = new Map<string, BlockFocusHandle>();
  let container: HTMLElement | null = null;
  let flight: Flight | null = null;
  /**
   * The best-effort queue for a target that EXISTS but has no mounted host. It
   * takes no keyboard and moves no caret, so it cannot misroute input; it is the
   * old `pendingFocusRef`, minus its ability to do damage. One slot, replaced by
   * a newer request — bounded by construction.
   */
  let queued: { id: string; policy: LandPolicy } | null = null;
  let listening = false;

  // ---- Capturing intent -----------------------------------------------------
  // Capture-phase NATIVE listeners on the container: capture runs root→target, so
  // they precede Lexical's own listeners on each contenteditable. `stopPropagation`
  // keeps them from React's delegated `onKeyDown` (the block-selection policy),
  // which is attached at the React root and only fires on the way back up.
  //
  // Text comes off `keydown`, not `beforeinput`: the container is deliberately NOT
  // an editing host (§ "Taking the keyboard" below), and `beforeinput` only fires
  // on one — so during a flight it is the ONLY input signal there is.

  function onKeyDownCapture(e: KeyboardEvent): void {
    if (!flight) return;
    // Shortcuts (Cmd+Z, clipboard, browser chrome) are never the caret's input.
    if (e.ctrlKey || e.metaKey) return;
    const key = keystrokeKey(e.key);
    if (key !== null) {
      e.preventDefault();
      e.stopPropagation();
      flight.buffer.push({ kind: "key", key, shift: e.shiftKey });
      return;
    }
    // A single-character `key` IS the character the user typed (dead keys and
    // modifiers resolve into it). Anything longer is a named key we do not own —
    // Escape, F5, PageDown — and is left to propagate untouched.
    if (e.key.length === 1) {
      e.preventDefault();
      e.stopPropagation();
      flight.buffer.push({ kind: "text", text: e.key });
    }
  }

  // Paste is deliberately NOT captured. A `FlightInput` can carry text; a paste
  // carries a block FOREST (`BLOCKS_MIME`) or markdown that parses into one, so
  // buffering it would flatten a multi-block paste to plain text — or, when the
  // clipboard has no `text/plain` at all, drop it entirely. Both happened.
  //
  // Nothing needs to: the event reaches a handler that understands forests.
  // `block-editor.tsx`'s `onPaste` gates on `document.activeElement ===
  // container` — true throughout a flight, since the claim focused it — and
  // dispatches the real forest `paste` op.
  //
  // Where that op ANCHORS during a flight, precisely, because it is not obvious:
  // `releaseCaret` dropped the DOM selection and the flight has not moved
  // `focusedBlockId` yet, so `pasteAnchorId(rows, selectedIds, focusedBlockId)`
  // finds no selection roots and falls back to `focusedBlockId` — the block the
  // caret LEFT. The forest lands after the origin, ahead of the flight's target,
  // which is where a paste issued between an Enter and its landing belongs.
  //
  // NOT verified by an e2e: `paste-optimistic-verify` pastes from
  // block-SELECTION mode with every block selected (Escape → Cmd+A), seconds
  // after the last flight resolved, so it exercises the selection anchor and
  // says nothing about the in-flight one. Treat the paragraph above as reasoning
  // from the code, not as a covered case.

  function onFocusOutCapture(e: FocusEvent): void {
    if (!flight) return;
    const next = e.relatedTarget;
    // `null` is a window/tab blur, not a caret move — the flight survives it and
    // the user comes back to their buffer. Only focus landing on a specific
    // element OUTSIDE the block list means the caret is no longer ours.
    if (next === null) return;
    if (next instanceof Node && container?.contains(next)) return;
    abort("focus-left-surface");
  }

  function startCapturing(el: HTMLElement): void {
    if (listening) return;
    el.addEventListener("keydown", onKeyDownCapture, true);
    el.addEventListener("focusout", onFocusOutCapture, true);
    listening = true;
  }

  function stopCapturing(): void {
    if (!listening || !container) return;
    container.removeEventListener("keydown", onKeyDownCapture, true);
    container.removeEventListener("focusout", onFocusOutCapture, true);
    listening = false;
  }

  // ---- The flight -----------------------------------------------------------

  /**
   * Take the keyboard. NOT by leaving focus in the origin and defending it with
   * `preventDefault` — that defence is not airtight, since `beforeinput` with
   * `insertCompositionText` is not cancelable, so an IME could still write into
   * the block the user left. Instead the origin stops being an editing host at
   * all, so nothing can enter it BY CONSTRUCTION: not typing, not IME, not paste,
   * not spellcheck autocorrect.
   *
   * Focus first, then `releaseCaret` — the order `focusContainer()` uses, so the
   * blurred origin never sits with a parked caret a reconcile could chase.
   */
  function claim(
    blockId: string,
    policy: LandPolicy,
    el: HTMLElement,
    input: readonly FlightInput[] = [],
  ): void {
    // A second claim before the first landed means the model caret moved AGAIN.
    // The buffer is undelivered input, and input follows the model — so it goes
    // with it, and the origin stays the block the user actually left.
    flight = {
      targetId: blockId,
      originId: flight?.originId ?? getOriginId(),
      policy,
      buffer: [...(flight?.buffer ?? []), ...input],
      misses: 0,
    };
    queued = null;
    startCapturing(el);
    el.focus({ preventScroll: true });
    releaseCaret(el);
  }

  /**
   * Hand `entries` to a mounted host, in order, coalescing consecutive text.
   *
   * DEFERRED one microtask, and that is load-bearing. A replay can be triggered
   * from INSIDE a Lexical update — the hydrating landing fires `onLanded` from an
   * update listener, and an abort can fire from a focus move a commit made — and
   * an `editor.update()` issued there is ENQUEUED, `discrete: true` included. The
   * replay's own insert-THEN-key ordering depends on each insert being committed
   * before the next key resolves against it (see `replayBufferedInput`), so a
   * replay begun inside an update would silently reproduce the bug it exists to
   * fix. One microtask puts the whole loop outside any enclosing update — the same
   * deferral, for the same reason, as `split`'s doc-edit capture.
   *
   * It cannot let the user overtake the buffer: microtasks drain before the
   * browser dispatches the next input event, so nothing typed after the landing
   * can be delivered ahead of what was typed before it.
   */
  function replayInto(
    handle: BlockFocusHandle,
    entries: readonly FlightInput[],
  ): void {
    const replay = handle.replayInput;
    if (!replay) return;
    void (async () => {
      for (let i = 0; i < entries.length; i++) {
        // A replayed key can claim the NEXT flight (a replayed Enter re-enters
        // `split()`), and everything after it belongs to that new target — which
        // is exactly the "alpha Enter bravo" case, with no special case for it.
        if (flight) {
          flight.buffer.push(...entries.slice(i));
          return;
        }
        replay([entries[i]!]);
        // YIELD ONE MICROTASK PER ENTRY. A live keystroke sequence lets everything
        // the editor DEFERS run between keystrokes, because each keystroke is its
        // own task: the markdown block shortcut converts from a `queueMicrotask`
        // (an update listener may not mutate during its own update), split defers
        // its doc-edit capture the same way, and the inline autoformat likewise. A
        // replay that ran the whole buffer inside ONE microtask starved all of
        // them — "- Bravo bullet" then Enter converted to a bullet only AFTER the
        // Enter had already minted the next block as `text`, so the user's list
        // silently lost its type.
        //
        // Microtasks drain before the browser dispatches the next input event, so
        // yielding to the editor cannot let the user overtake the buffer: the
        // ordering guarantee is unchanged, and deferred work now interleaves
        // exactly where it would have had the keys never been buffered.
        await Promise.resolve();
      }
    })();
  }

  function abort(reason: CaretFlightAbortReason): void {
    const failed = flight;
    if (!failed) return;
    flight = null;
    stopCapturing();
    const origin = failed.originId ? handles.get(failed.originId) : null;
    const replayedInto = origin?.replayInput ? failed.originId : null;
    if (origin) replayInto(origin, failed.buffer);
    // An EMPTY buffer means nothing was misrouted and nothing had to be
    // recovered — the user simply clicked away before the landing, which is
    // ordinary. Reporting those would bury the ones that cost the user input.
    if (failed.buffer.length === 0) return;
    caretFlightReportSink.emit({
      reason,
      targetId: failed.targetId,
      originId: failed.originId,
      buffered: failed.buffer.length,
      replayedInto,
    });
  }

  /**
   * The target's host mounted. Landing waits for CARET-READY, not for the mount:
   * a freshly split block's Lexical root is childless until the collab pre-seed
   * lands (`editorState: null` + `shouldBootstrap={false}` mean there is nothing
   * to insert into), so the policy reports back through `onLanded` and the
   * authority keeps buffering until then.
   *
   * That wait needs a failure edge as well as a success one: an asynchronous
   * landing can be given up on by the surface itself (focus moved off the
   * hydrating editor before its content arrived), and neither of the authority's
   * own bounds can see it — `focusout` only fires for focus leaving the block
   * LIST, and `reconcile` only counts commits that render no line for a target
   * that is in fact rendered. So the policy also gets `onLandingLost`, and a
   * surface that reports it aborts the flight loudly instead of hanging it.
   */
  function landFlight(handle: BlockFocusHandle): void {
    const inFlight = flight;
    if (!inFlight) return;
    if (!handle.replayInput) {
      // A void host (divider, image) cannot take typed characters. With nothing
      // buffered there is nothing at stake — land the caret as any caller would
      // expect. With input buffered, fail loudly and give the keystrokes back to
      // the block they came from, rather than dropping them into a block that
      // will never render them.
      if (inFlight.buffer.length > 0) {
        abort("target-cannot-hold-input");
        return;
      }
      flight = null;
      stopCapturing();
      inFlight.policy(handle, {});
      return;
    }
    let settled = false;
    inFlight.policy(handle, {
      onLanded: () => {
        if (settled || flight !== inFlight) return;
        settled = true;
        // Read the buffer HERE, not before the policy ran: everything typed
        // during the hydration wait belongs to this replay.
        const entries = inFlight.buffer;
        flight = null;
        stopCapturing();
        replayInto(handle, entries);
      },
      onLandingLost: () => {
        if (settled || flight !== inFlight) return;
        settled = true;
        abort("landing-focus-lost");
      },
    });
  }

  // ---- The public surface ---------------------------------------------------

  return {
    land(blockId, policy) {
      const handle = handles.get(blockId);
      if (handle) {
        queued = null;
        policy(handle, {});
        return;
      }
      // The block already exists, so its host is either caret-less (a void row)
      // or unmounted behind a collapsed ancestor — in neither case has the caret
      // moved off the origin, and claiming the keyboard for a landing that may
      // never come would strand the user's typing. Queue it instead.
      if (isLiveRow(blockId) || container === null) {
        queued = { id: blockId, policy };
        return;
      }
      claim(blockId, policy, container);
    },

    landWithInput(blockId, policy, input) {
      if (container === null) {
        throw new Error(
          `caret authority: input for block "${blockId}" with no interaction ` +
            "surface attached to route it through",
        );
      }
      claim(blockId, policy, container, input);
      const handle = handles.get(blockId);
      if (handle) landFlight(handle);
    },

    landIfMounted(blockId, policy) {
      const handle = handles.get(blockId);
      if (!handle) return false;
      policy(handle, {});
      return true;
    },

    hasHandle(blockId) {
      return handles.has(blockId);
    },

    surgeryOf(blockId) {
      return handles.get(blockId) ?? null;
    },

    registerHandle(id, handle) {
      handles.set(id, handle);
      if (flight?.targetId === id) landFlight(handle);
      else if (queued?.id === id) {
        const { policy } = queued;
        queued = null;
        policy(handle, {});
      }
      return () => {
        handles.delete(id);
      };
    },

    attachContainer(el) {
      if (el === container) return;
      if (flight) abort("surface-detached");
      stopCapturing();
      container = el;
    },

    reconcile(isRendered) {
      if (!flight) return;
      if (isRendered(flight.targetId)) {
        flight.misses = 0;
        return;
      }
      flight.misses += 1;
      if (flight.misses >= FLIGHT_MISS_LIMIT) abort("target-never-rendered");
    },
  };
}
