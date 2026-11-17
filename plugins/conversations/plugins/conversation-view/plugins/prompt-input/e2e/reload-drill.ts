// Reload drill: an unsent message in a conversation's composer survives a
// reload.
//
// Opens an existing conversation of this deploy (one whose composer is
// enabled — `waiting` — read from the deploy's database, read-only), types a
// message WITHOUT sending it, and runs the reload drill (`e2e-harness`
// reload-drill.ts): the composer's draft is work (kept-state, scoped to the
// conversation), so after the reload the composer holds the same text. Nothing
// is sent: no Enter is pressed, so no turn reaches any agent. The draft lives
// in the throwaway browser's storage only.
//
// Usage: ./equin run plugins/conversations/plugins/conversation-view/plugins/prompt-input/e2e/reload-drill.ts [--conversation <id>] [--no-record] [--headed]
import type { Page } from "playwright";
import {
  arg,
  openDeployDb,
  pathUrl,
  reloadDrill,
  reloadDrillText,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/prompt-input-reload-drill";
const DRAFT = "half a thought about the retry policy, not sent";

async function pickConversation(): Promise<string> {
  const given = arg("conversation");
  if (given) return given;
  const db = openDeployDb();
  try {
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM conversations WHERE status = 'waiting' AND kind <> 'system'
       ORDER BY created_at DESC LIMIT 1`,
    );
    const id = rows[0]?.id;
    if (!id)
      throw new Error(
        "no waiting conversation in this deploy's database — pass --conversation <id>",
      );
    return id;
  } finally {
    await db.close();
  }
}

/** The conversation's prompt editor (its placeholder names the send gesture). */
const composer = (page: Page) =>
  page
    .locator('[contenteditable="true"]')
    .filter({ hasNot: page.locator("[data-block-id]") })
    .last();

const conversationId = await pickConversation();

await withBrowser(async (h) => {
  const { page } = await h.session();
  const r = report("prompt-input: an unsent message survives a reload");
  r.note(`conversation ${conversationId}`);
  await page.goto(pathUrl(`/agents/c/${conversationId}`), {
    waitUntil: "domcontentloaded",
  });
  await composer(page).waitFor({ state: "visible", timeout: 60_000 });

  const drill = await reloadDrill(page, {
    step: async (p) => {
      await composer(p).click();
      await p.keyboard.type(DRAFT);
    },
    restore: async (p) => {
      await composer(p).waitFor({ state: "visible", timeout: 60_000 });
    },
  });
  console.log(reloadDrillText(drill));
  await snap(page, OUT, "after-reload");

  const text = (await composer(page).innerText()).trim();
  r.ok(
    "the composer shows the unsent message after the reload",
    text === DRAFT,
    JSON.stringify(text),
  );
  r.ok(
    "the reload gave everything back",
    drill.differences.length === 0 && drill.compared > 0,
    reloadDrillText(drill),
  );
  await r.finish();
});
