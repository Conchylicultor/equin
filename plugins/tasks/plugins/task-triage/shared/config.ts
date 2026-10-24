import { defineConfig } from "@plugins/config_v2/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { multilineTextField } from "@plugins/fields/plugins/multiline-text/plugins/config/core";
import { dynamicEnumField } from "@plugins/fields/plugins/dynamic-enum/plugins/config/core";
import type { PromptVariable } from "@plugins/tasks/plugins/automations/core";

/** The most commits since filing the triage prompt lists. */
export const MAX_RECENT_COMMITS = 200;

/** The variables the triage prompt may use — each filled per task at launch. */
export const TRIAGE_PROMPT_VARIABLES: readonly PromptVariable[] = [
  { name: "taskId", description: "The task's id" },
  { name: "title", description: "The task's title" },
  {
    name: "description",
    description: "The task's description (or a note that it has none)",
  },
  { name: "filedAgo", description: "How long ago it was filed" },
  {
    name: "recentCommits",
    description: `Commits on main since it was filed, newest first (at most ${MAX_RECENT_COMMITS})`,
  },
  {
    name: "note",
    description:
      "The person's note about the task (or a note that there is none)",
  },
];

/**
 * The prompt a triage run starts with — what the build commits as the config's
 * `prompt`. The agent may only read the code (its CLAUDE.md names the main
 * checkout and the tool contract); this text says what to judge and how. The
 * record's fields are the `task_submit_triage` tool's schema.
 */
export const TASK_TRIAGE_PROMPT = `Triage one task before the person decides whether, when and how an agent works on it. You can only read code: the main checkout of the repository, at its latest commit (see CLAUDE.md). Do not try to change anything.

# The task (\`{{taskId}}\`)

## {{title}}

{{description}}

It was filed {{filedAgo}}. Commits on main since then, newest first:

{{recentCommits}}

## The person's note

{{note}}

# What to decide

1. **Obsolete?** Search the code (and the commits above) for what the task names: is it already fixed, or is the code it talks about gone? If so, verdict \`obsolete\` — quote the commit or the path that shows it.
2. **Clear?** Could an agent nobody is watching do it without asking anyone? If one call is the person's to make, verdict \`decide\` and ask it.
3. **Too big?** If it does not fit one session, verdict \`split\` and propose the split as the question.
4. **Safe to accept?** Only give a positive verdict if every check passes:
   - Can it hurt performance, or make the program slower?
   - Does it hide a deeper issue — would fixing it this way paper over the real cause?
   - Would it silence actual issues (errors, warnings, checks)?
   If one fails, verdict \`decide\` and name the failing check in the question.
5. Otherwise verdict \`ready\`.

Then rate it:

- **priority** — MoSCoW, for the work in progress now (the current timebox), not for all time:
  - \`must\` — without it, what is being built is not viable: it is broken, unsafe, or does not do its job.
  - \`should\` — important and painful to leave out, but there is a workaround the person can live with for now.
  - \`could\` — desirable, with a small impact if it is left out: the first thing to cut when time runs short.
  - \`wont\` — explicitly out of scope this time. Not "never": it may come back in a later timebox.
- **taskType** — \`feature\` (new or changed behaviour), \`bugfix\` (something is actually broken — not merely missing or improvable), \`cleanup\` (refactoring, debt, dead code: no visible change), \`testing\` (tests, checks, verification), or \`other\`.
- **risk** — \`high\` when it changes behaviour a person relies on, a shared primitive many screens go through, a schema, auth or the gateway; \`medium\` for a contained behaviour change; \`low\` for a local fix nobody would notice except as "fixed".
- **areas** — the plugin paths it would touch (\`tasks/automations\`, \`shell/health-report\`, …).

# The context

The person is not familiar with this task nor the codebase, so start by reminding them of the high-level picture: what are we trying to do, and how does this task fit into it? Look at the parent task (or the one that filed this task) if relevant.

Write \`context\` for someone who has never seen this code and must decide in a minute what to do with this task: what the problem is, why it matters (or doesn't), how it could be fixed, and anything that makes it risky or hard. Plain language, short paragraphs, \`- \` bullets where they help, **bold** for the one thing to notice. As long as this task needs, and no longer.

If there is a question, \`question\` is ONE question the person can answer in a click, and \`answers\` its 2–4 short answers (a few words each). Otherwise \`question\` is null and \`answers\` is empty.`;

/**
 * The model triage runs with — a family follows its newest version. Its
 * options are the live model catalog's (a `DynamicEnum.Options` contribution in
 * this plugin's web half); the dispatcher reads it back through
 * `normalizeModelChoice`.
 */
export const triageModelField = dynamicEnumField({
  label: "Model",
  description: "The model every triage run reads the task with.",
  default: "sonnet",
});

/**
 * Task triage's config (Settings → Config): the model a run reads with, how
 * many run at once, when a read goes stale, and the prompt each run starts
 * with. Stored as `config/tasks/task-triage/config.origin.jsonc`.
 */
export const taskTriageConfig = defineConfig({
  fields: {
    model: triageModelField,
    concurrency: intField({
      label: "At once",
      description:
        "How many triage runs may read at the same time; further requests wait in the queue.",
      min: 1,
      max: 8,
      default: 2,
    }),
    staleAfterDays: intField({
      label: "Stale after (days)",
      description:
        "A read older than this is marked Stale (so is one of a task edited since). Nothing re-runs on its own.",
      min: 1,
      max: 90,
      default: 7,
    }),
    prompt: multilineTextField({
      label: "Prompt",
      description:
        "What each triage run starts with. {{variable}} placeholders are filled per task: taskId, title, description, filedAgo, recentCommits, note.",
      default: TASK_TRIAGE_PROMPT,
      rows: 16,
    }),
  },
});
