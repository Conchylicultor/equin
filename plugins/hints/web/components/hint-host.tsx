import { useEffect } from "react";
import { navigate } from "@plugins/apps-core/plugins/tabs/web";
import { useFocusedAppId } from "@plugins/apps-core/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
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
import { activeTip, wakeAt } from "../internal/tip-queue";
import {
  canGoBack,
  currentStep,
  isLastStep,
  stepIndex,
  type AnyTour,
  type TourRun,
} from "../internal/tour-machine";
import { useAnchorElement, useTrackedRect } from "../internal/use-anchor";
import { AnchoredCard } from "./anchored-card";
import { CenteredCard } from "./centered-card";
import { Halo } from "./halo";
import { HintCard } from "./hint-card";
import { Spotlight } from "./spotlight";

/** How long `?` pulses (and holds the toolbar open) after a tour ends. */
const EXIT_PULSE_MS = 3000;

/**
 * The one hints host, at `Core.Root` — outside every tab, so a tour crosses
 * apps. It owns the engine's effects: stepping the tip queue (one settle
 * timer), resolving `startTour` / `autoStart` against the declared tours, the
 * single tour-exit path, routing signals to the running tour, and declaring
 * which anchors are held. It draws the one active tip, or the running tour's
 * intro or step.
 */
export function HintHost() {
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
  const exitTour = useEventCallback(
    (tour: AnyTour, outcome: TourEndOutcome) => {
      markSeen(tour.id, outcome);
      pulseAnchor(targetKey(hintsHelpAnchor), EXIT_PULSE_MS);
      showToast({
        title: "The tour is here whenever you want it",
        description: "? in the toolbar → Replay the tour",
      });
    },
  );
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
    if (focusedApp !== tour.app.id) navigate(tour.app.basePath);
    runTour(tour);
  }, [engine.requestedTour, tours, focusedApp]);

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
  const step = useEventCallback(() => {
    stepTipQueue(Date.now(), (hint: Hint) => {
      if (tourRunning || seenRows === null) return false;
      if (seenRows.has(hint.id) || isAnswered(hint.id)) return false;
      return resolveAnchorElement(targetKey(hint.anchor)) !== null;
    });
  });
  useEffect(() => subscribeAnchors(step), [step]);
  useEffect(() => step(), [step, engine.tips, seenRows, tourRunning]);
  useEffect(() => {
    const at = wakeAt(engine.tips);
    if (at === null) return;
    // The settle window's deadline — one timer per window, not a poll.
    const timer = setTimeout(step, Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [engine.tips, step]);

  const tip = activeTip(engine.tips);

  // ── Held anchors: what a tip or a step is on holds its popup scope open ──
  const heldKeys = heldKeysOf(engine.tour, tip);
  const heldSignature = heldKeys.join("\n");
  useEffect(() => {
    setHeldAnchors(heldSignature === "" ? [] : heldSignature.split("\n"));
  }, [heldSignature]);
  useEffect(() => () => setHeldAnchors([]), []);

  if (engine.tour) return <TourView run={engine.tour} />;
  if (tip)
    return (
      <TipView
        hint={tip}
        onAnswer={(outcome) => {
          answerTip(tip.id);
          markSeen(tip.id, outcome);
        }}
      />
    );
  return null;
}

function heldKeysOf(run: TourRun | null, tip: Hint | null): string[] {
  if (run) {
    if (run.phase === "intro") return [];
    const step = currentStep(run);
    const target = resolveStepAnchor(step, run.data);
    return [target, step.cue].flatMap((t) => (t ? [targetKey(t)] : []));
  }
  return tip ? [targetKey(tip.anchor)] : [];
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

function TipView({
  hint,
  onAnswer,
}: {
  hint: Hint;
  onAnswer: (outcome: "acted" | "dismissed") => void;
}) {
  const el = useAnchorElement(targetKey(hint.anchor));
  const rect = useTrackedRect(el);
  // Acting on the target counts as "Got it".
  useElementEvent(el, "pointerdown", () => onAnswer("acted"));
  if (!el || !rect) return null;
  const dismiss = () => onAnswer("dismissed");
  return (
    <>
      <Halo rect={rect} />
      <AnchoredCard element={el} rect={rect} placement={hint.placement}>
        <HintCard
          title={hint.title}
          body={hint.body}
          onClose={dismiss}
          primary={{ label: hint.gotIt ?? "Got it", onClick: dismiss }}
        />
      </AnchoredCard>
    </>
  );
}

function TourView({ run }: { run: TourRun }) {
  if (run.phase === "intro") return <TourIntroView run={run} />;
  return <TourStepView run={run} />;
}

function TourIntroView({ run }: { run: TourRun }) {
  const intro = run.tour.intro;
  if (!intro)
    throw new Error(`tour "${run.tour.id}" is on its intro but declares none`);
  return (
    <CenteredCard scrim>
      <HintCard
        title={resolveContent(intro.title, run.data)}
        body={resolveContent(intro.body, run.data)}
        onClose={() => dispatchTour({ type: "end", outcome: "dismissed" })}
        alt={{
          label: intro.skip ?? "I'll explore on my own",
          onClick: () => dispatchTour({ type: "end", outcome: "skipped" }),
        }}
        primary={{
          label: intro.start ?? "Show me around",
          onClick: pressPrimary,
        }}
      />
    </CenteredCard>
  );
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

function TourStepView({ run }: { run: TourRun }) {
  const step = currentStep(run);
  const target = resolveStepAnchor(step, run.data);
  const el = useAnchorElement(target ? targetKey(target) : null);
  const rect = useTrackedRect(el);
  const cueEl = useAnchorElement(step.cue ? targetKey(step.cue) : null);
  const cueRect = useTrackedRect(cueEl);

  // A step brings its target into view when it lands on it (a conversation
  // row below the sidebar's fold): the spotlight and the card follow the
  // element, so an off-screen target would leave the card pinned to an edge,
  // pointing at nothing. Keyed on the step and the element — never on data
  // churn (a row that moves group re-registers as a new element, and is
  // followed). A target already fully on screen is left where it is; one
  // that is not is centered, so the card has room beside it on either side.
  useEffect(() => {
    if (el && !isFullyInViewport(el)) revealElement(el, { block: "center" });
  }, [el, run.stepId]);

  // Shown → lost is what `onAnchorLost` reacts to; never-shown is waiting.
  const present = el !== null;
  useEffect(() => {
    dispatchTour({ type: present ? "anchor-shown" : "anchor-lost" });
  }, [present, run.stepId]);

  // The step's gesture on its anchor is the user doing the primary
  // themselves (`actOnAnchor`): hovering it, or activating it.
  const advance = resolveStepAdvance(step, run.data);
  useElementEvent(el, advance === "anchor-hover" ? "pointerenter" : null, () =>
    actOnAnchor("anchor-hover"),
  );
  useActivation(el, advance === "anchor-click", () =>
    actOnAnchor("anchor-click"),
  );

  const next = step.next;
  const card = (
    <HintCard
      title={resolveContent(step.title, run.data)}
      body={resolveContent(step.body, run.data)}
      steps={{ count: run.tour.steps.length, index: stepIndex(run) }}
      onClose={() => dispatchTour({ type: "end", outcome: "dismissed" })}
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

  if (target === null) return <CenteredCard scrim={false}>{card}</CenteredCard>;
  if (!el || !rect) return null;
  return (
    <>
      {step.scrim === "none" ? <Halo rect={rect} /> : <Spotlight rect={rect} />}
      {cueRect && <Halo rect={cueRect} />}
      <AnchoredCard element={el} rect={rect} placement={step.placement}>
        {card}
      </AnchoredCard>
    </>
  );
}
