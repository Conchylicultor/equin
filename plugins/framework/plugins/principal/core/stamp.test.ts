import { afterEach, describe, expect, test } from "bun:test";
import {
  PRINCIPAL_STAMPED_FLAG,
  principalStamp,
  readPrincipalStamp,
  resetPrincipalStamp,
} from "./stamp";

const argv = (...rest: string[]) => ["bun", "bin/index.ts", ...rest];

afterEach(resetPrincipalStamp);

describe("readPrincipalStamp", () => {
  test("undeclared until an entry point reads it", () => {
    expect(principalStamp()).toBe("undeclared");
  });

  test("the bare flag anywhere on argv is stamped", () => {
    expect(
      readPrincipalStamp(
        argv(
          "--namespace",
          "att-1",
          "--socket",
          "/s.sock",
          PRINCIPAL_STAMPED_FLAG,
        ),
      ),
    ).toBe(true);
    expect(principalStamp()).toBe("stamped");
  });

  test("no flag (a gateway older than the stamp) is unstamped", () => {
    expect(readPrincipalStamp(argv("--namespace", "att-1"))).toBe(false);
    expect(principalStamp()).toBe("unstamped");
  });

  test("the same answer twice is fine; a different one throws", () => {
    readPrincipalStamp(argv(PRINCIPAL_STAMPED_FLAG));
    expect(readPrincipalStamp(argv(PRINCIPAL_STAMPED_FLAG))).toBe(true);
    expect(() => readPrincipalStamp(argv())).toThrow(/redeclared/);
  });
});
