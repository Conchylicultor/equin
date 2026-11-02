import { afterEach, expect, test } from "bun:test";
import {
  resetCodeStamp,
  resolveCodeStamp,
  stampDefinition,
} from "./code-stamp";

afterEach(() => resetCodeStamp());

/** The error `p` rejected with (`rejects.toThrow` is typed `void` under bun:test). */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const provider = (digest: string) => ({ stamp: async () => digest });

test("a definition is stamped with the code: other code, another stored definition", async () => {
  await resolveCodeStamp([provider("code-1")]);
  const one = stampDefinition("def");
  expect(stampDefinition("def")).toBe(one);
  resetCodeStamp();
  await resolveCodeStamp([provider("code-2")]);
  expect(stampDefinition("def")).not.toBe(one);
  // No definition stays none (a hand-written value's).
  expect(stampDefinition(null)).toBeNull();
});

test("not resolved yet: a definition matches nothing ever written", async () => {
  const pending = stampDefinition("def");
  await resolveCodeStamp([provider("code-1")]);
  expect(stampDefinition("def")).not.toBe(pending);
});

test("no provider (a host without the source): a stamp of this process alone", async () => {
  await resolveCodeStamp([]);
  const one = stampDefinition("def");
  resetCodeStamp();
  await resolveCodeStamp([]);
  expect(stampDefinition("def")).not.toBe(one);
});

test("a digest that fails, or two providers, throw: L2 stays off, nothing matches", async () => {
  const failed = await rejection(
    resolveCodeStamp([
      {
        stamp: async () => {
          throw new Error("cannot resolve an import");
        },
      },
    ]),
  );
  expect(failed.message).toBe("cannot resolve an import");
  expect(
    (await rejection(resolveCodeStamp([provider("a"), provider("b")]))).message,
  ).toMatch(/2 plugins provide the L2 code stamp/);
  // Still pending: whatever reads a definition matches no stored row.
  expect(stampDefinition("def")).toBe("unstamped");
});
