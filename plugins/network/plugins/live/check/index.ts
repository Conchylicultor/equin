import type TS from "typescript";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  listCandidateSources,
  sourceAnalysis,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { readHooks } from "./internal/read-hooks";
import { readMisuseDiagnostics } from "./internal/read-misuse-diagnostics";
import {
  reportLines,
  unregisteredArms,
  unregisteredExposures,
  unresolvedClientFields,
  type RegistrationReport,
} from "./internal/registrations";

// The registration checks below read code through the shared source analysis
// (`./internal/registrations.ts`): declarations are the uses of their
// factories through every alias and barrel, the `const` a call initializes is
// found through `as` / `satisfies` / ternaries, and a registration names a
// declaration only when its identifier RESOLVES to it. Fail-closed: what
// cannot be read is a violation. Test code neither declares nor registers.

let tsPromise: Promise<typeof TS> | undefined;
function loadTs(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

const candidatesFor = (grepArg: string) => listCandidateSources({ grepArg });

/** A registration check's verdict: one line per missing declaration and per unreadable spot. */
function verdict(
  r: RegistrationReport,
  what: string,
  hint: string,
): { ok: true } | { ok: false; message: string; hint: string } {
  const lines = reportLines(r);
  if (lines.length === 0) return { ok: true };
  return {
    ok: false,
    message: `${r.missing.length} ${what}, ${r.unreadable.length} spot(s) could not be read:\n    ${lines.join("\n    ")}`,
    hint: `${hint} An \`unreadable:\` line is code the check cannot follow — rewrite it as the reason says (declare with a \`const\`, register the declaration itself rather than through a helper's parameter).`,
  };
}

// ── live:exposures-registered ──────────────────────────────────────────────
// An extension shape declaring `exposes` (entity-extensions) is only the
// declaration: its fields reach a list when its plugin's server folds the
// extension (`LiveColumns.Expose(<the defineExtension handle over it>)`) and
// its web registers the exposure (`FieldPresentation.Register({ owner:
// <shape>.exposure, … })`). Either half missing type-checks and renders — the
// fields are silently absent from every list (no web half), or every list
// throws reading a slice the server never folded (no server half).

const exposuresRegistered: Check = {
  id: "live:exposures-registered",
  // INPUT-KEYED: a pure read of tracked sources (through ctx.repo()).
  inputKeyed: true,
  description:
    "Every extension shape declaring `exposes` (entity-extensions) is folded by its own plugin's server — `LiveColumns.Expose(h)` of a `defineExtension` handle over it — and registered by its own plugin's web — `FieldPresentation.Register({ owner: shape.exposure })` — outside test code. A half missing leaves its fields absent from every list, or every list reading a slice the server never folded. Read from the syntax tree, fail-closed.",
  async run(ctx) {
    const [ts, analysis] = await Promise.all([loadTs(), sourceAnalysis(ctx)]);
    return verdict(
      await unregisteredExposures(ts, analysis, candidatesFor),
      "exposing extension shape(s) are not folded and registered by their own plugin",
      "In the extension's plugin, contribute `LiveColumns.Expose(ext)` (network/live/server) from its server barrel, where `ext = defineExtension(parent, name, shape)`, and `FieldPresentation.Register({ owner: shape.exposure })` (network/live/web) from its web barrel.",
    );
  },
};

// ── live:arms-registered ───────────────────────────────────────────────────
// A union arm declared by fields (`const x = liveArm(…)`, in the arm's core)
// reaches a list when its plugin's server binds it (the union's arm binding —
// `served.arm(x, { … })` of `serveUnionCollection` — references it in
// `server/`) and its web registers it (`FieldPresentation.Register({ owner: x,
// … })`). Either half missing type-checks: the arm's rows carry no slice (its
// `read` throws), or its fields are absent from every list of the union.

const armsRegistered: Check = {
  id: "live:arms-registered",
  // INPUT-KEYED: a pure read of tracked sources (through ctx.repo()).
  inputKeyed: true,
  description:
    "Every union arm declared by fields (`const x = liveArm(…)`, network/live) is bound by its own plugin's server — referenced in its `server/` (the union's arm binding, `served.arm(x, { … })` of `serveUnionCollection` — e.g. `runsServed.arm(x, …)`) — and registered by its own plugin's web — `FieldPresentation.Register({ owner: x })` — outside test code. A half missing leaves the arm's rows without their slice, or its fields absent from every list of the union. Read from the syntax tree, fail-closed.",
  async run(ctx) {
    const [ts, analysis] = await Promise.all([loadTs(), sourceAnalysis(ctx)]);
    return verdict(
      await unregisteredArms(ts, analysis, candidatesFor, (dirs) =>
        listCandidateSources({
          grepArg: ".",
          pathspecs: dirs.flatMap((d) => [`${d}/*.ts`, `${d}/*.tsx`]),
        }),
      ),
      "union arm(s) are not bound and registered by their own plugin",
      "In the arm's plugin, bind the arm from its server (`served.arm(arm, { … })` of the union's `serveUnionCollection` — `runsServed.arm(arm, …)` for a run kind) and contribute `FieldPresentation.Register({ owner: arm })` (network/live/web) from its web barrel.",
    );
  },
};

// ── live:client-fields-resolved ────────────────────────────────────────────
// Client fields (`const x = clientFields(owner, id, …)`, in a plugin's core)
// reach a list only through a resolver its own plugin's web registers
// (`ClientFields.Resolve({ fields: x, … })`). Without one the declaration
// type-checks and its fields are simply absent from every list of the owner.

const clientFieldsResolved: Check = {
  id: "live:client-fields-resolved",
  // INPUT-KEYED: a pure read of tracked sources (through ctx.repo()).
  inputKeyed: true,
  description:
    "Every client-fields declaration (`const x = clientFields(…)`, network/live) is resolved by its own plugin's web — `ClientFields.Resolve({ fields: x })` — outside test code. Without one its fields are absent from every list of its owner. Read from the syntax tree, fail-closed.",
  async run(ctx) {
    const [ts, analysis] = await Promise.all([loadTs(), sourceAnalysis(ctx)]);
    return verdict(
      await unresolvedClientFields(ts, analysis, candidatesFor),
      "client-fields declaration(s) are not resolved by their own plugin",
      "In the declaring plugin, contribute `ClientFields.Resolve({ fields: x, component })` (network/live/web) from its web barrel.",
    );
  },
};

export default [
  exposuresRegistered,
  armsRegistered,
  clientFieldsResolved,
  readHooks,
  readMisuseDiagnostics,
];
