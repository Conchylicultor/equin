import { describe, expect, test } from "bun:test";
import {
  ENV_PREFIX,
  RUNTIME_FORWARDED_ENV,
  RUNTIME_FORWARDED_PREFIXES,
  RUNTIME_WITHHELD_ENV,
} from "./env-keys";

const forwarded = Object.keys(RUNTIME_FORWARDED_ENV);
const withheld = Object.keys(RUNTIME_WITHHELD_ENV);
const prefixes = Object.keys(RUNTIME_FORWARDED_PREFIXES);

describe("the declaration", () => {
  test("forwarded and withheld are disjoint", () => {
    expect(forwarded.filter((name) => withheld.includes(name))).toEqual([]);
  });

  test("no withheld name is forwarded by a prefix", () => {
    expect(
      withheld.filter((name) => prefixes.some((p) => name.startsWith(p))),
    ).toEqual([]);
  });

  test("a key is a bare suffix: it never carries a name prefix itself", () => {
    for (const key of [...forwarded, ...withheld, ...prefixes]) {
      expect(key).not.toStartWith(ENV_PREFIX);
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
