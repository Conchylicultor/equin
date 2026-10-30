import { describe, expect, test } from "bun:test";
import {
  ATTEMPT_TRAILER_KEY,
  PUSH_TRAILER_KEY,
  UNATTRIBUTED_TRAILER_KEY,
} from "@plugins/tasks/plugins/tasks-core/core";
import { resolvePushAttribution, trailerAmendCommand } from "./attribution";

const ATT = "att-1793320131-b1fur3";

describe("resolvePushAttribution", () => {
  const base = {
    branch: `claude-web/${ATT}`,
    pushId: "push-1",
    conversationId: undefined,
    unattributed: undefined,
  };

  test("an attempt's branch is credited to its attempt, with or without a conversation", () => {
    for (const conversationId of [undefined, "conv-1"]) {
      expect(resolvePushAttribution({ ...base, conversationId })).toEqual({
        ok: true,
        trailers: [
          `${PUSH_TRAILER_KEY}=push-1`,
          `${ATTEMPT_TRAILER_KEY}=${ATT}`,
        ],
      });
    }
  });

  test("a branch that is no attempt's carries the push trailer alone", () => {
    expect(resolvePushAttribution({ ...base, branch: "hotfix" })).toEqual({
      ok: true,
      trailers: [`${PUSH_TRAILER_KEY}=push-1`],
    });
  });

  test("--unattributed stamps its reason when nothing else names the push", () => {
    expect(
      resolvePushAttribution({
        ...base,
        branch: "hotfix",
        unattributed: " recovery: main would not boot ",
      }),
    ).toEqual({
      ok: true,
      trailers: [
        `${PUSH_TRAILER_KEY}=push-1`,
        `${UNATTRIBUTED_TRAILER_KEY}=recovery: main would not boot`,
      ],
    });
  });

  test("--unattributed is refused when the push is attributable", () => {
    expect(resolvePushAttribution({ ...base, unattributed: "why" }).ok).toBe(
      false,
    );
    expect(
      resolvePushAttribution({
        ...base,
        branch: "hotfix",
        conversationId: "conv-1",
        unattributed: "why",
      }).ok,
    ).toBe(false);
  });

  test("--unattributed needs a one-line reason", () => {
    for (const unattributed of ["", "  ", "two\nlines"]) {
      expect(
        resolvePushAttribution({ ...base, branch: "hotfix", unattributed }).ok,
      ).toBe(false);
    }
  });
});

test("the rebase --exec amend single-quotes every trailer", () => {
  expect(trailerAmendCommand(["A=1", "B=it's here"])).toBe(
    `git -c trailer.ifexists=replace commit --amend --no-edit --trailer 'A=1' --trailer 'B=it'\\''s here'`,
  );
});
