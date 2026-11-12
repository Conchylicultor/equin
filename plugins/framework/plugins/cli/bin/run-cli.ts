import type { Command } from "commander";
import {
  claimRunErrorFile,
  recordCliCrash,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";

/**
 * Process-boundary harness for the CLI. Commander's async actions reject
 * instead of exiting non-zero, so a thrown action must be translated into a
 * non-zero exit here — otherwise callers keying on the exit code read a failed
 * build/push/check as success. Fails loudly: prints the error and sets a
 * non-zero exit code.
 *
 * The error is also RECORDED, not just printed. stdout/stderr belong to whoever
 * spawned the CLI — for an auto-build that is a backend that streams them to a
 * log channel and is itself restarted moments later — so a printed-only error is
 * routinely the one copy nobody can find afterwards. The record is what lets the
 * build's exit-time verdict name its own cause in `build.log`; see ./cli-crash.ts.
 */
export async function runCli(
  program: Command,
  argv?: readonly string[],
): Promise<void> {
  claimRunErrorFile();
  try {
    await program.parseAsync(argv as string[]);
  } catch (err) {
    // Printed and the exit code set FIRST: recording can itself fail (a write
    // to the run's error file), and must not cost the error its one sure copy.
    console.error(err);
    process.exitCode = 1;
    recordCliCrash(err);
  }
}
