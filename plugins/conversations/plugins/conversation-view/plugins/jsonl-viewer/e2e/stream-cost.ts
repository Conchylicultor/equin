/**
 * What streaming a large tool input costs: the wire bytes the
 * `conversations.partial-message` value ships, and the page's main-thread time,
 * while the agent writes one big file with `Write`.
 *
 * One throwaway conversation (closed and deleted after) in the worktree of
 * `--attempt`, one turn that calls Write with ~`--kb` KB of content. Two
 * browser contexts watch it:
 *
 *   - A, tapped (`tapSharedSocket`): every frame of the partial message —
 *     count, bytes, the largest, and the amplification (bytes shipped over the
 *     size of the input written);
 *   - B, untapped (the tap's own relay would be page cost): CDP
 *     `Performance.getMetrics` between the first partial frame A saw and the
 *     Write row landing — script, layout and style time, per second of stream.
 *
 * Reported, not asserted, except `--max-amplification` (fail above it). The
 * SharedWorker's own frame parsing is not in B's page metrics.
 *
 * Spawns a real agent — run it deliberately.
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/e2e/stream-cost.ts --attempt <attempt-id> [--kb 30] [--max-amplification 0]
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
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";
import { parsePartialJson } from "@plugins/packages/plugins/partial-json/core";
import {
  applyValuePatch,
  type ValuePatchWireOp,
} from "@plugins/packages/plugins/value-patch/core";

const MODEL = "sonnet-5-5";
const TURN_BUDGET_MS = 420_000;
const KEY = "conversations.partial-message";
const attemptId = requireArg(
  "attempt",
  "usage: --attempt <attempt-id>  (the attempt whose worktree the throwaway session runs in)",
);
const KB = numArg("kb", 30);
const MAX_AMPLIFICATION = numArg("max-amplification", 0);

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

interface Frame {
  at: number;
  kind: string;
  bytes: number;
}

/** The partial message as the page holds it after the frames seen so far. */
let held: unknown = null;
/** The tool input's JSON as the page holds it after a frame — the longest seen. */
let toolInput = "";
/** The tool input's length after each frame that grew it: the prefixes the page parsed. */
const prefixLengths: number[] = [];

const METRICS = [
  "ScriptDuration",
  "TaskDuration",
  "LayoutDuration",
  "RecalcStyleDuration",
] as const;

/**
 * The tool block's input JSON in the partial message the page holds.
 */
function toolInputOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const blocks = (value as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks as { kind?: string; inputJson?: string }[])
    if (b.kind === "tool_use" && typeof b.inputJson === "string")
      return b.inputJson;
  return null;
}

