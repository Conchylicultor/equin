import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type {
  MachinePluginDefinition,
  ServerPluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import { defineEndpoint } from "../../core/define-endpoint";
import { implement } from "../../core/implement";
import { implementMachine, machineHandler } from "./implement-machine";

const launch = defineEndpoint({
  route: "POST /api/launch",
  response: z.object({ ok: z.boolean() }),
  needsMachine: { feature: "Launching an agent" },
});

const ping = defineEndpoint({
  route: "POST /api/ping",
  response: z.object({ ok: z.boolean() }),
});

const req = () =>
  new Request("http://localhost/api/launch", { method: "POST" });

describe("implementMachine", () => {
  test("serves a desktop-only endpoint like implement does", async () => {
    const res = await implementMachine(launch, () => ({ ok: true }))(req(), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("a raw machine handler answers its own Response", async () => {
    const raw = machineHandler(() => new Response("down", { status: 500 }));
    const res = await raw(req(), {});
    expect(res.status).toBe(500);
    const machine: NonNullable<MachinePluginDefinition["httpRoutes"]> = {
      "POST /api/raw": raw,
    };
    expect(Object.keys(machine)).toEqual(["POST /api/raw"]);
  });

  test("each host's handlers are a tsc error on the other's", () => {
    // @ts-expect-error — a desktop-only endpoint is implemented by implementMachine
    implement(launch, () => ({ ok: true }));
    // @ts-expect-error — a portable endpoint is implemented by implement
    implementMachine(ping, () => ({ ok: true }));

    const machineHandler = implementMachine(launch, () => ({ ok: true }));
    const portableHandler = implement(ping, () => ({ ok: true }));
    const server: NonNullable<ServerPluginDefinition["httpRoutes"]> = {};
    // @ts-expect-error — a server barrel never serves a machine route
    server[launch.route] = machineHandler;
    const machine: NonNullable<MachinePluginDefinition["httpRoutes"]> = {};
    // @ts-expect-error — a machine barrel serves only machine routes
    machine[ping.route] = portableHandler;
    expect(Object.keys(server)).toEqual([launch.route]);
    expect(Object.keys(machine)).toEqual([ping.route]);
  });
});
