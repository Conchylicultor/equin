// Reads the transcript's stat strip at three scroll positions and dumps what it
// says at each — the end of the transcript, a third of the way back, then the
// end again. The point is the middle reading: the numbers must WALK BACK when
// the reader scrolls into history, and return when they scroll out of it.
// A transcript tool, not a gate: it logs, it does not assert.
//
// Usage:
//   ./equin run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/e2e/stats-verify.ts \
//     --conv <conversationId> [--url http://<worktree>.localhost:9000] [--headed]

import {
  arg,
  pathUrl,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const CONV = requireArg(
  "conv",
  "--conv <conversationId> is required: the transcript to read the strip from.",
);
const OUT = arg("out") ?? "/tmp/transcript-stats";

/** One reading in the strip, as the reader sees it. */
interface Stat {
  text: string;
  detail: string | null;
}

interface Strip {
  stats: Stat[];
  /** Scroll offset, as `scrolled/max` px. */
  position: string;
  /** Budget reminders still rendered as rows — the whole point is that this stays 0. */
  reminderRows: number;
}

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });

  await page.goto(pathUrl(`/agents/c/${CONV}`));
  await page.waitForTimeout(6000);

  async function readStrip(tag: string): Promise<Strip> {
    const strip: Strip = await page.evaluate(() => {
      const scroller = document.querySelector("[data-pane-scroll]");
      const frame = scroller?.parentElement;
      const stats = [...(frame?.querySelectorAll("span[title]") ?? [])]
        .filter((el) => !scroller?.contains(el))
        .map((el) => ({
          text: (el.textContent ?? "").trim(),
          detail: el.getAttribute("title"),
        }));
      const el = scroller as HTMLElement | null;
      const scrolled = Math.round(el?.scrollTop ?? 0);
      const max = Math.round((el?.scrollHeight ?? 0) - (el?.clientHeight ?? 0));
      // Not "is there an attachment row" — the flow is full of legitimate ones.
      // Specifically: did a row render the reminder's own wording?
      const reminderRows = [
        ...(scroller?.querySelectorAll("[data-event-index]") ?? []),
      ].filter((row) =>
        (row.textContent ?? "").includes("total_tokens"),
      ).length;
      return { stats, position: `${scrolled}/${max}`, reminderRows };
    });
    console.log(
      `[${tag}] ${strip.position} px, ${strip.reminderRows} reminder rows in the flow`,
    );
    for (const stat of strip.stats) {
      console.log(`  "${stat.text}" — ${stat.detail?.replace(/\n/g, " / ")}`);
    }
    await snap(page, OUT, tag);
    return strip;
  }

  async function scrollTo(fraction: number) {
    await page.evaluate((f) => {
      const el = document.querySelector("[data-pane-scroll]") as HTMLElement;
      el.scrollTop = Math.round(
        (el.scrollHeight - el.clientHeight) * (f as number),
      );
    }, fraction);
    await page.waitForTimeout(1500);
  }

  await scrollTo(1);
  await readStrip("1-end");
  await scrollTo(0.3);
  await readStrip("2-history");
  await scrollTo(1);
  await readStrip("3-back-at-end");
});
