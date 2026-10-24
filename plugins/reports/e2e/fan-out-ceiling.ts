import {
  agentFetch,
  numArg,
  report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

// Drives the cross-fingerprint fan-out ceiling against a deployed backend.
//
// Files N reports of ONE kind, each with a distinct fingerprint, inside a
// single budget window, and asserts on the outcome the engine reports back.
// The endpoint's response IS the observable: `recorded` for the fingerprints
// that spent the window's budget, `collapsed` for the ones folded into the
// report-storm rollup. That is what makes this checkable from outside — the
// engine says which arm it took, rather than us inferring it from row counts.
//
// With the default budget (reports.fanOutPerWindow = 20) and 30 probes: 20
// recorded, 10 collapsed, and ONE `report-storm` row about a window later
// naming the collapsed set.
//
//   ./equin run plugins/reports/e2e/fan-out-ceiling.ts
//   ./equin run plugins/reports/e2e/fan-out-ceiling.ts --count 30 --url http://x.localhost:9000
//
// Each probe writes a real `crash` report into the target worktree's DB under
// the errorType prefix below, so the run's rows are easy to find afterwards:
//   delete from reports where data->>'errorType' like 'FanOutProbeError_%';

const PREFIX = "FanOutProbeError";

const r = report("reports fan-out ceiling");
const count = numArg("count", 30);

// One distinct fingerprint per probe: the crash fingerprint keys on errorType
// plus the top 3 stack frames, so varying errorType is enough.
async function fileProbe(n: number): Promise<string> {
  const res = await agentFetch("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "crash",
      source: "browser-error",
      message: `fan-out ceiling probe #${n}`,
      data: {
        errorType: `${PREFIX}_${n}`,
        stack: `${PREFIX}_${n}: probe\n    at probe (fan-out-ceiling.ts:1:1)`,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `probe #${n}: POST /api/reports ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { outcome?: string };
  if (typeof body.outcome !== "string") {
    throw new Error(
      `probe #${n}: response carries no "outcome" — got ${JSON.stringify(body)}`,
    );
  }
  return body.outcome;
}

const outcomes: string[] = [];
for (let n = 1; n <= count; n++) outcomes.push(await fileProbe(n));

const tally = new Map<string, number>();
for (const o of outcomes) tally.set(o, (tally.get(o) ?? 0) + 1);
for (const [outcome, n] of [...tally].sort((a, b) => b[1] - a[1])) {
  r.note(`${outcome.padEnd(10)} ${n}`);
}

const recorded = tally.get("recorded") ?? 0;
const collapsed = tally.get("collapsed") ?? 0;

// The ceiling engaged at all: the tail stopped minting its own alerts.
r.ok(
  "the tail collapsed instead of minting one alert per fingerprint",
  collapsed > 0,
  `${count} probes all came back "${[...tally.keys()].join(", ")}" — no ceiling applied`,
);
// And it engaged at a ceiling, not a cliff: the budget's worth still alerted,
// so a burst is thinned rather than silenced.
r.ok(
  "the budget's worth of fingerprints still raised their own alert",
  recorded > 0,
  "every probe collapsed — the ceiling swallowed the burst instead of capping it",
);
r.eq("every probe accounted for", recorded + collapsed, count);

await r.finish();
