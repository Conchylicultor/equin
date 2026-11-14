import { useEffect, useState, useSyncExternalStore } from "react";
import { SubjectError } from "@plugins/packages/plugins/error-subject/core";

/**
 * How long one loading stage may last on screen before it is a failure. A
 * cold load reads, shapes and draws the island in seconds; a minute in one
 * stage is a load that will never finish (a store whose answer never lands,
 * a reader cached on a stale answer — the 2026-11 "Painting the signs" hang).
 */
export const STAGE_DEADLINE_MS = 60_000;

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const pageVisible = () => document.visibilityState === "visible";

/**
 * The failure of a loading stage that outlasted {@link STAGE_DEADLINE_MS} on
 * screen, or null. One one-shot deadline per stage — armed while `stage` is
 * shown (`onScreen`, the page visible: a hidden or background tab draws no
 * frames, so its wait is not the stage's), restarted when the stage changes,
 * the island goes off screen or the page is hidden. Never a poll: the timer
 * is cleared or fires once.
 *
 * The caller throws it, into the pane's error boundary — which files the
 * crash report (one row per stage: the stage is the error's subject) and
 * shows the failure with its Retry in place of a title card that would wait
 * forever.
 */
export function useStageDeadline(
  stage: string | null,
  onScreen: boolean,
): Error | null {
  const visible = useSyncExternalStore(
    subscribeVisibility,
    pageVisible,
    () => false,
  );
  const [stuck, setStuck] = useState<{
    readonly stage: string;
    readonly error: Error;
  } | null>(null);
  const armed = stage !== null && onScreen && visible;
  useEffect(() => {
    if (!armed || stage === null) return;
    const timer = setTimeout(
      () =>
        setStuck({
          stage,
          error: new SubjectError(
            `isle: the island's load stayed on "${stage}" for ${STAGE_DEADLINE_MS / 1000} s on screen`,
            { subject: `isle loading stage: ${stage}` },
          ),
        }),
      STAGE_DEADLINE_MS,
    );
    return () => clearTimeout(timer);
  }, [armed, stage]);
  return stuck !== null && stuck.stage === stage ? stuck.error : null;
}
