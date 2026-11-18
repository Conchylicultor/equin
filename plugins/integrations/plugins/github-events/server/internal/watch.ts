import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/** The run a failure report is about, as a watch's `remedy` reads it. */
export interface WatchedRunFailure {
  repo: string;
  head: string;
  runId: string;
  /** What started the run (`push`, `schedule`, `workflow_dispatch`, …). */
  event: string;
}

/**
 * One GitHub workflow equin follows, declared by the plugin that owns the
 * repo (the installer's release workflow, the embedded Postgres builds…).
 * Only events of a watched workflow (and, with `releases`, the repo's
 * Releases) are stored; everything else a forwarder delivers is dropped.
 */
export interface GitHubWatch {
  /** `owner/name`. */
  repo: string;
  /** The workflow's file name under `.github/workflows/` (`build-and-publish.yml`). */
  workflow: string;
  /** Follow the repo's GitHub Releases too. */
  releases?: true;
  /**
   * The workflow's `run-name` is the ref it works on (`run-name: ${{
   * inputs.ref || github.ref_name }}`): a run's head is its title, not the
   * branch GitHub reports — a manual run of a tag (`-f ref=<tag>`) is
   * dispatched FROM main, so `head_branch` would say `main`. Read for
   * `workflow_dispatch` runs only: a push's `head_branch` is already right.
   */
  headIsRunName?: true;
  /**
   * What the failure report tells whoever investigates it beyond the run
   * itself — the owner's own fix (a re-publish command). Markdown lines.
   */
  remedy?: (failure: WatchedRunFailure) => readonly string[];
}

/**
 * `GitHubEvents.Watch({ repo, workflow, releases? })` — an open set: each
 * owner contributes its own, and the forwarders (one per watched repo), the
 * ingest and the catch-up read them through `watchedRepos()` / `watchFor()`
 * only, never naming one.
 */
export const GitHubEvents = {
  Watch: defineServerContribution<GitHubWatch>("github-events.watch", {
    docLabel: (w) => `${w.repo} ${w.workflow}`,
  }),
};

/** Every watch. */
export function githubWatches(): readonly GitHubWatch[] {
  return GitHubEvents.Watch.getContributions();
}

/** The watched repos, each once, in contribution order. */
export function watchedRepos(): string[] {
  return [...new Set(githubWatches().map((w) => w.repo))];
}

/** The workflow file's name from a run's `path` (`.github/workflows/x.yml` → `x.yml`). */
export function workflowFileOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The watch a run of `repo`'s workflow at `path` belongs to, if any. */
export function watchFor(repo: string, path: string): GitHubWatch | null {
  const file = workflowFileOf(path);
  return (
    githubWatches().find((w) => w.repo === repo && w.workflow === file) ?? null
  );
}

/** Whether `repo`'s Releases are watched. */
export function releasesWatched(repo: string): boolean {
  return githubWatches().some((w) => w.repo === repo && w.releases === true);
}
