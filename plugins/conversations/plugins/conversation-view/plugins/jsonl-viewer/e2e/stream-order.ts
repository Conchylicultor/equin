/**
 * The message being written streams every block — thinking, text, a tool
 * call — in the order its rows will stand, and each stand-in gives way to its
 * transcript row without ever sitting below a row that follows it.
 *
 * One throwaway conversation (closed and deleted after) in the worktree of
 * `--attempt`, one turn that thinks, says one sentence and calls Write. The
 * page records, on every DOM change until the Write call's row has landed,
 * the stand-ins (`[data-stand-in]`) and the turn's new rows, in document
 * order. Checks:
 *
 *   - every block that landed was drawn as a stand-in first (thinking only
 *     when the model thought — it decides per turn);
 *   - the Write stand-in showed its file path (the partial input reached the
 *     renderer; the card opens collapsed, so its content is not on screen);
 *   - at every change, the turn's rows and stand-ins read thinking → text →
 *     tool call, and no block was drawn twice (stand-in and row at once).
 *
 * Spawns a real agent — run it deliberately.
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/e2e/stream-order.ts --attempt <attempt-id>
 */
import {
  agentFetch,
  boot,
  pathUrl,
  report,
  requireArg,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const MODEL = "sonnet-5-5";
const TURN_BUDGET_MS = 240_000;
const attemptId = requireArg(
  "attempt",
  "usage: --attempt <attempt-id>  (the attempt whose worktree the throwaway session runs in)",
);

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

/** What the page recorded over the turn. */
interface Recording {
  /** Every distinct reading: the turn's blocks in document order, `~` marking a stand-in. */
  readings: string[];
  /** Readings out of order, or with a block drawn twice. */
  violations: string[];
  /** Distinct text lengths of the Write stand-in. */
  toolLengths: number[];
  /** When (ms after Enter) each reading and each Write stand-in length was first seen. */
  log: string[];
  /** Kinds seen as stand-ins before their first row. */
  streamedFirst: string[];
  /** Kinds whose row landed. */
  landed: string[];
  /** The Write stand-in named its file before the call landed. */
  toolShowedPath: boolean;
  done: boolean;
}

const created: string[] = [];
const r = report("every block streams, in order");

try {
  await withBrowser(async (h) => {
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
    const editor = page.locator(
      '[role="textbox"][aria-placeholder^="Send a message"]',
    );
    await editor.click();
    await page.keyboard.type(
      `Think it over first. Then say, in one short sentence, what you are about to do. Then use the Write tool to create /tmp/stream-order-${conv.id}.txt holding the numbers 1 to 300, one per line. After the tool call, reply with only Done.`,
    );
    await page.evaluate(() => {
      const RANK: { [kind: string]: number } = {
        "assistant-thinking": 0,
        "assistant-text": 1,
        "tool-call": 2,
      };
      const kindOfKey = (key: string) =>
        key.startsWith("tool:")
          ? "tool-call"
          : key.startsWith("assistant-thinking:")
            ? "assistant-thinking"
            : key.startsWith("assistant-text:")
              ? "assistant-text"
              : null;
      const before = new Set(
        [...document.querySelectorAll("[data-event-key]")].map((e) =>
          e.getAttribute("data-event-key"),
        ),
      );
      const rec: Recording = {
        readings: [],
        violations: [],
        toolLengths: [],
        log: [],
        streamedFirst: [],
        landed: [],
        toolShowedPath: false,
        done: false,
      };
      (window as unknown as { __rec: Recording }).__rec = rec;
      const landed = new Set<string>();
      const observer = new MutationObserver(() => {
        const items = [
          ...document.querySelectorAll("[data-event-key], [data-stand-in]"),
        ].flatMap((e) => {
          const standIn = e.getAttribute("data-stand-in");
          if (standIn) return [{ kind: standIn, standIn: true, el: e }];
          const key = e.getAttribute("data-event-key")!;
          const kind = kindOfKey(key);
          return kind && !before.has(key) && !e.closest("[data-stand-in]")
            ? [{ kind, standIn: false, el: e }]
            : [];
        });
        const reading = items
          .map((i) => (i.standIn ? "~" : "") + i.kind)
          .join(" ");
        const at = Math.round(performance.now() - t0);
        if (reading !== rec.readings.at(-1)) {
          rec.readings.push(reading);
          rec.log.push(`${at} ms  ${reading || "(nothing)"}`);
        }
        for (const i of items) {
          if (
            i.standIn &&
            !landed.has(i.kind) &&
            !rec.streamedFirst.includes(i.kind)
          )
            rec.streamedFirst.push(i.kind);
          if (!i.standIn) {
            landed.add(i.kind);
            if (!rec.landed.includes(i.kind)) rec.landed.push(i.kind);
          }
          if (i.standIn && i.kind === "tool-call") {
            const text = i.el.textContent ?? "";
            if (text.includes("/tmp/stream-order-")) rec.toolShowedPath = true;
            const len = text.length;
            if (!rec.toolLengths.includes(len)) {
              rec.toolLengths.push(len);
              rec.log.push(`${at} ms  Write stand-in: ${len} chars`);
            }
          }
        }
        const ranks = items.map((i) => RANK[i.kind]!);
        if (ranks.some((rank, n) => n > 0 && rank < ranks[n - 1]!))
          rec.violations.push(`out of order: ${reading}`);
        for (const kind of ["assistant-thinking", "tool-call"])
          if (
            items.some((i) => i.kind === kind && i.standIn) &&
            items.some((i) => i.kind === kind && !i.standIn)
          )
            rec.violations.push(`drawn twice: ${reading}`);
        // The Write call has landed: the message is over.
        if (items.some((i) => i.kind === "tool-call" && !i.standIn)) {
          rec.done = true;
          observer.disconnect();
        }
      });
      const t0 = performance.now();
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    await page.keyboard.press("Enter");
    const settled = await waitFor(
      () =>
        page.evaluate(() => (window as unknown as { __rec: Recording }).__rec),
      (rec) => rec.done,
      { timeoutMs: TURN_BUDGET_MS, intervalMs: 200 },
    );
    const rec = settled.value;
    r.note(
      `${rec.readings.length} readings; last: ${rec.readings.at(-1) ?? "—"}`,
    );
    for (const line of rec.log.slice(0, 60)) r.note(`  ${line}`);
    r.ok("the Write call landed", rec.done);
    r.ok(
      `every landed block streamed first (landed: ${rec.landed.join(", ")}; streamed first: ${rec.streamedFirst.join(", ") || "none"})`,
      rec.landed.every((kind) => rec.streamedFirst.includes(kind)),
    );
    if (!rec.landed.includes("assistant-thinking"))
      r.note("the model did not think this turn: thinking not exercised");
    r.ok(
      "the Write call streamed before its row",
      rec.streamedFirst.includes("tool-call"),
    );
    r.ok(
      "the Write stand-in showed its file path before the call landed",
      rec.toolShowedPath,
    );
    r.ok(
      `always in order, never drawn twice${rec.violations.length ? `: ${rec.violations.slice(0, 5).join(" | ")}` : ""}`,
      rec.violations.length === 0,
    );
    await awaitStatus(conv.id, "waiting");
  });
} finally {
  for (const id of created) {
    await agentFetch(`/api/conversations/${id}/close`, { method: "POST" });
    await agentFetch(`/api/conversations?name=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
}
await r.finish();
