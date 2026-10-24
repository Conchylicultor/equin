import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { MeasuredFixture } from "@plugins/primitives/plugins/css/plugins/layout-harness/core";
import { loadExhibits } from "@plugins/plugin-meta/plugins/exhibits/core";
import {
  falsificationDidNotBiteError,
  fixturePageError,
  geometryViolationError,
} from "../../core/failure-markers";
import { evaluateInvariant } from "../../core/oracle";
import { buildMeasurerPage, type BuiltPage } from "./build-measurer-page";
import {
  measurableExhibits,
  type MeasurableExhibit,
} from "./measurable-exhibits";
import { openMeasurer, type Measurer } from "./measure-page";

// THE generic geometry suite. It builds the measurer page once (Vite + React +
// real Tailwind), opens one headless Chromium, and sweeps every geometry-gated
// exhibit in the catalog: for each one it measures every `widths` entry, then evaluates
// each invariant via the pure oracle. `falsification` invariants are handled
// specially — re-measured with the mutation applied, then asserted VIOLATED, so
// the harness is proven to bite on the historical broken construct.
//
// jsdom can't lay out CSS grid or compute text overflow, so this drives a real
// browser (same approach as the bespoke frame/truncating-text geometry tests it
// supersedes). It launches Vite + Chromium and is therefore slow — that's
// expected; it gates behind the sig-cached `layout-geometry` check.

// bun:test registers tests synchronously, but loadExhibits is async. Await it
// once at module top-level so the per-exhibit describes below are registered
// before the run starts.
//
// `measurableExhibits` keeps the `isolated` exhibits that declare `geometry`,
// and turns each `isolated-region` exhibit (one that hands the harness a hole
// instead of a child list) into an ordinary measurable entry rendering the whole
// `REGION_CHILDREN` kit, with its invariants supplied by the expansion. App
// exhibits are dropped without being loaded. The suite below deals in one
// shape — it sweeps widths and evaluates invariants.
const collected = measurableExhibits(await loadExhibits());

let built: BuiltPage;
let measurer: Measurer;

/**
 * This suite's own budget, declared here rather than left to whoever runs it.
 *
 * bun:test's default is 5s per hook and per test, and the setup below — a cold
 * Vite build, a cold headless Chromium launch, a page load — routinely runs
 * longer than that even on an idle machine, let alone a host running several
 * worktree servers. The `layout-geometry` check passes `--timeout 120000` for
 * exactly this reason, but a flag on one caller is not a property of the suite:
 * running it the ordinary way (`./equin test <this plugin>`) blew the
 * default budget and reported a hook timeout that had nothing to do with
 * geometry. A suite that only passes when invoked with the right flag is a
 * suite with a trap in it, so the budget lives with the code that needs it and
 * the check's flag is now belt-and-braces.
 */
const SETUP_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  built = await buildMeasurerPage();
  measurer = await openMeasurer(built.outDir);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await measurer?.close();
  if (built?.outDir) await rm(built.outDir, { recursive: true, force: true });
});

/** Measure a fixture across all its widths (unmutated). */
async function sweep(
  fixture: MeasurableExhibit,
): Promise<Record<number, MeasuredFixture>> {
  const out: Record<number, MeasuredFixture> = {};
  for (const width of fixture.widths) {
    const at = `while measuring "${fixture.id}" at ${String(width)}px`;
    try {
      out[width] = await measurer.measure(fixture.id, width);
    } catch (err) {
      // A crashing fixture usually takes the measure call down with it, and the
      // rejection Playwright hands back ("Execution context was destroyed…")
      // names nothing and reads as a driver problem. The page-error buffer
      // names the fault, so it wins; the driver's own error is only re-thrown
      // when the buffer is empty and it really is all we know.
      throwOnPageErrors(measurer.takePageErrors(), at);
      throw err;
    }
    // Drained per WIDTH, not per fixture: this is the only point at which we
    // know which fixture was on screen when the error fired. The per-fixture
    // test below is the catch-all for one that arrives after the last measure
    // resolved (a rAF loop still unwinding).
    throwOnPageErrors(measurer.takePageErrors(), at);
  }
  return out;
}

