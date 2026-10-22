import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import {
  createTask,
  getConversation,
  getTask,
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
import { armTaskAutoStart } from "../../server/internal/arm-auto-start";
import { rewireDependencies } from "../../server/internal/rewire-dependencies";
import { fileAddTask, type AddTaskPorts } from "./add-task-filing";

// The real mutations behind `add_task`. The filing policy lives in
// add-task-filing.ts, which a test drives over an in-memory store.
const ports: AddTaskPorts = {
  getConversation,
  getTask,
  createTask: (input) => createTask(input),
  inheritLaunchOptions,
  rewire: (opts) => withNotifyBatch(() => rewireDependencies(opts)),
  armAutoStart: armTaskAutoStart,
  setTrack: (taskId, track) => setTaskTrack(taskId, track),
  modelCatalog: getModelCatalog,
};

// Named from the code's family set, so a family added there is offered here
// with no edit; versions are never listed (they are runtime data).
const FAMILIES = SELECTABLE_FAMILIES.map((f) => `"${f}"`).join(", ");

export const addTaskTool = Mcp.tool({
  name: "add_task",
  description: `Add a task to the Singularity task tree.

Task titles and descriptions should state the PROBLEM or ISSUE to solve —
not instructions on how to solve it, and no hints or suggestions either.
The agent that picks up the task will design and plan the solution itself.
Good: "Login button unresponsive on mobile". Bad: "Fix login button by
adding a touchstart handler in auth.tsx".

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
  the feature is not done. Main-track tasks are spliced into the dependency
  chain and auto-started (\`autostart\`, default "${DEFAULT_MODEL_CHOICE}") once the task they
  wait on is done. Chain several with \`target\` (see below).

- \`sidequest\` — no, it is OFF the critical path: every follow-up the feature
  can ship without — improvements, caveats, cleanup, unrelated bugs, ideas,
  "while I was here" findings. A sidequest runs after the target (default:
  your current task) but is NEVER spliced into its chain (the target's
  dependents do not wait on it) and is NEVER auto-started by an agent: passing
  \`autostart\` with a sidequest is an error. A human arms it later if wanted.
  No \`target\` chaining needed: file each sidequest on its own, in parallel.
  A sidequest cannot be a \`prerequisite\` (it would block the main track).

Being a follow-up of your work does NOT make a task main — every filed task
comes after something. An issue you discovered yourself is a sidequest even
when it feels important; the user can promote it. When unsure, file a
sidequest: a misfiled main task launches an agent on its own; a misfiled
sidequest just waits for a human to promote it.

## relation (dependency direction — independent of the track)

Controls how the new task connects to the target:

- \`followup\` (default): the new task depends on the target AND the
  target's existing dependents are rewired to wait on the new task instead.
  This inserts the new task into the chain: anything that was waiting on
  the target now waits on the new task. Use for "next step" decomposition.

- \`prerequisite\`: the target depends on the new task AND the target's
  existing dependencies transfer to the new task. The new task inherits
  the target's upstream position. Use when you discover something must
  happen before the current work.

## Examples

**Next step of the feature:**

  { "title": "Add dark mode support", "description": "... Plan first.", "track": "main" }

**Linear main-track chain** — use \`target\` to chain off the previous task:

  { "title": "Step 1", "track": "main" }                  → id: "X1"
  { "title": "Step 2", "track": "main", "target": "X1" }  → id: "X2"
  { "title": "Step 3", "track": "main", "target": "X2" }  → id: "X3"

If B was waiting on A, the chain auto-rewires: B → X3 → X2 → X1 → A.

**Sidequests** — off the critical path, no chaining, no autostart:

  { "title": "Flaky retry in upload test", "track": "sidequest" }
  { "title": "Dead helper left in utils.ts", "track": "sidequest" }

**Prerequisite** — insert before the current task (main track only):

  { "title": "Write design doc", "track": "main", "relation": "prerequisite" }

A now depends on the new task. A's old deps are rewired to the new task.

## Guidelines

For the main track, prefer **linear chains** over fan-out. Each downstream
task picks up cold from the prior task's outcome, and intermediate work
frequently surfaces issues that should reshape what comes after — a linear
chain lets the next agent see the actual outcome instead of executing a stale
plan.

**Filing several next steps from your current work?** Chain them off your
current task — do NOT fan them out as independent siblings. Leave \`target\`
unset on the FIRST call (it defaults to the current conversation's task),
then pass the previous call's returned \`task_id\` as \`target\` on each
subsequent call. The whole chain then hangs off your current (still-open)
task, so nothing autostarts until your work here completes — file them
straight away with the default \`autostart\`; there is no need to ask the user
first or to disable autostart to avoid launching agents prematurely.

**Filing a mix?** File the sidequests (no target) and the main-track chain
(first call without target, then chained) from the same task: the sidequests
hang off your task in parallel, and the main chain takes over its place in
the dependency graph.`,
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
        "`main`: on the critical path — the current feature is unfinished until it is done; chained and auto-started. " +
        "`sidequest`: off the critical path — any follow-up, caveat, bug or cleanup the feature can ship without; " +
        "runs after the target, never spliced into its chain, never auto-started. When unsure, `sidequest`.",
    ),
    relation: z
      .enum(["followup", "prerequisite"])
      .default("followup")
      .describe(
        "Dependency direction only — says nothing about the track. " +
          "`followup` (default): new task depends on target, target's dependents rewired (main) or left alone (sidequest). " +
          "`prerequisite` (main only): target depends on new task, target's deps transfer.",
      ),
    target: z
      .string()
      .optional()
      .describe(
        "Task ID to relate to. Defaults to the current conversation's task. " +
          "Use a previous call's task_id to chain main-track steps linearly.",
      ),
    autostart: ModelChoiceSchema.optional().describe(
      `Main track only (an error on a sidequest). Auto-launch model: a family (${FAMILIES}) runs that family's newest version ` +
        "when the task launches — use one unless a specific version is required. " +
        'A pinned version is "<family>-<major>[-<minor>]"; it must be one this machine can run (an unknown or retired version is refused with the current list). ' +
        `Defaults to "${DEFAULT_MODEL_CHOICE}". Use Sonnet only for purely mechanical refactoring (no design decisions, no unknowns).`,
    ),
  },
  async handler(input, { conversationId }) {
    const result = await fileAddTask(input, conversationId, ports);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  },
});
