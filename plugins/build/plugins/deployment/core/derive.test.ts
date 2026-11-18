import { describe, expect, test } from "bun:test";
import {
  resolved,
  unresolved,
} from "@plugins/network/plugins/live/plugins/live-state/core";
import { convergenceOf, wantsBuild } from "./derive";
import { MAX_NO_VERDICT_ATTEMPTS, sameCommit } from "./model";
import type { BuildAttempt, Carrier, CarrierId, Deployment } from "./model";

/**
 * The value of extracting `convergenceOf` / `wantsBuild` is that the properties
 * the whole design rests on are decidable without the db / config / git
 * singletons the callers bind — exactly as `needsRebuild` was tested before it,
 * and for the same reason: the auto-build policy is the thing that must not be
 * able to loop, and must not be able to miss.
 *
 * Run: `./equin test plugins/build/plugins/deployment`
 */

const A = "aaaaaaa1111111111111111111111111111111a";
const B = "bbbbbbb2222222222222222222222222222222b";

/** A deployable carrier sitting at `commit`, on the line to the target. */
function at(id: CarrierId, commit: string): Carrier {
  return {
    id,
    commit: resolved(commit),
    graph: resolved(`graph-of-${commit.slice(0, 7)}`),
    ancestorOfTarget: resolved(true),
  };
}

/** A carrier that cannot name its commit — a mixed boot, or a dist with no pin. */
function unpinned(id: CarrierId, reason: string): Carrier {
  return {
    id,
    commit: unresolved(reason),
    graph: unresolved(reason),
    ancestorOfTarget: unresolved(reason),
  };
}

/** A carrier sitting on a commit that is NOT an ancestor of the target. */
function offLine(id: CarrierId, commit: string): Carrier {
  return { ...at(id, commit), ancestorOfTarget: resolved(false) };
}

function deployment(target: string, deployable: Carrier[]): Deployment {
  return { target: resolved(target), deployable };
}

describe("convergenceOf", () => {
  test("every deployable carrier at the target ⇒ converged", () => {
    expect(convergenceOf(deployment(A, [at("server", A), at("web", A)]))).toBe(
      "converged",
    );
  });

  test("one carrier still on the old commit ⇒ behind", () => {
    // Today's incident: the backend restarted into the new tree while the dist
    // still served the previous commit's bundle.
    expect(convergenceOf(deployment(B, [at("server", B), at("web", A)]))).toBe(
      "behind",
    );
  });

  test("a carrier off the line ⇒ diverged, even when another sits on the target", () => {
    expect(
      convergenceOf(deployment(B, [at("server", B), offLine("web", A)])),
    ).toBe("diverged");
  });

  test("an unresolvable pin is NOT converged — it is behind", () => {
    // A server that is genuinely a mix of two trees cannot name one honest
    // commit. Reading that as converged is what would leave it running.
    expect(
      convergenceOf(
        deployment(A, [unpinned("server", "mixed boot"), at("web", A)]),
      ),
    ).toBe("behind");
  });

  test("no target (a release bundle has no checkout) ⇒ unknown", () => {
    expect(
      convergenceOf({
        target: unresolved("no checkout"),
        deployable: [at("server", A)],
      }),
    ).toBe("unknown");
  });

  test("no carriers ⇒ unknown, never a vacuous converged", () => {
    expect(convergenceOf(deployment(A, []))).toBe("unknown");
  });
});

/** A closed attempt at `commit`. */
function attempt(
  commit: string | null,
  outcome: BuildAttempt["outcome"],
  id = `build-${outcome}`,
): BuildAttempt {
  return { id, commit, outcome };
}

/** The bit: is a build wanted? */
function wants(d: Deployment, attempts: BuildAttempt[]): boolean {
  return wantsBuild(d, attempts).kind === "build";
}

