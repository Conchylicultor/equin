import { describe, expect, test } from "bun:test";
import { parseGecosFullName, parseIdFullName } from "./parse";
import {
  accountDisplayName,
  accountFirstName,
  accountInitial,
} from "../../core/internal/account";

describe("parseIdFullName (macOS id -F)", () => {
  test("reads the full name, trailing newline dropped", () => {
    expect(parseIdFullName("Etienne Pot\n")).toBe("Etienne Pot");
  });

  test("empty output is an account without a full name", () => {
    expect(parseIdFullName("")).toBeNull();
    expect(parseIdFullName("  \n")).toBeNull();
  });
});

describe("parseGecosFullName (passwd GECOS)", () => {
  test("takes the first comma-separated part of the GECOS field", () => {
    expect(
      parseGecosFullName(
        "epot:x:1000:1000:Etienne Pot,Room 1,555-0100,,:/home/epot:/bin/bash\n",
      ),
    ).toBe("Etienne Pot");
  });

  test("a GECOS with no commas is the name itself", () => {
    expect(
      parseGecosFullName("ada:x:1001:1001:Ada Lovelace:/home/ada:/bin/zsh"),
    ).toBe("Ada Lovelace");
  });

  test("an empty GECOS name is an account without a full name", () => {
    expect(
      parseGecosFullName("svc:x:999:999::/var/lib/svc:/usr/sbin/nologin"),
    ).toBeNull();
    expect(
      parseGecosFullName("svc:x:999:999:,,,:/var/lib/svc:/usr/sbin/nologin"),
    ).toBeNull();
  });

  test("& expands to the capitalised login name", () => {
    expect(
      parseGecosFullName("grace:x:1002:1002:& Hopper:/home/grace:/bin/sh"),
    ).toBe("Grace Hopper");
  });

  test("a line that is not a passwd entry throws", () => {
    expect(() => parseGecosFullName("not a passwd line")).toThrow(
      /not a passwd entry/,
    );
  });
});

describe("account display helpers", () => {
  test("full name: first word and its initial", () => {
    const a = { username: "epot", fullName: "etienne Pot" };
    expect(accountDisplayName(a)).toBe("etienne Pot");
    expect(accountFirstName(a)).toBe("etienne");
    expect(accountInitial(a)).toBe("E");
  });

  test("no full name falls back to the login name", () => {
    const a = { username: "epot", fullName: null };
    expect(accountDisplayName(a)).toBe("epot");
    expect(accountFirstName(a)).toBe("epot");
    expect(accountInitial(a)).toBe("E");
  });
});
