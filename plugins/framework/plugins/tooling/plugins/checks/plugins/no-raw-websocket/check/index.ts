import type { Check } from "@plugins/framework/plugins/tooling/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

const check: Check = {
  id: "no-raw-websocket",
  // INPUT-KEYED (Stage 1). The verdict is a pure function of `grepCode` and the
  // exemption manifests `ctx.exempt` reads — both route through the recording
  // view (query selection + per-candidate content + manifest content). See
  // read-set.ts / runner.ts.
  inputKeyed: true,
  description:
    "WebSocket clients must go through the shared `SharedWebSocket` primitive (not raw `new WebSocket`)",
  exemptable: {
    "no-raw-websocket":
      "constructs a raw `new WebSocket(` — only the networking primitive that every client shares may",
  },
  outOfScope: ["research"],
  async run(ctx) {
    const root = await getWorktreeRoot();
    const matches = await grepCode({
      root,
      pattern: /new WebSocket\(/,
      grepArg: "new WebSocket(",
      fixed: true,
      maskStrings: true,
    });
    const exempt = await ctx.exempt("no-raw-websocket");

    const offenders = matches
      .filter((m) => !exempt.skips(m.path))
      .map((m) => `${m.path}:${m.line}:${m.text}`);

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `raw \`new WebSocket(\` found in ${offenders.length} place(s):\n    ${offenders.join("\n    ")}`,
      hint:
        "Open the socket on the subtree's transport instead — `const t = useTransport(); t.openSocket(t.socketUrl(path))` (`@plugins/primitives/plugins/networking/web`), a socket shared across every tab of the origin, or `useReconnectingWebSocket({ path })` for a per-tab one — so a subtree pointed at another server (the demo's browser server) never opens a socket on the page's real one. " +
        "A file that genuinely must construct one declares it in its own plugin's `exempt/index.ts` (rule `no-raw-websocket`, with the reason).",
    };
  },
};

export default check;
