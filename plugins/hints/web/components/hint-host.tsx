import { useEffect, useState } from "react";
import { useNavigate } from "@plugins/apps-core/plugins/tabs/web";
import { useFocusedAppId } from "@plugins/apps-core/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { HintsLayer } from "../internal/layer";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import {
  hintsHelpAnchor,
  resolveContent,
  resolveLabel,
  resolveStepAdvance,
  resolveStepAnchor,
  targetKey,
  type Hint,
  type TourEndOutcome,
  type TourStep,
} from "../../core";
import {
  pulseAnchor,
  resolveAnchorElement,
  setHeldAnchors,
  subscribeAnchors,
} from "../internal/anchor-registry";
import {
  actOnAnchor,
  answerTip,
  clearTourRequest,
  dispatchTour,
  endPointer,
  isAnswered,
  pressPrimary,
  runTour,
  stepTipQueue,
  subscribeTourEffects,
  useEngineState,
} from "../internal/engine-store";
import { useTours } from "../internal/registry";
import { useHintSeen, useMarkHintSeen } from "../internal/seen";
import { subscribeHintSignals } from "../internal/signal-bus";
import { activeRequest, wakeAt, type TipRequest } from "../internal/tip-queue";
import { ledgerOf, subscribeLedgers } from "../internal/seen-ledger";
import { inScope } from "../internal/scope-key";
import { useElectedHintHost } from "../internal/host-election";
import {
  canGoBack,
  currentStep,
  isLastStep,
  stepIndex,
  type AnyTour,
  type TourRun,
} from "../internal/tour-machine";
import { useAnchorElement, useTrackedRect } from "../internal/use-anchor";
import { POINTER_LIFETIME_MS, type PointerRun } from "../internal/pointer";
import { hintsThemeScope } from "../internal/hints-theme";
import { ANCHOR_PADDING, inflate, type HintRect } from "../internal/rect";
import { HintCaption, HintCard, TourFarewell, WelcomeCard } from "./hint-card";
import {
  EMPTY_SCENE,
  HintStage,
  type StageBox,
  type StageScene,
  type StageToast,
} from "./stage";

/** How long `?` pulses (and holds the toolbar open) after a tour ends. */
const EXIT_PULSE_MS = 3000;
/** How long the farewell toast stays. */
const FAREWELL_MS = 4800;

/**
 * The one hints host, at `Core.Root` — outside every tab, so a tour crosses
 * apps. Mounted at the page root and in every plugin scope; one of them runs
 * (`useElectedHintHost`): the page's, else — on a page that holds the hints
 * plugin only for a scope — the scope's. It owns the engine's effects: stepping the tip queue (one settle
 * timer), resolving `startTour` / `autoStart` against the declared tours, the
 * single tour-exit path, routing signals to the running tour, and declaring
 * which anchors are held. It draws the one active tip, or the running tour's
 * intro or step, as a scene on the ONE stage (`HintStage`), in the hints'
 * own fixed theme — so every app sees the same cards, and every change of
 * scene is a transition of the same elements.
 */
export function HintHost() {
  // A root host of every scope (`scope: "each"`), of which one runs.
  return useElectedHintHost() ? <ElectedHintHost /> : null;
}

