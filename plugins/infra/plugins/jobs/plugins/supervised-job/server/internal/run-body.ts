import { z } from "zod";
import { recordRunError } from "./builtin-ledger";
import {
  mintExecContext,
  type ExecContext,
} from "../../core/internal/exec-context";
import { admitBackground } from "./admit";
import { defineSupervisedTask, type SupervisedTask } from "./task/registry";

/** What a `run` body is handed in its child process. */
export interface SupervisedRunContext {
  /** This run's id — the ledger row, the transcript and the marker name. */
  readonly runId: string;
  /**
   * Write one line to the transcript. The child's stdout and stderr ARE the
   * transcript, which the parent tails into the job's `channel` — so one
   * process writes each log file, and a line logged here shows up live.
   * `stream` only chooses the fd; the transcript merges both.
   */
  readonly log: (line: string, stream?: "stdout" | "stderr") => void;
  /**
   * Proof this body runs in its own process, off every backend's event loop —
   * what a function doing long, blocking or heavy work (`ensureDep`) demands.
   */
  readonly exec: ExecContext;
}

/** The payload a `run` body's child receives, as one JSON argv word. */
const RUN_BODY_PAYLOAD = z.object({
  runId: z.string(),
  attempt: z.number().int().positive(),
  // Parsed against the job's own input schema inside the child, below — the
  // value crossed a process boundary as JSON, so it is untrusted again.
  input: z.unknown(),
});

export type RunBodyTask = SupervisedTask<typeof RUN_BODY_PAYLOAD>;

function log(line: string, stream: "stdout" | "stderr" = "stdout"): void {
  process[stream].write(line.endsWith("\n") ? line : `${line}\n`);
}

/**
 * The child half of a `run`-body supervised job: a task registered under the
 * JOB NAME, which `./equin supervised-exec <name> <payload>` resolves in a
 * booted `exec` runtime.
 *
 * `recordErrors` is true for the built-in ledger: a throwing body records
 * `error_message` and `retryable = !isNonRetryableError(err)` on its row before
 * the process exits 1, because that bit is what the parent's failure policy
 * cannot recover from an exit code. With a job's OWN ledger the throw simply
 * propagates — the body writes its own row, as it always has.
 *
 * The job's input is re-parsed from JSON against the job's own schema. A schema
 * whose `.transform()` is not idempotent fails here, loudly, rather than
 * running on a value it never accepted.
 */
export function defineRunBodyTask<S extends z.ZodType>(opts: {
  readonly name: string;
  readonly input: S;
  readonly run: (input: z.infer<S>, ctx: SupervisedRunContext) => Promise<void>;
  readonly recordErrors: boolean;
}): RunBodyTask {
  return defineSupervisedTask({
    id: opts.name,
    payload: RUN_BODY_PAYLOAD,
    run: async ({ runId, input }) => {
      const parsed: z.infer<S> = opts.input.parse(input);
      try {
        await opts.run(parsed, {
          runId,
          log,
          exec: mintExecContext("supervised-run", admitBackground),
        });
      } catch (err) {
        if (!opts.recordErrors) throw err;
        try {
          await recordRunError(runId, err);
        } catch (recordError) {
          throw new AggregateError(
            [err, recordError],
            `[supervised-job] ${opts.name}: run ${runId} failed AND its error could not be recorded.`,
          );
        }
        throw err;
      }
    },
  });
}