const created: string[] = [];
const r = report(`streaming a ~${KB} KB Write`);

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

    const a = await h.session({ label: "A" });
    const tap = await tapSharedSocket(a.page);
    const frames: Frame[] = [];
    const t0 = Date.now();
    tap.onFrame((f) => {
      if (!f.data.includes(`"${KEY}"`)) return;
      const m = JSON.parse(f.data) as {
        kind?: string;
        value?: unknown;
        ops?: ValuePatchWireOp[];
      };
      // The value the page holds after this frame: a whole one, or the
      // previous one patched.
      if (m.kind === "patch") held = applyValuePatch(held, m.ops ?? []);
      else if (m.kind === "update" || m.kind === "sub-ack") held = m.value;
      const input = toolInputOf(held);
      if (input !== null && input.length > toolInput.length) {
        toolInput = input;
        prefixLengths.push(input.length);
      }
      frames.push({
        at: Date.now() - t0,
        kind: String(m.kind),
        bytes: new TextEncoder().encode(f.data).length,
      });
    });
    const b = await h.session({ label: "B" });
    const cdp = await b.context.newCDPSession(b.page);
    await cdp.send("Performance.enable");
    const metrics = async (): Promise<Record<string, number>> => {
      const { metrics: list } = await cdp.send("Performance.getMetrics");
      return Object.fromEntries(list.map((m) => [m.name, m.value]));
    };

    const url = pathUrl(`/agents/c/${conv.id}`);
    await boot(a.page, url, { marker: "[data-event-key]", settleMs: 2000 });
    await boot(b.page, url, { marker: "[data-event-key]", settleMs: 2000 });

    const landed = (page: typeof a.page) =>
      page.evaluate(
        () =>
          [...document.querySelectorAll("[data-event-key]")].filter((e) =>
            e.getAttribute("data-event-key")!.startsWith("tool:"),
          ).length,
      );
    const callsBefore = await landed(b.page);

    const editor = a.page.locator(
      '[role="textbox"][aria-placeholder^="Send a message"]',
    );
    await editor.click();
    await a.page.keyboard.type(
      `Do not think and do not say anything first. Use the Write tool, straight away, to create /tmp/stream-cost-${conv.id}.md holding a plain-prose essay about the history of bridges of about ${KB * 1000} characters (${Math.round(KB * 150)} words) — long paragraphs, no headings or lists. After the tool call, reply with only Done.`,
    );
    await a.page.keyboard.press("Enter");

    // The window: from the first partial frame after the turn was sent to
    // the Write row landing in B.
    const firstFrame = await waitFor(
      async () => frames.filter((f) => f.kind !== "sub-ack").length,
      (n) => n > 1,
      { timeoutMs: TURN_BUDGET_MS, intervalMs: 50 },
    );
    if (!firstFrame.ok) throw new Error("no partial frame arrived");
    const startAt = Date.now() - t0;
    const m0 = await metrics();
    const done = await waitFor(
      () => landed(b.page),
      (n) => n > callsBefore,
      { timeoutMs: TURN_BUDGET_MS, intervalMs: 100 },
    );
    const m1 = await metrics();
    const endAt = Date.now() - t0;
    r.ok("the Write call landed", done.ok);

    const window = frames.filter((f) => f.at >= startAt && f.at <= endAt);
    if (window.length === 0)
      throw new Error("no partial frame in the stream window");
    const all = frames.filter((f) => f.at <= endAt);
    const seconds = (endAt - startAt) / 1000;
    const bytes = all.reduce((s, f) => s + f.bytes, 0);
    const kinds = [...new Set(all.map((f) => f.kind))].join(", ");
    const largest = Math.max(...all.map((f) => f.bytes));
    const contentBytes = toolInput.length;
    r.note(
      `stream: ${seconds.toFixed(1)} s, ${all.length} partial frames (${kinds}), ${(bytes / 1024).toFixed(0)} KB total, largest ${(largest / 1024).toFixed(1)} KB`,
    );
    r.note(
      `wire: ${(window.reduce((s, f) => s + f.bytes, 0) / 1024 / seconds).toFixed(1)} KB/s, ${(window.length / seconds).toFixed(1)} frames/s`,
    );
    const amplification = bytes / contentBytes;
    r.note(
      `amplification: ${amplification.toFixed(1)}× the ${(contentBytes / 1024).toFixed(1)} KB tool input written`,
    );
    // What the page's partial-JSON parse costs over the stream: every prefix
    // it was handed, re-parsed here (the same code; bun, not the page's V8).
    const parseStart = performance.now();
    for (const len of prefixLengths) parsePartialJson(toolInput.slice(0, len));
    const parseMs = performance.now() - parseStart;
    r.note(
      `partial-JSON parse: ${prefixLengths.length} prefixes, ${parseMs.toFixed(0)} ms total, ${(parseMs / Math.max(1, prefixLengths.length)).toFixed(2)} ms each at the end-weighted mean`,
    );
    for (const name of METRICS) {
      const ms = ((m1[name] ?? 0) - (m0[name] ?? 0)) * 1000;
      r.note(
        `page B ${name}: ${ms.toFixed(0)} ms (${(ms / seconds).toFixed(1)} ms per s of stream)`,
      );
    }
    if (MAX_AMPLIFICATION > 0)
      r.ok(
        `amplification ≤ ${MAX_AMPLIFICATION}×`,
        amplification <= MAX_AMPLIFICATION,
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
