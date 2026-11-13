import { describe, expect, test } from "bun:test";
import { launchNotice } from "./launch-notice";

describe("launchNotice", () => {
  test("a launch nobody is looking at is announced as started", () => {
    expect(
      launchNotice({
        kind: "user",
        launchCause: "direct",
        shownByLauncher: false,
      }),
    ).toEqual({ title: "Conversation started", unblocked: false });
    expect(
      launchNotice({
        kind: "user",
        launchCause: "armed",
        shownByLauncher: false,
      }),
    ).toEqual({ title: "Conversation started", unblocked: false });
  });

  test("an unblocked launch says so", () => {
    expect(
      launchNotice({
        kind: "user",
        launchCause: "unblocked",
        shownByLauncher: false,
      }),
    ).toEqual({ title: "Conversation unblocked", unblocked: true });
  });

  test("a launch its launcher shows is not announced", () => {
    expect(
      launchNotice({
        kind: "user",
        launchCause: "direct",
        shownByLauncher: true,
      }),
    ).toBeNull();
  });

  test("a system conversation is never announced", () => {
    expect(
      launchNotice({
        kind: "system",
        launchCause: "direct",
        shownByLauncher: false,
      }),
    ).toBeNull();
  });
});
