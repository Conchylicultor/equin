import {
  PIN_LAG_MAX_DAYS,
  pinDecisionDue,
  reviewPin,
} from "@plugins/infra/plugins/deps/deps";
import type { PendingDecision } from "@plugins/infra/plugins/deps/plugins/updates/core";
import { DecisionDeclare } from "@plugins/infra/plugins/deps/plugins/updates/server";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import { pinStayCommand, pinSwitchCommand } from "../../core";
import { pinnedDeps } from "./check";

function versionOf(install: { identity: string; version: string | null }) {
  return install.version ?? install.identity;
}

/**
 * Review every pin against main's checkout, recording each lag (`reviewPin`
 * with `record`: a lag first seen now starts its clock, a pin back in line or
 * moved drops its record). On main only — the one backend whose view of main
 * is authoritative — at every advance of main (`reaction.ts`: where a lag
 * starts, since main's bun.lock moving is what makes a pin lag) and at each
 * weekly Dependency upgrades run, so the clock starts whether or not that
 * automation gets to detect.
 */
export async function recordPinReviews(now: Date) {
  const deps = await pinnedDeps();
  if (deps.length === 0) return { mainRoot: null, reviews: [] };
  const mainRoot = await getMainRepoRoot();
  const reviews = [];
  for (const dep of deps) {
    reviews.push({
      dep,
      review: await reviewPin(dep, { root: mainRoot, now, record: true }),
    });
  }
  return { mainRoot, reviews };
}

/**
 * Every pin whose lag needs a person now ({@link recordPinReviews}, then the
 * due ones). Run by the weekly Dependency upgrades automation, on main. A
 * declaration that cannot be read throws: the run records a partial failure
 * rather than call the pin decided.
 */
export async function pendingPinDecisions(
  now: Date,
): Promise<PendingDecision[]> {
  const { mainRoot, reviews } = await recordPinReviews(now);
  if (mainRoot === null) return [];
  const pending: PendingDecision[] = [];
  for (const { dep, review } of reviews) {
    if (review.kind === "unreadable") {
      throw new Error(
        `${dep.id}: couldn't read what main declares — ${review.message}`,
      );
    }
    if (review.kind !== "lagging" || !pinDecisionDue(review)) continue;
    const { pinned, declared, blocked, since, dueOn } = review.lag;
    const move = `${versionOf(pinned)} → ${versionOf(declared)}`;
    const situation =
      review.decision === "stay-lapsed" && review.stay !== null
        ? `pinned ${versionOf(pinned)}, main declares ${versionOf(declared)}; the decision to stay was to be reviewed by ${review.stay.reviewBy} — "${review.stay.reason}"`
        : `pinned ${versionOf(pinned)}, main declares ${versionOf(declared)}, behind since ${since?.slice(0, 10) ?? "?"} — past the ${PIN_LAG_MAX_DAYS}-day bound (due ${dueOn ?? "?"})`;
    pending.push({
      subject: dep.id,
      title: `pin ${dep.id} ${move}`,
      situation: blocked === null ? situation : `${situation}; ${blocked}`,
      options: [
        blocked === null
          ? `Switch: \`${pinSwitchCommand(mainRoot, dep.id)}\` (installs and moves the pin, restarts nothing), then restart at a time the user chooses — it applies at ${dep.pin?.appliesAt ?? "the daemon's next restart"}`
          : `Switch: not a plain switch (${blocked}) — only once the upgrade procedure it needs exists`,
        `Stay: \`${pinStayCommand(mainRoot, dep.id)}\` — a hold on ${declared.version === null ? `exactly ${declared.identity}` : `${declared.version} and up`}, reviewed again in at most 90 days (\`--review-by YYYY-MM-DD\` for sooner)`,
      ],
    });
  }
  return pending;
}

/** The pinned binaries as a decision source of the Dependency upgrades automation. */
export const pinDecisionSource = DecisionDeclare({
  source: {
    id: "pinned-binaries",
    label: "Pinned binaries",
    pending: pendingPinDecisions,
  },
});
