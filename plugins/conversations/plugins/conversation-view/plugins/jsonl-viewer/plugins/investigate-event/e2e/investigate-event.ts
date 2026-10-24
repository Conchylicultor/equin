/**
 * Verifies the investigate row action appears on exactly the rows nothing
 * handled, and nowhere else.
 *
 * The interesting assertion is the NEGATIVE one. The action gates on
 * `useDispatchOutcome()?.matched === false`, read from the *nearest* enclosing
 * dispatch — so a `Bash` card must stay clean even though the event-renderer
 * dispatch that wraps it also matched, and a `SendMessage` card must show one
 * even though its wrapping event row matched. Counting buttons globally would
 * pass with the gate inverted; this walks each button back to its own row and
 * reads that row's tool badge instead.
 *
 * Hover-reveal is opacity + pointer-events, not mount/unmount, so the buttons
 * are in the DOM without simulating hover.
 *
 *   ./equin run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/investigate-event/e2e/investigate-event.ts --conv <id>
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const INVESTIGATE = '[aria-label="Launch agent to add a renderer"]';

/** Tools with their own renderer plugin — their inner dispatch matches. */
const HANDLED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Agent",
  "Skill",
  "Workflow",
  "AskUserQuestion",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
];

const convId = arg("conv") ?? "conv-1784824270-417z";

await withBrowser(async (h) => {
  const r = report("investigate-event row action");
  const { page, captured } = await h.session();

  await boot(page, pathUrl(`/agents/c/${convId}`), {
    marker: "[data-event-index]",
    settleMs: 2500,
  });

  const rows = await page.$$eval(
    "[data-event-index]",
    (nodes, sel) =>
      nodes.map((n) => {
        // The tool-name Badge is the first font-mono leaf in the card header;
        // non-tool rows simply have none.
        const badge = n.querySelector(".font-mono");
        return {
          index: n.getAttribute("data-event-index"),
          badge: badge?.textContent?.trim() ?? null,
          // Non-tool fallbacks (unknown event kind, unknown attachment subtype)
          // have no tool badge, so carry their leading text for the transcript.
          text: (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
          buttons: n.querySelectorAll(sel).length,
        };
      }),
    INVESTIGATE,
  );

  r.note(`${rows.length} rows rendered in ${convId}`);

  const withButton = rows.filter((row) => row.buttons > 0);
  r.ok(
    "at least one fallback row shows the action",
    withButton.length > 0,
    "no row rendered the investigate button — the gate may be inverted",
  );
  r.note("rows with the action:");
  for (const row of withButton) r.note(`  · ${row.badge ?? row.text}`);

  // The reported bug: an un-rendered tool name must now carry the action.
  const sendMessage = rows.filter((row) => row.badge === "SendMessage");
  if (sendMessage.length === 0) {
    r.note("no SendMessage row in this conversation — skipping that assertion");
  } else {
    r.ok(
      "SendMessage card shows the action",
      sendMessage.every((row) => row.buttons === 1),
      `got ${sendMessage.map((row) => row.buttons).join("/")} button(s)`,
    );
  }

  // The nesting assertion: a matched inner dispatch wins over the matched outer one.
  for (const tool of HANDLED_TOOLS) {
    const cards = rows.filter((row) => row.badge === tool);
    if (cards.length === 0) continue;
    r.ok(
      `${tool} card stays clean`,
      cards.every((row) => row.buttons === 0),
      `${cards.filter((row) => row.buttons > 0).length}/${cards.length} carried an action`,
    );
  }

  // Regression guard for the two former hardcoded `trailing=` call sites.
  const doubled = rows.filter((row) => row.buttons > 1);
  r.ok(
    "no row renders the action twice",
    doubled.length === 0,
    `doubled on: ${doubled.map((row) => row.badge ?? row.index).join(", ")}`,
  );

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );

  await r.finish();
});
