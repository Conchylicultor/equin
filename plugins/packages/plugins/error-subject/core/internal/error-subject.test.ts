import { describe, expect, test } from "bun:test";
import { SubjectError, crashFieldsOf, errorSubject } from "./error-subject";

function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("errorSubject", () => {
  test("a plain error names nothing", () => {
    expect(errorSubject(new Error("boom"))).toBeNull();
    expect(errorSubject("boom")).toBeNull();
  });

  test("a SubjectError over a Postgres error: the subject, then the SQLSTATE", () => {
    const err = new SubjectError("migration x failed", {
      subject: "migration page_links_first_edge (expand)",
      cause: pgError('column "first" already exists', "42701"),
    });
    expect(errorSubject(err)).toBe(
      "migration page_links_first_edge (expand) › code 42701",
    );
  });

  test("one subject, two causes: two identities", () => {
    const of = (code: string) =>
      errorSubject(
        new SubjectError("m", {
          subject: "migration a",
          cause: pgError("x", code),
        }),
      );
    expect(of("42701")).not.toBe(of("55P03"));
  });

  test("nested subjects read outermost first; the innermost code wins", () => {
    const inner = new SubjectError("inner", {
      subject: "table pages",
      cause: Object.assign(new Error("e"), { code: "40P01" }),
    });
    const outer = Object.assign(
      new SubjectError("outer", { subject: "triggers", cause: inner }),
      { code: "EOUTER" },
    );
    expect(errorSubject(outer)).toBe("triggers › table pages › code 40P01");
  });

  test("a bare error with a class code is identified by it", () => {
    expect(errorSubject(pgError("terminating connection", "57P01"))).toBe(
      "code 57P01",
    );
  });

  test("a code that is not a class token is ignored", () => {
    expect(
      errorSubject(Object.assign(new Error("x"), { code: 404 })),
    ).toBeNull();
    expect(
      errorSubject(
        Object.assign(new Error("x"), { code: "not a code at all" }),
      ),
    ).toBeNull();
  });

  test("a cause cycle ends", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(errorSubject(b)).toBeNull();
  });
});

describe("crashFieldsOf", () => {
  test("an Error: its name and stack, the caller's scope then its subject", () => {
    const err = new SubjectError("m", {
      subject: "migration a",
      cause: pgError("x", "42701"),
    });
    expect(crashFieldsOf(err, "job:x")).toEqual({
      errorType: "Error",
      stack: err.stack ?? null,
      scope: "job:x › migration a › code 42701",
    });
  });

  test("no scope and no subject: scope null, so an unscoped report keeps its row", () => {
    expect(crashFieldsOf(new TypeError("t")).scope).toBeNull();
    expect(crashFieldsOf(new TypeError("t")).errorType).toBe("TypeError");
  });

  test("a non-Error throw has no stack", () => {
    expect(crashFieldsOf("plain", "s")).toEqual({
      errorType: "string",
      stack: null,
      scope: "s",
    });
  });
});
