import { expect, test } from "bun:test";
import { TRANSIENT_REFRESH_REPORT_AFTER_MS } from "@plugins/auth/core";
import {
  createRefreshFailureWatch,
  type RefreshFailure,
} from "./refresh-failures";

const MIN = 60_000;

function setup(awakeReadable = true) {
  const clock = { wall: 1_000_000, awake: 5_000 };
  const watch = createRefreshFailureWatch({
    nowMs: () => clock.wall,
    awakeMs: () => (awakeReadable ? clock.awake : null),
  });
  /** Advance `awakeMs` awake, then `sleptMs` asleep (wall moves by both). */
  const pass = (awakeMs: number, sleptMs = 0): void => {
    clock.wall += awakeMs + sleptMs;
    clock.awake += awakeMs;
  };
  return { watch, pass };
}

const transient: RefreshFailure = {
  providerId: "google",
  providerName: "Google",
  accountId: "primary",
  kind: "transient",
  error: "getaddrinfo ENOTFOUND oauth2.googleapis.com",
};

test("a transient failure is reported once, after the bound of awake time", () => {
  const { watch, pass } = setup();
  const filed = [];
  for (let i = 0; i <= 40; i++) {
    const r = watch.failed(transient);
    if (r) filed.push({ at: i, r });
    pass(MIN);
  }
  expect(filed).toHaveLength(1);
  expect(filed[0]!.at).toBe(TRANSIENT_REFRESH_REPORT_AFTER_MS / MIN);
  expect(filed[0]!.r).toMatchObject({
    kind: "transient",
    failingMs: TRANSIENT_REFRESH_REPORT_AFTER_MS,
    attempts: 31,
  });
});

test("sleep between failures does not count: dark-wake naps stay quiet", () => {
  const { watch, pass } = setup();
  // An hour of wall clock, made of 1 min awake + 10 min asleep cycles.
  for (let i = 0; i < 6; i++) {
    expect(watch.failed(transient)).toBeNull();
    pass(MIN, 10 * MIN);
  }
});

test("a success ends the run, so the next failure starts a new one", () => {
  const { watch, pass } = setup();
  watch.failed(transient);
  pass(TRANSIENT_REFRESH_REPORT_AFTER_MS - MIN);
  watch.succeeded("google", "primary");
  pass(2 * MIN);
  expect(watch.failed(transient)).toBeNull();
});

test("a permanent refusal is reported at once, every time", () => {
  const { watch, pass } = setup();
  watch.failed(transient);
  pass(5 * MIN);
  const r = watch.failed({
    ...transient,
    kind: "permanent",
    error: "invalid_grant",
    hint: "h",
  });
  expect(r).toMatchObject({
    kind: "permanent",
    failingMs: 5 * MIN,
    attempts: 2,
    hint: "h",
  });
  expect(
    watch.failed({ ...transient, kind: "permanent", error: "invalid_grant" }),
  ).toMatchObject({
    attempts: 1,
    failingMs: 0,
  });
});

test("without an awake clock the run is measured on the wall clock", () => {
  const { watch, pass } = setup(false);
  watch.failed(transient);
  pass(0, TRANSIENT_REFRESH_REPORT_AFTER_MS);
  expect(watch.failed(transient)?.failingMs).toBe(
    TRANSIENT_REFRESH_REPORT_AFTER_MS,
  );
});

test("accounts are watched separately", () => {
  const { watch, pass } = setup();
  watch.failed(transient);
  pass(TRANSIENT_REFRESH_REPORT_AFTER_MS);
  expect(watch.failed({ ...transient, accountId: "other" })).toBeNull();
  expect(watch.failed(transient)).not.toBeNull();
});
