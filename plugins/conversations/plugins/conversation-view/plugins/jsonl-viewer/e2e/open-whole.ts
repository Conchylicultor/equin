/**
 * Verifies a conversation opens on its WHOLE transcript — never on a part of it
 * that then grows. The defect it guards: the agent's replies are markdown, whose
 * renderer is a lazy chunk; drawn before it loaded, a finished conversation
 * opened on its prompt and tool cards alone, then grew by every reply at once
 * (~400 px) and jumped to its end.
 *
 * A fresh page each time (no chunk cached in memory), sampled every frame from
 * the first one: the first frame that shows transcript rows must already hold
 * (nearly) all of the transcript's text.
 *
 *   ./equin run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/e2e/open-whole.ts --conv <id>
 */
import {
  boot,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const SETTLE_MS = 4000;
/** Below this share of the settled text, the first frame drew a partial transcript. */
const WHOLE = 0.95;

const convId = requireArg("conv", "a finished conversation id");
const url = pathUrl(`/agents/c/${convId}`);

/** [ms since navigation start, transcript text length, scrollHeight] per frame. */
type Sample = [number, number, number];

await withBrowser(async (h) => {
  const r = report("conversation opens whole");
  const { page } = await h.session();
  await page.addInitScript(() => {
    const samples: [number, number, number][] = [];
    (window as unknown as { __openWhole: typeof samples }).__openWhole =
      samples;
    const tick = () => {
      const scroller = [
        ...document.querySelectorAll("[data-pane-scroll]"),
      ].find((n) => n.querySelector("[data-event-key]"));
      if (scroller) {
        samples.push([
          Math.round(performance.now()),
          scroller.textContent?.length ?? 0,
          scroller.scrollHeight,
        ]);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await boot(page, url, { marker: "[data-event-key]", settleMs: SETTLE_MS });
  const samples = await page.evaluate(
    () => (window as unknown as { __openWhole: Sample[] }).__openWhole,
  );
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return r.fail("no frame showed transcript rows");
  r.note(
    `first rows at ${first[0]} ms: ${first[1]} chars, ${first[2]} px; ` +
      `settled: ${last[1]} chars, ${last[2]} px`,
  );
  r.ok(
    "the first frame with rows holds the whole transcript",
    first[1] >= last[1] * WHOLE,
    `opened on ${first[1]} of ${last[1]} chars — a partial transcript that then grew`,
  );
  return await r.finish();
});
