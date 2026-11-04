import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { youtubeVideoId } from "@plugins/integrations/plugins/youtube/core";
import {
  AnalysisDeviceSchema,
  BeatModelSchema,
  ChromaVariantSchema,
} from "../../core";
import { ensureBeatFeatures, sonifyBeatFeatures } from "../../machine";
import { formatSummary, summarizeBeats } from "./summary";

export interface FeaturesOptions {
  force?: boolean;
  clicks?: string;
  device?: string;
  beatModel?: string;
  chroma?: string;
}

/**
 * The body of `audio features`, in its own module because it imports this
 * plugin's server barrel statically: that barrel evaluates config needing the
 * runtime namespace, so this module may only load inside `runExec`.
 */
export async function features(
  raw: readonly string[],
  opts: FeaturesOptions,
  exec: ExecContext,
): Promise<void> {
  const ids = raw.map((r) => {
    const id = youtubeVideoId(r);
    if (id === null) throw new Error(`not a YouTube video id or URL: ${r}`);
    return id;
  });
  // A flag overrides its setting; an absent one leaves the configured value.
  const device =
    opts.device === undefined
      ? undefined
      : AnalysisDeviceSchema.parse(opts.device);
  const settings = {
    beatModel:
      opts.beatModel === undefined
        ? undefined
        : BeatModelSchema.parse(opts.beatModel),
    chroma:
      opts.chroma === undefined
        ? undefined
        : ChromaVariantSchema.parse(opts.chroma),
  };
  const clicksDir = opts.clicks === undefined ? null : resolve(opts.clicks);
  if (clicksDir !== null) mkdirSync(clicksDir, { recursive: true });
  const log = (line: string) => console.log(`  ${line}`);

  for (const id of ids) {
    console.log(`${id}:`);
    const started = Date.now();
    const result = await ensureBeatFeatures(id, exec, {
      log,
      force: opts.force,
      device,
      settings,
    });
    console.log(
      `  ${formatSummary(summarizeBeats(result))} — ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
    if (clicksDir !== null) {
      const out = join(clicksDir, `${id}-clicks.wav`);
      await sonifyBeatFeatures(id, out, exec, {
        log,
        settings: result.source.settings,
      });
      console.log(`  clicks: ${out}`);
    }
  }
}
