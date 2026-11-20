import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { runExec } from "@plugins/framework/plugins/server-core/cli";
import type { ExecAdmission } from "@plugins/framework/plugins/server-core/core";
import {
  getSupervisedTask,
  getSupervisedTaskIds,
} from "../server/internal/task/registry";
import {
  admitThenBoot,
  parseAdmissionPool,
  supervisedChildExitCode,
} from "./internal/child-admission";

/**
 * `./equin supervised-exec <taskId> <payloadJson> --namespace <ns>`.
 *
 * The whole body sits inside `runExec`, which boots the plugin graph and never
 * returns: it exits 0 when the body resolves and 1 when anything in it throws,
 * running the shutdown hooks either way. The exit status is what the
 * supervising shim records into this run's marker, so a throw here IS how a
 * failed task reaches the ledger.
 *
 * **The lookup happens after boot, and it must.** The registry is populated by
 * each declaring plugin's `register:` token, which the boot's register phase
 * runs — so before boot every id is unknown and after it the set is complete.
 * There is no earlier point at which "unknown task" could be answered honestly.
 */
const run: CliAction<
  [string, string],
  { namespace: string; admit?: string; start?: string }
> = async (taskId, payloadJson, opts) => {
  // Validated here, at the process boundary where a string off a command line
  // becomes an identity: the namespace goes on to name a database and a
  // directory, so a malformed one must be loud rather than become a path.
  const namespace = asNamespace(opts.namespace);
  // The lists the job's body reads (its `read(List)` calls), as the build
  // derived them — loaded only for a partial start, never by a serving path.
  // A job missing from the table is a build that did not see it: loud.
  const reads =
    opts.start === undefined
      ? undefined
      : (await import("./job-reads.generated")).jobReads[taskId];
  if (opts.start !== undefined && reads === undefined) {
    throw new Error(
      `[supervised-exec] job ${JSON.stringify(taskId)} is not in the build's job-reads table (cli/job-reads.generated.ts): run \`./equin build\`.`,
    );
  }
  const pool =
    opts.admit === undefined ? undefined : parseAdmissionPool(opts.admit);
  const boot = (admission?: ExecAdmission) =>
    runExec(namespace, body, {
      // A database that refused the connection because it was full exits
      // EX_TEMPFAIL: the one failure this child cannot write on its row (that
      // row is in the database that refused it), so the status carries it.
      exitCodeFor: supervisedChildExitCode,
      // Given back while the boot only waits for its schema (`runExec`).
      ...(admission === undefined ? {} : { admission }),
      // Start the job's plugin and what it needs, not the whole app: the
      // contributors of each list its body reads, as the build derived them.
      // A complete list read anyway throws, naming the job and this fix.
      ...(opts.start === undefined || reads === undefined
        ? {}
        : {
            start: {
              root: opts.start,
              reads,
              label: `job ${taskId} (plugin ${opts.start})`,
              fix: (kind: string) =>
                `read the "${kind}" list in the run body of job ${taskId} with \`read(List)\` (the build derives the lists a job's child starts from those calls), ` +
                "or — if its entries are plain data — define it `data: true`, or — if each entry only matters to the plugin that contributed it — `partial: { reason }` (`defineServerContribution`).",
            },
          }),
    });
  // The job's admission pool, taken before anything boots (`--admit`). Its
  // lines go to stdout, which IS the run's transcript.
  await (pool === undefined
    ? boot()
    : admitThenBoot(pool, boot, (line) => {
        process.stdout.write(`${line}\n`);
      }));

  async function body(): Promise<void> {
    const task = getSupervisedTask(taskId);
    if (task === undefined) {
      // Loud, immediately, and naming the id. The alternative — returning
      // quietly — would exit 0, which the shim writes as a `0 -` marker and the
      // ledger records as a successful run that did nothing at all: a backup
      // that reports success and archived nothing.
      const known = getSupervisedTaskIds();
      throw new Error(
        `[supervised-exec] no task registered under ${JSON.stringify(taskId)}. ` +
          (known.length === 0
            ? "No tasks are registered in this composition at all — is the declaring plugin part of it?"
            : `Registered tasks: ${known.join(", ")}.`),
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(payloadJson);
    } catch (err) {
      throw new Error(
        `[supervised-exec] ${taskId}: payload is not valid JSON — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Parse and run in one call: the task owns its schema, so there is no way
    // from here to run a payload it did not accept.
    await task.execute(raw);
  }
};

export default run;
