import { z } from "zod";
import { cpus } from "node:os";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { TimelineSourceSchema } from "../../core";
import { collectTimeline } from "./collect";
import { renderTimeline } from "./render";

const DEFAULT_LOOKBACK_MIN = 30;
const MAX_LOOKBACK_MIN = 1440; // 24h — the timeline's own retention envelope
const DEFAULT_MAX_EVENTS = 200;
const MAX_MAX_EVENTS = 1000;

export const timelineTool = Mcp.tool({
  name: "get_timeline",
  unattached: true,
  description: `Cross-worktree incident timeline: every worktree's traces, slow-ops, reports, builds, boots (incl. never-ready bars), host duress bands, and health peaks merged onto ONE wall-clock local-time axis. Use this — NOT raw jsonl logs — to reconstruct a slowness/freeze/memory-pressure incident across the cluster. Backend-independent, so no worktree arg. Window: lookbackMinutes (default ${DEFAULT_LOOKBACK_MIN}, max ${MAX_LOOKBACK_MIN}) ending now or at endIso. Filter with minSeverity / sources. Events are wall-clock-interleaved; per-source drops reported explicitly.`,
  inputSchema: {
    lookbackMinutes: z
      .number()
      .int()
      .positive()
      .max(MAX_LOOKBACK_MIN)
      .optional()
      .describe(`Minutes of history to scan, ending at endIso (or now). Default ${DEFAULT_LOOKBACK_MIN}, max ${MAX_LOOKBACK_MIN}.`),
    endIso: z
      .string()
      .optional()
      .describe("End of the window as an ISO timestamp (for historical incidents). Defaults to now."),
    minSeverity: z
      .enum(["info", "warning", "error"])
      .optional()
      .describe('Drop events below this severity from the EVENTS list (drops are still counted). Default "info".'),
    sources: z
      .array(TimelineSourceSchema)
      .optional()
      .describe("Restrict to these timeline sources. Defaults to all."),
    maxEvents: z
      .number()
      .int()
      .positive()
      .max(MAX_MAX_EVENTS)
      .optional()
      .describe(`Max events in the EVENTS list (errors/warnings retained before info). Default ${DEFAULT_MAX_EVENTS}, max ${MAX_MAX_EVENTS}.`),
  },
  async handler({ lookbackMinutes = DEFAULT_LOOKBACK_MIN, endIso, minSeverity = "info", sources, maxEvents = DEFAULT_MAX_EVENTS }) {
    let toMs = Date.now();
    if (endIso !== undefined) {
      toMs = Date.parse(endIso);
      if (Number.isNaN(toMs)) throw new Error(`Unparseable endIso: "${endIso}"`);
    }
    const fromMs = toMs - lookbackMinutes * 60_000;

    let frames = await collectTimeline(fromMs, toMs);
    // Source filter is applied to the collected frames (not the fan-out) so the
    // producer stays the single source of truth; chunk errors for a filtered-out
    // source are dropped too, since the agent asked not to see that source.
    if (sources !== undefined) {
      const keep = new Set(sources);
      frames = frames.filter((f) => {
        if ("chunk" in f) return keep.has(f.chunk.source);
        if ("health" in f) return keep.has("health");
        return true; // total / end / error frames always pass
      });
    }

    const text = renderTimeline(frames, {
      fromMs,
      toMs,
      minSeverity,
      maxEvents,
      cpuCount: cpus().length || 8,
    });
    return { content: [{ type: "text", text }] };
  },
});
