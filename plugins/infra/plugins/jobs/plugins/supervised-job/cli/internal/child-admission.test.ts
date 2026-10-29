import { describe, expect, test } from "bun:test";
import { SUPERVISED_EXIT_TEMPFAIL } from "../../core";
import { parseAdmissionPool, supervisedChildExitCode } from "./child-admission";

describe("parseAdmissionPool", () => {
  test("a declared pool is accepted", () => {
    expect(parseAdmissionPool("worktree-prepare")).toBe("worktree-prepare");
  });

  test("an undeclared pool is refused loudly, naming the declared ones", () => {
    expect(() => parseAdmissionPool("nope")).toThrow(/names no host pool/);
    expect(() => parseAdmissionPool("nope")).toThrow(/worktree-prepare/);
    // Not an own key of the table, however it is spelled.
    expect(() => parseAdmissionPool("toString")).toThrow(/names no host pool/);
  });
});

describe("supervisedChildExitCode", () => {
  test("a database full at boot exits EX_TEMPFAIL, even wrapped", () => {
    const refused = Object.assign(
      new Error("no more connections allowed (max_client_conn)"),
      { code: "08P01" },
    );
    expect(supervisedChildExitCode(refused)).toBe(SUPERVISED_EXIT_TEMPFAIL);
    expect(
      supervisedChildExitCode(
        new Error("Database did not become reachable within 30000ms", {
          cause: refused,
        }),
      ),
    ).toBe(SUPERVISED_EXIT_TEMPFAIL);
  });

  test("every other failure exits 1", () => {
    expect(supervisedChildExitCode(new Error("install failed"))).toBe(1);
    expect(
      supervisedChildExitCode(
        Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      ),
    ).toBe(1);
  });
});
