import type { Registration } from "@plugins/framework/plugins/server-core/core";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import type { RefAdvancedPayload } from "../../shared/types";

/**
 * An IN-PROCESS reaction to a ref advance, run by the watcher itself.
 *
 * This plugin now offers two signals for the same advance, and picking the wrong
 * one is a real bug class:
 *
 * - `refAdvanced` is the DURABLE signal. It emits a trigger event, which enqueues
 *   a job, which runs in the backend's shared graphile pool. Use it for work that
 *   must survive a crash, may be slow, or wants retries. It is also `isMain()`-
 *   gated: the event only ever exists in the main backend's database.
 * - A REACTION is the in-process signal. It runs on the watcher's own callback,
 *   in EVERY backend, with nothing between the ref moving and the reaction
 *   running. Use it for a cheap, idempotent refresh whose correctness is
 *   independently guaranteed by an on-read fallback — and which therefore must
 *   not be able to queue behind unrelated work.
 *
 * A reaction that needs durability is a job in disguise: it has no retry, no
 * persistence, and it is skipped entirely while the backend is down. The pushes
 * ledger qualifies because `ensurePushLedgerFresh()` re-derives it on read and at
 * boot, so a missed reaction costs latency, never correctness.
 *
 * A reaction that throws is reported (never swallowed) and does not stop its
 * siblings or the durable emit — again, because the pull path is what makes the
 * push path optional.
 */
export interface RefReactionSpec {
  /** Stable id → profiler span + error attribution. Must be unique. */
  name: string;
  /** The ref this reacts to, e.g. `refs/heads/main`. */
  refName: string;
  /** Awaited by the watcher before it emits `refAdvanced`. */
  run: (advance: RefAdvancedPayload) => Promise<void>;
}

// Module-load-time registry, populated by `defineRefReaction(...).register()`
// during the framework's register phase — mirroring `defineJob` / `defineWarmup`.
const refReactionRegistry = new Map<string, RefReactionSpec>();

/**
 * Declare an in-process ref-advance reaction. Returns a {@link Registration} that
 * side-effects into the registry at `register()` time. Mount it via
 * `register: [<the returned token>]` on the consumer plugin's definition.
 */
export function defineRefReaction(spec: RefReactionSpec): Registration {
  return {
    _kind: "ref-reaction",
    _factory: "defineRefReaction",
    _doc: { label: `${spec.name} (${spec.refName})` },
    register() {
      if (refReactionRegistry.has(spec.name)) {
        throw new Error(`[git-watcher] duplicate ref reaction: ${spec.name}`);
      }
      refReactionRegistry.set(spec.name, spec);
    },
  };
}

/** The registered reactions. The watcher's default input; a test passes its own. */
export function getRefReactions(): RefReactionSpec[] {
  return [...refReactionRegistry.values()];
}

/**
 * Run every reaction registered for this ref, in registration order, awaited.
 *
 * Sequential rather than concurrent: reactions are cheap by contract, and one at
 * a time keeps a burst of advances from multiplying host git/DB load. A throw is
 * reported and the loop continues — one broken reaction must not silence the
 * others or block the durable emit that follows.
 *
 * `reactions` is a parameter (defaulted to the registry) so the behaviour is
 * exercisable without writing to module-global state — the same shape
 * warm-up executor's `drainWarmupsWith` uses.
 */
export async function runRefReactions(
  advance: RefAdvancedPayload,
  reactions: RefReactionSpec[] = getRefReactions(),
): Promise<void> {
  for (const reaction of reactions) {
    if (reaction.refName !== advance.refName) continue;
    try {
      await runTracked(`ref-reaction:${reaction.name}`, () =>
        reaction.run(advance),
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      reportServerError({
        message: `[git-watcher] ref reaction ${reaction.name} failed on ${advance.refName}: ${error.message}`,
        stack: error.stack,
        errorType: error.name,
      });
    }
  }
}
