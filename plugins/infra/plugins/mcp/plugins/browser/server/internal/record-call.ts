import { browserRecordingsDir } from "@plugins/debug/plugins/browser-recordings/data-dirs";
import { openRecording } from "@plugins/debug/plugins/browser-recordings/plugins/writer/core";
import type { HostCallBody, HostToolResult } from "../../shared/protocol";
import { callHostTool } from "./host-client";

/**
 * Run one page-changing call and record it under its tool call: a one-step
 * recording whose frame is the tab's viewport once the page settled after the
 * call (loaded, painted, nothing `aria-busy`, at most {@link SETTLE_CAP_MS} later), so
 * the conversation shows what the agent's action led to under the call.
 *
 * The frame is taken here, through the host's own `browser_screenshot`, not
 * inside the host: the host is shared by every checkout and only main
 * replaces it, so a capture living there would ship only once merged and
 * restart every agent's tabs on the way.
 *
 * A failed call is recorded too (its frame is what the failure left), then
 * re-thrown. A recording that fails never fails the call — the action already
 * happened, and an agent told it failed would repeat it — but it is said in
 * the result, never dropped.
 */
export async function recordedCall(
  call: HostCallBody,
  toolUseId: string,
): Promise<HostToolResult> {
  const recording = openRecording({
    root: browserRecordingsDir.path,
    toolUseId,
    source: { kind: "mcp", tool: call.tool },
    name: call.tool,
  });
  const startMs = recording.elapsedMs();
  const outcome = await callHostTool(call).then(
    (result) => ({ ok: true as const, result }),
    (err: unknown) => ({ ok: false as const, err }),
  );
  const durationMs = recording.elapsedMs() - startMs;

  const recorded = await (async () => {
    // Film what the call led to, not the instant it returned: a navigate
    // returns once the document loaded, before the app has its data.
    await callHostTool({
      ...call,
      tool: "browser_javascript",
      args: { tab: tabArg(call.args), code: SETTLE_SCRIPT },
    });
    const shot = await callHostTool({
      ...call,
      tool: "browser_screenshot",
      args: { tab: tabArg(call.args) },
    });
    const image = shot.content.find((c) => c.type === "image");
    if (image === undefined)
      throw new Error("browser_screenshot answered without an image");
    const frame = await recording.frame(
      Buffer.from(image.data, "base64"),
      "png",
    );
    await recording.close([
      {
        title: stepTitle(call.tool, call.args),
        startMs,
        durationMs,
        ...(outcome.ok ? {} : { error: errorMessage(outcome.err) }),
        frame,
      },
    ]);
  })().then(
    () => null,
    (err: unknown) => errorMessage(err),
  );

  if (!outcome.ok) throw outcome.err;
  if (recorded === null) return outcome.result;
  return {
    content: [
      ...outcome.result.content,
      { type: "text", text: `(The call's recording failed: ${recorded})` },
    ],
  };
}

/** How long nothing may be loading before the page counts as settled. */
const QUIET_MS = 400;
/** The longest a recording delays the call's answer waiting for the page. */
const SETTLE_CAP_MS = 5_000;

/**
 * Run in the page (a `browser_javascript` body): resolves once the document
 * has loaded and painted its first content, its fonts are ready and no region
 * has been `aria-busy` (the `Loading` primitive's mark) for {@link QUIET_MS} —
 * or at the cap, filming whatever is there. Push-based: a MutationObserver re-arms the quiet window;
 * the two timers are deadlines, not polls.
 */
const SETTLE_SCRIPT = `
  const start = performance.now();
  const left = () => Math.max(0, ${SETTLE_CAP_MS} - (performance.now() - start));
  const within = (p) => Promise.race([p, new Promise((r) => setTimeout(r, left()))]);
  if (document.readyState !== "complete")
    await within(new Promise((r) => addEventListener("load", r, { once: true })));
  // A single-page app's document loads blank: nothing is on screen until it
  // paints its first text or image (the standard first-contentful-paint).
  if (performance.getEntriesByName("first-contentful-paint").length === 0)
    await within(new Promise((r) => {
      const po = new PerformanceObserver((list) => {
        if (list.getEntriesByName("first-contentful-paint").length > 0) { po.disconnect(); r(); }
      });
      po.observe({ type: "paint", buffered: true });
    }));
  await within(document.fonts.ready);
  const busy = () => document.querySelector('[aria-busy="true"]') !== null;
  await new Promise((resolve) => {
    let quiet = null;
    const done = () => { observer.disconnect(); clearTimeout(quiet); clearTimeout(cap); resolve(); };
    const arm = () => {
      clearTimeout(quiet);
      quiet = busy() ? null : setTimeout(done, ${QUIET_MS});
    };
    const observer = new MutationObserver(arm);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["aria-busy"],
    });
    const cap = setTimeout(done, left());
    arm();
  });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
`;

/** The tab the call acted on: the one it named, else the last one used. */
function tabArg(args: unknown): string | undefined {
  const tab = (args as { tab?: unknown } | null)?.tab;
  return typeof tab === "string" ? tab : undefined;
}

/** `act click e12`, `navigate /agents` — the call in a line. */
function stepTitle(tool: string, args: unknown): string {
  const parts = Object.entries((args ?? {}) as Record<string, unknown>)
    .filter(([key, value]) => key !== "tab" && value !== undefined)
    .map(([, value]) =>
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const title = [tool.replace(/^browser_/, ""), ...parts].join(" ");
  return title.length > 160 ? `${title.slice(0, 159)}…` : title;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
