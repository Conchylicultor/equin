import type TS from "typescript";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  listCandidateSources,
  sourceAnalysis,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { formatUnreadable } from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { unregisteredFailures } from "./analyze";

// ── investigate:failures-registered ────────────────────────────────────────
// A collection (or a union arm) whose rows can be FAILED — one of its fields
// declares an option tinted `variant: "destructive"`, the tint reserved for
// "the one outcome someone must act on" — gets the Investigate action in every
// list of it only once something registers it (`Investigate.Register({ owner
// })`, or a helper built on it such as runs' `investigateRuns(arm, …)`). Without
// the registration it type-checks and renders, and its failed rows simply
// offer nothing: exactly how most failure surfaces ended up without one.
//
// Why a check and not a type: the tint lives in field option meta typed
// `variant?: BadgeVariant`, reached through shared constants that widen it, so
// no declaration's type can see it; and the registration is web-only (it
// carries React) while collections are core. The code is read through the
// shared source analysis (`./analyze.ts`), fail-closed.
//
// The tint is read as DATA: literals, constants, spreads, namespaces and call
// arguments. A function's body is code and is not read — a field option must
// spell its tint where it is declared, not compute it.

const ID = "investigate:failures-registered";

let tsPromise: Promise<typeof TS> | undefined;
function loadTs(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

const failuresRegistered: Check = {
  id: ID,
  // INPUT-KEYED: a pure read of tracked sources (through ctx.repo()).
  inputKeyed: true,
  exemptable: {
    [ID]: 'declares a collection (or union arm) with a failure-tinted option (`variant: "destructive"`) whose failed rows offer no Investigate action — sanctioned only where that tint does not mean a failure someone must act on',
  },
  outOfScope: ["test"],
  description:
    'Every collection or union arm (`liveCollection` / `liveArm`) declaring a field option tinted `variant: "destructive"` — directly or through constants — is registered for the Investigate action: an `Investigate.Register({ owner })` (primitives/launch/investigate), or a helper built on it such as runs\' `investigateRuns(arm, …)`, names it. Otherwise its failed rows offer no way to launch an agent on them. Read from the syntax tree, fail-closed: what cannot be read is a violation.',
  async run(ctx) {
    const root = await getWorktreeRoot();
    const [ts, analysis, exempt] = await Promise.all([
      loadTs(),
      sourceAnalysis(ctx),
      ctx.exempt(ID),
    ]);
    const { missing, unreadable } = await unregisteredFailures(
      ts,
      analysis,
      (grepArg) => listCandidateSources({ root, grepArg }),
      (rel) => exempt.skips(rel),
    );
    if (missing.length === 0 && unreadable.length === 0) return { ok: true };
    const lines = [
      ...missing.map((m) => `${m.site.rel}:${m.site.line} — ${m.name}`),
      ...unreadable.map((u) => `unreadable: ${formatUnreadable(u)}`),
    ];
    return {
      ok: false,
      message: `${missing.length} failure-bearing collection(s) offer no Investigate action, ${unreadable.length} spot(s) could not be read:\n    ${lines.join("\n    ")}`,
      hint: "From the collection's (or arm's) web barrel, contribute `Investigate.Register({ owner, failed, noun, categoryId, subject, description, brief })` (primitives/launch/investigate/web) — or for a run arm `investigateRuns(arm, …)` (runs/web). An `unreadable:` line is code the check cannot read — rewrite it as the reason says (a literal `variant`, a `const` the declaration names). If the destructive tint there does not mean a failure someone must act on, exempt the file in the plugin's `exempt/index.ts` (rule `investigate:failures-registered`, kind `sanctioned`, with the reason).",
    };
  },
};

export default [failuresRegistered];
