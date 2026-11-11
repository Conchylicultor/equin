import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import {
  worktreeDataDir,
  worktreeArtifacts,
  pruneWorktreeBuildArtifactsSync,
} from "@plugins/infra/plugins/paths/server";
import { buildProgressSpanStart, buildProgressSpanEnd } from "./build-progress";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  fsCallsSince,
  snapshotFsCalls,
  type FsCallSummary,
} from "@plugins/packages/plugins/timed-fs/core";

export interface BuildSpan {
  id: string;
  phase: string;
  label: string;
  startMs: number;
  durationMs: number;
  /**
   * Peak RSS (bytes) of the subprocess this span wrapped, when one was
   * measured (exec/execBuffered in build.ts). Calibration input for the build
   * pool's memory budget (host-semaphore.ts).
   */
  maxRssBytes?: number;
  /**
   * The file calls (`packages/timed-fs`) made while the span ran, by kind,
   * with the path prefixes most went to. A span this process ran counts every
   * call the process made in its window — a concurrent in-process span's too;
   * a check span carries its own check's calls, counted in the check
   * subprocess under that check's own async context. Absent on a profile
   * written before calls were counted (and on a check span whose record has
   * none). What `build/step-baseline` judges a step's file work by.
   */
  fs?: FsCallSummary;
  /** A check span: the check answered from the cache, its body never ran. */
  cached?: boolean;
  /**
   * The span is a WAIT, not the build's own work: its length is another
   * party's — a lock's queue, the host grant, Postgres, a backend or central
   * adopting the deploy or booting (judged by their own boot monitors) — so no
   * step baseline judges it.
   */
  wait?: true;
}

/** How a span is opened beyond its name. */
export interface SpanOptions {
  /** A wait, not work — see `BuildSpan.wait`. */
  wait?: boolean;
}

/** What a retroactively recorded span may carry beyond its timing. */
export interface PushedSpanExtra {
  fs?: FsCallSummary;
  cached?: boolean;
}

export interface BuildProfile {
  spans: BuildSpan[];
  totalDurationMs: number;
}

/**
 * One build's span accumulator + writer: the collector owns its own `spans[]`
 * and its own `t0` baseline, so every span's `startMs` is relative to the
 * collector's creation instant. Callers reach the module-default instance
 * through the wrapper exports below.
 */
interface SpanCollector {
  start(
    id: string,
    phase: string,
    label: string,
    options?: SpanOptions,
  ): (extra?: { maxRssBytes?: number }) => void;
  push(
    id: string,
    phase: string,
    label: string,
    durationMs: number,
    wallStartMs?: number,
    extra?: PushedSpanExtra,
  ): void;
  /**
   * Writes `build-profile-<buildId>.json` under worktree `name`, accepting the
   * id-less (`undefined`) case so the module-default collector can still produce
   * the unsuffixed `build-profile.json` for a manual CLI build with no
   * EQUIN_BUILD_ID.
   */
  writeProfile(name: Namespace, buildId: string | undefined): void;
}

// Per-span unique token feeding the durable build-progress log. The human `id`
// can repeat across concurrent spans (web artifacts / checks run in parallel), so
// the progress log is keyed on this monotonic counter, never on `id`.
let spanSeq = 0;

function makeSpanCollector(): SpanCollector {
  const t0 = performance.now();
  const spans: BuildSpan[] = [];

  function writeProfile(name: Namespace, buildId: string | undefined): void {
    const profile: BuildProfile = {
      spans,
      totalDurationMs:
        spans.length === 0
          ? 0
          : Math.max(...spans.map((s) => s.startMs + s.durationMs)),
    };
    const dir = worktreeDataDir(name);
    mkdirSync(dir, { recursive: true });
    const path = worktreeArtifacts.buildProfile(name, buildId);
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(profile, null, 2) + "\n");
    renameSync(tmp, path);
    // Trim old per-build artifact sets now that this build's set is on disk (the leak
    // fix). See pruneWorktreeBuildArtifacts: the just-written files are always retained.
    pruneWorktreeBuildArtifactsSync(name);
  }

  return {
    start(id, phase, label, options) {
      const start = performance.now();
      const fsAtStart = snapshotFsCalls();
      // Durable, synchronous `enter` marker — on disk before the span body runs, so a
      // build that wedges inside it is named even after SIGKILL. The in-memory `spans`
      // array below is flushed only by write() at the very end, which a wedged build
      // never reaches; this is the crash-durable twin.
      const token = ++spanSeq;
      buildProgressSpanStart(token, id, phase, label);
      return (extra) => {
        const durationMs = Math.round(performance.now() - start);
        const fs = fsCallsSince(fsAtStart);
        spans.push({
          id,
          phase,
          label,
          startMs: Math.round(start - t0),
          durationMs,
          ...(extra?.maxRssBytes != null
            ? { maxRssBytes: extra.maxRssBytes }
            : {}),
          fs,
          ...(options?.wait === true ? { wait: true as const } : {}),
        });
        buildProgressSpanEnd(token, id, durationMs);
      };
    },
    push(id, phase, label, durationMs, wallStartMs, extra) {
      const startMs =
        wallStartMs != null
          ? Math.round(wallStartMs - t0)
          : Math.round(performance.now() - t0) - durationMs;
      spans.push({
        id,
        phase,
        label,
        startMs,
        durationMs,
        ...(extra?.fs !== undefined ? { fs: extra.fs } : {}),
        ...(extra?.cached !== undefined ? { cached: extra.cached } : {}),
      });
    },
    writeProfile,
  };
}

// The module-default collector backing the legacy wrappers below, so every current
// caller (build.ts, admission-valve.ts) is byte-for-byte unaffected.
const defaultCollector = makeSpanCollector();

export function buildProfilerStart(
  id: string,
  phase: string,
  label: string,
  options?: SpanOptions,
): (extra?: { maxRssBytes?: number }) => void {
  return defaultCollector.start(id, phase, label, options);
}

export function pushBuildSpan(
  id: string,
  phase: string,
  label: string,
  durationMs: number,
  wallStartMs?: number,
  extra?: PushedSpanExtra,
): void {
  defaultCollector.push(id, phase, label, durationMs, wallStartMs, extra);
}

export function writeBuildProfile(name: Namespace): void {
  defaultCollector.writeProfile(name, readEnv("BUILD_ID"));
}
