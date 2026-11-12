import { describe, expect, test } from "bun:test";
import { encodeBase64UrlJson } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import { MIRROR_QUESTION_MAX_CHARS } from "@plugins/apps/plugins/deploy/plugins/site-mirror/core";
import { fittingRowsRequest, MirrorQuestionTooLongError } from "./fetch";

const base = { setId: "analytics", table: "analytics_visits", columns: ["id"] };
const uuidKey = (i: number) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
});

describe("fittingRowsRequest", () => {
  test("a list that fits travels whole", () => {
    const pks = [uuidKey(1), uuidKey(2)];
    expect(fittingRowsRequest({ ...base, pks })).toEqual({
      req: { ...base, pks },
      rest: [],
    });
  });

  test("a long list is cut at the longest prefix that fits, the rest handed back", () => {
    const pks = Array.from({ length: 2000 }, (_, i) => uuidKey(i));
    const { req, rest } = fittingRowsRequest({ ...base, pks });
    expect(req.pks.length + rest.length).toBe(pks.length);
    expect([...req.pks, ...rest]).toEqual(pks);
    expect(encodeBase64UrlJson(req).length).toBeLessThanOrEqual(
      MIRROR_QUESTION_MAX_CHARS,
    );
    const oneMore = { ...req, pks: pks.slice(0, req.pks.length + 1) };
    expect(encodeBase64UrlJson(oneMore).length).toBeGreaterThan(
      MIRROR_QUESTION_MAX_CHARS,
    );
  });

  test("a single key past the bound throws", () => {
    const pks = [{ value: "x".repeat(MIRROR_QUESTION_MAX_CHARS) }];
    expect(() => fittingRowsRequest({ ...base, pks })).toThrow(
      MirrorQuestionTooLongError,
    );
  });
});
