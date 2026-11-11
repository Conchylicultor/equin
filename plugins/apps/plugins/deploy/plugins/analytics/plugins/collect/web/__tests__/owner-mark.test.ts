import { describe, expect, it } from "vitest";
import {
  applyOwnerFragment,
  isOwnerMarked,
  type MarkStore,
} from "../internal/owner-mark";

function memoryStore(): MarkStore {
  let marked = false;
  return {
    read: () =>
      marked
        ? { kind: "value", value: true, ts: 0 }
        : { kind: "none", why: "absent" },
    write: () => {
      marked = true;
      return { ok: true };
    },
    remove: () => {
      marked = false;
    },
  };
}

describe("owner mark", () => {
  it("#equin-me marks the browser, #equin-not-me unmarks it", () => {
    const store = memoryStore();
    expect(isOwnerMarked(store)).toBe(false);
    applyOwnerFragment("#equin-me", store);
    expect(isOwnerMarked(store)).toBe(true);
    applyOwnerFragment("#equin-not-me", store);
    expect(isOwnerMarked(store)).toBe(false);
  });

  it("leaves any other fragment alone", () => {
    const store = memoryStore();
    applyOwnerFragment("", store);
    applyOwnerFragment("#section", store);
    expect(isOwnerMarked(store)).toBe(false);
  });
});