/**
 * Turn a drained batch of page errors into the one loud failure.
 *
 * The marker `fixturePageError` stamps is a contract with `check/classify.ts`:
 * it is a FATAL signature there, so a crashed fixture can never be filed as an
 * environmental timeout and cached past. There is nothing to keep in step — both
 * ends read the one constant in `core/failure-markers.ts`.
 */
function throwOnPageErrors(errors: string[], where: string): void {
  if (errors.length === 0) return;
  throw fixturePageError(
    `${String(errors.length)} uncaught error(s) escaped to the top of the measurer page ${where}. A fixture that throws is not laying anything out, so every box measured around it is meaningless:\n\n${errors.join("\n\n--- next page error ---\n\n")}`,
  );
}

test("the geometry-gated exhibit set is non-empty", () => {
  expect(collected.length).toBeGreaterThan(0);
});

// Registered BEFORE the per-fixture describes so it drains the load window only:
// anything that threw while the bundle evaluated and `loadExhibits()` resolved.
// Nothing has been rendered yet at this point, so an error here is the harness
// itself, not a fixture.
test("the measurer page loaded without a page error", () => {
  throwOnPageErrors(measurer.takePageErrors(), "while it loaded");
});

for (const fixture of collected) {
  describe(fixture.id, () => {
    let measuredByWidth: Record<number, MeasuredFixture>;

    // Same reasoning as the setup budget: a sweep is one settle loop per width,
    // and a settle loop waits on frames. A fixture whose layout takes a while to
    // settle is slow, not broken, and must not read as a hook timeout.
    beforeAll(async () => {
      measuredByWidth = await sweep(fixture);
    }, SETUP_TIMEOUT_MS);

    // The catch-all for an error that fired after the sweep's last measure
    // resolved — a rAF loop still unwinding, a deferred effect. Errors DURING
    // the sweep are drained inside `sweep` itself, where the width is still
    // known. First test in the describe so it reports before the invariants,
    // whose numbers are meaningless once something has crashed.
    test("no page error while measuring this fixture", () => {
      throwOnPageErrors(
        measurer.takePageErrors(),
        `while measuring "${fixture.id}" across widths [${fixture.widths.join(", ")}]`,
      );
    });

    for (const inv of fixture.invariants) {
      if (inv.kind === "falsification") {
        // Re-measure the mutated construct across the sweep, then assert the
        // inner `expectViolated` invariant is genuinely VIOLATED.
        test(`falsification(${inv.mutate.kind}:${"value" in inv.mutate ? inv.mutate.value : ""}) → ${inv.expectViolated.kind} VIOLATED`, async () => {
          const mutatedByWidth: Record<number, MeasuredFixture> = {};
          for (const width of fixture.widths) {
            mutatedByWidth[width] = await measurer.measure(
              fixture.id,
              width,
              inv.mutate,
            );
          }
          // The mutation is applied to the painted DOM, so it can crash the page
          // in its own right; drained here so that reads as the mutation's
          // fault rather than the next fixture's.
          throwOnPageErrors(
            measurer.takePageErrors(),
            `while measuring "${fixture.id}" with the ${inv.mutate.kind} falsification applied`,
          );
          const r = evaluateInvariant(inv.expectViolated, mutatedByWidth);
          // The whole point: the mutation reproduces the historical broken shape,
          // so the inner invariant MUST fail. If it passes, the harness is NOT
          // biting — a real failure to investigate, never to paper over.
          if (r.ok) {
            throw falsificationDidNotBiteError(
              `applying ${JSON.stringify(inv.mutate)} to "${fixture.id}" left invariant ${inv.expectViolated.kind} satisfied — the mutated construct should have violated it`,
            );
          }
          expect(r.ok).toBe(false);
        });
        continue;
      }

      test(inv.kind, () => {
        const r = evaluateInvariant(inv, measuredByWidth);
        if (!r.ok) throw geometryViolationError(r.detail);
        expect(r.ok).toBe(true);
      });
    }
  });
}
