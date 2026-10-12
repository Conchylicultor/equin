import { z } from "zod";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import type { Semaphore } from "@plugins/packages/plugins/semaphore/core";
import { singleFlight } from "@plugins/packages/plugins/single-flight/core";
import type { CheckObservation, CheckOutcome } from "./thrown-outcome";

/**
 * One check's slot in its run's fan-out gate (`--jobs`), as a lease the check
 * can give back and re-take while it is still in flight. `runChecks` takes it
 * before the check starts and releases it when the check settles; in between,
 * a check that JOINS another run's flight gives it back for the wait (see
 * `runCheckFlight`). Both calls are idempotent against the current state, so
 * the settle-time `release()` is safe whatever the check did with it.
 */
export interface GateSlot {
  /** Take the slot if not held; resolves with the milliseconds spent queued. */
  acquire(): Promise<number>;
  /** Give the slot back if held. */
  release(): void;
}

export function gateSlot(gate: Semaphore): GateSlot {
  let release: (() => void) | null = null;
  return {
    async acquire() {
      if (release !== null) return 0;
      const t0 = performance.now();
      release = await gate.acquire();
      return performance.now() - t0;
    },
    release() {
      const held = release;
      release = null;
      held?.();
    },
  };
}

/**
 * What a leading run hands a joined one. A PASS carries nothing: the leader
 * recorded it in the check cache before publishing, so the joiner re-enters
 * its own cache lookup and is served the ordinary hit. A FAILURE carries the
 * result and the check's observations — the one place a failure verdict is
 * persisted, and only for runs that saw this leader in flight (the primitive's
 * per-publish nonce), so "failures always re-run" still holds for every later
 * run.
 *
 * `inconclusive` is in the schema only so that a stray one can be REFUSED
 * (`adoptable`) rather than stripped by the parse into a hard failure: a leader
 * never publishes one.
 */
const SharedCheckVerdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pass") }),
  z.object({
    kind: z.literal("fail"),
    result: z.object({
      ok: z.literal(false),
      message: z.string(),
      hint: z.string().optional(),
      inconclusive: z.literal(true).optional(),
    }),
    observations: z.array(
      z.object({ line: z.string(), stream: z.enum(["stdout", "stderr"]) }),
    ),
  }),
]);
type SharedCheckVerdict = z.infer<typeof SharedCheckVerdictSchema>;

export interface CheckFlightArgs {
  check: Check;
  /** The flight directory (`checkFlightDir()`), host-global like the cache. */
  dir: string;
  /** Everything the verdict is a function of: the cache key's three parts. */
  sig: string;
  treeHash: string;
  /** This run's id — what a joiner prints as `shared with run <id>`. */
  runId: string;
  wallStart: number;
  /** The check's observation buffer; an adopted failure's lines land in it. */
  observations: CheckObservation[];
  /** This check's gate slot, held on entry. */
  slot: GateSlot;
  /** The ordinary cache lookup: the hit's outcome, or null on a miss. */
  lookup: () => Promise<CheckOutcome | null>;
  /**
   * The miss path: run the body and record a pass in the cache. A throw (a
   * crashed check) propagates and publishes nothing.
   */
  run: () => Promise<CheckOutcome>;
  /** This check started waiting on another run's flight (`null`: a leader that has not recorded itself yet). */
  onJoin: (leaderId: string | null) => void;
  /** The wait ended: `adopted` — the leader's verdict was taken. */
  onJoinEnd: (adopted: boolean) => void;
}

/**
 * A cache MISS, run at most once across every concurrent check run on the
 * host that asks for the same `(check, sig, treeHash)`. Called with the gate
 * slot held, after the caller's own lookup missed.
 *
 * **Leading** (the key is free): run the body holding the slot, and publish a
 * pass (`{kind:"pass"}`, after the body's own cache record) or a fatal failure
 * (`{kind:"fail", result, observations}`). An inconclusive result, or a body
 * that throws, publishes nothing — a joiner then runs the check itself.
 *
 * **Joining** (another run is in it): the slot is RELEASED for the wait, so
 * this run's other checks keep going, and re-taken only when there is work to
 * do. An adopted pass re-enters the cache lookup and returns that hit; should
 * it miss (the input-keyed read-set slot is not tree-keyed, so another tree's
 * record can replace it), the body runs — a pass is never fabricated. An
 * adopted failure returns the leader's result and observations. A joiner that
 * cannot adopt wakes holding the flight lock (the primitive keeps it, so no
 * third run barges in), re-takes its slot, and leads.
 *
 * **Why this cannot deadlock, at any `--jobs`.** A check never holds its slot
 * while it waits on a flight — it lets go before the wait begins. So every
 * slot holder is doing something that ends without waiting on a flight or a
 * slot: its cache lookup, its body, or the step that releases the slot to
 * join. A joiner that wakes holding a flight lock and queues for its slot is
 * therefore waiting on work that finishes, and every flight lock is held by a
 * check that runs its body or is about to. Holding the slot through the wait
 * would also be cycle-free, but it would park a `--jobs 1` run behind
 * another run's check for the whole of that check.
 *
 * **Grants.** A leader's body runs on its own run's host grant, acquired
 * before `runChecks` was called (or inherited from the parent build), and
 * `grant.run` only divides those units in-process. So a leader is never
 * queued for host admission, and a joiner holding its own grant through the
 * wait cannot be what a leader waits on — the cycle `withDirectOp`'s nested
 * `tryLead` guards against does not exist one level down.
 */
export async function runCheckFlight(
  args: CheckFlightArgs,
): Promise<CheckOutcome> {
  let joined = false;
  const flight = await singleFlight<SharedCheckVerdict, CheckOutcome>(
    {
      dir: args.dir,
      key: JSON.stringify({
        v: 1,
        checkId: args.check.id,
        sig: args.sig,
        treeHash: args.treeHash,
      }),
      id: args.runId,
      schema: SharedCheckVerdictSchema,
      adoptable: (v) => v.kind === "pass" || v.result.inconclusive !== true,
      onJoin: (leader) => {
        joined = true;
        args.slot.release();
        args.onJoin(leader?.id ?? null);
      },
    },
    async (publish) => {
      if (joined) {
        // The leader published nothing adoptable (it died, threw, or came
        // back inconclusive): run it ourselves, with our slot back.
        args.onJoinEnd(false);
        await args.slot.acquire();
      }
      const outcome = await args.run();
      if (outcome.result.ok) publish({ kind: "pass" });
      else if (!outcome.result.inconclusive)
        publish({
          kind: "fail",
          result: outcome.result,
          observations: outcome.observations,
        });
      return outcome;
    },
  );
  if (flight.role === "led") return flight.result;

  args.onJoinEnd(true);
  const sharedFrom = flight.leader.id;
  const { verdict } = flight;
  if (verdict.kind === "fail") {
    args.observations.push(...verdict.observations);
    const result: CheckResult = {
      ok: false,
      message: verdict.result.message,
      ...(verdict.result.hint !== undefined
        ? { hint: verdict.result.hint }
        : {}),
    };
    return {
      check: args.check,
      result,
      durationMs: Math.round(performance.now() - args.wallStart),
      wallStart: args.wallStart,
      cached: false,
      sharedFrom,
      observations: args.observations,
    };
  }
  await args.slot.acquire();
  const hit = await args.lookup();
  if (hit !== null) return { ...hit, sharedFrom };
  return await args.run();
}
