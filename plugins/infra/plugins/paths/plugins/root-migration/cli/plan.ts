import type { DataRootLayout } from "@plugins/infra/plugins/paths/core";

// What `./equin data-dir migrate` will do, decided from facts alone — pure, so
// every state an install can be in is a unit test, and the dry run prints the
// exact plan `--apply` executes. The effects live in `./migrate.ts`.

/** One move: a rename of `from` to `to`, then every stored `from/…` rewritten to `to/…`. */
export interface Move {
  from: string;
  to: string;
}

/** Something running that the migration must not pull the data root out from under. */
export interface LiveWork {
  /** What it is, as a person reads it (`build in att-x (pid 123)`). */
  what: string;
}

/** An SDK agent process — alive while its conversation is open, working or idle. */
export interface LiveAgent extends LiveWork {
  pid: number;
}

/** A checkout of this repo whose code predates the move (see `staleCheckouts`). */
export interface StaleCheckout {
  path: string;
  /** The commit it has checked out. */
  head: string;
}

export interface MigrationFacts {
  /** The home-relative layout, read from disk now (never this process's memo). */
  layout: DataRootLayout | { kind: "split"; message: string };
  /**
   * The local backups' two dirs and what sits at each. `legacyExists` is a
   * real directory to move; `legacyIsLink` the link an earlier run left to
   * the current dir.
   */
  backups: {
    legacy: string;
    current: string;
    legacyExists: boolean;
    legacyIsLink: boolean;
    currentExists: boolean;
  };
  /** Whether the gateway's service is still installed under its old label. */
  oldLabelInstalled: boolean;
  /** Whether the command was started by an agent (its conversation id is in the env). */
  runByAgent: boolean;
  /** The process's cwd, when it sits inside the data root to be moved. */
  cwdInsideRoot: string | null;
  /** Build/push/check/test/e2e ops running now: always wait for these. */
  liveWork: readonly LiveWork[];
  /** Agent processes alive now (every open conversation has one, idle or not). */
  liveAgents: readonly LiveAgent[];
  /** `--stop-agents`: the user asked for the agents to be stopped rather than waited for. */
  stopAgents: boolean;
  /**
   * Checkouts of this repo whose code still predates the move: it resolves the
   * legacy names unconditionally (no environment variable the gateway passes
   * overrides them). While any exists, removing a legacy link would let its
   * `./equin`, guard hooks, backend or a relaunched agent create a real legacy
   * dir beside the current one — a split every later start refuses
   * (`DataRootSplitError`). So the links stay until none is left.
   */
  staleCheckouts: readonly StaleCheckout[];
}

/** Legacy names kept as links to their new homes because pre-move code can still run. */
export interface KeptLinks {
  links: string[];
  staleCheckouts: readonly StaleCheckout[];
}

export type MigrationPlan =
  | { kind: "refuse"; reasons: string[] }
  | {
      kind: "done";
      /** A legacy link left in place for stale checkouts: the one thing still pending. */
      keptLinks: KeptLinks | null;
    }
  | {
      kind: "migrate";
      /** The data root's move; null when it already sits at the current root. */
      root: Move | null;
      /** The local backups' move; null when there is nothing to move. */
      backups: Move | null;
      /**
       * The prefixes every stored copy is rewritten from — the root's (and the
       * backups') legacy paths. Present even when the root already moved: a
       * migration whose leftover scan was not clean is rerun to finish it.
       */
      rewrite: Move[];
      /**
       * The legacy names left as links to their new homes while the rewrite
       * runs, removed once the leftover scan is clean.
       */
      dropLinks: string[];
      /** The legacy names that stay links whatever the scan finds (stale checkouts). */
      keptLinks: KeptLinks | null;
      /** Remove the gateway's old-label service definition and install the new one. */
      relabel: boolean;
      /** Agent processes to stop (SIGTERM, their clean exit) with the app. */
      stopAgents: LiveAgent[];
    };

