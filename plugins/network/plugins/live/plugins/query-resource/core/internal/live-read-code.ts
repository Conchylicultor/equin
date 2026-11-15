import { defineSourceSet } from "@plugins/packages/plugins/source-digest/core";

/**
 * The code that shapes what a compiled collection read produces beyond what
 * its definition pins (the rendered SQL, decoder ids, row schema, bounds, the
 * encode-row id): the compilers and their loaders, the decoders, the row
 * encode and `$columns` fold. Two things outlive the process that served a
 * value and are refused under another digest of this set, with no version
 * constant to bump:
 *
 * - the epoch handoff (a `:rows` tuple inherited across a restart);
 * - the L2 snapshot (a persisted `all` set's value, read back at boot).
 *
 * Both are judged in network/live/live-state-snapshot. Each module that is part of
 * the set includes itself (`include(import.meta)`): query-resource's
 * `compile-window.ts` (window / point) and `compile-alias.ts` (`all`), with
 * everything they load, and network/live's `encode-row.ts` (the row encode and
 * fold `serveCollection` and the `all` arm use).
 *
 * **The resource runtime and the wire protocol are deliberately outside the
 * set.** The compilers' `routes.ts` imports only the runtime's `routing` leaf
 * (`resource-runtime/plugins/routing`, which imports nothing), never the
 * runtime barrel, and `compile-alias.ts` throws its params-gate refusal
 * through `CompileHost.contractError` instead of importing resource-protocol.
 * That is sound because neither shapes a row of what either survivor carries
 * (a refused params tuple has no rows at all):
 *
 * - A handoff record carries no rows: per tuple only its key, params, version
 *   and definition (`HandoffTuple`). It vouches that a client echoing
 *   `(epoch, version)` holds what the old loader produced at the cut; only
 *   routed point reads are inheritable (`inheritable`: no derive, relation
 *   read, hook, revalidate, upstream or follow — nothing the runtime computes
 *   into a value), so that value is the compiled loader's output, which this
 *   set covers. The rows the client holds were put there by frames whose
 *   encoding is the wire protocol's (resource-protocol), not the read's.
 * - The restart gap is re-proven by the SUCCESSOR: it replays the changelog
 *   since the cut through its own router and its own route plans
 *   (`ResumeRecord.replay`), so how changes are routed is always the new
 *   code's, whatever the old runtime did. The routes themselves (`routes.ts`,
 *   what a declaration's SQL reads) and the pure per-tuple decision
 *   (`routeTuple`, in the routing leaf) stay in the set all the same.
 * - An L2 `all` value is the loader's output as persisted; the runtime only
 *   stores and seeds it.
 *
 * So an edit to the runtime (delivery, admission, ledgers, the socket) cannot
 * make an inherited tuple's rows differ from a fresh load's; it no longer
 * moves the digest, nor makes the next restart reload every handed-over read.
 */
export const liveReadCode = defineSourceSet(
  "the code that shapes a compiled collection's rows (the epoch handoff, the L2 snapshot)",
);