describe("wantsBuild", () => {
  test("converged ⇒ no build, and says so", () => {
    expect(
      wantsBuild(deployment(A, [at("server", A), at("web", A)]), [
        attempt(A, "ok"),
      ]),
    ).toEqual({ kind: "converged" });
  });

  test("behind ⇒ build", () => {
    expect(
      wantsBuild(deployment(B, [at("server", B), at("web", A)]), [
        attempt(A, "ok"),
      ]),
    ).toEqual({ kind: "build", retry: 0 });
  });

  test("diverged ⇒ build", () => {
    expect(
      wants(deployment(B, [at("server", B), offLine("web", A)]), [
        attempt(A, "ok"),
      ]),
    ).toBe(true);
  });

  test("TERMINATION: the same target already built with a verdict ⇒ no build, ok or failed", () => {
    // The loop this clause exists to prevent: a build that FAILED leaves the
    // carriers behind for ever, so "not converged ⇒ build" alone would rebuild
    // the same broken commit without end.
    const behind = deployment(B, [at("server", A), at("web", A)]);
    const failed = attempt(B, "failed");
    expect(wantsBuild(behind, [failed])).toEqual({
      kind: "failed",
      attempt: failed,
    });
    const ok = attempt(B, "ok");
    expect(wantsBuild(behind, [ok])).toEqual({ kind: "built", attempt: ok });
  });

  test("the chain terminates after exactly one extra build", () => {
    const behind = deployment(B, [at("server", A), at("web", A)]);
    expect(wants(behind, [attempt(A, "ok")])).toBe(true);
    // That build is FOR B, so the next reconcile — even before B is deployed —
    // stops.
    expect(wants(behind, [attempt(B, "ok"), attempt(A, "ok")])).toBe(false);
  });

  test("THE INCIDENT: a superseded attempt ⇒ build", () => {
    // 2026-08-19: a push landed 13s before the running build finished. The build
    // was for A, main moved to B, and the deployed bundle stayed at A. The last
    // attempt is for A, the target is B — they differ, so the rebuild is minted.
    // This is the case all three of the old mechanisms missed.
    expect(
      wants(deployment(B, [at("server", B), at("web", A)]), [attempt(A, "ok")]),
    ).toBe(true);
  });

  test("2026-11-18: a build of the target killed from outside is retried, with how many came before", () => {
    // A fresh Linux VM: main's build of B was OOM-killed mid-checks (exit
    // 143). Consuming the target with it left main on A until the next push,
    // while the run logged "converged".
    const behind = deployment(B, [at("web", A)]);
    expect(wantsBuild(behind, [attempt(B, "no-verdict")])).toEqual({
      kind: "build",
      retry: 1,
    });
    expect(
      wantsBuild(behind, [
        attempt(B, "no-verdict"),
        attempt(B, "no-verdict"),
        attempt(A, "ok"),
      ]),
    ).toEqual({ kind: "build", retry: 2 });
  });

  test("TERMINATION, no-verdict arm: the retries are bounded", () => {
    // A commit whose build is killed every time (it runs the host out of
    // memory) must stop, or it would rebuild for ever.
    const behind = deployment(B, [at("web", A)]);
    const killed = Array.from({ length: MAX_NO_VERDICT_ATTEMPTS }, (_, i) =>
      attempt(B, "no-verdict", `build-killed-${i}`),
    );
    expect(wantsBuild(behind, killed)).toEqual({
      kind: "retries-spent",
      attempts: killed,
    });
  });

  test("a verdict behind a killed attempt still decides: a failure is not retried by being killed later", () => {
    // B failed its checks; a person's manual Build of B was then killed. The
    // code's verdict stands — the next push is the next automatic attempt.
    const behind = deployment(B, [at("web", A)]);
    const failed = attempt(B, "failed");
    expect(
      wantsBuild(behind, [attempt(B, "no-verdict"), failed, attempt(A, "ok")]),
    ).toEqual({ kind: "failed", attempt: failed });
  });

  test("attempts at an older commit never count against the target's retries", () => {
    const behind = deployment(B, [at("web", A)]);
    expect(
      wantsBuild(behind, [
        attempt(A, "no-verdict"),
        attempt(A, "no-verdict"),
        attempt(A, "no-verdict"),
      ]),
    ).toEqual({ kind: "build", retry: 0 });
  });

  test("an unresolved pin does NOT re-attempt a target already built — termination wins", () => {
    // The one place two properties of this design pull against each other. A
    // mixed-boot server is not converged, and a rebuild would clear it — but
    // exempting it from termination is an unbounded loop if the pin is
    // unresolvable for a persistent reason. Termination is absolute; the mixed
    // state stays visible in the chain and a manual Build is the escape hatch.
    expect(
      wants(deployment(A, [unpinned("server", "mixed boot"), at("web", A)]), [
        attempt(A, "ok"),
      ]),
    ).toBe(false);
  });

  test("an unresolved pin DOES build once the target moves past the last attempt", () => {
    // Not converged, and this target has not been attempted — so the mixed-boot
    // server does heal at the next advance, which is what bounds how long it can
    // stay mixed.
    expect(
      wants(deployment(B, [unpinned("server", "mixed boot"), at("web", B)]), [
        attempt(A, "ok"),
      ]),
    ).toBe(true);
  });

  test("no target ⇒ no build — a release bundle has nothing to converge toward", () => {
    expect(
      wantsBuild(
        { target: unresolved("no checkout"), deployable: [at("web", A)] },
        [],
      ),
    ).toEqual({ kind: "unknown" });
  });

  test("no attempt on record ⇒ build", () => {
    expect(wants(deployment(B, [at("server", A), at("web", A)]), [])).toBe(
      true,
    );
  });

  test("an attempt that cannot name its commit does not stop the build", () => {
    expect(
      wants(deployment(B, [at("server", A), at("web", A)]), [
        attempt(null, "failed"),
      ]),
    ).toBe(true);
  });

  test("a stale tab is not a deployable carrier, so it never mints a build", () => {
    // `deployable` carries server + web only. Were the tab in it, a tab nobody
    // reloads would loop the reconciler for ever.
    const d = deployment(A, [at("server", A), at("web", A)]);
    expect(d.deployable.some((c) => c.id === "tab")).toBe(false);
    expect(wants(d, [attempt(A, "ok")])).toBe(false);
  });
});

