import { describe, expect, it } from "bun:test";
import { listingChanged } from "./listing-changed";

const role = { listed: true, name: "Perf", description: "Slow things." };

describe("listingChanged", () => {
  it("a listed role created or deleted changes the listing", () => {
    expect(listingChanged(null, role)).toBe(true);
    expect(listingChanged(role, null)).toBe(true);
  });

  it("an unlisted role created or deleted does not", () => {
    const hidden = { ...role, listed: false };
    expect(listingChanged(null, hidden)).toBe(false);
    expect(listingChanged(hidden, null)).toBe(false);
  });

  it("listing or unlisting a role changes it", () => {
    expect(listingChanged({ ...role, listed: false }, role)).toBe(true);
    expect(listingChanged(role, { ...role, listed: false })).toBe(true);
  });

  it("a listed role's name or description changes it", () => {
    expect(listingChanged(role, { ...role, name: "Performance" })).toBe(true);
    expect(listingChanged(role, { ...role, description: "Other." })).toBe(true);
  });

  it("an unlisted role's edit, or an edit the section does not show, does not", () => {
    const hidden = { ...role, listed: false };
    expect(listingChanged(hidden, { ...hidden, name: "X" })).toBe(false);
    expect(listingChanged(role, { ...role })).toBe(false);
    expect(
      listingChanged(role, { ...role, description: "Slow things.\n" }),
    ).toBe(false);
  });
});
