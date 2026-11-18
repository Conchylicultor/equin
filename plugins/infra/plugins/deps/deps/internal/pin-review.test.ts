import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import { defineDep, type DepSource } from "./dep";
import { pinDep, pinnedDep } from "./pin";
import {
  liftPinStay,
  PIN_LAG_MAX_DAYS,
  pinDecisionDue,
  reviewPin,
  stayPin,
} from "./pin-review";

let base: string;
let root: AppPath;
let reviewDir: AppPath;
let store: { cacheRoot: AppPath; locksRoot: AppPath };
const exec = execContextForTests();

/** The checkout's `version` file is the version; installed as `env/v`. */
const source: DepSource<"pin-review-test"> = {
  kind: "pin-review-test",
  label: "the version file",
  async identityInputs(r) {
    return { version: await readFile(join(r, "version"), "utf8") };
  },
  async install(ctx) {
    mkdirSync(ctx.dir, { recursive: true });
    writeFileSync(
      join(ctx.dir, "v"),
      readFileSync(join(ctx.root, "version"), "utf8"),
    );
  },
  version: {
    declared: (r) => readFile(join(r, "version"), "utf8"),
    installed: (dir) => readFile(join(dir, "v"), "utf8"),
  },
};

const dep = defineDep({
  id: "pin-review-test",
  owner: "infra/deps",
  description: "",
  sizeHint: "",
  source,
  updates: { none: "test" },
  pin: {
    holder: "machine-pin-review-test",
    appliesAt: "the next restart",
    switchBlocked: (from, to) =>
      from[0] === to[0] ? null : `major ${from[0]} → ${to[0]}`,
  },
});

const version = (v: string) => writeFileSync(join(root, "version"), v);
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
const review = (now: Date, record = true) =>
  reviewPin(dep, { root, store, reviewDir, now, record });
const recordFile = () => join(reviewDir, `${dep.id}.json`);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "deps-pin-review-test-"));
  root = joinAppPath(asAppPath(base), "repo");
  reviewDir = joinAppPath(asAppPath(base), "reviews");
  store = {
    cacheRoot: joinAppPath(asAppPath(base), "cache"),
    locksRoot: joinAppPath(asAppPath(base), "locks"),
  };
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("a pin's lag is bounded like a hold", () => {
  test("unpinned, or pinned to what main declares, is current and records nothing", async () => {
    expect(await review(day("2026-11-01"))).toEqual({ kind: "current" });
    version("1.0.0");
    await pinnedDep(dep, exec, { root, store });
    expect(await review(day("2026-11-01"))).toEqual({ kind: "current" });
    expect(existsSync(recordFile())).toBe(false);
  });

  test(`the clock starts when a review first sees the lag; past ${PIN_LAG_MAX_DAYS} days it is due`, async () => {
    version("1.0.0");
    await pinnedDep(dep, exec, { root, store });
    version("1.1.0");

    // A read-only look records nothing: the lag has no clock yet.
    const unrecorded = await review(day("2026-11-01"), false);
    expect(unrecorded).toMatchObject({
      kind: "lagging",
      decision: "within-bound",
      lag: { since: null, dueOn: null, blocked: null },
    });
    expect(existsSync(recordFile())).toBe(false);

    const first = await review(day("2026-11-01"));
    expect(first).toMatchObject({
      kind: "lagging",
      decision: "within-bound",
      lag: {
        pinned: { version: "1.0.0" },
        declared: { version: "1.1.0" },
        dueOn: "2026-12-01",
      },
    });
    expect(pinDecisionDue(first)).toBe(false);

    // Main moving on while the pin lags keeps the clock.
    version("1.2.0");
    expect(await review(day("2026-11-30"))).toMatchObject({
      decision: "within-bound",
      lag: { since: "2026-11-01T12:00:00.000Z" },
    });
    const due = await review(day("2026-12-01"));
    expect(due).toMatchObject({ decision: "due" });
    expect(pinDecisionDue(due)).toBe(true);
  });

  test("a stay defers the decision until its reviewBy, then it is due again", async () => {
    version("1.0.0");
    await pinnedDep(dep, exec, { root, store });
    version("2.0.0");
    await review(day("2026-08-01"));
    expect(await review(day("2026-11-01"))).toMatchObject({
      decision: "due",
      lag: { blocked: "major 1 → 2" },
    });

    const stay = await stayPin(dep, {
      root,
      store,
      reviewDir,
      now: day("2026-11-01"),
      reason: "no major upgrade procedure yet",
      reviewBy: "2027-01-30",
    });
    expect(stay).toEqual({
      names: [dep.id],
      below: "2.0.0",
      reason: "no major upgrade procedure yet",
      reviewBy: "2027-01-30",
    });
    const stayed = await review(day("2027-01-30"));
    expect(stayed).toMatchObject({ decision: "stayed" });
    expect(pinDecisionDue(stayed)).toBe(false);
    // Covers what main declares next too (the stay holds 2.0.0 and up).
    version("2.1.0");
    expect(await review(day("2027-01-30"))).toMatchObject({
      decision: "stayed",
    });

    const lapsed = await review(day("2027-01-31"));
    expect(lapsed).toMatchObject({ decision: "stay-lapsed" });
    expect(pinDecisionDue(lapsed)).toBe(true);

    expect(await liftPinStay(dep, { reviewDir })).toEqual(stay);
    expect(await review(day("2027-01-31"))).toMatchObject({
      decision: "due",
      stay: null,
    });
  });

  test("a stay is bounded to 90 days, and needs a lag to stay on", async () => {
    version("1.0.0");
    await pinnedDep(dep, exec, { root, store });
    const stay = (reviewBy: string) =>
      stayPin(dep, {
        root,
        store,
        reviewDir,
        now: day("2026-11-01"),
        reason: "r",
        reviewBy,
      });
    expect(stay("2027-01-01")).rejects.toThrow(/nothing to stay on/);
    version("1.1.0");
    expect(stay("2027-02-01")).rejects.toThrow(/at most 90 days/);
    expect(stay("2026-10-31")).rejects.toThrow(/from today/);
    expect(stay("2026-11-31")).rejects.toThrow(/a real day/);
  });

  test("switching the pin closes the lag: the record goes, a stay with it", async () => {
    version("1.0.0");
    await pinnedDep(dep, exec, { root, store });
    version("1.1.0");
    await stayPin(dep, {
      root,
      store,
      reviewDir,
      now: day("2026-11-01"),
      reason: "r",
      reviewBy: "2027-01-01",
    });
    await pinDep(dep, exec, { root, store });
    expect(await review(day("2026-11-02"))).toEqual({ kind: "current" });
    expect(existsSync(recordFile())).toBe(false);

    // A later lag starts a fresh clock, with no stay.
    version("1.2.0");
    expect(await review(day("2026-11-10"))).toMatchObject({
      decision: "within-bound",
      stay: null,
      lag: { dueOn: "2026-12-10" },
    });
  });
});
