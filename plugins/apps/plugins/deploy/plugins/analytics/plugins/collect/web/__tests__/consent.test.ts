import { describe, expect, it } from "vitest";
import {
  answerConsent,
  consentKeyOf,
  readConsent,
  type ConsentStore,
} from "../internal/consent";

type Entry = Parameters<ConsentStore["write"]>[1];

function memoryStore(): ConsentStore {
  let entry: Entry | null = null;
  return {
    read: () =>
      entry === null
        ? { kind: "none", why: "absent" }
        : { kind: "value", value: entry, ts: 0 },
    write: (_id, value) => {
      entry = value;
      return { ok: true };
    },
    remove: () => {
      entry = null;
    },
    subscribe: () => () => {},
  };
}

describe("consent", () => {
  it("is undecided, with no key, until the visitor answers", () => {
    const store = memoryStore();
    expect(readConsent(store)).toBe("undecided");
    expect(consentKeyOf(store)).toBeUndefined();
  });

  it("accepting keeps a fresh key; accepting again mints another", () => {
    const store = memoryStore();
    answerConsent(store, true);
    expect(readConsent(store)).toBe("accepted");
    const first = consentKeyOf(store);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    answerConsent(store, true);
    expect(consentKeyOf(store)).not.toBe(first);
  });

  it("rejecting drops the key at once", () => {
    const store = memoryStore();
    answerConsent(store, true);
    answerConsent(store, false);
    expect(readConsent(store)).toBe("rejected");
    expect(consentKeyOf(store)).toBeUndefined();
  });
});
