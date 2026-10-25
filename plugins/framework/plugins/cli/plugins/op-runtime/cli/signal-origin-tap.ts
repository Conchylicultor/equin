import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { ensureDep, type Ready } from "@plugins/infra/plugins/deps/deps";
import type { BuildSource } from "@plugins/infra/plugins/deps/plugins/build/deps";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import {
  armSignalOrigin,
  readSignalOrigin,
  signalOriginDisabled,
} from "@plugins/packages/plugins/signal-origin/server";
import type { SignalOrigin } from "@plugins/packages/plugins/signal-origin/core";
import { signalOriginShim } from "@plugins/packages/plugins/signal-origin/deps";
import {
  FATAL_SIGNAL_EXITS,
  signoOf,
  type FatalSignal,
  type FatalSignalExitOptions,
} from "./fatal-signals";
import { recordSignalOriginLine } from "./signal-origin-log";

export interface SignalOriginTapOptions {
  /**
   * What names this op in the sink — `build_runs.id` for a build, the push id
   * for a push, the check's own run id for a check. Must be unique per run: it
   * is the only key a reader has to find the lines of one death.
   */
  opId: string;
  /** The worktree the op is running in, for a human reading the sink. */
  worktree: string;
  /**
   * Anything the command wants to do with the death BEYOND the sink line, on
   * the same synchronous death path — `build` stamps its receipt and builds the
   * termination its verdict guard prints. Runs after the line is written, so a
   * throw here can never cost the durable record.
   */
  onSignal?: (signal: FatalSignal, origin: SignalOrigin | null) => void;
}

/** The shim to arm from, or why there is none (recorded as the `arm-failed` line). */
type Shim =
  | { kind: "ready"; ready: Ready<BuildSource> }
  | { kind: "unavailable"; reason: string };

/**
 * Ensure the tap's compiled shim (the `signal-origin-shim` dependency). Fast
 * path: its identity (source hash, `cc --version`) and one `ready.json` read.
 * Cold: one compile of one C file, taking no host grant — the declaration
 * says `admission: { none }`, because this runs on the way INTO an op that
 * has not asked for its own grant yet.
 *
 * Fails open: an install that fails (no compiler, a compile error) is kept on
 * the record by the engine as the dependency's `failed` state and returned
 * here as the reason the arm will record — never thrown, since an op must not
 * stop because its death could not be attributed.
 */
async function ensureShim(): Promise<Shim> {
  if (signalOriginDisabled()) {
    return {
      kind: "unavailable",
      reason: `disabled by ${envName("NO_SIGNAL_ORIGIN")}=1`,
    };
  }
  try {
    return {
      kind: "ready",
      ready: await ensureDep(signalOriginShim, cliExecContext()),
    };
  } catch (err) {
    return {
      kind: "unavailable",
      reason: `${signalOriginShim.id} could not be installed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The signal-origin tap expressed once, as the hook pair `installFatalSignalExit`
 * takes. `build`, `check` and `push` all await this and differ only in what
 * their own `onSignal` does with the origin.
 *
 * Async because the tap's shim is a dependency (`signal-origin-shim`, a
 * `build` kind): it is ensured here, BEFORE the listeners are installed, so the
 * arm itself stays the synchronous call `afterInstall` needs.
 *
 * Both halves are load-bearing:
 *
 * - `afterInstall` is where the native SA_SIGINFO tap arms, and it may not move.
 *   **Bun installs its own `sigaction` lazily on the first `process.on(sig)` and
 *   does NOT chain**, so a tap armed before that loop is silently overwritten
 *   and never fires. `afterInstall` is the seam that guarantees the order; see
 *   its docblock in fatal-signals.ts.
 * - `onSignal` reads the slot the tap filled — by then the native handler has
 *   already run (it sits underneath Bun's own and chains up to it), so the read
 *   is the sender's identity rather than a guess — and writes the sink line.
 *
 * An arm failure — including a shim that could not be installed — is recorded
 * rather than printed. A banner on every op on a machine without a C toolchain
 * would be noise in exactly the transcript this feature exists to keep
 * readable; the sink is where the absence goes on the record (and a failed
 * install is also `failed` in `./equin deps list` / Settings →
 * Dependencies), so a later unattributed death is explainable rather than
 * mysterious. `origin: null` on a `signal` line means the same thing from the
 * other side: "we looked and could not see", never "nobody sent a signal".
 */
export async function signalOriginTap(
  options: SignalOriginTapOptions,
): Promise<FatalSignalExitOptions> {
  const { opId, worktree } = options;
  const shim = await ensureShim();
  return {
    onSignal: (signal, exitCode) => {
      const origin = readSignalOrigin(signoOf(exitCode));
      recordSignalOriginLine({
        event: "signal",
        buildId: opId,
        worktree,
        signal,
        origin,
      });
      options.onSignal?.(signal, origin);
    },
    afterInstall: () => {
      const armed =
        shim.kind === "ready"
          ? armSignalOrigin(
              shim.ready,
              FATAL_SIGNAL_EXITS.map(([, code]) => signoOf(code)),
            )
          : { armed: false as const, reason: shim.reason };
      if (!armed.armed) {
        recordSignalOriginLine({
          event: "arm-failed",
          buildId: opId,
          worktree,
          reason: armed.reason,
        });
      }
    },
  };
}
