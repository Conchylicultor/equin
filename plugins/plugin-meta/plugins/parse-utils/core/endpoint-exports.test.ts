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
    {
      name: "ping",
      route: "POST /api/app/ping",
      needsMachine: false,
      line: 2,
      prediction: "undecided",
    },
    {
      name: "launch",
      route: "POST /api/app/launch",
      needsMachine: true,
      line: 3,
      prediction: "undecided",
    },
    {
      name: "stop",
      route: "POST /api/app/stop",
      needsMachine: true,
      line: 4,
      prediction: "undecided",
    },
  ]);
});

test("a route that is not one literal throws, naming file and line", () => {
  const src = `export const x = defineEndpoint({ route: ROUTE });`;
  expect(() => endpointExports("f.ts", src)).toThrow(/f\.ts:1: `x`/);
});

test("reads each write's prediction arm; a read has none", () => {
  const src = [
    `export const a = defineEndpoint({ route: "POST /api/a", effect: (on) => patchRow(on, { x: 1 }) });`,
    `export const b = defineEndpoint({ route: "POST /api/b", unpredicted: { reason: "precondition", why: "409 inline" } });`,
    `export const c = defineEndpoint({ route: "POST /api/c", unpredicted: { gap: "web-context" } });`,
    `export const d = defineEndpoint({ route: "POST /api/d", internal: { why: "rpc" } });`,
    `export const e = defineEndpoint({ route: "POST /api/e", agentWrite: "telemetry" });`,
    `export const f = defineEndpoint({ route: "GET /api/f", body: { unpredicted: { gap: "x" } } });`,
    `export const g = defineEndpoint({ route: "POST /api/g", body: B, response: { effect: 1 } });`,
  ].join("\n");
  expect(endpointExports("f.ts", src).map((x) => x.prediction)).toEqual([
    "predicted",
    { unpredicted: "precondition" },
    { debt: "web-context" },
    "internal",
    "telemetry",
    undefined,
    "undecided",
  ]);
});
