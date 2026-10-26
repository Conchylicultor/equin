/**
 * The turn ledger against a real Claude session: every turn the app sends gets
 * a `conversation_turns` row confirmed by the agent's own `turn_started`, which
 * echoes the row's id and names the transcript line it became (`prompt_uuid`)
 * — never by matching transcript text.
 *
 *   1. Send → the row reaches `accepted`, and the pane shows no card for it.
 *   2. Send while the agent is busy → `accepted` when the agent queues it,
 *      while the conversation is still `working`.
 *   3. Stop, then a different turn: Stop returns exactly the stopped turn's
 *      row (found by its transcript uuid) and hands back that row's own text;
 *      the next turn is accepted alone. P is a harmless counting turn, not
 *      Push & Close: a wrap-up prompt the Stop came too late for would push
 *      the throwaway attempt.
 *   4. Identity: the launch turn and every accepted turn carry their own
 *      `prompt_uuid`, and the transcript holds a line under each — a user
 *      line, or the `queued_command` attachment of a turn the busy agent
 *      absorbed (`source_uuid`) — which is what retires each echo; the pane
 *      shows no card for any of them.
 *
 * It creates its own throwaway conversation (Haiku) and acts only on that one:
 * agent processes and transcripts live in `~/.claude`, so driving a
 * conversation this deploy merely inherited from main's database would type
 * into the real one. The ledger is read from this deploy's database
 * (read-only).
 *
 * `--attempt` names the attempt whose worktree the session runs in (it touches
 * no file). Spawns a real agent — run it deliberately.
 *
 *   ./equin run plugins/conversations/plugins/turn-ledger/e2e/send-flow.ts --attempt <attempt-id>
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
  text: string;
  typed_text: string;
  error: string | null;
  prompt_uuid: string | null;
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
    `SELECT id, state, text, typed_text, error, prompt_uuid
       FROM conversation_turns WHERE id = $1`,
    [turnId],
  );
  return row ?? null;
}

/** Wait for a turn's row to reach one of `states`; returns the row either way. */
async function awaitTurn(
  turnId: string,
  states: readonly TurnState[],
  intervalMs = 250,
): Promise<LedgerRow | null> {
  const settled = await waitFor(
    () => ledgerRow(turnId),
    (row) => row !== null && states.includes(row.state),
    { timeoutMs: TURN_BUDGET_MS, intervalMs },
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

  // 1. An idle agent: it confirms the turn by its id.
  const first = await send(conv.id, "Reply with only the word ALPHA.");
  const firstRow = await awaitTurn(first, ["accepted", "failed"]);
  r.ok(
    `an idle send is accepted (got ${firstRow?.state ?? "no row"})`,
    firstRow?.state === "accepted",
  );
  await awaitStatus(conv.id, "waiting");

  await withBrowser(async (h) => {
    const { page } = await h.session();
    await boot(page, pathUrl(`/agents/c/${conv.id}`), {
      marker: "[data-event-index]",
      settleMs: 2500,
    });
    const cards = page.getByText(
      /Sending…|Waiting for the agent|Failed to send/,
    );
    r.ok(
      `no pending card once the turn is accepted (found ${await cards.count()})`,
      (await cards.count()) === 0,
    );
  });

  // 2. A busy agent: it confirms the turn when it queues it.
  await send(
    conv.id,
    "Count from 1 to 300, one number per line, and nothing else.",
  );
  await awaitStatus(conv.id, "working");
  const queued = await send(conv.id, "Then reply with only the word BETA.");
  const queuedRow = await awaitTurn(queued, ["accepted", "failed"]);
  const stillWorking = await api<{ status: string }>(
    `/api/conversations/${conv.id}`,
  );
  r.ok(
    `a turn sent while busy is accepted (got ${queuedRow?.state ?? "no row"})`,
    queuedRow?.state === "accepted",
  );
  r.note(`status when the queued turn was accepted: ${stillWorking.status}`);
  await awaitStatus(conv.id, "waiting");

  // 3. Stop takes back exactly the stopped turn, then a different turn goes alone.
  //    Stop takes a turn back only while it has no reply yet, and Haiku starts
  //    answering about a second after it takes the turn: Stop as soon as the
  //    row is accepted (the agent took it), and try again when the reply won
  //    the race (Stop then rightly keeps the turn).
  const STOP_TRIES = 3;
  let stopped: string | null = null;
  let stop: { ok: boolean; rewindText: string | null } = {
    ok: false,
    rewindText: null,
  };
  for (let attempt = 1; attempt <= STOP_TRIES; attempt++) {
    stopped = await send(
      conv.id,
      "Count from 1 to 500, one number per line, and nothing else.",
    );
    await awaitTurn(stopped, ["accepted", "failed"], 25);
    stop = await post<{ ok: boolean; rewindText: string | null }>(
      `/api/conversations/${conv.id}/stop`,
      {},
    );
    if (stop.rewindText !== null) break;
    r.note(
      `stop try ${attempt}: the turn already had a reply, so Stop kept it`,
    );
    await awaitStatus(conv.id, "waiting");
  }
  const stoppedRow = stopped === null ? null : await ledgerRow(stopped);
  r.ok(
    `the stopped turn's own row is returned (got ${stoppedRow?.state ?? "no row"}, prompt_uuid ${stoppedRow?.prompt_uuid ?? "none"})`,
    stoppedRow?.state === "returned" && stoppedRow.prompt_uuid !== null,
  );
  r.ok(
    `Stop hands back that row's text as the draft (got ${JSON.stringify(stop.rewindText)})`,
    stoppedRow !== null && stop.rewindText === stoppedRow.text,
  );
  await awaitStatus(conv.id, "waiting");
  const B = "Reply with only the word GAMMA.";
  const after = await send(conv.id, B);
  const afterRow = await awaitTurn(after, ["accepted", "failed"]);
  r.ok(
    `the turn after Stop is accepted (got ${afterRow?.state ?? "no row"})`,
    afterRow?.state === "accepted" && afterRow.typed_text === B,
  );

  // 4. Identity: every confirmed turn — the launch prompt included — is
  //    confirmed by its own id and names its own transcript line.
  const launchRows = await db.query<LedgerRow>(
    `SELECT id, state, text, typed_text, error, prompt_uuid
       FROM conversation_turns WHERE conversation_id = $1 AND kind = 'launch'`,
    [conv.id],
  );
  const confirmed = [launchRows[0] ?? null, firstRow, queuedRow, afterRow];
  const uuids = confirmed.map((row) => row?.prompt_uuid ?? null);
  r.ok(
    `the launch turn and each accepted turn carry a transcript uuid (got ${JSON.stringify(uuids)})`,
    confirmed.every((row) => row?.state === "accepted") &&
      uuids.every((uuid) => uuid !== null),
  );
  r.ok(
    "each turn's transcript uuid is its own",
    new Set(uuids).size === uuids.length,
  );

  // The line each echo retires on: a user line under the uuid, or a busy
  // agent's `queued_command` attachment naming it.
  // The agent confirms a turn as it hands it to Claude Code, which writes the
  // line a moment later: wait for it (bounded) rather than read once.
  const missingLines = async (): Promise<(string | null)[]> => {
    const { paths } = await api<{ paths: string[] }>(
      `/api/conversations/${conv.id}/transcript`,
    );
    const lines = (
      await Promise.all(paths.map((path) => Bun.file(path).text()))
    ).join("\n");
    return uuids.filter(
      (uuid) =>
        uuid === null ||
        !(
          lines.includes(`"uuid":"${uuid}"`) ||
          lines.includes(`"source_uuid":"${uuid}"`)
        ),
    );
  };
  const missing = (
    await waitFor(missingLines, (left) => left.length === 0, {
      timeoutMs: 30_000,
      intervalMs: 250,
    })
  ).value;
  r.ok(
    `the transcript holds a line under each turn's uuid (missing ${JSON.stringify(missing)})`,
    missing.length === 0,
  );
  await withBrowser(async (h) => {
    const { page } = await h.session();
    await boot(page, pathUrl(`/agents/c/${conv.id}`), {
      marker: "[data-event-index]",
      settleMs: 2500,
    });
    const cards = page.getByText(
      /Sending…|Waiting for the agent|Failed to send/,
    );
    r.ok(
      `every echo retired on its line (pending cards: ${await cards.count()})`,
      (await cards.count()) === 0,
    );
  });
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
