/**
 * Drives "Fork from here" and "Rewind to here" against real Claude sessions and
 * checks what the MODEL remembers afterwards — the only observation that proves
 * the cut reached the process, not just the transcript view.
 *
 * It creates its own throwaway conversation (Haiku, two one-word turns) and acts
 * only on that one. That is not tidiness: transcripts live in `~/.claude` and
 * panes on one tmux server, both shared by every worktree, so rewinding a
 * conversation this deploy merely inherited from main's database would cut the
 * real one.
 *
 * `--attempt` names the attempt whose worktree the throwaway sessions run in
 * (they never touch a file). Reusing an attempt avoids a worktree checkout.
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/rewind/e2e/rewind.ts --attempt <attempt-id>
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

const MODEL = "haiku-4-5";
const TURN_BUDGET_MS = 120_000;
const attemptId = requireArg(
  "attempt",
  "usage: --attempt <attempt-id>  (the attempt whose worktree the throwaway sessions run in)",
);

interface Turn {
  role: "user" | "assistant";
  text: string;
}
interface UserTextEvent {
  kind: string;
  text?: string;
  uuid?: string;
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

const turnsOf = async (id: string) =>
  (await api<{ turns: Turn[] }>(`/api/conversations/${id}/turns`)).turns;

/** Wait until the conversation holds `count` assistant turns, and return them all. */
async function awaitReplies(id: string, count: number): Promise<Turn[]> {
  const settled = await waitFor(
    () => turnsOf(id),
    (turns) => turns.filter((t) => t.role === "assistant").length >= count,
    { timeoutMs: TURN_BUDGET_MS, intervalMs: 1000 },
  );
  if (!settled.ok)
    throw new Error(`conversation ${id} never reached ${count} replies`);
  return settled.value;
}

async function awaitStatus(id: string, status: string): Promise<void> {
  const settled = await waitFor(
    () => api<{ status: string }>(`/api/conversations/${id}`),
    (c) => c.status === status,
    { timeoutMs: TURN_BUDGET_MS, intervalMs: 1000 },
  );
  if (!settled.ok)
    throw new Error(
      `conversation ${id} is ${settled.value.status}, wanted ${status}`,
    );
}

async function ask(id: string, text: string, replies: number): Promise<string> {
  await awaitStatus(id, "waiting");
  await post(`/api/conversations/${id}/turn`, { text });
  const turns = await awaitReplies(id, replies);
  return turns.filter((t) => t.role === "assistant").at(-1)?.text ?? "";
}

async function userRows(id: string): Promise<UserTextEvent[]> {
  const body = await api<UserTextEvent[] | { value: UserTextEvent[] }>(
    `/api/resources/jsonl-events?id=${encodeURIComponent(id)}`,
  );
  const events = Array.isArray(body) ? body : body.value;
  return events.filter((e) => e.kind === "user-text");
}

const REWIND = "Rewind to here";
const RECALL =
  "List every word I asked you to remember so far. Reply with the words only.";
const created: string[] = [];
const r = report("rewind + fork from a message");

try {
  const conv = await post<{ id: string }>("/api/conversations", {
    attemptId,
    model: MODEL,
    prompt: "Remember the word APPLE. Reply with only OK.",
  });
  created.push(conv.id);
  r.note(`throwaway conversation ${conv.id}`);
  await awaitReplies(conv.id, 1);
  await ask(conv.id, "Remember the word BANANA. Reply with only OK.", 2);

  const rows = await userRows(conv.id);
  const apple = rows.find((e) => e.text?.includes("APPLE"));
  const banana = rows.find((e) => e.text?.includes("BANANA"));
  r.ok(
    "both user messages carry their transcript line id",
    !!apple?.uuid && !!banana?.uuid,
  );
  if (!apple?.uuid || !banana?.uuid)
    throw new Error("no uuid on the user rows");
  const sessionBefore = (
    await api<{ claudeSessionId: string }>(`/api/conversations/${conv.id}`)
  ).claudeSessionId;

  // The first message: nothing would be left to resume.
  const first = await post<{ ok: boolean; reason?: string }>(
    `/api/conversations/${conv.id}/rewind/preview`,
    { uuid: apple.uuid },
  );
  r.ok(
    "going back to the first message is refused",
    !first.ok && first.reason === "nothing-before",
  );

  const preview = await post<{
    ok: boolean;
    inPlace?: boolean;
    messageText?: string;
  }>(`/api/conversations/${conv.id}/rewind/preview`, { uuid: banana.uuid });
  r.ok(
    "preview of the second message",
    preview.ok &&
      preview.inPlace === true &&
      !!preview.messageText?.includes("BANANA"),
  );

  // Fork from the second message: the original must not change.
  const fork = await post<{ id: string }>("/api/conversations", {
    forkFromConversationId: conv.id,
    forkAtMessageUuid: banana.uuid,
    model: MODEL,
  });
  created.push(fork.id);
  const forkAnswer = await ask(fork.id, RECALL, 2);
  r.note(`fork answered: ${JSON.stringify(forkAnswer)}`);
  r.ok("the fork remembers APPLE", /apple/i.test(forkAnswer));
  r.ok("the fork never saw BANANA", !/banana/i.test(forkAnswer));
  r.ok(
    "the original still holds both messages",
    (await userRows(conv.id)).length === 2,
  );

  // Rewind the original to the second message — through the real menu, so a
  // dead click handler or a missing draft write fails here rather than in use.
  await withBrowser(async (h) => {
    const { page } = await h.session();
    await boot(page, pathUrl(`/agents/c/${conv.id}`), {
      marker: "[data-event-index]",
      settleMs: 2500,
    });
    const buttons = page.locator(`[aria-label="${REWIND}"]`);
    r.ok(
      `one "rewind" button per user message (found ${await buttons.count()})`,
      (await buttons.count()) === 2,
    );
    // The strip is revealed by hovering its row (opacity + pointer-events).
    const row = page
      .locator("[data-event-index]", { has: page.getByText("BANANA") })
      .first();
    await row.hover();
    await row.locator(`[aria-label="${REWIND}"]`).click();
    // Nothing is lost by this cut, so no dialog: the message goes straight back
    // into the prompt editor.
    const draft = await waitFor(
      () => page.locator('[contenteditable="true"]').last().innerText(),
      (text) => text.includes("BANANA"),
      { timeoutMs: 30_000 },
    );
    r.ok("the removed message is back in the prompt editor", draft.ok);
  });
  const after = await waitFor(
    () => userRows(conv.id),
    (rows2) => rows2.length === 1,
    { timeoutMs: 30_000 },
  );
  r.ok("the conversation now shows only the first message", after.ok);
  const sessionAfter = (
    await api<{ claudeSessionId: string }>(`/api/conversations/${conv.id}`)
  ).claudeSessionId;
  r.ok("same Claude session id as before", sessionAfter === sessionBefore);
  const rewoundAnswer = await ask(conv.id, RECALL, 2);
  r.note(`rewound conversation answered: ${JSON.stringify(rewoundAnswer)}`);
  r.ok(
    "after the rewind the agent remembers APPLE",
    /apple/i.test(rewoundAnswer),
  );
  r.ok(
    "after the rewind the agent never saw BANANA",
    !/banana/i.test(rewoundAnswer),
  );
} finally {
  // Close first (so the status reconciler files them as done, not as hibernated work to
  // come back to), then kill the panes.
  for (const id of created) {
    await agentFetch(`/api/conversations/${id}/close`, { method: "POST" });
    await agentFetch(`/api/conversations?name=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
}
await r.finish();
