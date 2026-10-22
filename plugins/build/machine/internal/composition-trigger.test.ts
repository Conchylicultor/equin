import { describe, expect, test } from "bun:test";
import { compositionWantsRebuild } from "./composition-trigger";
import type { CompositionRebuildInputs } from "./composition-trigger";

/**
 * The value of extracting `compositionWantsRebuild` is the same as for
 * `wantsBuild` next door: the properties the loop rests on are decidable
 * without the db / config / git singletons the caller binds. A composition
 * rebuild is an automatic trigger that stands up and replaces a whole running
 * namespace, so the two things it must not be able to do — mint a namespace
 * nobody asked for, and rebuild a target it already attempted — are exactly
 * what belongs in a test with no checkout.
 *
 * Run: `./singularity test plugins/build`
 */

const A = "aaaaaaa1111111111111111111111111111111a";
const B = "bbbbbbb2222222222222222222222222222222b";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/** `NOW` minus `ms`, as the ISO instant a marker records. */
function agoIso(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function inputs(
  over: Partial<CompositionRebuildInputs> = {},
): CompositionRebuildInputs {
  return {
    mode: "push",
    // Built long ago, from A — so by default the composition is behind B with
    // every rate limit satisfied, and each test moves the ONE field it is about.
    marker: { commit: A, builtAt: agoIso(30 * 24 * HOUR) },
    head: B,
    lastAttempt: null,
    now: NOW,
    ...over,
  };
}

describe("the mode decides whether any edge may act", () => {
  test("`off` never builds — the composition is not served at all", () => {
    expect(compositionWantsRebuild(inputs({ mode: "off" }))).toBe(false);
  });

  test("`manual` never builds — served, but hand-driven", () => {
    // The distinction the interval record keeps: `manual` is `null` (no edge
    // may act), not `0` (act at the first edge). Collapsing them would make
    // "served" imply "rebuilt", which is the mode nobody could opt out of.
    expect(compositionWantsRebuild(inputs({ mode: "manual" }))).toBe(false);
  });

  test("`push` builds at the first edge once the commit has moved", () => {
    expect(compositionWantsRebuild(inputs({ mode: "push" }))).toBe(true);
  });

  test("an unknown mode throws rather than picking one", () => {
    // A stored value outside the union is a broken invariant, not an input:
    // defaulting would quietly rebuild (or quietly stop rebuilding) something
    // nobody asked for.
    expect(() =>
      compositionWantsRebuild(inputs({ mode: "nightly" })),
    ).toThrow();
  });
});

describe("an automatic trigger never MINTS a namespace", () => {
  test("no marker ⇒ never, in any automatic mode", () => {
    // Claiming a namespace provisions a gateway registry dir, a database and a
    // spec dir. The one thing that may do that is a human pressing Serve;
    // switching a never-served composition to `push` must not stand up an app
    // that has never existed.
    for (const mode of ["push", "hourly", "daily", "weekly"]) {
      expect(compositionWantsRebuild(inputs({ mode, marker: null }))).toBe(
        false,
      );
    }
  });
});

describe("convergence — the same policy main's own auto-build runs", () => {
  test("the marker's commit IS this checkout's HEAD ⇒ no build", () => {
    expect(
      compositionWantsRebuild(
        inputs({ marker: { commit: B, builtAt: agoIso(30 * 24 * HOUR) } }),
      ),
    ).toBe(false);
  });

  test("behind, `push`, nothing attempted ⇒ build", () => {
    expect(compositionWantsRebuild(inputs({ lastAttempt: null }))).toBe(true);
  });

  test("TERMINATION: this target already attempted ⇒ no build, ok or failed", () => {
    // Delegated to `wantsBuild`, deliberately not restated here: a composition
    // that cannot build must not rebuild for ever, and one spelling of that
    // property is the whole reason this function has no termination clause of
    // its own.
    expect(
      compositionWantsRebuild(
        inputs({ lastAttempt: { commit: B, ok: false } }),
      ),
    ).toBe(false);
    expect(
      compositionWantsRebuild(inputs({ lastAttempt: { commit: B, ok: true } })),
    ).toBe(false);
  });

  test("an attempt for the PREVIOUS commit does not stop the rebuild", () => {
    expect(
      compositionWantsRebuild(inputs({ lastAttempt: { commit: A, ok: true } })),
    ).toBe(true);
  });

  test("a marker with no commit builds once, then self-heals", () => {
    // Markers written before the `commit` field cannot name one. An unresolved
    // pin reads as `behind`, never as converged, so the namespace rebuilds and
    // the build stamps a marker that can answer next time.
    expect(
      compositionWantsRebuild(
        inputs({ marker: { builtAt: agoIso(30 * 24 * HOUR) } }),
      ),
    ).toBe(true);
    expect(
      compositionWantsRebuild(
        inputs({ marker: { commit: null, builtAt: agoIso(30 * 24 * HOUR) } }),
      ),
    ).toBe(true);
  });

  test("no HEAD ⇒ no build — nothing to converge toward", () => {
    expect(compositionWantsRebuild(inputs({ head: null }))).toBe(false);
  });
});

describe("the rate limit is the entire content of a cadence", () => {
  test("hourly, built 10 minutes ago ⇒ not due", () => {
    expect(
      compositionWantsRebuild(
        inputs({
          mode: "hourly",
          marker: { commit: A, builtAt: agoIso(10 * 60 * 1000) },
        }),
      ),
    ).toBe(false);
  });

  test("hourly, built 2 hours ago and behind ⇒ due", () => {
    expect(
      compositionWantsRebuild(
        inputs({
          mode: "hourly",
          marker: { commit: A, builtAt: agoIso(2 * HOUR) },
        }),
      ),
    ).toBe(true);
  });

  test("daily and weekly hold a composition that hourly would release", () => {
    const twoHoursAgo = { commit: A, builtAt: agoIso(2 * HOUR) };
    expect(
      compositionWantsRebuild(inputs({ mode: "daily", marker: twoHoursAgo })),
    ).toBe(false);
    expect(
      compositionWantsRebuild(inputs({ mode: "weekly", marker: twoHoursAgo })),
    ).toBe(false);
  });

  test("`push` is rate limit ZERO, not 'no rate limit' — a marker stamped this instant still builds", () => {
    expect(
      compositionWantsRebuild(
        inputs({
          mode: "push",
          marker: { commit: A, builtAt: NOW.toISOString() },
        }),
      ),
    ).toBe(true);
  });

  test("ORDER: rate-limited BEFORE convergence — behind is not enough", () => {
    // The clauses are conjunctive and the rate limit sits above the commit
    // comparison, so a composition that genuinely IS behind still waits out its
    // cadence. Without this the cadences would collapse into `push`.
    expect(
      compositionWantsRebuild(
        inputs({
          mode: "weekly",
          marker: { commit: A, builtAt: agoIso(HOUR) },
        }),
      ),
    ).toBe(false);
  });

  test("ORDER: the never-mint guard sits ABOVE the rate limit", () => {
    // A marker-less composition has no `builtAt` to measure from, so reaching
    // the rate limit at all would mean choosing a fallback instant — and every
    // choice of one either mints the namespace or strands it.
    expect(
      compositionWantsRebuild(inputs({ mode: "weekly", marker: null })),
    ).toBe(false);
  });

  test("an unparseable builtAt is treated as DUE, never as stranded", () => {
    // The rate limit cannot be applied, and "not due" would be permanent:
    // nothing rewrites a marker except the build this clause would be refusing.
    // The convergence clause still gates it, so a converged namespace with a
    // corrupt instant does not build.
    expect(
      compositionWantsRebuild(
        inputs({
          mode: "weekly",
          marker: { commit: A, builtAt: "not a date" },
        }),
      ),
    ).toBe(true);
    expect(
      compositionWantsRebuild(
        inputs({
          mode: "weekly",
          marker: { commit: B, builtAt: "not a date" },
        }),
      ),
    ).toBe(false);
  });
});
