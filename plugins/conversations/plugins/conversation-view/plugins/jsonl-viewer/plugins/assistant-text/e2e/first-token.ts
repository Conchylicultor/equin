/**
 * Send → the first visible word of the reply, in the page.
 *
 * For each turn it types a prompt into the composer, presses Enter, and times
 * (from just before Enter, in the page's own clock) when the page first draws:
 *
 *   - `stream` — text in the streaming block (`[data-streaming-message]`):
 *     what the reader sees first now;
 *   - `row` — the finished `assistant-text` row of the reply: what the reader
 *     saw first before token streaming, and still sees once the message ends.
 *
 * Then, in the last conversation, Stop mid-stream: the streaming block must
 * go (an interrupted message never lands in the transcript, so a block left
 * behind would stand forever).
 *
 * One run gives both, side by side, on the same turns. The replies are ~300
 * words of plain prose (Haiku), so `row - stream` is about how long a long
 * answer used to arrive all at once.
 *
 * It creates its own throwaway conversations (closed and deleted after) in
 * the worktree of `--attempt`; the prompts touch no file. Spawns real agents —
 * run it deliberately.
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/e2e/first-token.ts --attempt <attempt-id> [--conversations 2] [--turns 5]
 */
import {
  agentFetch,
  boot,
  numArg,
  pathUrl,
  report,
  requireArg,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const MODEL = "haiku-4-5";
const TURN_BUDGET_MS = 180_000;
const attemptId = requireArg(
  "attempt",
  "usage: --attempt <attempt-id>  (the attempt whose worktree the throwaway sessions run in)",
);
const conversations = numArg("conversations", 2);
const turns = numArg("turns", 5);

const TOPICS = [
  "the history of the bicycle",
  "how lighthouses work",
  "why bread rises",
  "the life cycle of a star",
  "how a canal lock works",
  "the history of the printing press",
  "how bees make honey",
  "why the sky is blue",
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await agentFetch(path, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok)
    throw new Error(
      `${init?.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`,
    );
  return (await res.json()) as T;
}

async function awaitStatus(id: string, status: string): Promise<void> {
  const settled = await waitFor(
    () => api<{ status: string }>(`/api/conversations/${id}`),
    (c) => c.status === status,
    { timeoutMs: TURN_BUDGET_MS, intervalMs: 500 },
  );
  if (!settled.ok)
    throw new Error(
      `conversation ${id} is ${settled.value.status}, wanted ${status}`,
    );
}

interface Timing {
  stream: number | null;
  row: number | null;
}

function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ]!;
}
const fmt = (xs: number[]) =>
  xs.length === 0
    ? "—"
    : `p50 ${(percentile(xs, 50) / 1000).toFixed(2)} s · p90 ${(percentile(xs, 90) / 1000).toFixed(2)} s (n=${xs.length})`;

const created: string[] = [];
const r = report("send → first visible token");
const streams: number[] = [];
const rows: number[] = [];

try {
  await withBrowser(async (h) => {
    for (let c = 0; c < conversations; c++) {
      const conv = await api<{ id: string }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({
          attemptId,
          model: MODEL,
          prompt: "Reply with only OK.",
        }),
      });
      created.push(conv.id);
      r.note(`throwaway conversation ${conv.id}`);
      await awaitStatus(conv.id, "waiting");

      const { page } = await h.session();
      await boot(page, pathUrl(`/agents/c/${conv.id}`), {
        marker: "[data-event-key]",
        settleMs: 2000,
      });
      // The composer itself (its placeholder is an overlay that takes no clicks).
      const editor = page.locator(
        '[role="textbox"][aria-placeholder^="Send a message"]',
      );

      for (let t = 0; t < turns; t++) {
        const topic = TOPICS[(c * turns + t) % TOPICS.length]!;
        await editor.click();
        await page.keyboard.type(
          `Write about 300 words of plain prose about ${topic}. No headings, no lists, no tools.`,
        );
        await page.evaluate(() => {
          const w = window as unknown as {
            __timing: { t0: number; stream: number | null; row: number | null };
          };
          const ROW = '[data-event-key^="assistant-text:"]';
          const PROMPT = '[data-event-key^="user-text:"]';
          const keys = (sel: string) =>
            new Set(
              [...document.querySelectorAll(sel)].map((e) =>
                e.getAttribute("data-event-key"),
              ),
            );
          const before = keys(`${ROW}, ${PROMPT}`);
          const isNew = (e: Element) =>
            !before.has(e.getAttribute("data-event-key"));
          w.__timing = { t0: 0, stream: null, row: null };
          const observer = new MutationObserver(() => {
            const now = performance.now();
            const timing = w.__timing;
            if (timing.stream === null) {
              const block = document.querySelector("[data-streaming-message]");
              if (block?.textContent?.trim()) timing.stream = now - timing.t0;
            }
            if (timing.row === null) {
              // The reply: a new assistant row after this turn's own prompt row.
              const prompt = [...document.querySelectorAll(PROMPT)].find(isNew);
              const reply =
                prompt &&
                [...document.querySelectorAll(ROW)].find(
                  (e) =>
                    isNew(e) &&
                    prompt.compareDocumentPosition(e) &
                      Node.DOCUMENT_POSITION_FOLLOWING,
                );
              if (reply) timing.row = now - timing.t0;
            }
            if (timing.stream !== null && timing.row !== null)
              observer.disconnect();
          });
          observer.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
          });
          w.__timing.t0 = performance.now();
        });
        await page.keyboard.press("Enter");
        const settled = await waitFor(
          () =>
            page.evaluate(
              () => (window as unknown as { __timing: Timing }).__timing,
            ),
          (timing) => timing.row !== null,
          { timeoutMs: TURN_BUDGET_MS, intervalMs: 100 },
        );
        const timing = settled.value;
        r.note(
          `turn ${c + 1}.${t + 1}: stream ${timing.stream === null ? "never" : `${timing.stream.toFixed(0)} ms`} · row ${timing.row === null ? "never" : `${timing.row.toFixed(0)} ms`}`,
        );
        if (timing.stream !== null) streams.push(timing.stream);
        if (timing.row !== null) rows.push(timing.row);
        await awaitStatus(conv.id, "waiting");
      }

      if (c === conversations - 1) {
        await editor.click();
        await page.keyboard.type(
          "Write about 1500 words of plain prose about the history of maps. No headings, no lists, no tools.",
        );
        await page.keyboard.press("Enter");
        const block = page.locator("[data-streaming-message]");
        await block.waitFor({ state: "visible", timeout: TURN_BUDGET_MS });
        await api(`/api/conversations/${conv.id}/stop`, {
          method: "POST",
          body: "{}",
        });
        const gone = await block
          .waitFor({ state: "detached", timeout: 10_000 })
          .then(() => true)
          .catch((err: unknown) => {
            if (err instanceof Error && err.name === "TimeoutError")
              return false;
            throw err;
          });
        r.ok("Stop mid-stream clears the streaming block", gone);
        await awaitStatus(conv.id, "waiting");
      }
    }
  });
  r.note(`first streamed text (after): ${fmt(streams)}`);
  r.note(`finished row (before): ${fmt(rows)}`);
  r.ok(
    `every turn streamed before its finished row (${streams.length}/${rows.length})`,
    streams.length === conversations * turns &&
      rows.length === conversations * turns,
  );
} finally {
  for (const id of created) {
    await agentFetch(`/api/conversations/${id}/close`, { method: "POST" });
    await agentFetch(`/api/conversations?name=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
}
await r.finish();
