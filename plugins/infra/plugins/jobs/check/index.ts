import type { Check } from "@plugins/framework/plugins/tooling/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

// The one file allowed to insert a `jobs.run` row is `machine/internal/graphile-queue.ts`;
// everything else goes through `job.enqueue(...)`, which routes there. The one
// file that may SPELL a graphile task identifier is the class table
// (`core/hold.ts`). Both are exempted in the jobs plugin's own manifest.
const INSERT = "jobs:no-raw-addjob";
const TASK_LITERAL = "jobs:no-raw-addjob:task-literal";

// Why this exists rather than a comment saying "remember to pass the queue name".
//
// A job declaring `serial` (see registry.ts `SerialSpec`) is serialized by
// graphile's `queue_name`, and graphile refuses to FETCH a job whose queue is
// busy — that is what makes waiting free, and what stops one wedged job from
// costing more than one worker slot. But the guarantee is carried by the row: an
// insertion that omits the queue name produces a row with `job_queue_id IS NULL`,
// which graphile fetches regardless of who else is running. One forgetful call
// site silently un-serializes that path, with no type error, no runtime error,
// and no symptom until two of them run at once.
//
// So the queue name is derived from the registered job inside the desktop queue
// (`queueNameFor` / `graphileSpecFor`, `machine/internal/graphile-routing.ts`) and is never a caller argument — and this
// check keeps that true by making the alternative unspellable: `utils.addJob(`
// and `graphile_worker.add_job` exist in exactly one file. There were five
// insertion sites when `serial` landed (two in `registry.ts`, `resume-job.ts`'s
// target re-enqueue, and `worker.ts`'s `scheduleResume` + cron items); the point
// of the check is that a sixth cannot be added without noticing.
//
// ── The same argument, one field later: the task identifier ────────────────
//
// A row's graphile task identifier is now the other half of that same "property
// of the registered job, never a caller argument" rule. Since hold classes
// landed there is one task per class (`jobs.run.instant` / `.seconds` /
// `.minutes`), derived by `taskFor(job.hold)`, and each is served by a different
// subset of the three runners — that partition at FETCH is the whole reservation
// mechanism. `"jobs.run"` is the pre-class legacy identifier, kept registered on
// the widest runner forever so no row can strand on a task nobody serves.
//
// So a hand-typed `"jobs.run"` anywhere else is a row that silently lands in the
// widest tier and escapes its class's reservation — no type error, no runtime
// error, and no symptom beyond latency nobody attributes to it. The literal is
// therefore confined to `core/hold.ts`, which declares it as `LEGACY_JOB_TASK`;
// everything else imports that name and gets a tsc error when it is wrong.
const check: Check = {
  id: "jobs:no-raw-addjob",
  description:
    "Only the jobs plugin's graphile queue (machine/internal/graphile-queue.ts) may insert graphile rows (`utils.addJob` / `graphile_worker.add_job`), so every enqueue carries the job's serialization queue and its hold class's task identifier — which only `core/hold.ts` may spell",
  exemptable: {
    [INSERT]:
      "inserts a graphile row by hand (`utils.addJob` / `graphile_worker.add_job`), bypassing the job's serialization queue and hold-class task",
    [TASK_LITERAL]:
      'spells the legacy `"jobs.run"` task identifier instead of importing `LEGACY_JOB_TASK`',
  },
  async run(ctx) {
    const root = await getWorktreeRoot();
    const insertExempt = await ctx.exempt(INSERT);
    const taskExempt = await ctx.exempt(TASK_LITERAL);

    // Two greps because the tokens live in different lexical contexts.
    // `utils.addJob(` is code, so string literals are masked as well as comments
    // — a doc comment mentioning it must not fail the build. The SQL call
    // legitimately lives INSIDE a string (that is the only way to write it), so
    // strings must stay visible for it; comments are masked either way.
    const jsMatches = await grepCode({
      root,
      pattern: /\.addJob\(/,
      grepArg: ".addJob(",
      fixed: true,
      maskStrings: true,
      pathspecs: ["*.ts"],
    });
    const sqlMatches = await grepCode({
      root,
      pattern: /graphile_worker\.add_job/,
      grepArg: "graphile_worker.add_job",
      fixed: true,
      maskStrings: false,
      pathspecs: ["*.ts"],
    });

    // The third token is a bare string literal, so strings must stay visible
    // (as for the SQL call) and the quotes are part of the pattern — that is
    // what keeps `"jobs.run.instant"` and friends, which are the CLASS tasks
    // `hold.ts` composes, from matching. Comments are masked either way, so the
    // paragraphs above naming it do not trip their own check.
    const taskLiteralMatches = await grepCode({
      root,
      pattern: /["'`]jobs\.run["'`]/,
      grepArg: "jobs.run",
      fixed: true,
      maskStrings: false,
      pathspecs: ["*.ts"],
    });

    const insertOffenders = [...jsMatches, ...sqlMatches]
      .filter((m) => !insertExempt.skips(m.path))
      .map((m) => `${m.path}:${m.line}:${m.text.trim()}`)
      .sort();

    const taskOffenders = taskLiteralMatches
      .filter((m) => !taskExempt.skips(m.path))
      .map((m) => `${m.path}:${m.line}:${m.text.trim()}`)
      .sort();

    if (insertOffenders.length === 0 && taskOffenders.length === 0)
      return { ok: true };

    const messages: string[] = [];
    const hints: string[] = [];
    if (insertOffenders.length > 0) {
      messages.push(
        `${insertOffenders.length} graphile job insertion(s) outside plugins/infra/plugins/jobs/machine/internal/graphile-queue.ts:\n    ${insertOffenders.join("\n    ")}`,
      );
      hints.push(
        `Enqueue through the registered job — \`job.enqueue(input, opts)\` — or, inside the jobs plugin, build the spec with \`graphileSpecFor(job, …)\` from plugins/infra/plugins/jobs/machine/internal/graphile-routing.ts. A hand-written addJob omits the job's \`serial\` queue name, so that one path escapes serialization silently.`,
      );
    }
    if (taskOffenders.length > 0) {
      messages.push(
        `${taskOffenders.length} hand-typed \`jobs.run\` task identifier(s) outside plugins/infra/plugins/jobs/core/hold.ts:\n    ${taskOffenders.join("\n    ")}`,
      );
      hints.push(
        `Import \`LEGACY_JOB_TASK\` from the jobs barrel instead. A row's task identifier is a property of the registered job — \`taskFor(job.hold)\` — and each class's task is served by a different set of runners; a hand-typed \`jobs.run\` lands the row in the widest tier, escaping its class's reserved slots with no type error and no symptom.`,
      );
    }

    return {
      ok: false,
      message: messages.join("\n\n  "),
      hint: hints.join("\n\n"),
    };
  },
};

export default check;
