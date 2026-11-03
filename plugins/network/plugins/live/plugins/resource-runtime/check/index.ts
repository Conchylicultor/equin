import type { Check } from "@plugins/framework/plugins/tooling/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

// A `RoutePlan` / `ReachPlan` is minted, never written: the type carries a
// module-private brand only `mintRoutePlan` / `mintReachPlan` can put on it, and
// `createResource` refuses a plan without it. This check closes the last door —
// WHO may call the minters. A route's `columns` gate which updates reach the
// resource, so only the compiler that renders the SQL may state them.
//
// The minters' own module and the barrel that re-exports them are exempt (in
// resource-runtime's own manifest), as is test code (a harness injects routes
// directly). Every other production caller is a compiler that does not exist
// yet: its plugin declares the exemption with the reason.
const PATTERN = "mint(Route|Reach)Plan";

const check: Check = {
  id: "resource-runtime:compiled-routes",
  // INPUT-KEYED: a pure `grepCode` over tracked sources.
  inputKeyed: true,
  exemptable: {
    "resource-runtime:compiled-routes":
      "calls `mintRoutePlan` / `mintReachPlan` outside the minters' module — only a query compiler that renders the SQL may state a route's columns",
  },
  outOfScope: ["test"],
  description:
    "A live resource's route plan (`RoutePlan` / `ReachPlan`) is written by a query compiler, never by hand: only the minters' module, the query-resource compilers' `routes.ts`, and test code may call `mintRoutePlan` / `mintReachPlan`. A route's `columns` decide which updates reach the resource, so a hand-kept list that missed a column the SQL reads would silently drop that column's updates. See research/2026-09-29-global-scoped-change-routing.md.",
  async run(ctx) {
    const root = await getWorktreeRoot();
    const matches = await grepCode({
      root,
      pattern: new RegExp(`\\b${PATTERN}\\b`),
      grepArg: PATTERN,
    });
    const exempt = await ctx.exempt("resource-runtime:compiled-routes");
    const offenders = matches.filter((m) => !exempt.skips(m.path));
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `A route plan is minted outside a query compiler in ${offenders.length} place(s):\n    ${offenders.map((m) => `${m.path}:${m.line}:${m.text.trim()}`).join("\n    ")}`,
      hint: "Serve the resource through a compiler that emits its routes from the same declaration it renders the SQL from — a collection is a `liveCollection` served by `serveCollection` (`plugins/network/plugins/live`). A new compiler that must mint plans declares an exemption (rule `resource-runtime:compiled-routes`) in its own plugin's `exempt/index.ts`, with the reason.",
    };
  },
};

export default check;
