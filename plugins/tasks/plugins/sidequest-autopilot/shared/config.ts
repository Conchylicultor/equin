import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineLaunchAutomationConfig } from "@plugins/tasks/plugins/automations/core";

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

## The person's note

{{note}}

## How to work

- **Never ask questions, and never wait for an answer.** Nobody will reply. Where you would ask, make the cleanest call and record it in your report — or, if the call is the person's to make, stop and put it to them as your report's decision question.
- **First check the task is still worth doing.** Search the code and git history: it may already be fixed, or the code it names may be gone. If it is obsolete, change nothing — say why in your report and ask whether to drop it.
- **Stay in scope.** Do what this task asks, nothing more. Anything else you notice: file it with the \`add_task\` MCP tool on the \`sidequest\` track, and move on.
- **Stop early** when the task turns out much bigger than its description suggests, or needs a design choice that is not yours to make: write up what you found and what the options are, and stop there.
- **Never touch database migrations, auth, or the gateway** without leaving the push to the person, whatever the push setting below says.
- Build with \`./equin build\` and make sure it is \`ok\`.

## Pushing

{{pushPolicy}}

## When you are done

Finish by calling the \`submit_outcome_report\` MCP tool **exactly once**, then stop — do NOT call \`exit_clean\`: the conversation stays open so the person can read your report and answer it. Write the report for someone who has no context on this code:

1. **The problem and why we care** — what was wrong, and what it cost.
2. **The mental model, before → after** — how this part worked before and how it works now.
3. **What changed** — the files and behaviour, briefly, and whether you pushed.
4. **Caveats** — anything you encountered, skipped or are unsure of.
5. **One decision question**, only if there is one — the single thing you need the person to decide.`;

/**
 * The Sidequest autopilot's config: OFF by default; on, it starts agents on
 * the ready sidequests the person APPROVED, best first, 2 at a time and at
 * most 5 in total, each allowed to push only an uncontroversial change — then
 * it turns itself off (or at `runUntil`, or when the person does). `triage`
 * (on by default, independent of `enabled`) asks task-triage for a read of
 * each new sidequest so the launch list can propose it; it approves nothing. Woken when a task becomes ready to start (a burst settling 2
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
      label: "Triage new sidequests automatically",
      description:
        "Ask task-triage for a read of each sidequest that becomes ready, so it is proposed in the launch list. It approves nothing; off, sidequests are triaged only when someone asks (the task's Triage card, or Triage now in the list).",
      default: true,
    }),
    runUntil: textField({
      label: "Run until",
      description:
        'When it turns itself off: an ISO datetime, or "" to run until you turn it off. Agents already running finish either way.',
      default: "",
    }),
  },
);
