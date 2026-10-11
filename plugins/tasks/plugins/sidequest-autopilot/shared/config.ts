import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { multilineTextField } from "@plugins/fields/plugins/multiline-text/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  defineLaunchAutomationConfig,
  type PromptVariable,
} from "@plugins/tasks/plugins/automations/core";

/** The automation's id: its config document's name and its job's suffix. */
export const SIDEQUEST_AUTOPILOT_ID = "sidequest-autopilot";

/**
 * The default prompt an autopilot agent starts with — what the build commits
 * as the config's `prompt`. Written for an agent nobody is watching: it never
 * waits on a person, and everything it would have asked goes into its report.
 */
export const SIDEQUEST_AUTOPILOT_PROMPT = `You are working through the sidequest backlog on autopilot. Nobody is watching this conversation: the person reads your report when they are back. Your task (\`{{taskId}}\`):

# {{title}}

{{description}}

## What triage found

A read-only reviewer read the code before you and wrote this for the person, who approved this task for you to work on:

{{context}}

## The person's call

{{decision}}

## How to work

- **Never ask questions, and never wait for an answer.** Nobody will reply. Where you would ask, make the cleanest call and record it in your report — or, if the call is the person's to make, stop and put it to them as your report's decision question.
- **First check the task is still worth doing.** Search the code and git history: it may already be fixed, or the code it names may be gone. If it is obsolete, change nothing — say why in your report and ask whether to drop it.
- **Stay in scope.** Do what this task asks, nothing more. Anything else you notice: file it with the \`add_task\` MCP tool on the \`sidequest\` track, and move on.
- **Stop early** when the task turns out much bigger than its description suggests, or needs a design choice that is not yours to make: write up what you found and what the options are, and stop there.
- **Never touch database migrations, auth, or the gateway** without leaving the push to the person, whatever the push setting below says.
- Build with \`./singularity build\` and make sure it is \`ok\`.

## Pushing

{{pushPolicy}}

## When you are done

Finish by calling the \`submit_outcome_report\` MCP tool **exactly once**, then stop — do NOT call \`exit_clean\`: the conversation stays open so the person can read your report and answer it. Write the report for someone who has no context on this code:

1. **The problem and why we care** — what was wrong, and what it cost.
2. **The mental model, before → after** — how this part worked before and how it works now.
3. **What changed** — the files and behaviour, briefly, and whether you pushed.
4. **Caveats** — anything you encountered, skipped or are unsure of.
5. **One decision question**, only if there is one — the single thing you need the person to decide.`;

/** The most commits since filing the triage prompt lists. */
export const MAX_RECENT_COMMITS = 200;

/** The variables the triage prompt may use. */
export const TRIAGE_PROMPT_VARIABLES: readonly PromptVariable[] = [
  { name: "taskId", description: "The sidequest's task id" },
  { name: "title", description: "The sidequest's title" },
  {
    name: "description",
    description: "The sidequest's description (or a note that it has none)",
  },
  { name: "filedAgo", description: "How long ago it was filed" },
  {
    name: "recentCommits",
    description: `Commits on main since it was filed, newest first (at most ${MAX_RECENT_COMMITS})`,
  },
];

/**
 * The prompt triage reads each sidequest with — what the build commits as the
 * config's `triagePrompt`. The run may only read the code (Read / Grep /
 * Glob, in the main checkout) and answers with the structured triage record,
 * whose fields the CLI enforces; this text says how to judge them.
 */
export const SIDEQUEST_TRIAGE_PROMPT = `Triage one sidequest before the person decides whether an unattended agent may pick it up. You can only read: the working directory is the main checkout of the repository, at its latest commit. Do not try to change anything.

# The sidequest (\`{{taskId}}\`)

## {{title}}

{{description}}

It was filed {{filedAgo}}. Commits on main since then, newest first:

{{recentCommits}}

# What to decide

1. **Obsolete?** Search the code (and the commits above) for what the task names: is it already fixed, or is the code it talks about gone? If so, verdict \`obsolete\` — quote the commit or the path that shows it.
2. **Clear?** Could an agent nobody is watching do it without asking anyone? If one call is the person's to make, verdict \`decide\` and ask it.
3. **Too big?** If it does not fit one session, verdict \`split\` and propose the split as the question.
4. Otherwise verdict \`ready\`.

Then rate it:

- **risk** — \`high\` when it changes behaviour a person relies on, a shared primitive many screens go through, a schema, auth or the gateway; \`medium\` for a contained behaviour change; \`low\` for a local fix nobody would notice except as "fixed".
- **sizeMinutes** — your honest estimate of an agent's working time.
- **value** — 1–5: how much fixing it is worth to the person.
- **areas** — the plugin paths it would touch (\`tasks/automations\`, \`shell/health-report\`, …).

# The context

Write \`context\` for someone who has never seen this code and must decide in a minute whether to let an agent do it: what the problem is, why it matters (or doesn't), how it could be fixed, and anything that makes it risky or hard. Plain language, short paragraphs, \`- \` bullets where they help, **bold** for the one thing to notice. As long as this task needs, and no longer.

If there is a question, \`question\` is ONE question the person can answer in a click, and \`answers\` its 2–4 short answers (a few words each). Otherwise \`question\` is null and \`answers\` is empty.`;

/**
 * The Sidequest autopilot's config: OFF by default; on, it starts agents on
 * the ready sidequests the person APPROVED, best first, 2 at a time and at
 * most 5 in total, each allowed to push only an uncontroversial change — then
 * it turns itself off (or at `runUntil`, or when the person does). Triage (on
 * by default, independent of `enabled`) reads each new sidequest read-only and
 * proposes it; it approves nothing. Woken when a task becomes ready to start (a burst settling 2
 * min), and whenever one of its agents finishes or reports. Stored as
 * `config/tasks/automations/sidequest-autopilot.origin.jsonc`.
 */
export const sidequestAutopilotConfig = defineLaunchAutomationConfig(
  SIDEQUEST_AUTOPILOT_ID,
  {
    enabled: false,
    push: "safe",
    trigger: "event",
    settleMinutes: 2,
    concurrency: 2,
    maxLaunches: 5,
    prompt: SIDEQUEST_AUTOPILOT_PROMPT,
  },
  {
    triage: boolField({
      label: "Triage",
      description:
        "Read each new sidequest with Sonnet (read-only) and propose it in the launch list. It approves nothing; off, nothing new is read.",
      default: true,
    }),
    staleAfterDays: intField({
      label: "Stale after (days)",
      description:
        "A triage read older than this — or of a task edited since — is tagged Stale in the launch list. Nothing re-runs on its own.",
      min: 1,
      max: 90,
      default: 7,
    }),
    triagePrompt: multilineTextField({
      label: "Triage prompt",
      description:
        "What triage reads each sidequest with. {{variable}} placeholders are filled per task.",
      default: SIDEQUEST_TRIAGE_PROMPT,
      rows: 16,
    }),
    runUntil: textField({
      label: "Run until",
      description:
        'When it turns itself off: an ISO datetime, or "" to run until you turn it off. Agents already running finish either way.',
      default: "",
    }),
  },
);
