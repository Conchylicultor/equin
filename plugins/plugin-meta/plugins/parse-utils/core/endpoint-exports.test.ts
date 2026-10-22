import { expect, test } from "bun:test";
import { endpointExports } from "./endpoint-exports";

test("reads every exported endpoint: name, route, needsMachine (key or shorthand), line", () => {
  const src = [
    `import { defineEndpoint } from "x";`,
    `export const ping = defineEndpoint({ route: "POST /api/app/ping", body: B });`,
    `export const launch = defineEndpoint({ route: "POST /api/app/launch", needsMachine: M });`,
    `export const stop = defineEndpoint({ route: "POST /api/app/stop", needsMachine });`,
    `// export const ghost = defineEndpoint({ route: "GET /api/ghost" });`,
    `const local = defineEndpoint({ route: "GET /api/local" });`,
  ].join("\n");
  expect(endpointExports("f.ts", src)).toEqual([
    { name: "ping", route: "POST /api/app/ping", needsMachine: false, line: 2 },
    {
      name: "launch",
      route: "POST /api/app/launch",
      needsMachine: true,
      line: 3,
    },
    { name: "stop", route: "POST /api/app/stop", needsMachine: true, line: 4 },
  ]);
});

test("a route that is not one literal throws, naming file and line", () => {
  const src = `export const x = defineEndpoint({ route: ROUTE });`;
  expect(() => endpointExports("f.ts", src)).toThrow(/f\.ts:1: `x`/);
});
