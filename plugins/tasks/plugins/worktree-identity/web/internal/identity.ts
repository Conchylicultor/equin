import {
  MAIN_COMPOSITION_ID,
  namespaceLabel,
  namespaceParts,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import type { HealthInfo } from "@plugins/shell/plugins/health-report/web";

/**
 * Where this page is served from, as far as its host name says.
 *
 * - `local` — no namespace at all (bare `localhost`, a dev server).
 * - `main` — the main composition on the main checkout (`MAIN_COMPOSITION_ID`).
 * - `worktree` — served from a checkout, whose name is what an attempt's
 *   worktree path ends in. `composition` is set for a `<composition>.<checkout>`
 *   namespace and `null` for a lone label.
 *
 * A lone label other than `MAIN_COMPOSITION_ID` is read as the main composition on an
 * agent checkout — the shape every agent worktree has. It could also be another
 * composition served from the main checkout (`sonata`); the name cannot tell
 * the two apart (see `namespaceParts`), and the only cost of guessing wrong is
 * a summary that says "agent worktree" and a task lookup that finds nothing.
 */
export type WorktreePlace =
  | { kind: "local" }
  | { kind: "main"; namespace: Namespace }
  | {
      kind: "worktree";
      namespace: Namespace;
      checkout: string;
      composition: string | null;
    };

export function placeOf(namespace: Namespace | null): WorktreePlace {
  if (namespace === null) return { kind: "local" };
  const parts = namespaceParts(namespace);
  if (parts.kind === "pair") {
    return {
      kind: "worktree",
      namespace,
      checkout: parts.checkout,
      composition: parts.composition,
    };
  }
  if (parts.label === MAIN_COMPOSITION_ID) return { kind: "main", namespace };
  return {
    kind: "worktree",
    namespace,
    checkout: parts.label,
    composition: null,
  };
}

/**
 * The task this checkout is working on, as a state: `pending` while the
 * attempts / tasks are still loading is its own answer, never "no task" — and
 * so is `failed`, when one of those reads failed. A linked task carries its
 * short title (`tasks/task-title`, at most three words) only while that short
 * title was made from the task's current title, else `null`.
 */
export type LinkedTask =
  | { kind: "pending" }
  | { kind: "failed" }
  | { kind: "none" }
  | { kind: "linked"; taskId: string; shortTitle: string | null };

/** The row's title: the kind of checkout, never a task title. */
function titleOf(place: WorktreePlace): string {
  switch (place.kind) {
    case "local":
      return "Local dev";
    case "main":
      return "Main checkout";
    case "worktree":
      return place.composition === null
        ? "Agent worktree"
        : `${place.composition.charAt(0).toUpperCase()}${place.composition.slice(1)} worktree`;
  }
}

/**
 * The one-line summary — the details the title leaves out: the namespace (as
 * shown — its public label) on main; on a worktree the task's short title,
 * then the checkout. Until a short title is known (lookup pending, no task, no
 * current short title) a worktree's summary is the checkout alone.
 */
function summaryOf(place: WorktreePlace, task: LinkedTask): string {
  switch (place.kind) {
    case "local":
      return "Served outside the gateway";
    case "main":
      return namespaceLabel(place.namespace);
    case "worktree":
      return task.kind === "linked" && task.shortTitle !== null
        ? `${task.shortTitle} · ${place.checkout}`
        : place.checkout;
  }
}

/** The worktree row: titled by the kind of checkout, detailed in its summary. */
export function identityInfo(
  place: WorktreePlace,
  task: LinkedTask,
): HealthInfo {
  return { title: titleOf(place), summary: summaryOf(place, task) };
}
