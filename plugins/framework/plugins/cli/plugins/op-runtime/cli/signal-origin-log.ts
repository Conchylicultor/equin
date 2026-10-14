import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import {
  SIGNAL_ORIGIN_FILE,
  type SignalOriginLineInput,
} from "@plugins/packages/plugins/signal-origin/plugins/sink/core";

// The path and the line shape are DECLARED NEXT DOOR, in signal-origin/sink,
// not here — `bin/` is unreachable across plugin boundaries, so a backend that
// reads this file back could otherwise only re-derive the path and re-type the
// lines, leaving one record with two independent definitions. This file stays
// the sole WRITER; see that plugin's CLAUDE.md.

// The same explicit 2 MB × keep 2 bound build-progress chose, and for the same
// reason: defineFileSink's 128 MB default is a firehose budget sized for the
// live-state channel and absurd here. A line is written only when a catchable
// fatal signal actually arrives, so this retains years of real incidents.
const sink = defineFileSink({
  id: "signal-origin",
  description:
    "Who killed an op (`./singularity build|check|push`): one JSONL line per " +
    "catchable fatal signal, carrying the sender's pid/uid, executable path and " +
    "the ancestry captured inside the signal handler before the sender was " +
    "reaped — plus one line when the native tap could not be armed, so an " +
    "unattributed death is explainable rather than mysterious. Host-global.",
  consumer: {
    kind: "rendering-only",
    note: "Who killed an op (defineFileSink, cli/op-runtime signal-origin-log; CLI-only, host-global): one line per catchable fatal signal reaching build/check/push, plus arm failures. Read by build/build-termination's endpoint and shown as the termination detail on a build run (build-info). The durable 'this build died' fact is the build run's own outcome; this names the sender.",
  },
  path: SIGNAL_ORIGIN_FILE,
  maxBytes: 2 * 1024 * 1024,
  keep: 2,
});

/**
 * Append one line. Synchronous by contract: every caller is on a death path —
 * inside a signal listener, or an exit hook — where nothing can be awaited.
 *
 * Never throws. This runs while the process is already dying, and a sink that
 * turned a clean termination into an unhandled rejection would destroy the very
 * record it exists to write. The bounded-append primitive underneath is the one
 * sanctioned home for the rotation, so the growth bound stays true by
 * construction rather than by this caller's good behaviour.
 */
export function recordSignalOriginLine(line: SignalOriginLineInput): void {
  try {
    sink.append(JSON.stringify({ at: new Date().toISOString(), ...line }));
    // eslint-disable-next-line promise-safety/no-bare-catch -- runs on the death path (signal listener / exit hook); a throw here would replace the incident record with a second, less useful failure. There is no recovery to attempt and nothing left to report to.
  } catch {
    // Intentionally swallowed — see above.
  }
}
