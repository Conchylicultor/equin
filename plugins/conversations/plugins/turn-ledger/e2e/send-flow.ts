/**
 * The turn ledger against a real Claude session: every turn the app types gets
 * a `conversation_turns` row whose verdict comes from the CLI's own
 * UserPromptSubmit hook — never from matching transcript text.
 *
 *   1. Send → the row reaches `accepted`, and the pane shows no card for it.
 *   2. Send while the agent is busy → `accepted` at Enter (the hook fires on
 *      enqueue), while the conversation is still `working`.
 *   3. The incident replay (research/2026-10-15-conversations-turn-ledger.md):
 *      a turn P, Stop (the CLI puts P back in its input box; Stop's rewind
 *      hands it to the draft), then a different turn B. P's row is `returned`
 *      and B's is `accepted` with exactly B — the box was emptied before B was
 *      typed, so the CLI never submitted `P+B`. P is a harmless counting turn,
 *      not Push & Close: a wrap-up prompt the Stop came too late for would
 *      push the throwaway attempt.
 *
 * Not covered here: a server killed mid-send, whose mailbox file confirms the
 * row on the next boot — `server/internal/mailbox.test.ts` pins the boot drain.
 *
 * It creates its own throwaway conversation (Haiku) and acts only on that one:
 * panes share one tmux server and transcripts live in `~/.claude`, so driving a
 * conversation this deploy merely inherited from main's database would type
 * into the real one. The ledger is read from this deploy's database
 * (read-only).
 *
 * `--attempt` names the attempt whose worktree the session runs in (it touches
 * no file). Spawns a real agent — run it deliberately.
 *
 *   ./singularity run plugins/conversations/plugins/turn-ledger/e2e/send-flow.ts --attempt <attempt-id>
 */
import {
  agentFetch,
  boot,
  openDeployDb,
  pathUrl,
  report,
  requireArg,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  turnIdKind,
  type TurnState,
} from "@plugins/conversations/plugins/turn-ledger/core";

const MODEL = "haiku-4-5";
const TURN_BUDGET_MS = 120_000;
const attemptId = requireArg(
  "attempt",
  "usage: --attempt <attempt-id>  (the attempt whose worktree the throwaway session runs in)",
);

interface LedgerRow extends Record<string, unknown> {
  id: string;
  state: TurnState;
  typed_text: string;
  submitted_text: string | null;
  extra_text: string | null;
  error: string | null;
}

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
const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

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

const db = openDeployDb();

async function ledgerRow(turnId: string): Promise<LedgerRow | null> {
  const [row] = await db.query<LedgerRow>(
    `SELECT id, state, typed_text, submitted_text, extra_text, error
       FROM conversation_turns WHERE id = $1`,
    [turnId],
  );
  return row ?? null;
}

/** Wait for a turn's row to reach one of `states`; returns the row either way. */
async function awaitTurn(
  turnId: string,
  states: readonly TurnState[],
): Promise<LedgerRow | null> {
  const settled = await waitFor(
    () => ledgerRow(turnId),
    (row) => row !== null && states.includes(row.state),
    { timeoutMs: TURN_BUDGET_MS, intervalMs: 250 },
  );
  return settled.value;
}

/** Send a user turn under a fresh client-minted id, as the web does. */
async function send(conversationId: string, text: string): Promise<string> {
  const turnId = turnIdKind.mint();
  const res = await post<{ turnId: string }>(
    `/api/conversations/${conversationId}/turn`,
    { text, turnId },
  );
  if (res.turnId !== turnId)
    throw new Error(`the server answered turn ${res.turnId}, sent ${turnId}`);
  return turnId;
}

const created: string[] = [];
const r = report("turn ledger: send, send while busy, stop then send");

try {
  const conv = await post<{ id: string }>("/api/conversations", {
    attemptId,
    model: MODEL,
    prompt: "Reply with only OK.",
  });
  created.push(conv.id);
  r.note(`throwaway conversation ${conv.id}`);
  await awaitStatus(conv.id, "waiting");

  // 1. An idle agent: the hook confirms the exact text.
  const first = await send(conv.id, "Reply with only the word ALPHA.");
  const firstRow = await awaitTurn(first, ["accepted", "merged", "failed"]);
  r.ok(
    `an idle send is accepted (got ${firstRow?.state ?? "no row"})`,
    firstRow?.state === "accepted",
  );
  r.ok(
    "an accepted turn carries no submitted text of its own",
    firstRow?.submitted_text === null,
  );
  await awaitStatus(conv.id, "waiting");

  await withBrowser(async (h) => {
    const { page } = await h.session();
    await boot(page, pathUrl(`/agents/c/${conv.id}`), {
      marker: "[data-event-index]",
      settleMs: 2500,
    });
    const cards = page.getByText(/Sending…|Not confirmed|Failed to send/);
    r.ok(
      `no pending card once the turn is accepted (found ${await cards.count()})`,
      (await cards.count()) === 0,
    );
  });

  // 2. A busy agent: the hook fires at Enter, carrying the running prompt's id.
  await send(
    conv.id,
    "Count from 1 to 300, one number per line, and nothing else.",
  );
  await awaitStatus(conv.id, "working");
  const queued = await send(conv.id, "Then reply with only the word BETA.");
  const queuedRow = await awaitTurn(queued, ["accepted", "merged", "failed"]);
  const stillWorking = await api<{ status: string }>(
    `/api/conversations/${conv.id}`,
  );
  r.ok(
    `a turn sent while busy is accepted (got ${queuedRow?.state ?? "no row"})`,
    queuedRow?.state === "accepted",
  );
  r.note(`status when the queued turn was accepted: ${stillWorking.status}`);
  await awaitStatus(conv.id, "waiting");

  // 3. Stop, then a different turn: never `P+B`.
  const stopped = await send(
    conv.id,
    "Count from 1 to 500, one number per line, and nothing else.",
  );
  await awaitStatus(conv.id, "working");
  const stop = await post<{ ok: boolean; rewindText: string | null }>(
    `/api/conversations/${conv.id}/stop`,
    {},
  );
  r.ok(
    "Stop hands the stopped turn back as the draft",
    stop.rewindText?.includes("1 to 500") ?? false,
  );
  const stoppedRow = await awaitTurn(stopped, ["returned"]);
  r.ok(
    `the stopped turn is returned (got ${stoppedRow?.state ?? "no row"})`,
    stoppedRow?.state === "returned",
  );
  await awaitStatus(conv.id, "waiting");
  const B = "Reply with only the word GAMMA.";
  const after = await send(conv.id, B);
  const afterRow = await awaitTurn(after, ["accepted", "merged", "failed"]);
  r.ok(
    `the turn after Stop is accepted alone (got ${afterRow?.state ?? "no row"}${afterRow?.extra_text ? `, merged with ${JSON.stringify(afterRow.extra_text)}` : ""})`,
    afterRow?.state === "accepted" && afterRow.typed_text === B,
  );
} finally {
  // Close first (so the status reconciler files it as done, not as hibernated
  // work to come back to), then kill the pane.
  for (const id of created) {
    await agentFetch(`/api/conversations/${id}/close`, { method: "POST" });
    await agentFetch(`/api/conversations?name=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  await db.close();
}
await r.finish();
