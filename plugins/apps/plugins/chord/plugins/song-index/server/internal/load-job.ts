import { existsSync } from "node:fs";
import { z } from "zod";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { loadSections } from "./load";
import { ensureSnapshot, snapshotPath } from "./snapshot";
import {
  beginIndexLoad,
  currentIndexTarget,
  markIndexFailed,
  markIndexReady,
  readIndexState,
  setIndexPhase,
  setIndexProgress,
} from "./state";
import { isIndexCurrent } from "./status";

// The load's transcript, at `logs/chord-song-index.jsonl` of the backend that
// supervises it (the child's own output, tailed).
const songIndexLog = defineLogSink({
  id: "chord-song-index",
  description:
    "Chord song index load: the Sheet Sage download, the snapshot build and the section load, with their counts and timings.",
});

/**
 * Load the song index, in a detached child (`./singularity supervised-exec
 * chord.song-index.load`): the snapshot build streams 1.5 GB of JSON and a full
 * load inserts ~184k windows, work that must neither block a backend's event
 * loop nor die with a restart.
 *
 * `lock` gives the built-in ledger one in-flight key, so a second enqueue
 * (another `ensure`, a boot) claims nothing while a load runs and returns. And
 * the body starts by re-checking the state row, so an enqueue that lands just
 * after a load finished does not reload a current index.
 */
export const songIndexLoadJob = defineSupervisedJob({
  name: "chord.song-index.load",
  description:
    "Downloads and loads the song index of real-song chord sections used by the chord trainer.",
  input: z.object({}),
  channel: songIndexLog,
  lock: () => "chord.song-index.load",
  async run(_input, { log, exec }) {
    const target = currentIndexTarget();
    if (isIndexCurrent(await readIndexState(), target)) {
      log(
        `index already loaded at ${target.snapshotName}, ${target.scope}, derivation v${target.derivationVersion}`,
      );
      return;
    }
    log(
      `loading the index: ${target.snapshotName}, ${target.scope}, derivation v${target.derivationVersion}`,
    );
    const started = Date.now();
    await beginIndexLoad(
      target,
      existsSync(snapshotPath()) ? "loading" : "downloading",
    );
    try {
      const path = await ensureSnapshot({
        log,
        exec,
        onPhase: setIndexPhase,
      });
      const result = await loadSections({
        snapshotPath: path,
        scope: target.scope,
        log,
        onProgress: setIndexProgress,
      });
      // API documents step: sections fetched from the Hooktheory API
      // (`chord_api_documents`) are re-applied here, over the dump's rows, once
      // the top-up exists. Nothing writes them yet.
      await markIndexReady(result);
      log(`index ready in ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (err) {
      await markIndexFailed(err instanceof Error ? err.message : String(err));
      throw err;
    }
  },
});