function ElectedHintHost() {
  const goToApp = useNavigate();
  const engine = useEngineState();
  // Not known (loading, or a failed read) is `null`: nothing shows and nothing
  // auto-starts until the seen state is known.
  const seenRows = foldResource(useHintSeen(), {
    ready: (rows) => rows,
    loading: () => null,
    error: () => null,
  });
  const tours = useTours();
  const focusedApp = useFocusedAppId();
  const markSeen = useMarkHintSeen();

  // ── The ONE tour-exit path: finish, ×, Esc, "I'll explore on my own". ──
  const [farewell, setFarewell] = useState<StageToast | null>(null);
  const exitTour = useEventCallback(
    (tour: AnyTour, outcome: TourEndOutcome) => {
      markSeen(tour.id, outcome);
      pulseAnchor(targetKey(hintsHelpAnchor), EXIT_PULSE_MS);
      setFarewell((prev) => ({
        id: (prev?.id ?? 0) + 1,
        content: <TourFarewell />,
      }));
    },
  );
  const farewellId = farewell?.id ?? null;
  useEffect(() => {
    if (farewellId === null) return;
    // The toast's lifetime — one timer per showing, not a poll.
    const timer = setTimeout(() => setFarewell(null), FAREWELL_MS);
    return () => clearTimeout(timer);
  }, [farewellId]);
  useEffect(
    () =>
      subscribeTourEffects((effect) => {
        if (effect.type === "started") markSeen(effect.tour.id, null);
        else exitTour(effect.tour, effect.outcome);
      }),
    [markSeen, exitTour],
  );

  useEffect(
    () =>
      subscribeHintSignals((id, payload) =>
        dispatchTour({ type: "signal", id, payload }),
      ),
    [],
  );

  // ── startTour(id) ──
  useEffect(() => {
    const id = engine.requestedTour;
    if (id === null) return;
    clearTourRequest();
    const tour = tours.find((t) => t.id === id);
    if (!tour) {
      throw new Error(
        `startTour("${id}"): no Hints.Tour declares it (declared: ${tours.map((t) => t.id).join(", ") || "none"})`,
      );
    }
    if (focusedApp !== tour.app.id) goToApp(tour.app.basePath);
    runTour(tour);
  }, [engine.requestedTour, tours, focusedApp, goToApp]);

  // ── autoStart: once, when unseen and its app is focused ──
  useEffect(() => {
    if (engine.tour || seenRows === null) return;
    const due = tours.find(
      (t) =>
        t.autoStart &&
        t.app.id === focusedApp &&
        !seenRows.has(t.id) &&
        !isAnswered(t.id),
    );
    if (due) runTour(due);
  }, [engine.tour, seenRows, tours, focusedApp]);

  // ── The tip queue: step on every input change, and at the settle deadline ──
  const tourRunning = engine.tour !== null;
  const pointing = engine.pointer !== null;
  const stepTips = useEventCallback(() => {
    stepTipQueue(Date.now(), (hint: Hint, request: TipRequest) => {
      if (tourRunning || pointing) return false;
      // The seen state of the scope that asked (the page's, or the demo's on
      // its own worker) — not known yet: nothing shows.
      const seen = ledgerOf(request.scope)?.seen ?? null;
      if (seen === null) return false;
      if (seen.has(hint.id) || isAnswered(request.key)) return false;
      // On screen: a tip on a scrolled-away anchor would point at nothing.
      return (
        resolveAnchorElement(tipAnchorKey(request), { onScreen: true }) !== null
      );
    });
  });
  useEffect(() => subscribeAnchors(stepTips), [stepTips]);
  useEffect(() => subscribeLedgers(stepTips), [stepTips]);
  useEffect(() => stepTips(), [stepTips, engine.tips, tourRunning, pointing]);
  useEffect(() => {
    const at = wakeAt(engine.tips);
    if (at === null) return;
    // The settle window's deadline — one timer per window, not a poll.
    const timer = setTimeout(stepTips, Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [engine.tips, stepTips]);

  const tip = activeRequest(engine.tips);

  // ── Held anchors: what a tip or a step is on holds its popup scope open ──
  const heldKeys = heldKeysOf(engine.tour, tip);
  const heldSignature = heldKeys.join("\n");
  useEffect(() => {
    setHeldAnchors(heldSignature === "" ? [] : heldSignature.split("\n"));
  }, [heldSignature]);
  useEffect(() => () => setHeldAnchors([]), []);

  const run = engine.tour;
  // `pointAt` refuses while a tour runs and a tour start clears it, so at most one is set.
  const pointer = run ? null : engine.pointer;
  const shownTip = run || pointer ? null : tip;
  const step = run && run.phase !== "intro" ? currentStep(run) : null;
  const stepTarget = run && step ? resolveStepAnchor(step, run.data) : null;
  // A tip draws on an anchor the user can see (its eligibility), registered in
  // the scope that asked; a tour step takes its anchor wherever it is and
  // scrolls it into view. A one-off highlight (`pointAt`) brings its own element.
  const anchorKey = stepTarget
    ? targetKey(stepTarget)
    : shownTip
      ? tipAnchorKey(shownTip)
      : null;
  const anchorEl = useAnchorElement(anchorKey, { onScreen: !run });
  const el = pointer ? pointer.el : anchorEl;
  const rect = useTrackedRect(el);
  const cueEl = useAnchorElement(step?.cue ? targetKey(step.cue) : null);
  const cueRect = useTrackedRect(cueEl);

  const answerShownTip = (outcome: "acted" | "dismissed") => {
    if (!shownTip) return;
    // Recorded on the server of the scope that asked — the moment showing it
    // publishes that ledger, so it is there while the tip is. The one gap is
    // an answer landing in the instant its last moment let go (the click that
    // closes a window also unmounts its tip's moment, before this render
    // caught up): the request is being withdrawn, so it is answered for the
    // session only — the next moment asks again, and is recorded then.
    answerTip(shownTip.key);
    ledgerOf(shownTip.scope)?.mark(shownTip.hint.id, outcome);
  };
  // Acting on a tip's target counts as "Got it": pressing it, and — for a tip
  // declared `actOn: "hover"` (a hover-revealed control) — pointing at it.
  useElementEvent(shownTip ? el : null, "pointerdown", () =>
    answerShownTip("acted"),
  );
  useElementEvent(
    shownTip?.hint.actOn === "hover" ? el : null,
    "pointerenter",
    () => answerShownTip("acted"),
  );
  useStepEffects(run && step ? { run, step } : null, el);
  usePointerEffects(pointer, rect);

  const scene: StageScene = {
    ...(run
      ? tourScene(run, step, el, rect, cueEl, cueRect)
      : pointer
        ? pointerScene(pointer, rect)
        : shownTip
          ? tipScene(shownTip, el, rect, () => answerShownTip("dismissed"))
          : EMPTY_SCENE),
    toast: farewell,
  };
  return (
    <Theme name={hintsThemeScope} surface="none" className="contents">
      <ViewportOverlay layer={HintsLayer} className="pointer-events-none">
        <HintStage scene={scene} />
      </ViewportOverlay>
    </Theme>
  );
}

/**
 * The box the stage draws around `el` (the anchor `id` resolves to): its rect
 * grown by `pad`, its corners grown to match.
 */
function boxAround(
  id: string,
  el: HTMLElement,
  rect: HintRect,
  pad: number,
): StageBox {
  const own = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius);
  return {
    id,
    rect: inflate(rect, pad),
    radius: Math.max((Number.isFinite(own) ? own : 0) + pad, 10),
  };
}

/** The anchor key a tip points at: its anchor, as registered in the scope that asked. */
function tipAnchorKey(request: TipRequest): string {
  return inScope(request.scope, targetKey(request.hint.anchor));
}

function tipScene(
  request: TipRequest,
  el: HTMLElement | null,
  rect: HintRect | null,
  dismiss: () => void,
): StageScene {
  if (!el || !rect) return EMPTY_SCENE;
  const hint = request.hint;
  const box = boxAround(tipAnchorKey(request), el, rect, ANCHOR_PADDING);
  return {
    ...EMPTY_SCENE,
    halos: [box],
    card: {
      variant: "tip",
      target: box,
      placement: hint.placement ?? "bottom",
      content: (
        <HintCard
          title={hint.title}
          body={hint.body}
          primary={{ label: hint.gotIt ?? "Got it", onClick: dismiss }}
        />
      ),
    },
  };
}

/**
 * `pointAt`'s highlight: a pulsing ring on the element and its caption beside
 * it (none when the element names itself) — no scrim and nothing to press, so
 * the page stays the user's.
 */
function pointerScene(pointer: PointerRun, rect: HintRect | null): StageScene {
  if (!rect) return EMPTY_SCENE;
  // One id for every highlight, so a `pointAt` replacing another glides to it.
  const box = boxAround("pointer", pointer.el, rect, ANCHOR_PADDING);
  return {
    ...EMPTY_SCENE,
    halos: [box],
    card:
      pointer.caption === null
        ? null
        : {
            variant: "caption",
            target: box,
            placement: "bottom",
            content: <HintCaption body={pointer.caption} />,
          },
  };
}

/**
 * A highlight's effects: its element brought into view when it goes up, and
 * its ends — its lifetime running out, the user's next move (a pointerdown
 * anywhere, heard in the capture phase and never stopped, so it still does
 * what it does), and the element leaving the page (its rect update is the
 * signal — `autoUpdate`'s resize observer fires as its box goes). Esc is the
 * `hints.pointer-end` shortcut.
 */
function usePointerEffects(pointer: PointerRun | null, rect: HintRect | null) {
  const id = pointer?.id ?? null;
  const el = pointer?.el ?? null;
  useEffect(() => {
    if (id !== null && el && !isFullyInViewport(el))
      revealElement(el, { block: "center" });
  }, [el, id]);
  useEffect(() => {
    if (id !== null && el && rect && !el.isConnected) endPointer(id);
  }, [id, el, rect]);
  useEffect(() => {
    if (id === null) return;
    // The highlight's lifetime — one timer per showing, not a poll.
    const timer = setTimeout(() => endPointer(id), POINTER_LIFETIME_MS);
    const end = () => endPointer(id);
    document.addEventListener("pointerdown", end, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", end, true);
    };
  }, [id]);
}

function tourScene(
  run: TourRun,
  step: TourStep<object> | null,
  el: HTMLElement | null,
  rect: HintRect | null,
  cueEl: HTMLElement | null,
  cueRect: HintRect | null,
): StageScene {
  const end = (outcome: TourEndOutcome) => () =>
    dispatchTour({ type: "end", outcome });
  if (run.phase === "intro" || step === null) {
    const intro = run.tour.intro;
    if (!intro)
      throw new Error(
        `tour "${run.tour.id}" is on its intro but declares none`,
      );
    return {
      ...EMPTY_SCENE,
      spot: { mode: "cover" },
      welcome: (
        <WelcomeCard
          icon={intro.icon}
          title={resolveContent(intro.title, run.data)}
          body={resolveContent(intro.body, run.data)}
          note={intro.note && resolveContent(intro.note, run.data)}
          start={{
            label: intro.start ?? "Show me around",
            onClick: pressPrimary,
          }}
          skip={{
            label: intro.skip ?? "I'll explore on my own",
            onClick: end("skipped"),
          }}
        />
      ),
    };
  }

  const target = resolveStepAnchor(step, run.data);
  const next = step.next;
  const content = (
    <HintCard
      title={resolveContent(step.title, run.data)}
      body={resolveContent(step.body, run.data)}
      footnote={step.footnote && resolveContent(step.footnote, run.data)}
      steps={{ count: run.tour.steps.length, index: stepIndex(run) }}
      onClose={end("dismissed")}
      alt={
        step.alt && {
          label: resolveLabel(step.alt.label, run.data),
          onClick: () => dispatchTour({ type: "alt" }),
        }
      }
      onBack={canGoBack(run) ? () => dispatchTour({ type: "back" }) : undefined}
      primary={
        next === "none"
          ? undefined
          : {
              label: next
                ? resolveLabel(next.label, run.data)
                : isLastStep(run)
                  ? "Done"
                  : "Next",
              onClick: pressPrimary,
            }
      }
    />
  );
  const placement = step.placement ?? "bottom";
  // No anchor: the card waits centered, no spotlight.
  if (target === null)
    return {
      ...EMPTY_SCENE,
      card: { variant: "step", target: null, placement, content },
    };
  // An anchor not on the page yet: nothing until it comes.
  if (!el || !rect) return EMPTY_SCENE;
  const box = boxAround(
    targetKey(target),
    el,
    rect,
    step.padding ?? ANCHOR_PADDING,
  );
  return {
    ...EMPTY_SCENE,
    spot: { mode: step.scrim === "none" ? "ring" : "hole", box },
    halos:
      step.cue && cueEl && cueRect
        ? [boxAround(targetKey(step.cue), cueEl, cueRect, 4)]
        : [],
    card: { variant: "step", target: box, placement, content },
  };
}

function isFullyInViewport(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return (
    r.top >= 0 &&
    r.left >= 0 &&
    r.bottom <= window.innerHeight &&
    r.right <= window.innerWidth
  );
}

/** A running step's effects on its anchor: reveal, shown/lost, and its gesture. */
function useStepEffects(
  current: { run: TourRun; step: TourStep<object> } | null,
  el: HTMLElement | null,
) {
  const stepId = current?.run.stepId ?? null;
  // A step brings its target into view when it lands on it (a conversation
  // row below the sidebar's fold): the spotlight and the card follow the
  // element, so an off-screen target would leave the card pinned to an edge,
  // pointing at nothing. Keyed on the step and the element — never on data
  // churn. A target already fully on screen is left where it is; one that is
  // not is centered, so the card has room beside it on either side.
  useEffect(() => {
    if (stepId !== null && el && !isFullyInViewport(el))
      revealElement(el, { block: "center" });
  }, [el, stepId]);

  // Shown → lost is what `onAnchorLost` reacts to; never-shown is waiting.
  const present = el !== null;
  useEffect(() => {
    if (stepId === null) return;
    dispatchTour({ type: present ? "anchor-shown" : "anchor-lost" });
  }, [present, stepId]);

  // The step's gesture on its anchor is the user doing the primary
  // themselves (`actOnAnchor`): hovering it, or activating it.
  const advance = current
    ? resolveStepAdvance(current.step, current.run.data)
    : null;
  useElementEvent(el, advance === "anchor-hover" ? "pointerenter" : null, () =>
    actOnAnchor("anchor-hover"),
  );
  useActivation(el, advance === "anchor-click", () =>
    actOnAnchor("anchor-click"),
  );
}

function heldKeysOf(run: TourRun | null, tip: TipRequest | null): string[] {
  if (run) {
    if (run.phase === "intro") return [];
    const step = currentStep(run);
    const target = resolveStepAnchor(step, run.data);
    return [target, step.cue].flatMap((t) => (t ? [targetKey(t)] : []));
  }
  return tip ? [tipAnchorKey(tip)] : [];
}

/** Calls `handler` on `type` events of `el` (while both are set). */
function useElementEvent(
  el: HTMLElement | null,
  type: "pointerdown" | "pointerenter" | null,
  handler: () => void,
) {
  const stable = useEventCallback(handler);
  useEffect(() => {
    if (!el || type === null) return;
    el.addEventListener(type, stable);
    return () => el.removeEventListener(type, stable);
  }, [el, type, stable]);
}

/**
 * Calls `handler` when `el` (or anything inside it) is activated — a `click`,
 * which a pointer and the keyboard (Enter / Space on a button) both produce —
 * AFTER the element's own handlers: the listener is on the document, whose
 * bubble phase runs after React's root-delegated handlers. So the anchor's
 * own action has happened first (Improve's popover is open) and the handler
 * builds on it rather than racing it (an open fired on pointerdown would be
 * toggled shut by the trigger's own click).
 */
function useActivation(
  el: HTMLElement | null,
  enabled: boolean,
  handler: () => void,
) {
  const stable = useEventCallback(handler);
  useEffect(() => {
    if (!el || !enabled) return;
    const doc = el.ownerDocument;
    const onClick = (e: MouseEvent) => {
      if (e.target instanceof Node && el.contains(e.target)) stable();
    };
    doc.addEventListener("click", onClick);
    return () => doc.removeEventListener("click", onClick);
  }, [el, enabled, stable]);
}
