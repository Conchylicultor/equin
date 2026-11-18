// A pin's lag behind what main declares, bounded the way a dependency hold is
// (the `deps/hold` model): once a pin has lagged for PIN_LAG_MAX_DAYS someone
// must decide — switch it (`./equin deps pin`), or record a deliberate stay,
// which IS a hold (a reason and a `reviewBy` at most HOLD_MAX_DAYS out). Past
// its `reviewBy` the stay is lapsed and the decision is due again. Nothing here
// switches a pin or restarts anything: the switch stays a person's.
//
// Machine-local, like the pin: one `<id>.json` per pinned dependency in the
// `state/deps-pins` data dir, holding when the pin was first seen lagging
// (`lag`, reset whenever the pinned install changes) and the stay (`stay`).

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";
import {
  HoldSchema,
  heldBy,
  holdProblems,
  holdState,
  utcDay,
  type Hold,
} from "@plugins/infra/plugins/deps/plugins/hold/core";
import { depsPinsState } from "../../data-dirs";
import type { Dep, DepSource } from "./dep";
import { pinStatus, type PinnedInstall } from "./pin";
import type { DepStore } from "./store";

/**
 * How long a pin may lag what main declares before a person must decide:
 * switch it, or record a stay. The weekly Dependency upgrades task carries
 * every pin past it.
 */
export const PIN_LAG_MAX_DAYS = 30;

const DAY_MS = 86_400_000;

const ReviewRecordSchema = z
  .object({
    /** The pinned install first seen lagging main, and when (ISO instant). */
    lag: z.object({ pinned: z.string(), since: z.string() }).nullable(),
    /** The person's "stay on this version" decision, a hold on the declared one. */
    stay: HoldSchema.nullable(),
  })
  .strict();
type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

const EMPTY: ReviewRecord = { lag: null, stay: null };

/** One pinned dependency lagging main. */
export interface PinLag {
  readonly pinned: PinnedInstall;
  readonly declared: PinnedInstall;
  /** Why the move is not a plain switch (a Postgres major), or null. */
  readonly blocked: string | null;
  /** When it was first seen lagging (ISO instant); null until a review recorded it. */
  readonly since: string | null;
  /** The day a decision is due (`since` + {@link PIN_LAG_MAX_DAYS}); null with `since`. */
  readonly dueOn: string | null;
}

/**
 * Where a pin's lag stands:
 *
 * - `within-bound` — lagging for less than {@link PIN_LAG_MAX_DAYS} (or not
 *   recorded yet): nothing to decide yet.
 * - `due` — past the bound with no stay covering what main declares: a person
 *   decides now.
 * - `stayed` — a stay covers it, its `reviewBy` not past.
 * - `stay-lapsed` — a stay covers it and its `reviewBy` has passed: decide
 *   again (switch, or renew the stay).
 */
export type PinDecision = "within-bound" | "due" | "stayed" | "stay-lapsed";

/** Where a pinned dependency stands against main, for its review. */
export type PinReview =
  /** Unpinned, or pinned to what main declares. */
  | { kind: "current" }
  | { kind: "unreadable"; message: string }
  | {
      kind: "lagging";
      lag: PinLag;
      decision: PinDecision;
      stay: Hold | null;
    };

/** Whether `review` needs a person's decision now. */
export function pinDecisionDue(review: PinReview): boolean {
  return (
    review.kind === "lagging" &&
    (review.decision === "due" || review.decision === "stay-lapsed")
  );
}

export interface PinReviewOptions {
  /** The checkout whose declaration the pin is compared with (main's). */
  root: AppPath;
  store?: DepStore;
  /** Where the review records live. Default: the `state/deps-pins` data dir. */
  reviewDir?: AppPath;
}

async function dirOf(opts: PinReviewOptions): Promise<AppPath> {
  return opts.reviewDir ?? (await depsPinsState.ensure());
}

function fileOf(dir: AppPath, id: string): AppPath {
  return joinAppPath(dir, `${id}.json`);
}

