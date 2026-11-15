import { describe, expect, test } from "bun:test";
import { declareExecAdmission, schemaRoleFor } from "./schema-role";

// One process, one declaration: the module-global is declared once here, for
// every test below.
const events: string[] = [];
declareExecAdmission({
  release: () => {
    events.push("release");
    return Promise.resolve();
  },
  reacquire: () => {
    events.push("reacquire");
    return Promise.resolve();
  },
});

function verifier() {
  const role = schemaRoleFor("exec");
  if (role.kind !== "verifier") throw new Error("exec is not a verifier");
  return role;
}

describe("a verifier's yieldAdmission", () => {
  test("gives the admission back for the wait and takes it again after", async () => {
    events.length = 0;
    const result = await verifier().yieldAdmission(() => {
      events.push("wait");
      return Promise.resolve(42);
    });
    expect(result).toBe(42);
    expect(events).toEqual(["release", "wait", "reacquire"]);
  });

  test("a wait that throws does not queue for the slot again: the boot fails", async () => {
    events.length = 0;
    let caught: unknown;
    try {
      await verifier().yieldAdmission(() => {
        events.push("wait");
        return Promise.reject(new Error("not ready"));
      });
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain("not ready");
    expect(events).toEqual(["release", "wait"]);
  });

  test("a second declaration is refused", () => {
    expect(() =>
      declareExecAdmission({
        release: () => Promise.resolve(),
        reacquire: () => Promise.resolve(),
      }),
    ).toThrow(/declared twice/);
  });
});
