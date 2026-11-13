import { expect, test } from "bun:test";
import { sendEndpointRequest } from "@plugins/infra/plugins/endpoints/core";
import { bootSnapshot } from "../../core";
import { HEAD_REQUEST_GLOBAL } from "../../shared/head-request";
import { bootSnapshotHeadScript } from "./head-request";

// The head script sends the boot task's request ahead of it, so the two must be
// the same request: the path the contract builds, a plain GET with no headers.
test("the head script sends the request the boot task would", async () => {
  let sent: { path: string; init: RequestInit } | undefined;
  await sendEndpointRequest(
    (path, init) => {
      sent = { path, init };
      return Promise.resolve(new Response(null, { status: 204 }));
    },
    bootSnapshot,
    {},
  );
  expect(sent?.init.method).toBe("GET");
  expect(sent?.init.headers).toEqual({});
  const script = bootSnapshotHeadScript();
  expect(script).toContain(`fetch(${JSON.stringify(sent?.path)})`);
  expect(script).toContain(
    `globalThis[${JSON.stringify(HEAD_REQUEST_GLOBAL)}]`,
  );
  expect(script.startsWith(`<script type="module" async>`)).toBe(true);
});
