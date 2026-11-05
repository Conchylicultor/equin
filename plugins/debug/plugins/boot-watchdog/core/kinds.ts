import { z } from "zod";

// The jsonb payload for a `boot-wedge` report. One report per distinct worktree
// (fingerprint `boot-wedge:<worktree>` — the row's own `worktree` column is
// always `main`, since the monitor job runs there, so the subject MUST live in
// the payload + fingerprint). Each boot is reported once — except `booting`,
// re-filed each tick while the gateway still waits on it — so the row `count`
// is about the number of failed boot attempts, plus the minutes spent booting
// past the budget.
//
//   • `state: "booting"` — the latest attempt, and the gateway is still
//     waiting on it (fleet state `starting`): past its budget, not given up on
//     yet. Re-filed each tick.
//   • `state: "failed"` — the latest attempt, and the gateway gave up on it
//     (fleet state `broken`: killed at its readiness deadline — a SIGKILL, so
//     the boot wrote no exit line). No backend runs, none has become ready
//     since, and the gateway retries it only on a deploy or a browser start —
//     the worktree is unusable until then. Filed once per boot: background
//     requests get the failure as their own 502, and each retry (a deploy, a
//     browser start) is a new boot with its own report if it fails again.
//   • `state: "killed"` — the latest attempt was killed before ready, and the
//     gateway now lists the worktree `idle` / `stopping`: it runs nothing for
//     it and no longer holds the failure (a gateway restart, the idle sweeper)
//     — the next request boots it again. A past fact, filed once.
//   • `state: "restart-failed"` — the latest attempt was a hot restart's new
//     process, killed before ready, while the previous backend kept serving
//     (fleet state `running`): a failed deploy, not an outage. Filed once.
//   • `state: "superseded"` — a later boot replaced it (the outage is over;
//     filed once, post-hoc, so it is on record).
//   • `state: "open"` — legacy rows only (before 2026-11-05): "latest attempt,
//     worktree still in the fleet", which read a dead, SIGKILLed boot as
//     "still live". Never filed now; kept so those rows still render.
export const BootWedgeStateSchema = z.enum([
  "booting",
  "failed",
  "killed",
  "restart-failed",
  "superseded",
  "open",
]);
export type BootWedgeState = z.infer<typeof BootWedgeStateSchema>;

// What the boot's own journal says (boot-events' `readBootJournals`), in ms
// since its process started — where the time went and where it stopped.
export const BootWedgeJournalSchema = z.object({
  // Its last journaled entry: how far it got, at least.
  lastEntryAtMs: z.number(),
  // Plugin imports done, or null — it never finished importing.
  importedAtMs: z.number().nullable(),
  // The step still open when the journal ends — where it was when it stopped.
  diedIn: z.string().nullable(),
  // Its longest finished import waves and blocking hooks, longest first.
  slowest: z.array(z.object({ id: z.string(), ms: z.number() })),
  // How long it ran darwinbg (spawned demoted, not yet moved), or null.
  darwinbgMs: z.number().nullable(),
});
export type BootWedgeJournal = z.infer<typeof BootWedgeJournalSchema>;

export const BootWedgePayloadSchema = z.object({
  worktree: z.string(),
  // Process-start epoch ms — the boot's identity, the pairing key with its
  // (missing) ready line.
  processStartedAt: z.number(),
  // How long the worktree has had no ready backend from this attempt on:
  // (supersededAtMs ?? now) − processStartedAt. For a `failed` boot this is
  // how long the worktree has been unusable, not how long the process lived
  // (the journal's `lastEntryAtMs` bounds that).
  wedgedMs: z.number(),
  state: BootWedgeStateSchema,
  // Set only for a superseded wedge — the superseding attempt's start, which
  // bounds the outage.
  supersededAtMs: z.number().optional(),
  budgetMs: z.number(),
  // The gateway's state for the worktree at file time (booting / failed).
  fleetState: z.string().optional(),
  // The gateway's own word on its last failed start (its lastSpawnErr), when
  // it still has one — e.g. "readiness timeout: still not ready 1m30s after
  // escalation".
  gatewayError: z.string().optional(),
  // Absent when the boot left no journal (a backend older than the journal).
  journal: BootWedgeJournalSchema.optional(),
});
export type BootWedgePayload = z.infer<typeof BootWedgePayloadSchema>;
