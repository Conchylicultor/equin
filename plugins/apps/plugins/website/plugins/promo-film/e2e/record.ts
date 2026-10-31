// Records the showcase film's session: the real app on this checkout's seeded
// `promo-film` composition, segment by segment (internal/segments.ts). Frames,
// input logs, the facts a segment reads off the page, and Sonata's sound go to
// /tmp/equin-film/session/; film.ts renders from there without recording.
//
//   ./equin build --composition promo-film      # once
//   ./equin promo-film seed                     # first launch + the story
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/record.ts \
//     --composition promo-film [--only integrated,sonata,…]
//
// Each segment is re-recordable alone (see this plugin's CLAUDE.md for which
// need a fresh seed). A segment records ~0.5 s of real time per frame.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  arg,
  usage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { SEGMENTS } from "./internal/segments";
import { REC_DIR } from "./internal/session-kit";

const ALL = Object.keys(SEGMENTS);
const only = arg("only")?.split(",") ?? ALL;
for (const k of only)
  if (!ALL.includes(k))
    usage(`unknown segment "${k}"; known: ${ALL.join(", ")}`);

mkdirSync(REC_DIR, { recursive: true });
await withBrowser(
  async (h) => {
    for (const name of only) {
      console.log(`— ${name}`);
      const run = SEGMENTS[name];
      if (!run) throw new Error(`unreachable: segment ${name}`);
      await run({ h });
    }
  },
  {
    // Google's vector map in Places needs hardware WebGL (else a raster
    // fallback with a "not a vector map" banner).
    gpu: true,
    // A blinking caret runs on the browser's real clock and would flicker
    // across virtual-clock frames: the OS's non-blinking caret setting.
    steadyCaret: true,
  },
);
const have = ALL.filter((k) => existsSync(join(REC_DIR, `${k}.json`)));
console.log(`recorded: ${only.join(", ")}; on disk: ${have.join(", ")}`);
