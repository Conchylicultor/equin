import { afterEach, expect, test } from "bun:test";
import {
  persistCandidates,
  resetCodeStamps,
  resolveCodeStamps,
  shouldPersist,
  stampDefinition,
} from "./code-stamp";

afterEach(() => resetCodeStamps());

/** The error `p` rejected with (`rejects.toThrow` is typed `void` under bun:test). */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const set = (description: string) => ({ description, urls: () => [] });
const loaderA = set("a's loader");
const loaderB = set("b's loader");
const compiler = set("the compiler");
const candidates = new Map([
  ["a", [loaderA]],
  ["b", [loaderB]],
  ["c", [compiler]],
]);
// A digest per set description: each key's code digests apart.
const provider = (version: string) => ({
  digest: async (code: readonly { description: string }[]) =>
    `${version}:${code.map((c) => c.description).join("+")}`,
});
const neverFails = (key: string, err: unknown) => {
  throw new Error(`unexpected digest failure for ${key}: ${String(err)}`);
};

test("candidates: a preloaded key whose Declare names its code — never one without, nor an enumerated preload", () => {
  const out = persistCandidates([
    { key: "with-code", preload: "boot", code: [loaderA] },
    { key: "no-code", preload: "boot" },
    { key: "empty-code", preload: "boot", code: [] },
    { key: "not-preloaded", code: [loaderA] },
    {
      key: "enumerated",
      preload: "boot",
      preloadTuples: () => Promise.resolve([]),
      code: [loaderA],
    },
  ]);
  expect([...out.keys()]).toEqual(["with-code"]);
});

test("each key is stamped with its own code: other code, another stored definition", async () => {
  await resolveCodeStamps(neverFails, candidates, [provider("v1")]);
  const a = stampDefinition("a", null);
  expect(stampDefinition("a", null)).toBe(a);
  // A key without a definition is still versioned, apart from another key's.
  expect(a).not.toBe("unstamped");
  expect(stampDefinition("b", null)).not.toBe(a);
  // A definition moves it too.
  expect(stampDefinition("c", "def-1")).not.toBe(stampDefinition("c", "def-2"));
  const c = stampDefinition("c", "def-1");
  resetCodeStamps();
  await resolveCodeStamps(neverFails, candidates, [provider("v2")]);
  expect(stampDefinition("a", null)).not.toBe(a);
  expect(stampDefinition("c", "def-1")).not.toBe(c);
});

test("only a stamped key is persisted: no code, or not resolved yet, is never persisted or matched", async () => {
  expect(shouldPersist("a")).toBe(false);
  const pending = stampDefinition("a", null);
  expect(pending).toBe("unstamped");
  await resolveCodeStamps(neverFails, candidates, [provider("v1")]);
  expect(shouldPersist("a")).toBe(true);
  expect(shouldPersist("not-a-candidate")).toBe(false);
  expect(stampDefinition("not-a-candidate", "def")).toBe("unstamped");
  expect(stampDefinition("a", null)).not.toBe(pending);
});

test("a digest that fails leaves that key out (reported) and stamps the rest", async () => {
  const failed: string[] = [];
  await resolveCodeStamps((key) => failed.push(key), candidates, [
    {
      digest: async (code) => {
        if (code[0] === loaderB) throw new Error("cannot resolve an import");
        return "v1";
      },
    },
  ]);
  expect(failed).toEqual(["b"]);
  expect(shouldPersist("a")).toBe(true);
  expect(shouldPersist("b")).toBe(false);
  expect(shouldPersist("c")).toBe(true);
});

test("no provider (a host without the source): every key stamped by this process alone", async () => {
  await resolveCodeStamps(neverFails, candidates, []);
  expect(shouldPersist("a")).toBe(true);
  const one = stampDefinition("a", null);
  resetCodeStamps();
  await resolveCodeStamps(neverFails, candidates, []);
  expect(stampDefinition("a", null)).not.toBe(one);
});

test("two providers throw: L2 stays off, nothing persists or matches", async () => {
  expect(
    (
      await rejection(
        resolveCodeStamps(neverFails, candidates, [
          provider("a"),
          provider("b"),
        ]),
      )
    ).message,
  ).toMatch(/2 plugins provide the L2 code digest/);
  expect(shouldPersist("a")).toBe(false);
  expect(stampDefinition("a", "def")).toBe("unstamped");
});
