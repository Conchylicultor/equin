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
  { namespace: string; admit?: string; start?: string; reads?: string }
> = async (taskId, payloadJson, opts) => {
  // Validated here, at the process boundary where a string off a command line
  // becomes an identity: the namespace goes on to name a database and a
  // directory, so a malformed one must be loud rather than become a path.
  const namespace = asNamespace(opts.namespace);
  if (opts.reads !== undefined && opts.start === undefined) {
    throw new Error(
      "[supervised-exec] --reads names the lists a partial start reads, and only means something with --start <pluginPath>.",
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
      // The job declared what it reads: start its plugin and what it needs,
      // not the whole app. A complete list it did not declare throws when
      // read, naming the job and this fix.
      ...(opts.start === undefined
        ? {}
        : {
            start: {
              root: opts.start,
              reads:
                opts.reads === undefined || opts.reads === ""
                  ? []
                  : opts.reads.split(","),
              label: `job ${taskId} (plugin ${opts.start})`,
              fix: (kind: string) =>
                `add the "${kind}" list to the \`reads\` of job ${taskId} (\`defineSupervisedJob\`), or — if each entry only matters to the plugin that contributed it — declare the list \`partial: { reason }\` (\`defineServerContribution\`).`,
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
