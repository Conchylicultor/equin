import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { readyNow } from "@plugins/infra/plugins/deps/deps";
import { requestDep } from "@plugins/infra/plugins/deps/server";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import { listPrototypeMetas } from "@plugins/apps/plugins/prototypes/plugins/files/server";
import { hasThumbnail, sweepThumbnails, writeThumbnail } from "./cache";
import { fingerprintPrototype } from "./fingerprint";
import { ThumbnailRenderError } from "./errors";
import { renderThumbnail } from "./render";
import { setThumbnailState } from "./state";

/** How long an unused thumbnail is kept. A swept one is simply re-rendered. */
const THUMBNAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Render one prototype's thumbnail.
 *
 * `dedup` by slug, so a burst of saves — or a reconcile racing the watcher —
 * collapses to one render per prototype instead of racing two browsers over
 * the same folder. The payload carries the fingerprint the enqueue was for, so
 * the job can tell it has been superseded.
 *
 * `dedup` has a limit worth naming, because it cost main's queue 70 minutes on
 * 2026-08-17: it cannot collapse onto a row that is already LOCKED. Three saves
 * of one prototype in 14 seconds therefore became three rows, not one — the
 * first running, the next two behind it.
 *
 * `serial: true` is what makes that harmless. One browser at a time is the
 * right bound — a chromium launch plus a render saturates roughly a core, and a
 * gallery open can ask for several prototypes at once — but it must be enforced
 * BEFORE dispatch, not inside the handler. This job used to hold a
 * `createSemaphore(1)` around the browser; a run wedged holding the permit, and
 * the two behind it were dequeued and then blocked *waiting for it*, each
 * burning a worker slot to do nothing. `serial` is graphile's `queue_name`: a
 * job whose queue is busy is never fetched, so it waits in the ready backlog
 * where waiting is free and visible.
 *
 * Known limit, unchanged: this bounds THIS backend, not the host —
 * `browser-fetch` reserves a host-wide pool for its own launches and this does
 * not share it. Fine while prototype renders are rare and short; if galleries
 * get opened across many worktrees at once the fix is a `HOST_POOLS` entry
 * in `host-admission/core`, not anything here.
 *
 * `maxAttempts` is left at the default because it only ever governs the
 * UNEXPECTED case: a classified render failure is caught here and becomes a
 * visible state on the card, which is a successful job.
 */
export const renderThumbnailJob = defineJob({
  name: "prototypes.render-thumbnail",
  description: "Renders a prototype's preview picture for the gallery.",
  // minutes: a chromium launch plus a page render, bounded by nothing shorter
  // than the work. Orthogonal to `serial` below — that bounds how many run at
  // once, this bounds how long one may hold a slot.
  hold: "minutes",
  inProcess:
    "A render lost to a restart only leaves a card without its picture until " +
    "the next enqueue re-renders it (the cache is content-addressed), and renders " +
    "are too frequent and short to pay a detached child's boot for each one.",
  input: z.object({ name: z.string(), key: z.string() }),
  event: z.never(),
  dedup: { key: (input) => input.name },
  serial: true,
  // A browser launch plus a page render is seconds by nature; that is not a
  // slow op worth reporting.
  slowThresholdMs: 60_000,
  run: async ({ input }) => {
    const meta = (await listPrototypeMetas()).find(
      (m) => m.name === input.name,
    );
    // Deleted between enqueue and run — the work is moot, not failed.
    if (!meta) return;

    // Edited between enqueue and run. A fresh enqueue for the new fingerprint
    // is already on its way, so rendering the old bytes would burn a browser to
    // produce a picture nothing will ask for.
    if ((await fingerprintPrototype(meta.name)) !== input.key) return;

    // Another backend (or an earlier run) may have rendered these exact bytes
    // already — the cache is content-addressed and host-global.
    if (await hasThumbnail(input.key)) {
      setThumbnailState(meta.name, { status: "ready", key: input.key });
      return;
    }

    // Chromium is an on-demand dependency, and this job runs IN the backend
    // (no ExecContext), so it never installs: it reads, and when the browser is
    // not there yet it asks for the install and says so on the card. The
    // server barrel re-syncs when that install settles (`onDepInstallSettled`),
    // and `waiting-for-browser` is re-rendered by every sync.
    const browser = await readyNow(chromium);
    if (browser.kind === "failed") {
      setThumbnailState(meta.name, {
        status: "failed",
        key: input.key,
        kind: "browser-unavailable",
        message:
          `Chromium could not be installed: ${browser.message} ` +
          `Retry from Settings → Dependencies, or run \`./equin deps install chromium\`.`,
      });
      return;
    }
    if (browser.kind !== "ready") {
      await requestDep(chromium);
      setThumbnailState(meta.name, {
        status: "waiting-for-browser",
        message:
          "Installing Chromium (~280 MB, once per machine) — the preview renders when it is ready.",
      });
      return;
    }

    try {
      const png = await renderThumbnail(meta, browser.ready);
      await writeThumbnail(input.key, png);
      setThumbnailState(meta.name, { status: "ready", key: input.key });
    } catch (err) {
      // Only a CLASSIFIED render failure becomes a state. Anything else is a
      // bug in this plugin and must surface as a failed job.
      if (!(err instanceof ThumbnailRenderError)) throw err;
      setThumbnailState(meta.name, {
        status: "failed",
        key: input.key,
        kind: err.kind,
        message: err.message,
      });
      console.error(`[prototype-thumbnails] ${meta.name}: ${err.message}`);
    }
  },
});

/**
 * Nightly cache sweep. Main-only (`perWorktree` unset), which is right for a
 * host-global cache: one machine, one sweeper.
 */
export const sweepThumbnailsJob = defineJob({
  name: "prototypes.sweep-thumbnails",
  description:
    "Deletes prototype preview pictures that have gone unused so the cache stays small.",
  hold: "instant",
  // Cron payloads are built from `input.parse({})`, so this must parse `{}`.
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "20 4 * * *" },
  run: async () => {
    await sweepThumbnails(THUMBNAIL_TTL_MS);
  },
});
