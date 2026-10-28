import { describe, expect, test } from "bun:test";
import {
  gateByPrincipal,
  hostGate,
  hostRouteTable,
  refuseAnonymousUpgrade,
  HostRouteTableSchema,
  type GatedRouteHandler,
} from "./gate";
import { PRINCIPAL_HEADER, isCrossSiteRefusal } from "./principal";

const as = (principal?: string) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: principal === undefined ? {} : { [PRINCIPAL_HEADER]: principal },
  });

function counting(access?: GatedRouteHandler["access"]) {
  const calls: number[] = [];
  const handler: GatedRouteHandler = Object.assign(
    () => {
      calls.push(1);
      return new Response("ran");
    },
    access === undefined ? {} : { access },
  );
  return { handler, calls };
}

function only(routes: Array<[string, GatedRouteHandler]>): GatedRouteHandler {
  expect(routes).toHaveLength(1);
  return routes[0]![1];
}

describe("gateByPrincipal", () => {
  test("an owner route refuses an anonymous caller before the handler runs", async () => {
    const { handler, calls } = counting("owner");
    const gated = only(gateByPrincipal([["POST /api/x", handler]]));
    const res = await gated(as("anonymous"), {});
    expect(res.status).toBe(403);
    expect(isCrossSiteRefusal(res.status, await res.json())).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("an owner route serves the owner", async () => {
    const { handler, calls } = counting("owner");
    const gated = only(gateByPrincipal([["POST /api/x", handler]]));
    expect(await (await gated(as("owner"), {})).text()).toBe("ran");
    expect(calls).toHaveLength(1);
  });

  test("a missing header is refused (fail closed)", async () => {
    const { handler, calls } = counting("owner");
    const gated = only(gateByPrincipal([["POST /api/x", handler]]));
    expect((await gated(as(), {})).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("a raw handler with no access is owner", async () => {
    const { handler, calls } = counting();
    const gated = only(gateByPrincipal([["GET /api/raw", handler]]));
    expect((await gated(as("anonymous"), {})).status).toBe(403);
    expect(await (await gated(as("owner"), {})).text()).toBe("ran");
    expect(calls).toHaveLength(1);
  });

  test("a public route passes everyone, untouched", async () => {
    const { handler, calls } = counting({ public: "nonce-authenticated" });
    const gated = only(gateByPrincipal([["GET /api/cb", handler]]));
    expect(gated).toBe(handler);
    expect(await (await gated(as("anonymous"), {})).text()).toBe("ran");
    expect(await (await gated(as(), {})).text()).toBe("ran");
    expect(calls).toHaveLength(2);
  });
});

describe("refuseAnonymousUpgrade", () => {
  test("refuses anonymous, lets the owner through", () => {
    expect(refuseAnonymousUpgrade(as("anonymous"), "/ws/x")?.status).toBe(403);
    expect(refuseAnonymousUpgrade(as(), "/ws/x")?.status).toBe(403);
    expect(refuseAnonymousUpgrade(as("owner"), "/ws/x")).toBeNull();
  });
});

describe("host route table", () => {
  test("lists every route with its access, sockets as owner", () => {
    const owner = counting().handler;
    const pub = counting({ public: "why" }).handler;
    expect(
      hostRouteTable(
        [
          ["POST /api/a", owner],
          ["GET /api/b", pub],
        ],
        ["/ws/c"],
      ),
    ).toEqual([
      { route: "POST /api/a", kind: "http", access: "owner" },
      { route: "GET /api/b", kind: "http", access: "public", reason: "why" },
      { route: "/ws/c", kind: "ws", access: "owner" },
    ]);
  });

  test("a stamped host serves its own table, owner-only", async () => {
    const routes = hostGate(true).routes({
      tableRoute: "GET /api/host/routes",
      http: [["GET /api/b", counting({ public: "why" }).handler]],
      wsPaths: ["/ws/c"],
    });
    const table = routes.find(([k]) => k === "GET /api/host/routes")![1];
    expect((await table(as("anonymous"), {})).status).toBe(403);
    const body = HostRouteTableSchema.parse(
      await (await table(as("owner"), {})).json(),
    );
    expect(body.stamped).toBe(true);
    expect(body.routes.map((r) => `${r.kind} ${r.route} ${r.access}`)).toEqual([
      "http GET /api/b public",
      "http GET /api/host/routes owner",
      "ws /ws/c owner",
    ]);
  });
});

describe("hostGate", () => {
  const mount = (stamped: boolean) => {
    const { handler, calls } = counting("owner");
    const routes = hostGate(stamped).routes({
      tableRoute: "GET /api/host/routes",
      http: [["POST /api/x", handler]],
      wsPaths: ["/ws/c"],
    });
    const find = (key: string) => routes.find(([k]) => k === key)![1];
    return {
      calls,
      x: find("POST /api/x"),
      table: find("GET /api/host/routes"),
    };
  };

  test("stamped: an owner route refuses a missing header (fail closed)", async () => {
    const { calls, x } = mount(true);
    expect((await x(as(), {})).status).toBe(403);
    expect((await x(as("anonymous"), {})).status).toBe(403);
    expect(await (await x(as("owner"), {})).text()).toBe("ran");
    expect(calls).toHaveLength(1);
  });

  test("stamped: anonymous upgrades are refused", () => {
    const gate = hostGate(true);
    expect(gate.refuseUpgrade(as(), "/ws/c")?.status).toBe(403);
    expect(gate.refuseUpgrade(as("owner"), "/ws/c")).toBeNull();
  });

  test("not stamped: every route is served ungated, the table says so", async () => {
    const { calls, x, table } = mount(false);
    // An old gateway sends no header at all — its readiness probe included.
    expect(await (await x(as(), {})).text()).toBe("ran");
    expect(calls).toHaveLength(1);
    const body = HostRouteTableSchema.parse(
      await (await table(as(), {})).json(),
    );
    expect(body.stamped).toBe(false);
    expect(body.routes.map((r) => r.route)).toEqual([
      "POST /api/x",
      "GET /api/host/routes",
      "/ws/c",
    ]);
  });

  test("not stamped: no upgrade is refused", () => {
    const gate = hostGate(false);
    expect(gate.refuseUpgrade(as(), "/ws/c")).toBeNull();
    expect(gate.refuseUpgrade(as("anonymous"), "/ws/c")).toBeNull();
  });
});
