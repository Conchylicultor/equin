import { useMemo } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { JsonlViewer, type ContextRole } from "./slots";
import { groupContextRuns, type TranscriptItem } from "./context-runs";

/**
 * The visible events as transcript items: runs of harness context folded,
 * per the `JsonlViewer.ContextRole` classifiers and the `hostsContext`
 * renderers. A rendering of `useVisibleEvents`' output, never a filter of it.
 * `answeredBefore`: the agent answered before the first of `events` (a window
 * of a longer transcript).
 */
export function useContextRuns(
  events: JsonlEvent[],
  answeredBefore = false,
): TranscriptItem[] {
  const classifiers = JsonlViewer.ContextRole.useContributions();
  const renderers = JsonlViewer.EventRenderer.useContributions();
  return useMemo(() => {
    const regular = classifiers.filter((c) => !c.fallback);
    const fallbacks = classifiers.filter((c) => c.fallback);
    const roleOf = (e: JsonlEvent): ContextRole | undefined => {
      for (const c of regular) {
        const role = c.role(e);
        if (role !== undefined) return role;
      }
      for (const c of fallbacks) {
        const role = c.role(e);
        if (role !== undefined) return role;
      }
      return undefined;
    };
    const hostKinds = new Set<string>(
      renderers.flatMap((r) =>
        r.hostsContext && typeof r.match === "string" ? [r.match] : [],
      ),
    );
    return groupContextRuns(
      events,
      roleOf,
      (e) => hostKinds.has(e.kind),
      answeredBefore,
    );
  }, [events, classifiers, renderers, answeredBefore]);
}
