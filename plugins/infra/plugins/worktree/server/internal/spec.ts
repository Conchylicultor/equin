import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import {
  worktreeArtifacts,
  worktreesDir,
} from "@plugins/infra/plugins/paths/server";

export interface WorktreeSpec {
  /** Namespace = subdomain = the backend's `--namespace`. Spec dir basename. */
  name: string;
  /** Absolute path to the backend working dir (`bun bin/index.ts` runs here). */
  server: string;
  /** Absolute path to web/dist. Omitted for API-only namespaces (central). */
  web?: string;
  /**
   * Explicit backend spawn argv (e.g. `["<abs>/server"]` for a compiled
   * release). Omitted for dev, where the gateway falls back to its
   * `bun bin/index.ts` convention. On-disk JSON key is exactly `command`
   * (the Go gateway reads it via `json:"command"`).
   */
  command?: string[];
  /**
   * WHICH APP this namespace serves. The BACKEND reads it back off this same
   * file at boot (`server-core/bin/spec-composition.ts`) and
   * `server-core/bin/select-registry.ts` picks the plugin registry from it. The
   * gateway carries the field through its own spec round-trip but never passes
   * it on: it reads this file, and so does the backend, so the two cannot
   * disagree and there is no second hop that could drop the value. (It also
   * means the field works against a stale gateway binary — `./equin build`
   * rebuilds the backend but not the Go gateway.)
   *
   * Absent means "no composition declared", which the backend reads as the main
   * app — the shape `central` and every pre-composition spec have, so an absent
   * value serializes byte-for-byte as before. It is deliberately NOT the same as
   * an empty string, which would arrive as a composition id and be rejected as
   * one.
   *
   * This field exists because identity may not be inferred from the checkout's
   * files. The backend used to pick a filtered registry if one happened to be
   * sitting in `server-core/core/`, which meant a `git clean` silently demoted a
   * composition to the full app, and a main-composition build silently promoted
   * main to somebody else's filtered registry. The spec is the one thing that
   * knows, so the spec says it.
   */
  composition?: string;
}

/**
 * Register a servable namespace by writing its `spec.json`. The gateway's
 * fsnotify watcher picks it up; identity flows from the dir basename to the
 * `--namespace <ns>` the gateway spawns the backend with. Returns the spec.json
 * path.
 *
 * This is the single seam shared by the dev build (identity derived from the git
 * worktree) and the release launcher (a fixed name, no git operation). The spec
 * is pure identity, and `composition` is part of that identity: a namespace is
 * `<composition>.<checkout>` with both sentinels elided, so the name alone
 * cannot say which of the two axes it came from. The `web` tree it points at is
 * already composition-filtered; the `server` tree is shared, so the backend is
 * TOLD which registry to load rather than left to find one.
 */
export function writeWorktreeSpec({
  name,
  server,
  web,
  command,
  composition,
}: WorktreeSpec): string {
  // The path comes from `paths` (`worktreeArtifacts.spec`), not from a join
  // here: the backend this spec spawns reads the same file back at boot
  // (`server-core/bin/spec-composition.ts`), so the name has more than one
  // caller and therefore exactly one owner. `asNamespace` at the join is the
  // same boundary cast `worktree-op.ts` makes for its markers — `name` IS a
  // namespace by contract, and a malformed one would mint a spec dir the
  // gateway can never route to.
  const path = worktreeArtifacts.spec(asNamespace(name));
  mkdirSync(dirname(path), { recursive: true });
  // Build the spec object additively so absent keys are omitted entirely (no
  // `web`/`command` when unset), since the gateway treats a missing `command` as
  // "use the bun bin/index.ts convention".
  const spec: {
    server: string;
    web?: string;
    command?: string[];
    composition?: string;
  } = { server };
  if (web) spec.web = web;
  if (command) spec.command = command;
  if (composition) spec.composition = composition;
  // Atomically publish the spec (temp + rename in the same dir) so a concurrent
  // reader — the gateway registry's loadFile, its periodic reconcile, or a lazy
  // resolve — never observes a truncated/partial spec.json and skips
  // registration. rename(2) within one filesystem is atomic, so every read sees
  // either the old complete file or the new complete file, never a torn write.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(spec, null, 2) + "\n");
  renameSync(tmp, path);
  return path;
}

/**
 * Deregister a namespace by removing its registry entry from disk — the mirror
 * of `writeWorktreeSpec`. Deleting the spec file is the gateway's ONLY
 * deregistration path: its fsnotify watcher fires a Remove event and calls
 * `registry.remove()`, and tearing down the watched subdir also frees the
 * gateway's per-worktree kqueue/inotify watch.
 */
export async function removeWorktreeSpec(name: string): Promise<void> {
  const dir = worktreesDir();
  // New layout: <worktreesDir>/<name>/ (spec.json + logs/ + ops/).
  await rm(join(dir, name), { recursive: true, force: true });
  // Legacy layout: flat <worktreesDir>/<name>.json written by old CLI versions.
  await rm(join(dir, `${name}.json`), { force: true });
}
