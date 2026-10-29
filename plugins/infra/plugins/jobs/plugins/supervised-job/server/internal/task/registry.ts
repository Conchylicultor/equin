import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import type { z } from "zod";
import type { Registration } from "@plugins/framework/plugins/server-core/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import type { HostPoolId } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import {
  SUPERVISED_EXEC_COMMAND,
  type SupervisedTaskInvocation,
} from "../../../core";

/**
 * A task id: lowercase, dot-separated, the same shape a job name has
 * (`backup.run`). It travels on a command line and appears in a transcript, so
 * it is kept to characters that need no quoting and read the same everywhere.
 *
 * Validated at DEFINITION, not at registration: a malformed id is a coding
 * error, and throwing at module eval names the file that wrote it.
 */
const TASK_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/**
 * A registered task with its payload type erased — what the registry holds and
 * what the `supervised-exec` command resolves an id to.
 *
 * `execute` is ONE method rather than an exposed schema plus a `run`, so the
 * CLI cannot parse against the wrong schema, run without parsing, or run a
 * value the schema rejected. The only thing a caller holding this can do with
 * untrusted JSON is the correct thing.
 */
export interface RegisteredSupervisedTask extends Registration {
  readonly id: string;
  /**
   * Parse `raw` against this task's payload schema and run the body.
   *
   * Throws — a `ZodError` naming the offending path — when the payload does not
   * decode. That is the right outcome in a child: the argv it was spawned with
   * is wrong, and the run should fail loudly rather than proceed on a guess.
   */
  execute(raw: unknown): Promise<void>;
}

/**
 * A declared task, as its own plugin holds it: the erased half the registry
 * uses, plus the typed way to ask for a child that runs it.
 */
export interface SupervisedTask<
  P extends z.ZodType,
> extends RegisteredSupervisedTask {
  /**
   * The child command that runs this task with `payload`.
   *
   * `defineSupervisedJob` calls this for a `run` body's child. The payload is
   * checked against this task's own schema HERE, at the call site that knows
   * both.
   *
   * `z.input` rather than `z.infer`: what is written here is serialized to JSON
   * and parsed in the child, so a schema with `.default()` or `.transform()`
   * legitimately takes less than it produces.
   */
  invoke(payload: z.input<P>): SupervisedTaskInvocation;
}

export interface DefineSupervisedTaskSpec<P extends z.ZodType> {
  /** Stable identity — the id the `supervised-exec` argv names. */
  id: string;
  /**
   * Schema for the value that crosses the process boundary.
   *
   * It is JSON on a command line by the time the child sees it, so keep it
   * small: an id, a trigger, a flag. Anything large belongs in the database the
   * child is about to open anyway.
   */
  payload: P;
  /** The work. An ordinary async function, run in a booted `exec` runtime. */
  run(payload: z.infer<P>): Promise<void>;
  /**
   * The host pool the child waits on BEFORE it boots, holding the slot until
   * it exits (`--admit <pool>`, see `cli/run.ts`). Bounds how many of these
   * children are booted at once, host-wide — and so the database connections
   * and memory a booted graph costs — while a queued child costs nothing but
   * an idle process. Absent, the child boots at once.
   */
  admission?: HostPoolId;
}

const tasks = new Map<string, RegisteredSupervisedTask>();

/**
 * Register a body that runs OUT OF PROCESS under an id.
 *
 * Internal: the only caller is `defineSupervisedJob`, which registers one task
 * per `run`-body job under the JOB NAME (`run-body.ts`). `./equin
 * supervised-exec <id> <payloadJson>` boots the plugin graph in `exec` mode —
 * load waves, `register`, `collectContributions`, `onReadyBlocking`, and nothing
 * else — resolves the id here, and calls `run`. So the body sees the same
 * contributions, the same config registry and the same database the backend
 * does, and none of the machinery a short-lived process must not start (see
 * `server-core`'s "Boot modes").
 *
 * A `register:` token rather than a side effect at module eval, and for the
 * reason the CLI depends on: the framework runs every plugin's register phase to
 * completion before anything else, so by the time `supervised-exec` looks up an
 * id the registry is complete — a miss is genuinely a miss, never a module that
 * had not been reached yet.
 */
export function defineSupervisedTask<P extends z.ZodType>(
  spec: DefineSupervisedTaskSpec<P>,
): SupervisedTask<P> {
  if (!TASK_ID_RE.test(spec.id)) {
    throw new Error(
      `[supervised-task] invalid task id ${JSON.stringify(spec.id)} — expected ` +
        `lowercase alphanumeric segments separated by "." or "-" (e.g. "backup.run").`,
    );
  }
  const task: SupervisedTask<P> = {
    id: spec.id,
    execute: async (raw) => {
      await spec.run(spec.payload.parse(raw) as z.infer<P>);
    },
    invoke: (payload) => ({
      taskId: spec.id,
      // The payload travels as ONE argv word. The shim runs `"$@"`, so the
      // words it was handed are the words the command gets — there is no shell
      // to re-split or expand them, whatever JSON puts in there.
      argv: [
        `./${CLI_NAME}`,
        SUPERVISED_EXEC_COMMAND,
        spec.id,
        JSON.stringify(payload),
        // The child's runtime namespace, stated rather than inherited. THIS
        // backend is the only process that knows which namespace the work
        // belongs to — a composition backend runs out of main's checkout, so
        // the child's own cwd cannot answer it.
        "--namespace",
        runtimeNamespace(),
        ...(spec.admission === undefined ? [] : ["--admit", spec.admission]),
      ],
      // `./equin` is a path relative to the checkout root, and the
      // backend's own cwd is its `server-core` directory.
      cwd: REPO_ROOT,
    }),
    _kind: "supervised-task",
    _factory: "defineSupervisedTask",
    _doc: { label: spec.id },
    register() {
      const existing = tasks.get(spec.id);
      if (existing !== undefined && existing !== task) {
        throw new Error(
          `[supervised-task] duplicate task id: ${spec.id} — an id is what a ` +
            `child argv names, so two tasks sharing one would each be able to ` +
            `run in the other's place.`,
        );
      }
      tasks.set(spec.id, task);
    },
  };
  return task;
}

/**
 * The task registered under `id`, or undefined.
 *
 * The caller is `supervised-exec`, whose whole job is turning a string off a
 * command line into a body to run — so this answers with `undefined` rather
 * than throwing, and the command raises the error that names the ids that DO
 * exist (see {@link getSupervisedTaskIds}).
 */
export function getSupervisedTask(
  id: string,
): RegisteredSupervisedTask | undefined {
  return tasks.get(id);
}

/** Every registered task id, sorted — for the unknown-id error message. */
export function getSupervisedTaskIds(): string[] {
  return [...tasks.keys()].sort();
}
