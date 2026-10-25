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
 * so is `failed`, when one of those reads failed.
 */
export type LinkedTask =
  | { kind: "pending" }
  | { kind: "failed" }
  | { kind: "none" }
  | { kind: "linked"; taskId: string; title: string };

/** The final segment of a path, ignoring a trailing slash. */
function basename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** The task of the attempt running in `checkout`, or `null` when none is. */
export function linkedTaskIdOf(
  attempts: ReadonlyArray<{ worktreePath: string; taskId: string }>,
  checkout: string,
): string | null {
  return (
    attempts.find((a) => basename(a.worktreePath) === checkout)?.taskId ?? null
  );
}

/** The one-line summary: the namespace (as shown — its public label), and what
 *  kind of place it names. */
export function summaryOf(place: WorktreePlace): string {
  switch (place.kind) {
    case "local":
      return "Served outside the gateway";
    case "main":
      return `${namespaceLabel(place.namespace)} · main checkout`;
    case "worktree":
      return `${namespaceLabel(place.namespace)} · ${place.composition ?? "agent worktree"}`;
  }
}

/**
 * The worktree row: the linked task's title, else the namespace. While the task
 * lookup is pending the title is the namespace — the same thing an unlinked
 * checkout shows, so nothing reverses once the lookup settles.
 */
export function identityInfo(
  place: WorktreePlace,
  task: LinkedTask,
): HealthInfo {
  const summary = summaryOf(place);
  if (place.kind === "local") return { title: "Local dev", summary };
  return {
    title:
      task.kind === "linked" ? task.title : namespaceLabel(place.namespace),
    summary,
  };
}
