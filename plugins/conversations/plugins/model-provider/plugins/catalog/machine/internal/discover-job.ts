import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { isHostSingleton } from "@plugins/infra/plugins/paths/core";
import {
  checkClaudeCode,
  requireClaudeBin,
} from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { catalogLog as log } from "./log";
import { recordReport } from "@plugins/reports/server";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import {
  choiceLabel,
  modelMeta,
} from "@plugins/conversations/plugins/model-provider/core";
import { readCliModels } from "./cli-models";
import { readMenu, type MenuProblem } from "./menu";
import { updateModelCatalog } from "./store";
import { applyMenu, type CurrentMove, type MenuChanges } from "./transitions";

/**
 * Read the installed Claude CLI's model menu and make it the catalog: each
 * family runs what its alias resolves to, every version the menu offers is
 * known, and a known version the menu no longer offers is retired.
 *
 * Daily at 05:00 UTC, plus whenever the availability probe sees a Claude CLI
 * version the catalog has not read (`startCliVersionTrigger`) — a CLI update is
 * exactly when the menu moves, so that trigger is the real freshness signal and
 * the cron covers a machine where nothing changes locally.
 *
 * `perWorktree` is omitted: graphile's fleet-wide cron runs it on main only,
 * and the run itself is gated on `isHostSingleton()` so a manual or
 * version-triggered enqueue on a worktree backend does nothing. That makes it
 * the catalog's one writer.
 */
export const modelsDiscoverJob = defineJob({
  name: "models.discover",
  description:
    "Reads the Claude CLI's model menu, so a new model shows up in every picker without a code change and one the CLI dropped is retired.",
  // seconds: one CLI start-up, bounded by its timeout.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 5 * * *" }, // daily at 05:00 UTC
  async run({ ctx }) {
    await discoverModels(ctx.signal);
  },
});

async function discoverModels(signal: AbortSignal): Promise<void> {
  if (!isHostSingleton()) {
    log.publish(
      "skipped: the catalog is discovered by the host's main backend",
    );
    return;
  }
  const status = await checkClaudeCode();
  if (status.kind !== "ready") {
    // Not a failure of discovery: nothing can be asked, and the catalog stays as it is.
    log.publish(`skipped: Claude Code is ${status.kind}`);
    return;
  }
  const menu = readMenu(await readCliModels(requireClaudeBin(), signal));
  for (const problem of menu.problems) await reportProblem(problem);
  if (Object.keys(menu.current).length === 0)
    // A menu naming no family is not one to retire every version against.
    throw new Error(
      `the Claude CLI's model menu names no model family this code knows (${menu.problems.length} unrecognized entries); the catalog is unchanged`,
    );

  const changes = await updateModelCatalog((current) =>
    applyMenu(current, menu, { now: new Date(), cliVersion: status.version }),
  );
  for (const move of changes.moves) await announceMove(move);
  log.publish(describe(changes, status.version));
}

function describe(changes: MenuChanges, cliVersion: string): string {
  const parts = [
    ...changes.moves.map((m) => `${m.family} ${m.from}→${m.to}`),
    ...changes.added.map((id) => `+${id}`),
    ...changes.retired.map((id) => `retired ${id}`),
    ...changes.unretired.map((id) => `un-retired ${id}`),
  ];
  return `menu read (Claude Code ${cliVersion}): ${parts.length > 0 ? parts.join(", ") : "no change"}`;
}

async function reportProblem(problem: MenuProblem): Promise<void> {
  await recordReport({
    kind: "model-unrecognized",
    source: "server-model-discovery",
    data: problem,
    message:
      problem.problem === "family-missing"
        ? `the Claude CLI's model menu does not list ${problem.value}; it keeps its current version`
        : `the Claude CLI's model menu entry ${problem.value} → ${problem.resolvedModel} is unrecognized (${problem.problem}); nothing changed for it`,
  });
}

/** One bell line per family whose current version moved: "Sonnet now runs 5.5". */
async function announceMove(move: CurrentMove): Promise<void> {
  const version = modelMeta(move.to).version;
  await recordNotification({
    type: "models",
    title: `${choiceLabel(move.family)} now runs ${version}`,
    description: `A new ${choiceLabel(move.family)} version was discovered: ${modelMeta(move.to).label} replaces ${modelMeta(move.from).label}. Every launch with "${choiceLabel(move.family)}" now runs it; ${modelMeta(move.from).label} stays available as a pinned version while Claude Code offers it.`,
    variant: "info",
    dedupeKey: `models.current:${move.family}:${move.to}`,
  });
}
