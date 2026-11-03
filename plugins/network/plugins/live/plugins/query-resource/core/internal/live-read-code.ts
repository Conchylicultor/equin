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
 */
export const liveReadCode = defineSourceSet(
  "the code that shapes a compiled collection's rows (the epoch handoff, the L2 snapshot)",
);
