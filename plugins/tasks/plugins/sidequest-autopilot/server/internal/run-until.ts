import { z } from "zod";
import { getConfig, setConfig } from "@plugins/config_v2/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { sidequestAutopilotConfig } from "../../shared/config";
import { log } from "./log";
import { parseRunUntil, runUntilPassed } from "../../shared/run-until";

/**
 * Turn the autopilot off if its `runUntil` has passed — a write to its config
 * (the person's own layer), exactly as if they had switched it off: the pane,
 * the catalog and the pump all read it from there. Returns whether the window
 * is over (so nothing more is launched), whether or not this call wrote.
 */
export async function stopIfPastRunUntil(
  now: Date = new Date(),
): Promise<boolean> {
  const config = getConfig(sidequestAutopilotConfig);
  if (!runUntilPassed(parseRunUntil(config.runUntil), now)) return false;
  if (config.enabled) {
    await setConfig(sidequestAutopilotConfig, "enabled", false, {
      writer: systemOrigin("sidequest-autopilot: runUntil passed"),
    });
    log.publish(
      `automation sidequest-autopilot: runUntil ${config.runUntil} passed; turned off`,
    );
  }
  return true;
}

/**
 * Turns the autopilot off at its `runUntil`, so the pane says Off when the
 * window ends rather than at its next wake. Queued for that instant whenever
 * its config changes (`scheduleRunUntil`); a run that finds the window moved
 * or cleared does nothing.
 */
export const runUntilJob = defineJob({
  name: "sidequest-autopilot.run-until",
  description:
    "Turns the Sidequest autopilot off when the end time it was given passes.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  run: async () => {
    await stopIfPastRunUntil();
  },
});

/**
 * Queue the turn-off for the config's `runUntil` (main only, like every
 * automation run). The singleton key collapses it onto the one pending row,
 * and graphile's default key mode moves that row to the new time — so an
 * edited end replaces the old one.
 */
export function scheduleRunUntil(): void {
  if (!isMain()) return;
  const config = getConfig(sidequestAutopilotConfig);
  const runUntil = parseRunUntil(config.runUntil);
  if (!config.enabled || runUntil.kind === "no-end") return;
  void runUntilJob.enqueue({}, { runAt: runUntil.at });
}