async function readRecord(dir: AppPath, id: string): Promise<ReviewRecord> {
  const file = fileOf(dir, id);
  if (!(await exists(file))) return EMPTY;
  const parsed = ReviewRecordSchema.safeParse(
    JSON.parse(await readFile(file, "utf8")),
  );
  if (!parsed.success) {
    throw new Error(
      `${file}: not a pin review record — ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

async function writeRecord(
  dir: AppPath,
  id: string,
  record: ReviewRecord,
): Promise<void> {
  const file = fileOf(dir, id);
  if (record.lag === null && record.stay === null) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dir, { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** What a stay is matched by: the declared install's version, else its identity. */
function declaredKey(declared: PinnedInstall): string {
  return declared.version ?? declared.identity;
}

function compareVersions(a: string, b: string): number {
  return Bun.semver.order(a, b);
}

/** A real `YYYY-MM-DD` day (the schema checks only its shape). */
function isRealDay(day: string): boolean {
  const t = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day;
}

/**
 * Where `dep`'s pin stands against the checkout at `opts.root`. With `record`
 * (the weekly review, and a stay being set), the record follows what it finds:
 * a lag first seen now starts its clock; a pin no longer lagging, or pinned to
 * another install than the one that lagged, drops the record (a stay decided
 * about another install decides nothing now). Without it, read only.
 *
 * A stay set past its {@link HOLD_MAX_DAYS} bound throws, like any hold.
 */
export async function reviewPin(
  dep: Dep<DepSource>,
  opts: PinReviewOptions & { now: Date; record: boolean },
): Promise<PinReview> {
  const dir = await dirOf(opts);
  const [status, before] = await Promise.all([
    pinStatus(dep, { root: opts.root, store: opts.store }),
    readRecord(dir, dep.id),
  ]);
  if (status.kind === "unpinned" || status.declared.kind === "same") {
    if (opts.record && before !== EMPTY) await writeRecord(dir, dep.id, EMPTY);
    return { kind: "current" };
  }
  if (status.declared.kind === "failed") {
    return { kind: "unreadable", message: status.declared.message };
  }
  const { install: declared, blocked } = status.declared;
  let record = before;
  if (record.lag?.pinned !== status.pinned.identity) {
    record = opts.record
      ? {
          lag: {
            pinned: status.pinned.identity,
            since: opts.now.toISOString(),
          },
          stay: null,
        }
      : EMPTY;
    if (opts.record) await writeRecord(dir, dep.id, record);
  }
  const today = utcDay(opts.now);
  const stays = record.stay === null ? [] : [record.stay];
  const problems = holdProblems(stays, today, fileOf(dir, dep.id));
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const since = record.lag?.since ?? null;
  const dueOn =
    since === null
      ? null
      : utcDay(new Date(Date.parse(since) + PIN_LAG_MAX_DAYS * DAY_MS));
  // A `below` stay is measured in versions: against an install whose version
  // cannot be read, only an exact (identity) stay can cover it.
  const comparable =
    declared.version === null
      ? stays.filter((h) => h.version !== undefined)
      : stays;
  const stay =
    heldBy(comparable, dep.id, declaredKey(declared), compareVersions) ?? null;
  const decision: PinDecision =
    stay !== null
      ? holdState(stay, today) === "active"
        ? "stayed"
        : "stay-lapsed"
      : dueOn !== null && today >= dueOn
        ? "due"
        : "within-bound";
  return {
    kind: "lagging",
    lag: { pinned: status.pinned, declared, blocked, since, dueOn },
    decision,
    stay: record.stay,
  };
}

/**
 * Record a person's decision to keep `dep` on its pinned install while main
 * declares another: a hold on the declared version and everything after it
 * (`below`; on the identity alone when the source reads no version), with
 * `reason` and `reviewBy` — at most HOLD_MAX_DAYS out. Replaces any earlier
 * stay. Throws when the pin does not lag main: there is nothing to stay on.
 */
export async function stayPin(
  dep: Dep<DepSource>,
  opts: PinReviewOptions & { now: Date; reason: string; reviewBy: string },
): Promise<Hold> {
  const review = await reviewPin(dep, { ...opts, record: true });
  if (review.kind !== "lagging") {
    throw new Error(
      review.kind === "unreadable"
        ? `${dep.id}: cannot read what main declares — ${review.message}`
        : `${dep.id} does not lag main (unpinned, or pinned to what main declares): there is nothing to stay on`,
    );
  }
  const { declared } = review.lag;
  const stay = HoldSchema.parse({
    names: [dep.id],
    ...(declared.version === null
      ? { version: declared.identity }
      : { below: declared.version }),
    reason: opts.reason,
    reviewBy: opts.reviewBy,
  });
  const today = utcDay(opts.now);
  if (!isRealDay(stay.reviewBy) || stay.reviewBy < today) {
    throw new Error(
      `${dep.id}: review day ${stay.reviewBy} must be a real day from today (${today}) on`,
    );
  }
  const dir = await dirOf(opts);
  const problems = holdProblems([stay], today, fileOf(dir, dep.id));
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const record = await readRecord(dir, dep.id);
  await writeRecord(dir, dep.id, { ...record, stay });
  return stay;
}

/** Remove `dep`'s stay, if any: its lag is due again as soon as it is past the bound. */
export async function liftPinStay(
  dep: Dep<DepSource>,
  opts: { reviewDir?: AppPath } = {},
): Promise<Hold | null> {
  const dir = opts.reviewDir ?? (await depsPinsState.ensure());
  const record = await readRecord(dir, dep.id);
  if (record.stay === null) return null;
  await writeRecord(dir, dep.id, { ...record, stay: null });
  return record.stay;
}
