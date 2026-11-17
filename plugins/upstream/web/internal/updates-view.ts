import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import {
  releaseVersion,
  type ReleaseStatus,
} from "@plugins/upstream/plugins/release/core";
import {
  OUT_OF_DATE_TITLE,
  outOfDateSummary,
  updateSpan,
} from "../../shared/update-words";

/** One read as `useLive` hands it back — a value read may be `unavailable`. */
export type Read<T> = ResourceResult<T> | ResourceUnavailable;

/** The merge task's latest run, as the row shows it. */
export interface MergeRun {
  id: string;
  status: ConversationStatus;
}

/**
 * Where this clone stands on updates, derived from three reads and never
 * stored: the release status (which also says whether main serves the
 * release), and the live merge task about the newest release
 * (`tasks/task-subject`) with its latest run.
 *
 * - `pending` / `error` — a read has not answered, or failed.
 * - `absent` — nothing to update from: the canonical repo (no upstream),
 *   upstream has cut no release, nobody has asked upstream yet, or a host
 *   without the computer. The row is not drawn.
 * - `out-of-date` — a release local `main` does not hold, and no agent on it.
 * - `in-progress` — the same, with a task merging it; `run` is its latest
 *   conversation (`null`: filed, never started).
 * - `installing` — local `main` holds it, main's backend does not serve a
 *   build of it yet (it is rebuilding).
 * - `up-to-date` — main holds and serves the newest release.
 */
export type UpdatesView =
  | { kind: "pending" }
  | { kind: "error"; what: string }
  | { kind: "absent" }
  | {
      kind: "out-of-date";
      current: string | null;
      latest: string;
      /** Commits the release holds that local `main` does not. */
      commits: number;
    }
  | {
      kind: "in-progress";
      current: string | null;
      latest: string;
      run: MergeRun | null;
    }
  | { kind: "installing"; latest: string }
  | { kind: "up-to-date"; latest: string };

export interface UpdatesInputs {
  release: Read<ReleaseStatus>;
  /** The live task about the newest release (`null`: none). */
  task: Read<{ taskId: string | null }>;
  /** That task's runs, oldest first (read only while there is a task). */
  runs: Read<readonly MergeRun[]>;
}

export function deriveUpdatesView({
  release,
  task,
  runs,
}: UpdatesInputs): UpdatesView {
  if (release.status === "unavailable") return { kind: "absent" };
  if (release.status === "loading") return { kind: "pending" };
  if (release.status === "error")
    return { kind: "error", what: "the release status" };
  const status = release.data;
  switch (status.kind) {
    case "unknown":
    case "no-upstream":
    case "no-release":
      return { kind: "absent" };
    case "current":
      return status.installed
        ? { kind: "up-to-date", latest: status.latest }
        : { kind: "installing", latest: status.latest };
    case "behind": {
      const { current, latest, commits } = status;
      if (task.status === "loading") return { kind: "pending" };
      if (task.status === "error" || task.status === "unavailable")
        return { kind: "error", what: "the update task" };
      if (task.data.taskId === null)
        return { kind: "out-of-date", current, latest, commits };
      if (runs.status === "loading") return { kind: "pending" };
      if (runs.status === "error" || runs.status === "unavailable")
        return { kind: "error", what: "the update's conversation" };
      return {
        kind: "in-progress",
        current,
        latest,
        run: runs.data.at(-1) ?? null,
      };
    }
  }
}

const IN_PROGRESS_TITLE = "Update in progress";
const INSTALLING_TITLE = "Installing";
const UP_TO_DATE_TITLE = `${PRODUCT_NAME} is up to date`;

/**
 * The row's health, titled by its state.
 *
 * Being behind is not a problem: `out-of-date` is drawn as attention (so its
 * Send remedy shows) but ambient with no marks, so the dot stays green. An
 * update in progress follows its conversation: working → ok and pulsing; at
 * rest (waiting on the user, done, disconnected) or never started → attention,
 * since the next step is the user's.
 */
export function updatesHealth(view: UpdatesView): HealthStatus {
  switch (view.kind) {
    case "pending":
      return { state: "unknown" };
    case "error":
      return { state: "unknown", summary: `Couldn't read ${view.what}` };
    case "absent":
      return { state: "absent" };
    case "out-of-date":
      return {
        state: "attention",
        title: OUT_OF_DATE_TITLE,
        summary: outOfDateSummary(view.current, view.latest, view.commits),
        ambient: [],
      };
    case "in-progress": {
      const summary = updateSpan(view.current, view.latest);
      const busy =
        view.run !== null &&
        (view.run.status === "working" || view.run.status === "starting");
      return busy
        ? {
            state: "ok",
            title: IN_PROGRESS_TITLE,
            summary,
            transitioning: true,
          }
        : { state: "attention", title: IN_PROGRESS_TITLE, summary };
    }
    case "installing":
      return {
        state: "ok",
        title: INSTALLING_TITLE,
        summary: releaseVersion(view.latest),
        transitioning: true,
      };
    case "up-to-date":
      return {
        state: "ok",
        title: UP_TO_DATE_TITLE,
        summary: releaseVersion(view.latest),
      };
  }
}
