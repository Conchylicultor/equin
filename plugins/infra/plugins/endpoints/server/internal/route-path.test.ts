import { expect, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint, sendEndpointRequest } from "../../core";
import { endpointPath } from "./route-path";

const withQuery = defineEndpoint({
  route: "GET /api/things/:id/files/:file",
  query: z.object({ q: z.string().optional(), n: z.number().optional() }),
});
const noParams = defineEndpoint({ route: "POST /api/things" });

test("the server barrel's endpointPath answers what core's request builder sends", async () => {
  const cases = [
    [withQuery, { id: "a b", file: "x/y.svg" }, { q: "é&", n: 3 }],
    [withQuery, { id: "a", file: "b" }, { q: undefined }],
    [noParams, {}, undefined],
  ] as const;
  for (const [endpoint, params, query] of cases) {
    let sent = "";
    await sendEndpointRequest(
      (path) => {
        sent = path;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
      endpoint as typeof withQuery,
      params as { id: string; file: string },
      query === undefined ? undefined : { query },
    );
    expect(
      endpointPath(
        endpoint as typeof withQuery,
        params as { id: string; file: string },
        query,
      ),
    ).toBe(sent);
  }
  expect(endpointPath(withQuery, { id: "a b", file: "c" }, { n: 1 })).toBe(
    "/api/things/a%20b/files/c?n=1",
  );
});
