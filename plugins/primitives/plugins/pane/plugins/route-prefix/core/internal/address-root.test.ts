import { describe, expect, it } from "bun:test";
import { addressPathOf, addressUrlOf, routePathOf } from "./address-root";

describe("address root", () => {
  it("is the identity without a root", () => {
    expect(addressPathOf("/about/vision", null)).toBe("/about/vision");
    expect(routePathOf("/vision", null)).toBe("/vision");
  });

  it.each([
    ["/about", "/"],
    ["/about/vision", "/vision"],
    ["/about/demo/at/sonata", "/demo/at/sonata"],
    ["/about;view.x=y", "/;view.x=y"],
  ])("maps %p ⇄ %p", (route, address) => {
    expect(addressPathOf(route, "/about")).toBe(address);
    expect(routePathOf(address, "/about")).toBe(route);
  });

  it("refuses a route path outside the root", () => {
    expect(() => addressPathOf("/agents/c/1", "/about")).toThrow(
      /outside the address root/,
    );
    expect(() => addressPathOf("/aboutx", "/about")).toThrow();
  });

  it("refuses a root that is not an app base path", () => {
    expect(() => addressPathOf("/x", "/")).toThrow();
    expect(() => routePathOf("/x", "/about/")).toThrow();
  });

  it("keeps a URL's query and hash", () => {
    expect(addressUrlOf("/about/vision?x=1#h", "/about")).toBe("/vision?x=1#h");
    expect(addressUrlOf("/about?x=1", "/about")).toBe("/?x=1");
  });
});
