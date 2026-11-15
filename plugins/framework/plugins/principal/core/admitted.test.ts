import { afterEach, describe, expect, test } from "bun:test";
import { admittedAs } from "./admitted";
import { PRINCIPAL_HEADER } from "./principal";
import {
  PRINCIPAL_STAMPED_FLAG,
  readPrincipalStamp,
  resetPrincipalStamp,
} from "./stamp";

const req = (stamp?: string) =>
  new Request("http://backend/api/resources/x", {
    headers: stamp === undefined ? {} : { [PRINCIPAL_HEADER]: stamp },
  });

afterEach(resetPrincipalStamp);

describe("admittedAs", () => {
  test("undeclared (in-realm host, tests) and unstamped hosts serve the owner", () => {
    expect(admittedAs(req("visitor"))).toBe("owner");
    readPrincipalStamp(["bun", "x"]);
    expect(admittedAs(req("visitor"))).toBe("owner");
  });

  test("stamped: only an owner stamp is the owner; anything else is a visitor", () => {
    readPrincipalStamp(["bun", "x", PRINCIPAL_STAMPED_FLAG]);
    expect(admittedAs(req("owner"))).toBe("owner");
    expect(admittedAs(req("visitor"))).toBe("visitor");
    expect(admittedAs(req("anonymous"))).toBe("visitor");
    expect(admittedAs(req("content"))).toBe("visitor");
    expect(admittedAs(req())).toBe("visitor");
  });
});
