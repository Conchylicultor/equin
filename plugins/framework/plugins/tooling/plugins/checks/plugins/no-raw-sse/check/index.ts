import type { Check } from "@plugins/framework/plugins/tooling/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

/**
 * A line that names the token as an **`Accept` request header** — which is the
 * exact opposite of what this check bans. A writer says "I am SENDING a stream";
 * an `Accept` header says "I can RECEIVE one", and produces no stream at all.
 *
 * Not a hypothetical carve-out: the MCP Streamable HTTP transport REQUIRES a
 * caller to accept both `application/json` and `text/event-stream`, answering
 * 406 otherwise — unconditionally, `enableJsonResponse` included
 * (`sdk/…/webStandardStreamableHttp.js`, `handlePostRequest`). So every MCP
 * client must name the token, and without this the check would ban calling our
 * own `POST /api/mcp/:conversationId` from TS at all.
 *
 * Deliberately scoped to the matched LINE and deliberately not smarter. A header
 * split across two lines still trips the check — a false POSITIVE, loud and
 * fixed by joining the line, rather than a hole a real writer could hide in.
 * Default-deny is preserved: this exempts one recognizable shape, not a path.
 */
const ACCEPT_HEADER = /\baccept\b["']?\s*[:,]/i;

const check: Check = {
  id: "no-raw-sse",
  // INPUT-KEYED (Stage 1). Pure `grepCode` — see no-raw-websocket for rationale.
  inputKeyed: true,
  description:
    "Live state must go through `liveValue` / `liveCollection` + `useLive`; no raw `text/event-stream` writers in TS",
  exemptable: {
    "no-raw-sse":
      "names `text/event-stream` as a raw SSE writer instead of serving live state through liveValue / liveCollection",
  },
  outOfScope: ["research"],
  async run(ctx) {
    const root = await getWorktreeRoot();
    const matches = await grepCode({
      root,
      pattern: /text\/event-stream/,
      grepArg: "text/event-stream",
      fixed: true,
      maskStrings: false,
    });

    const exempt = await ctx.exempt("no-raw-sse");
    const offenders = matches
      .filter((m) => !ACCEPT_HEADER.test(m.text) && !exempt.skips(m.path))
      .map((m) => `${m.path}:${m.line}:${m.text}`);

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `raw \`text/event-stream\` response found in ${offenders.length} place(s):\n    ${offenders.join("\n    ")}`,
      hint: "Live state belongs in a `liveValue` / `liveCollection` declaration, served with `serveValue` / `serveCollection` and read with `useLive`; see `plugins/network/plugins/live/CLAUDE.md`. Append-only firehoses (terminal, log tails) belong on a dedicated WS route. The gateway's SSE endpoint for external log streams is Go and out of scope for this check. A CLIENT declaring `Accept: application/json, text/event-stream` (e.g. any MCP caller, which the transport 406s without) is not a writer and is already exempt — keep the header on ONE line so the exemption can see it. Any other file that must name it declares an exemption in its own plugin's `exempt/index.ts` (rule `no-raw-sse`).",
    };
  },
};

export default check;
