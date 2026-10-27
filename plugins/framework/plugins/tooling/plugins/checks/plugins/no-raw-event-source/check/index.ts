import type { Check } from "@plugins/framework/plugins/tooling/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

const check: Check = {
  id: "no-raw-event-source",
  // INPUT-KEYED (Stage 1). Pure `grepCode` — see no-raw-websocket for rationale.
  inputKeyed: true,
  description:
    "No raw `new EventSource` — server data streams to the page through live values (useLive), not an SSE connection of its own",
  exemptable: {
    "no-raw-event-source":
      "constructs a raw `new EventSource(` — a stream the app does not read through live",
  },
  outOfScope: ["research"],
  async run(ctx) {
    const root = await getWorktreeRoot();
    const matches = await grepCode({
      root,
      pattern: /new EventSource\(/,
      grepArg: "new EventSource(",
      fixed: true,
      maskStrings: true,
    });

    const exempt = await ctx.exempt("no-raw-event-source");
    const offenders = matches
      .filter((m) => !exempt.skips(m.path))
      .map((m) => `${m.path}:${m.line}:${m.text}`);

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `raw \`new EventSource(\` found in ${offenders.length} place(s):\n    ${offenders.join("\n    ")}`,
      hint: "Declare the stream as a live value (`network/live`) and read it with `useLive`: one tab-shared socket carries every subscription, with reconnection built in. A same-origin `/api` EventSource is also refused at runtime by the page request guard (`primitives/networking/plugins/request-guard`). A file that genuinely must construct one (a third-party stream) declares it in its own plugin's `exempt/index.ts` (rule `no-raw-event-source`).",
    };
  },
};

export default check;