export function planRootMigration(facts: MigrationFacts): MigrationPlan {
  const { layout, backups } = facts;
  const reasons: string[] = [];
  if (facts.runByAgent) {
    reasons.push(
      "Run by an agent. Moving the data root stops the whole app, every agent included — only you run this, from a terminal.",
    );
  }
  if (layout.kind === "split") reasons.push(layout.message);
  if (layout.kind === "custom") {
    reasons.push(
      `The data root is set by the environment (${layout.root}): there is no home-relative root to move.`,
    );
  }
  if (backups.legacyExists && backups.currentExists) {
    reasons.push(
      `Two local backup dirs: ${backups.legacy} and ${backups.current}. Merge them by hand (or move one aside), then retry.`,
    );
  }
  if (facts.cwdInsideRoot !== null) {
    reasons.push(
      `This shell's directory (${facts.cwdInsideRoot}) is inside the data root being moved. cd elsewhere (e.g. your checkout) and retry.`,
    );
  }
  if (facts.liveWork.length > 0) {
    reasons.push(
      `Still running — wait for it to finish, or stop it, then retry:\n${facts.liveWork.map((w) => `    - ${w.what}`).join("\n")}`,
    );
  }
  if (facts.liveAgents.length > 0 && !facts.stopAgents) {
    reasons.push(
      `${facts.liveAgents.length} agent process(es) alive — one per open conversation, idle or working. Close them, or pass --stop-agents to stop them with the app (an agent mid-turn loses that turn; its conversation resumes on the next message):\n${facts.liveAgents.map((w) => `    - ${w.what}`).join("\n")}`,
    );
  }
  if (reasons.length > 0) return { kind: "refuse", reasons };
  if (layout.kind === "split" || layout.kind === "custom") {
    throw new Error("unreachable: refused above");
  }

  const backupsMove: Move | null = backups.legacyExists
    ? { from: backups.legacy, to: backups.current }
    : null;
  const stale = facts.staleCheckouts;
  /** Split the legacy links into those removed once clean and those kept for stale checkouts. */
  const links = (
    names: string[],
  ): { dropLinks: string[]; keptLinks: KeptLinks | null } =>
    stale.length === 0 || names.length === 0
      ? { dropLinks: names, keptLinks: null }
      : { dropLinks: [], keptLinks: { links: names, staleCheckouts: stale } };
  if (layout.kind === "legacy") {
    const root = { from: layout.root, to: layout.current };
    return {
      kind: "migrate",
      root,
      backups: backupsMove,
      rewrite: [root, ...(backupsMove ? [backupsMove] : [])],
      ...links([root.from, ...(backupsMove ? [backupsMove.from] : [])]),
      relabel: facts.oldLabelInstalled,
      stopAgents: [...facts.liveAgents],
    };
  }
  // On the current root already: finish what an earlier run left — the legacy
  // link its leftover scan kept, a backups dir it did not move, the old label.
  // A link that stays for stale checkouts is not finished by a rerun: their
  // code goes on writing legacy paths through it, so its rewrite waits for the
  // run that can also remove it.
  const backupsLinked = backups.legacyIsLink;
  const kept: string[] = [];
  const rewrite: Move[] = [];
  const dropLinks: string[] = [];
  if (layout.legacyLink) {
    if (stale.length > 0) kept.push(layout.legacy);
    else {
      rewrite.push({ from: layout.legacy, to: layout.root });
      dropLinks.push(layout.legacy);
    }
  }
  if (backupsMove) {
    rewrite.push(backupsMove);
    (stale.length > 0 ? kept : dropLinks).push(backupsMove.from);
  } else if (backupsLinked) {
    if (stale.length > 0) kept.push(backups.legacy);
    else {
      rewrite.push({ from: backups.legacy, to: backups.current });
      dropLinks.push(backups.legacy);
    }
  }
  const keptLinks: KeptLinks | null =
    kept.length > 0 ? { links: kept, staleCheckouts: stale } : null;
  if (rewrite.length === 0 && !facts.oldLabelInstalled) {
    return { kind: "done", keptLinks };
  }
  return {
    kind: "migrate",
    root: null,
    backups: backupsMove,
    rewrite,
    dropLinks,
    keptLinks,
    relabel: facts.oldLabelInstalled,
    stopAgents: [...facts.liveAgents],
  };
}

/** How many stale checkouts `describePlan` names before summarising the rest. */
const STALE_SAMPLE = 5;

function describeKeptLinks(kept: KeptLinks): string {
  const { links, staleCheckouts } = kept;
  const sample = staleCheckouts
    .slice(0, STALE_SAMPLE)
    .map((c) => `       - ${c.path} (at ${c.head.slice(0, 10)})`);
  const more = staleCheckouts.length - sample.length;
  return [
    `Keep ${links.join(" and ")} as ${links.length > 1 ? "links" : "a link"} to ${links.length > 1 ? "their" : "its"} new home: ${staleCheckouts.length} checkout(s) of this repo still run code from before the move, which uses the legacy name${links.length > 1 ? "s" : ""} unconditionally — without the link, the first command, hook, backend or agent from one would create a second, real data root that every start then refuses (DataRootSplitError).`,
    ...sample,
    ...(more > 0 ? [`       - …and ${more} more`] : []),
    `     Clear each one — rebase it onto main and \`./equin build\`, or delete the worktree (\`git worktree remove <path>\`) — then rerun \`./equin data-dir migrate\`: once none is left it rewrites what still names the old path and removes the link.`,
  ].join("\n");
}

/** The plan as the dry run prints it. */
export function describePlan(plan: MigrationPlan): string {
  switch (plan.kind) {
    case "refuse":
      return `Refusing to migrate:\n${plan.reasons.map((r) => `  - ${r}`).join("\n")}`;
    case "done":
      return plan.keptLinks === null
        ? "Nothing to do: this install is on the current data root and its gateway runs under the new label."
        : `Nothing to do yet: this install is on the current data root and its gateway runs under the new label.\n  1. ${describeKeptLinks(plan.keptLinks)}`;
    case "migrate": {
      const lines = [
        `Stop the app: login services, the gateway (and every backend), PgBouncer, Postgres${plan.stopAgents.length > 0 ? `, and ${plan.stopAgents.length} agent process(es)` : ""}.`,
      ];
      if (plan.root)
        lines.push(`Move the data root ${plan.root.from} → ${plan.root.to}.`);
      if (plan.backups)
        lines.push(
          `Move the local backups ${plan.backups.from} → ${plan.backups.to}.`,
        );
      if (plan.rewrite.length > 0) {
        const prefixes = plan.rewrite.map((m) => `${m.from}/`).join(", ");
        lines.push(
          `Rewrite every stored path under ${prefixes}: every database in the cluster, text files under the root, Claude Code's transcript dirs; drop the cache entries that hold one.`,
          plan.dropLinks.length > 0
            ? `Scan for leftovers; if none, remove ${plan.dropLinks.join(" and ")} (otherwise keep ${plan.dropLinks.length > 1 ? "them as links" : "it as a link"} and list what is left).`
            : "Scan for leftovers and list what is left.",
        );
      }
      if (plan.keptLinks) lines.push(describeKeptLinks(plan.keptLinks));
      if (plan.relabel)
        lines.push(
          "Remove the gateway's old-label service; `./equin start` installs it as dev.equin.gateway.",
        );
      lines.push("Start the app again (`./equin start`).");
      return lines.map((l, i) => `  ${i + 1}. ${l}`).join("\n");
    }
  }
}
