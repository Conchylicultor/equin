import { describe, expect, test } from "bun:test";
import { classifyRejection } from "./write-sinks";

describe("classifyRejection", () => {
  test("a 4xx is final, except 401 / 408 / 429; 5xx is transient", () => {
    for (const status of [400, 403, 404, 409, 410, 422])
      expect(classifyRejection(status)).toBe("permanent");
    for (const status of [401, 408, 429, 500, 502, 503])
      expect(classifyRejection(status)).toBe("transient");
  });
});
