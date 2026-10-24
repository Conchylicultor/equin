/**
 * Both surfaces render the SAME launch-option registry — in two different
 * shapes.
 *
 * The point of the registry is that an option is one plugin folder and shows up
 * on the task detail's Prompt card AND in the task-draft popover with no host
 * edit. A type-check cannot catch a host that silently renders a subset — it
 * still compiles — so it is asserted here.
 *
 * The two hosts draw that one set differently, so each is checked in the shape
 * it really has:
 *
 * - The **task detail's Prompt card** paints a labelled row per option, each
 *   holding the option's own control. One aria-labelled control per option, so
 *   the check is that each appears exactly once.
 * - The **draft popover** paints the options as pills on the composer bar, and
 *   the ones that declared the same `cluster` fuse into a single trigger — the
 *   model and the thinking mode read together as `✦ Opus 5  Auto`. There is
 *   deliberately no longer one control per option on that surface, so the check
 *   is reachability through the new chrome: every expected pill is on the bar,
 *   opening one shows exactly one headed section per option it carries with
 *   selectable rows under each, and the trigger prints every value it holds.
 *
 * That last one is the assertion that earns its keep. A fused member whose
 * value simply vanished while unset is a control the user cannot see and so
 * cannot find — which is exactly how the thinking mode was invisible until it
 * was given a word for its own unset state. So the fused trigger must print
 * both members, with the second in the muted tone.
 *
 * `OPTIONS` below is what keeps this honest. The registry is a web slot, which
 * an `e2e/` script may not import, so the set is *declared* here rather than
 * read back out of the app: a host that dropped an option fails, and so does
 * one that moved an option into a different pill. Only the value strings are
 * imported — from the providers' `core` barrels — so renaming a model or the
 * unset thinking mode moves this script with it instead of reddening it.
 *
 * Drives the draft popover from the task detail's "+ Prerequisite" button
 * rather than the Improve toolbar button: same `TaskDraftPopover`, but a plain
 * always-mounted trigger instead of one behind the floating action bar's
 * hover-disclosure animation.
 *
 *   ./equin run plugins/tasks/plugins/launch-options/e2e/launch-options-verify.ts \
 *     --task <taskId> [--headed]
 */
import {
  arg,
  boot,
  clearToasts,
  ELEMENT_TIMEOUT_MS,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  DEFAULT_MODEL_CHOICE,
  choiceLabel,
} from "@plugins/conversations/plugins/model-provider/core";
import { EFFORT_UNSET_LABEL } from "@plugins/conversations/plugins/effort-provider/core";
import type { Locator, Page } from "playwright";

const out = arg("out") ?? "/tmp/launch-options";

/** One registered launch option, as it is expected to appear on both hosts. */
interface ExpectedOption {
  /**
   * The `ariaLabel` its contributed control carries. Asserting on the CONTROL
   * rather than the row label is what makes the detail half a real check: a
   * host that painted the labels but dropped the controls would still pass a
   * text-only assertion.
   */
  control: string;
  /**
   * The option's `label`. On the composer bar it titles this option's section
   * inside its pill's menu, and — for the option that leads a pill — it is that
   * trigger's accessible name.
   */
  label: string;
  /** Which pill carries it on the bar, named by that trigger's accessible name. */
  pill: string;
  /**
   * What this option's value prints on the trigger of a FRESH draft card.
   * `null` means it prints nothing there, which is what a solo pill holding
   * nothing looks like — it falls back to its placeholder instead.
   */
  value: string | null;
}

/**
 * Auto-start and the thinking mode share the `run` pill, auto-start leading it,
 * so its label is the fused trigger's name. The preprompt has a pill of its own
 * and is unset on a fresh card.
 */
const OPTIONS: ExpectedOption[] = [
  {
    control: "Auto-start model",
    label: "Auto-start",
    pill: "Auto-start",
    value: choiceLabel(DEFAULT_MODEL_CHOICE),
  },
  {
    control: "Task preprompt",
    label: "Preprompt",
    pill: "Preprompt",
    value: null,
  },
  {
    control: "Task thinking mode",
    label: "Thinking mode",
    pill: "Auto-start",
    value: EFFORT_UNSET_LABEL,
  },
];

/** The pills the bar is expected to carry, each with the options behind it. */
interface ExpectedPill {
  name: string;
  members: ExpectedOption[];
}