describe("sameCommit — tolerance for the rows written before the format was fixed", () => {
  test("two full shas — the spelling both writers use now", () => {
    expect(sameCommit(A, A)).toBe(true);
    expect(sameCommit(A, B)).toBe(false);
  });

  test("a historical short sha still matches the full sha it abbreviates", () => {
    // `build_runs.commitHash` used to hold `rev-parse --short` output while
    // `.build-commit` and the target were full. Plain `===` between them is
    // silently always-false, so termination would never fire on those rows.
    expect(sameCommit(A.slice(0, 9), A)).toBe(true);
    expect(sameCommit(A, A.slice(0, 9))).toBe(true);
    expect(sameCommit(A.slice(0, 8), A)).toBe(true);
  });

  test("different commits never match", () => {
    expect(sameCommit(A, B)).toBe(false);
    expect(sameCommit(A.slice(0, 9), B)).toBe(false);
  });

  test("a prefix too short to be evidence never matches", () => {
    expect(sameCommit(A.slice(0, 4), A)).toBe(false);
    expect(sameCommit("", A)).toBe(false);
  });

  test("termination holds for a historical short-sha attempt against a full target", () => {
    // The mixed case, pinned: an old row (abbreviated) still terminates against
    // a target read at full length.
    const behind = deployment(B, [at("server", A), at("web", A)]);
    expect(wants(behind, [attempt(B.slice(0, 9), "failed")])).toBe(false);
    expect(wants(behind, [attempt(B.slice(0, 8), "ok")])).toBe(false);
    // And a DIFFERENT old short sha must still mint the build.
    expect(wants(behind, [attempt(A.slice(0, 9), "ok")])).toBe(true);
  });
});
