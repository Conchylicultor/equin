import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import {
  addTaskDependency,
  createTask,
  getConversation,
  getTask,
  withTaskStatusBatch,
} from "@plugins/tasks/plugins/tasks-core/server";
import { withNotifyBatch } from "@plugins/framework/plugins/server-core/core";
import {
  DEFAULT_MODEL_CHOICE,
  ModelChoiceSchema,
  SELECTABLE_FAMILIES,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { inheritLaunchOptions } from "@plugins/tasks/plugins/launch-options/server";
import { TaskTrackSchema } from "@plugins/tasks/plugins/task-track/core";
import { setTaskTrack } from "@plugins/tasks/plugins/task-track/server";
import {
  granted,
  grantOf,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
  TaskFilingStartSchema,
  tasksFile,
} from "@plugins/tasks/plugins/tasks-core/core";
import { armTaskAutoStart } from "../../server/internal/arm-auto-start";
import { rewireDependencies } from "../../server/internal/rewire-dependencies";
import {
  describeFilingGrant,
  fileAddTask,
  type AddTaskPorts,
} from "./add-task-filing";
import { digestFor } from "./tree-digest";
import { watchTask } from "@plugins/tasks/plugins/orchestration/plugins/watch/server";
import { watchChildren } from "@plugins/tasks/plugins/orchestration/plugins/watch/core";

// The real mutations behind `add_task`. The filing policy lives in
// add-task-filing.ts, which a test drives over an in-memory store.
const ports: AddTaskPorts = {
  grant: (conversationId) => grantOf(tasksFile, conversationId),
  getConversation,
  getTask,
  createTask: (input) => createTask(input),
  inheritLaunchOptions,
  rewire: (opts) => withNotifyBatch(() => rewireDependencies(opts)),
  addDependencies: (taskId, dependsOnIds) =>
    withNotifyBatch(() =>
      withTaskStatusBatch(async (tx) => {
        for (const id of dependsOnIds) await addTaskDependency(taskId, id, tx);
      }),
    ),
  armAutoStart: armTaskAutoStart,
  setTrack: (taskId, track) => setTaskTrack(taskId, track),
  watchesChildren: async (conversationId) =>
    (await grantOf(watchChildren, conversationId)) !== null,
  watch: async (taskId, conversationId) => {
    await watchTask(taskId, { kind: "conversation", conversationId });
  },
  modelCatalog: getModelCatalog,
};

// Named from the code's family set, so a family added there is offered here
// with no edit; versions are never listed (they are runtime data).
const FAMILIES = SELECTABLE_FAMILIES.map((f) => `"${f}"`).join(", ");

export const addTaskTool = Mcp.tool({
  name: "add_task",
  // Only an agent whose mandate lets it file tasks sees the tool.
  when: granted(tasksFile),
  // Which tracks and start modes THIS caller's mandate allows.
  liveDescription: async ({ conversationId }) => {
    const grant = await grantOf(tasksFile, conversationId);
    return grant === null
      ? null
      : `## Your mandate allows\n\n${describeFilingGrant(grant)}. Any other track or start mode is refused.`;
  },
  description: `Add a task to the equin task tree.

Task titles and descriptions should state the PROBLEM or ISSUE to solve —
not instructions on how to solve it, and no hints or suggestions either.
The agent that picks up the task will design and plan the solution itself.
Good: "Login button unresponsive on mobile". Bad: "Fix login button by
adding a touchstart handler in auth.tsx".

Which tracks and start modes you may use is set by your task's mandate (listed
at the end of this description); anything else is refused. The result carries
a digest of what changed in your task tree since you last looked
(\`task_tree\` reads the whole tree).

## track (required) — who asked for it?

The quick heuristic is WHERE THE TASK CAME FROM:

- The USER asked for it (they requested the feature, reported the issue,
  or told you to file it) → \`main\`.
- YOU came up with it (something you noticed, a caveat, a cleanup, an
  idea, a bug you found along the way) → \`sidequest\`.

The heuristic stands for the underlying question: is the feature you are
working on unfinished until this task is done? What the user asked for is
the critical path. What an agent finds along the way usually is not.

- \`main\` — yes, it is ON THE CRITICAL PATH: a remaining step without which
  the feature is not done. A main-track task after a single task is spliced
  into that task's dependency chain.

- \`sidequest\` — no, it is OFF the critical path: every follow-up the feature
  can ship without — improvements, caveats, cleanup, unrelated bugs, ideas,
  "while I was here" findings. A sidequest runs after the task it names
  (default: your current task) but is NEVER spliced into its chain (that
  task's dependents do not wait on it), and is never a \`prerequisite\` (it
  would block the main track). No chaining needed: file each sidequest on its
  own, in parallel.

Being a follow-up of your work does NOT make a task main — every filed task
comes after something. An issue you discovered yourself is a sidequest even
when it feels important; the user can promote it. When unsure, file a
sidequest.

## start (required) — when does it launch?

- \`now\` — filed under your task with no dependency, and armed: an agent
  launches on it right away. \`after\` is an error.
- \`after\` — runs after the tasks in \`after\` (default: your current task),
  armed: an agent launches on it once they are done.
- \`manual\` — wired after the same way, but never armed: it waits for a
  person to start it. \`model\` is an error.

In an interactive conversation the mandate typically allows \`main\` with
\`after\` and \`sidequest\` with \`manual\` — a misfiled main task launches an
agent on its own, a misfiled sidequest just waits for a human.

## after / relation — the dependency wiring

- One \`after\` task (or none: your current task) — \`relation\` says how
  the new task connects to it:
  - \`followup\` (default): the new task depends on it AND (main track) its
    existing dependents are rewired to wait on the new task instead — the new
    task is inserted into the chain. Use for "next step" decomposition.
  - \`prerequisite\` (main track only): it depends on the new task AND its
    existing dependencies transfer to the new task. Use when you discover
    something must happen before the current work.
- Several \`after\` tasks — a join: the new task waits on all of them and is
  spliced into no chain. \`relation\` is an error.

## Examples

**Next step of the feature:**

  { "title": "Add dark mode support", "description": "... Plan first.", "track": "main", "start": "after" }

**Linear main-track chain** — chain each call off the previous one:

  { "title": "Step 1", "track": "main", "start": "after" }                    → id: "X1"
  { "title": "Step 2", "track": "main", "start": "after", "after": ["X1"] }  → id: "X2"
  { "title": "Step 3", "track": "main", "start": "after", "after": ["X2"] }  → id: "X3"

If B was waiting on A, the chain auto-rewires: B → X3 → X2 → X1 → A.

**Sidequests** — off the critical path, no chaining:

  { "title": "Flaky retry in upload test", "track": "sidequest", "start": "manual" }
  { "title": "Dead helper left in utils.ts", "track": "sidequest", "start": "manual" }

**Prerequisite** — insert before the current task (main track only):

  { "title": "Write design doc", "track": "main", "start": "after", "relation": "prerequisite" }

A now depends on the new task. A's old deps are rewired to the new task.

**Join** — a step that needs two earlier ones:

  { "title": "Integrate", "track": "main", "start": "after", "after": ["X1", "Y1"] }

## Guidelines

For the main track, prefer **linear chains** over fan-out. Each downstream
task picks up cold from the prior task's outcome, and intermediate work
frequently surfaces issues that should reshape what comes after — a linear
chain lets the next agent see the actual outcome instead of executing a stale
plan.

**Filing several next steps from your current work?** Chain them off your
current task — do NOT fan them out as independent siblings. Leave \`after\`
unset on the FIRST call (it defaults to the current conversation's task),
then pass the previous call's returned \`task_id\` as \`after\` on each
subsequent call. The whole chain then hangs off your current (still-open)
task, so nothing launches until your work here completes — file them
straight away with start \`after\`; there is no need to ask the user first or
to file them \`manual\` to avoid launching agents prematurely.

**Filing a mix?** File the sidequests (no \`after\`) and the main-track chain
(first call without \`after\`, then chained) from the same task: the
sidequests hang off your task in parallel, and the main chain takes over its
place in the dependency graph.`,
  inputSchema: {
    title: z.string().min(1).describe("Short title for the task."),
    description: z
      .string()
      .optional()
      .describe(
        "Optional longer description of the problem or issue. Describe WHAT is wrong or needed, not HOW to fix it. " +
          'End with "Plan first." to instruct the executing agent to write its own plan before implementing — ' +
          "do this for any non-mechanical task, even if a broader plan already exists.",
      ),
    track: TaskTrackSchema.describe(
      "Heuristic: the user asked for it → `main`; you (the agent) came up with it → `sidequest`. " +
        "`main`: on the critical path — the current feature is unfinished until it is done; spliced into the chain after a single task. " +
        "`sidequest`: off the critical path — any follow-up, caveat, bug or cleanup the feature can ship without; " +
        "runs after its task, never spliced into its chain. When unsure, `sidequest`.",
    ),
    start: TaskFilingStartSchema.describe(
      "`now`: under your task, no dependency, launched right away. " +
        "`after`: launched once the `after` tasks (default: your task) are done. " +
        "`manual`: wired the same way, never launched — a person starts it. " +
        "Your mandate lists which modes each track allows.",
    ),
    after: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        "With start `after` / `manual`: the task ids it runs after. Defaults to the current conversation's task. " +
          "One id: wired per `relation` (use a previous call's task_id to chain main-track steps linearly). " +
          "Several: a join — waits on all, spliced into no chain. An error with start `now`.",
      ),
    relation: z
      .enum(["followup", "prerequisite"])
      .optional()
      .describe(
        "A single `after` only — how the new task connects to it. " +
          "`followup` (default): new task depends on it, its dependents rewired (main) or left alone (sidequest). " +
          "`prerequisite` (main only): it depends on the new task, its deps transfer.",
      ),
    model: ModelChoiceSchema.optional().describe(
      `The model the task launches with (an error with start \`manual\`): a family (${FAMILIES}) runs that family's newest version ` +
        "when the task launches — use one unless a specific version is required. " +
        'A pinned version is "<family>-<major>[-<minor>]"; it must be one this machine can run (an unknown or retired version is refused with the current list). ' +
        `Defaults to your mandate's model for the track, else "${DEFAULT_MODEL_CHOICE}". Use Sonnet only for purely mechanical refactoring (no design decisions, no unknowns).`,
    ),
  },
  async handler(input, { conversationId }) {
    const result = await fileAddTask(input, conversationId, ports);
    const digest = await digestFor(conversationId);
    return {
      content: [
        {
          type: "text",
          text: digest
            ? `${JSON.stringify(result)}\n\n${digest}`
            : JSON.stringify(result),
        },
      ],
    };
  },
});
