import { describe, expect, test } from "bun:test";
import {
  binaryIdentity,
  dialAddressOf,
  diffGatewayFlags,
  flagValue,
  listenPortOf,
} from "./diff";

describe("diffGatewayFlags", () => {
  test("the same flags in another order are no difference", () => {
    expect(
      diffGatewayFlags(
        ["-listen", "loopback:9000", "-log-level", "info"],
        ["-log-level", "info", "-listen", "loopback:9000"],
      ),
    ).toEqual([]);
  });

  test("a changed short value names both", () => {
    expect(
      diffGatewayFlags(["-listen", ":9000"], ["-listen", "loopback:9000"]),
    ).toEqual(["-listen :9000 → loopback:9000"]);
  });

  test("new and dropped flags", () => {
    expect(
      diffGatewayFlags(
        ["-a", "1", "-old", "x"],
        ["-a", "1", "-pid-file", "/p"],
      ),
    ).toEqual(["new -pid-file", "dropped -old"]);
  });

  test("a comma list is compared as a set, capped", () => {
    expect(
      diffGatewayFlags(
        ["-child-env", "HOME,PATH,OLD"],
        ["-child-env", "HOME,PATH,A,B,C,D"],
      ),
    ).toEqual(["-child-env +A, +B, +C and 2 more"]);
    expect(
      diffGatewayFlags(["-child-env", "A,B"], ["-child-env", "B,A"]),
    ).toEqual(["-child-env reordered"]);
  });

  test("a long value is only said to have changed", () => {
    const long = (c: string) => `/${c.repeat(40)}`;
    expect(
      diffGatewayFlags(["-log-dir", long("a")], ["-log-dir", long("b")]),
    ).toEqual(["-log-dir changed"]);
  });
});

test("flagValue", () => {
  expect(flagValue(["-a", "1", "-b", "2"], "-b")).toBe("2");
  expect(flagValue(["-a", "1"], "-b")).toBeUndefined();
});

test("binaryIdentity", () => {
  expect(
    binaryIdentity("/h/cache/deps/gateway-binary/a6922f99527e4bbb/env/gateway"),
  ).toBe("a6922f99527e4bbb");
  expect(binaryIdentity("/tmp/gateway")).toBeNull();
});

test("a launch's port is its -listen's; none is the old default, 9000", () => {
  expect(listenPortOf(["-listen", "loopback:8701", "-log-level", "info"])).toBe(
    8701,
  );
  expect(listenPortOf(["-listen", ":8700"])).toBe(8700);
  expect(listenPortOf(["-log-level", "info"])).toBe(9000);
  expect(dialAddressOf(["-listen", "loopback:8702"])).toBe("127.0.0.1:8702");
  expect(() => listenPortOf(["-listen", "loopback:"])).toThrow(/names no port/);
});
