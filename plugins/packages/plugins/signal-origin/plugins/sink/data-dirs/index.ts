import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The signal-origin record family: `signal-origin.jsonl` plus the two rotations
 * `defineFileSink` keeps beside it.
 *
 * A directory rather than three loose files at the root, because the rotations
 * ARE the history — and here that matters more than usual: for `check` and
 * `push`, which own no receipt anywhere else, this file is the ONLY record that
 * an op was killed and by whom, so a reader that stops at the last rotation
 * loses the incident outright.
 *
 * Declared by the sink rather than by the parent plugin: the parent's `core/` is
 * its FFI-free, web-safe half (`build/build-termination/core` imports it), and a
 * data-dir declaration reaches `paths/core`, which calls `homedir()` at module
 * scope. The sink's `core/` is already runtime-neutral Node for exactly that
 * reason, so the declaration belongs beside the writer.
 */
export const signalOriginLogDir = defineDataDir({
  kind: "logs",
  name: "signal-origin",
  owner: "packages/signal-origin/sink",
  description:
    "The host-global record of who killed an op (`signal-origin.jsonl` + rotations): one JSONL line per signal received or arm failure, keyed by op run id",
  // Observability output. It is the only record for check/push kills, but it is
  // a record of the PAST — nothing running reads it, so dropping it costs
  // history and never correctness.
  reclaim: { kind: "safe" },
  logs: [{ pattern: "signal-origin.jsonl", bound: { kind: "file-sink" } }],
});

export default [signalOriginLogDir];
