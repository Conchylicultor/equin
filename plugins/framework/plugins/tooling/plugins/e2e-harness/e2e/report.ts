/**
 * Pass/fail reporting for e2e scripts.
 *
 * The pre-move scripts each reimplemented a `check()` logger, in two mutually
 * incompatible shapes — `check(name, ok, detail)` (predicate) and
 * `check(label, actual, expected)` (equality) — with four different endings
 * (`process.exit(1)` on a boolean AND; a `FAILURES: n` line; a joined failure
 * array; and one script that printed mismatches and exited 0 regardless).
 *
 * The two shapes cannot be safely overloaded on arity: `check("x", true, "d")`
 * and `check("x", true, true)` are indistinguishable. So they become two named
 * methods on one object, sharing a single failure counter and a single exit path.
 */

import { drainDiagnostics } from "./diagnostics";

/**
 * Async errors with nowhere to land, collected process-wide.
 *
 * `finish()` ends the run with an explicit `process.exit(0)` when every
 * assertion passed. That exit code WINS over the one the runtime would have set
 * on its own — so an unhandled rejection printed to stderr at second 4 was
 * followed, at second 9, by `ALL CHECKS PASSED` and exit 0. Anything that threw
 * outside the script's own `await` chain was invisible to the verdict: a route
 * handler, a listener, a detached promise in a helper.
 *
 * That is the same failure `promise-safety`'s rules exist to prevent — a script
 * that goes green while asserting nothing — so an unhandled rejection is a
 * FAILURE here, not a diagnostic. A verification script that reports success is
 * cited as evidence; it must not be able to do that with an error in flight.
 *
 * Installing a listener suppresses the runtime's own reporting, so the handler
 * prints the error itself. `uncaughtException` is deliberately NOT intercepted:
 * a listener there would keep a process running past a genuinely fatal error,
 * and an uncaught throw already fails the run loudly on its own.
 *
 * Known limit: a rejection is delivered on a later tick, so one raised after the
 * script's final `await` can still land after `finish()` has exited. Everything
 * raised during the run — which is every case this is aimed at — is caught.
 */
const asyncFailures: string[] = [];
let watchingAsyncFailures = false;

/**
 * Async work that must happen before the verdict prints — and the ONLY place it
 * can happen.
 *
 * `finish()` ends in `process.exit()`, which skips `finally`. That is not an
 * edge case here: 86 of the 136 `withBrowser` scripts call `finish()` INSIDE the
 * `withBrowser` callback, so for two thirds of the fleet a `finally` in
 * `withBrowser` never runs at all. Today that already means `await
 * browser.close()` is skipped and those runs leak a Chromium process, despite
 * `browser.ts` claiming the `finally` "fixes that for every caller at once".
 *
 * So teardown registers here instead, and `finish()` drains it before printing.
 * A registrant that also has a reachable `finally` deregisters via the returned
 * handle and runs it there — whichever path fires first, the work happens once.
 */
const beforeFinish: Array<() => Promise<void>> = [];

export function onBeforeFinish(fn: () => Promise<void>): () => void {
  beforeFinish.push(fn);
  return () => {
    const i = beforeFinish.indexOf(fn);
    if (i >= 0) beforeFinish.splice(i, 1);
  };
}

/**
 * The reports whose `finish()` has not run yet, newest last — so a run that
 * ends on a throw (`failRun`) still ends through the script's own report, with
 * the checks it counted so far.
 */
const openReports: Report[] = [];

/**
 * End the run on a throw that escaped the script — never returns.
 *
 * An uncaught throw (a Playwright `TimeoutError`, say) used to end the process
 * with a stack trace and no verdict: no FAILURES line, no count, nothing a
 * batch runner grepping for the verdict could see. And `withBrowser`'s
 * `finally` then ran the teardown, so a teardown that threw too (a recording
 * that could not be filed) REPLACED the script's error — the transcript showed
 * only the teardown's.
 *
 * So the throw is recorded FIRST, as a failure of the newest open report (one
 * made here when the script has none), and the run ends through its
 * `finish()`: the registered teardown drains after it, a teardown error is a
 * second FAIL line under it, and the verdict counts both with every check made
 * so far. `label` names what threw.
 */
export async function failRun(
  err: unknown,
  label = "script threw",
): Promise<never> {
  const r = openReports.at(-1) ?? report();
  recordError(label, err, (name) => r.fail(name));
  return r.finish();
}

/**
 * Record a thrown error as one failure named by `label` and the error itself
 * (`script threw: TimeoutError: waitFor: Timeout 1000ms exceeded.`), so the
 * verdict's list says what threw, then print the rest of its message and its
 * frames under it: this replaces the runtime's own uncaught-error print.
 */