function expectedPills(options: ExpectedOption[]): ExpectedPill[] {
  const pills: ExpectedPill[] = [];
  for (const option of options) {
    const open = pills.find((pill) => pill.name === option.pill);
    if (open) open.members.push(option);
    else pills.push({ name: option.pill, members: [option] });
  }
  return pills;
}

/**
 * What a pill's trigger prints, left to right, on a fresh draft card. A pill
 * holding nothing prints its placeholder — the lead option's label, which is
 * also the trigger's accessible name.
 */
function expectedTriggerText(pill: ExpectedPill): string[] {
  const values = pill.members
    .map((member) => member.value)
    .filter((value): value is string => value !== null);
  return values.length > 0 ? values : [pill.name];
}

/** The pieces of text on a pill's trigger: its own element children, in order. */
function triggerValues(trigger: Locator): Locator {
  return trigger.locator("> span");
}

/** A tone as the browser resolved it, so "muted" is read off the pixels. */
function colorOf(value: Locator): Promise<string> {
  return value.evaluate((el) => getComputedStyle(el).color);
}

/** A task to open the Prompt card on. Any id in this worktree's DB will do. */
const taskId = requireArg(
  "task",
  "launch-options-verify.ts --task <taskId> [--out <prefix>] [--headed]",
);

const r = report("launch options on both surfaces");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl(`/agents/tasks/t/${taskId}`), { settleMs: 3000 });
  await snap(page, out, "task-detail");

  // --- task detail Prompt card ---
  // Only the detail is mounted here, so one control each.
  for (const option of OPTIONS) {
    r.eq(
      `task detail renders "${option.control}"`,
      await page.getByLabel(option.control).count(),
      1,
    );
  }

  // --- task-draft popover ---
  await page
    .getByRole("button", { name: "+ Prerequisite" })
    .click({ timeout: 15_000 });
  // Wait on Submit, NOT on the editor placeholder: the editor is Lexical, whose
  // placeholder is an overlay element and not a `placeholder` attribute — so
  // `getByPlaceholder` never matches and would look like the popover never
  // opened.
  const submit = page.getByRole("button", { name: "Submit", exact: true });
  await submit.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(800);
  await snap(page, out, "draft-popover");

  // The run pill sits in the corner the toasts stack in, so anything on screen
  // there has to be gone before the bar is driven — see `clearToasts`.
  await clearToasts(page);
  for (const pill of expectedPills(OPTIONS)) {
    await checkPill(page, pill);
  }
});

/**
 * One pill on the draft card's composer bar: that it is there, that it reads
 * back every value it holds, and that its menu offers each of its options.
 */
async function checkPill(page: Page, pill: ExpectedPill): Promise<void> {
  const carries = pill.members.map((member) => member.label).join(" + ");
  // Exact, because the detail card's controls behind the popover are named for
  // the same options ("Auto-start model" contains "Auto-start").
  const trigger = page.getByRole("button", { name: pill.name, exact: true });
  r.eq(`draft bar carries the ${carries} pill`, await trigger.count(), 1);
  if ((await trigger.count()) !== 1) return;

  const values = triggerValues(trigger);
  r.eq(
    `${pill.name} pill reads back what it holds`,
    await values.allInnerTexts(),
    expectedTriggerText(pill),
  );

  // A fused trigger says which value is the lead one by tone alone, so the
  // second has to actually be drawn dimmer — not merely be second.
  if ((await values.count()) > 1) {
    const [lead, next] = [
      await colorOf(values.nth(0)),
      await colorOf(values.nth(1)),
    ];
    r.ok(
      `${pill.name} pill mutes its trailing value`,
      lead !== next,
      `both drawn ${lead}`,
    );
  }

  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });

  // One section per option and no more: an option that joined this pill's
  // cluster without being declared above shows up here as an extra section.
  r.eq(
    `${pill.name} menu has one section per option`,
    await menu.getByRole("group").count(),
    pill.members.length,
  );
  for (const member of pill.members) {
    const section = menu.getByRole("group", {
      name: member.label,
      exact: true,
    });
    r.eq(
      `${pill.name} menu has a "${member.label}" section`,
      await section.count(),
      1,
    );
    if ((await section.count()) !== 1) continue;
    r.ok(
      `"${member.label}" section offers rows to pick`,
      (await section.getByRole("menuitem").count()) > 0,
    );
  }

  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: ELEMENT_TIMEOUT_MS });
}

await r.finish();
