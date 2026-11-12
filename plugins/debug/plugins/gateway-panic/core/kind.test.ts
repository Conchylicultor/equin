import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OutboxEntrySchema } from "@plugins/reports/plugins/outbox/plugins/file/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { GatewayPanicPayloadSchema, describeGatewayPanic } from "./kind";

// The entry the gateway's Go writer produces (its own test asserts it builds
// exactly this): the cross-language contract, read by both sides.
const GOLDEN = join(REPO_ROOT, "gateway/testdata/gateway-panic-entry.json");

describe("gateway-panic", () => {
  test("the gateway's entry parses as an outbox entry of this kind", () => {
    const entry = OutboxEntrySchema.parse(
      JSON.parse(readFileSync(GOLDEN, "utf8")),
    );
    expect(entry.kind).toBe("gateway-panic");
    const d = GatewayPanicPayloadSchema.parse(entry.data);
    expect(describeGatewayPanic(d)).toBe(
      "gateway panicked in (*backend).incHTTP serving GET /api/health (240×)",
    );
  });

  test("a single panic does not count itself", () => {
    const d = GatewayPanicPayloadSchema.parse({
      site: "equin/gateway.(*Proxy).handleWebSocket",
      value: "boom",
      stack: [],
      method: "GET",
      host: "x.localhost:9000",
      path: "/ws/notifications",
      count: 1,
      firstAt: 0,
      lastAt: 0,
    });
    expect(describeGatewayPanic(d)).toBe(
      "gateway panicked in (*Proxy).handleWebSocket serving GET /ws/notifications",
    );
  });
});