function recordError(
  label: string,
  err: unknown,
  fail: (name: string) => void,
): void {
  if (!(err instanceof Error)) {
    fail(`${label}: ${String(err)}`);
    return;
  }
  // A Playwright message runs on for lines (its call log): its first line
  // names the failure, the rest is detail.
  const [headline = "", ...detail] = err.message.split("\n");
  fail(`${label}: ${err.name}: ${headline}`);
  const frames = (err.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "));
  for (const line of [...detail, ...frames]) {
    if (line.trim() !== "") console.log(`      ${line.trim()}`);
  }
  // A wrapper's cause is usually the root of it: print the chain.
  for (let cause = err.cause; cause !== undefined;) {
    const head =
      cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : String(cause);
    console.log(`      caused by ${head.split("\n").join("\n      ")}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
}

function watchAsyncFailures(): void {
  if (watchingAsyncFailures) return;
  watchingAsyncFailures = true;
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    const line = `unhandled rejection — ${err.message}`;
    asyncFailures.push(line);
    console.log(`FAIL  ${line}`);
    // A few frames of provenance: which handler / helper the throw came from is
    // the whole question when the throw happened outside the script's own flow.
    if (err.stack) {
      for (const frame of err.stack.split("\n").slice(1, 4)) {
        console.log(`      ${frame.trim()}`);
      }
    }
  });
}

export interface Report {
  /** Predicate form. `detail` is printed only on failure. */
  ok(name: string, condition: boolean, detail?: string): void;
  /** Equality form. Prints got/want on failure. */
  eq(name: string, actual: unknown, expected: unknown): void;
  /** Unconditional failure — for a branch that should have been unreachable. */
  fail(name: string, detail?: string): void;
  /**
   * A check this run could not make, and why — the host offers nothing to
   * check (an absent control, an empty choice). Printed as SKIP and counted
   * apart: never a pass, so a run whose checks were skipped says so in its
   * verdict instead of passing with fewer of them.
   */
  skip(name: string, reason: string): void;
  /** A transcript line that is not itself an assertion. */
  note(line: string): void;
  readonly failures: readonly string[];
  /**
   * Drain registered teardown, print the summary, and exit 0 (all passed) or 1
   * (any failed). Never returns.
   *
   * `await` it. The promise is what makes teardown (see `onBeforeFinish`) run
   * before the verdict; a bare call would print and exit while the revert was
   * still in flight. `no-floating-promises` enforces the `await` repo-wide, and
   * `await` on `Promise<never>` still narrows to `never`, so control flow after
   * a call site is unchanged.
   */
  finish(): Promise<never>;
}

export function report(title?: string): Report {
  const failures: string[] = [];
  const skipped: string[] = [];
  let passed = 0;
  watchAsyncFailures();
  if (title) console.log(`\n=== ${title} ===`);

  const record = (name: string, detail?: string): void => {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const self: Report = {
    failures,

    ok(name, condition, detail) {
      if (condition) {
        passed++;
        console.log(`ok    ${name}`);
      } else {
        record(name, detail);
      }
    },

    eq(name, actual, expected) {
      // JSON equality: every pre-move call site compared primitives or values
      // the script had already JSON.stringify'd by hand.
      if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
        console.log(`ok    ${name}`);
      } else {
        record(
          name,
          `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`,
        );
      }
    },

    fail(name, detail) {
      record(name, detail);
    },

    skip(name, reason) {
      skipped.push(`${name} — ${reason}`);
      console.log(`SKIP  ${name} — ${reason}`);
    },

    note(line) {
      console.log(`      ${line}`);
    },

    async finish(): Promise<never> {
      const open = openReports.indexOf(self);
      if (open >= 0) openReports.splice(open, 1);
      // Registered teardown first, and its failures are FAILURES. A revert that
      // could not restore the user's config must not be followed by ALL CHECKS
      // PASSED — same reasoning as asyncFailures below: a green verification
      // script gets cited as evidence, so it must not be able to go green with
      // the app left in a state it changed.
      //
      // `splice(0)` so a teardown that itself registers one cannot loop, and so
      // a second finish() (a script with two reports) drains nothing twice.
      for (const teardown of beforeFinish.splice(0)) {
        try {
          await teardown();
        } catch (err) {
          recordError("harness teardown", err, (name) => record(name));
        }
      }

      // Fold in anything that threw outside the script's own await chain. These
      // already printed a FAIL line when they were caught; adding them here is
      // what stops the run exiting 0 with an error in flight.
      failures.push(...asyncFailures);
      const total = passed + failures.length;

      // Non-fatal notices (a screenshot that could not be written, say) are
      // surfaced but never counted: a diagnostic must not decide the verdict of
      // a run whose assertions are green.
      const diagnostics = drainDiagnostics();
      if (diagnostics.length > 0) {
        console.log(`\nDIAGNOSTICS (non-fatal): ${diagnostics.length}`);
        for (const d of diagnostics) console.log(`  - ${d}`);
      }

      // Skips are listed, never counted as passes.
      const skips = skipped.length === 0 ? "" : `, ${skipped.length} skipped`;
      if (skipped.length > 0) {
        console.log(`\nSKIPPED: ${skipped.length}`);
        for (const s of skipped) console.log(`  - ${s}`);
      }
      if (failures.length === 0) {
        console.log(`\nALL CHECKS PASSED (${total}${skips})`);
        process.exit(0);
      }
      console.log(`\nFAILURES: ${failures.length}/${total}${skips}`);
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    },
  };
  openReports.push(self);
  return self;
}
