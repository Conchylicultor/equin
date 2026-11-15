/**
 * A page transport handed out inside a `RequestIssuerScope` stamps the scope
 * on its requests (so e2e can tell a scope's leak from the page's chrome); any
 * other transport is handed out as given, and outside every scope the page
 * transport is itself.
 */
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  REQUEST_ISSUER_HEADER,
  scopeIssuer,
} from "@plugins/primitives/plugins/networking/core";
import { TransportProvider, useTransport, type Transport } from "../transport";
import { RequestIssuerScope, stampIssuer } from "../request-issuer";
import { testTransport } from "../testing";

function recording(server: Transport["server"]) {
  const sent: (string | null)[] = [];
  const transport = testTransport({
    server,
    fetch: (_input, init) => {
      sent.push(new Headers(init?.headers).get(REQUEST_ISSUER_HEADER));
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  return { transport, sent };
}

function transportUnder(transport: Transport, scoped: boolean): Transport {
  const wrapper = ({ children }: { children: ReactNode }) => {
    const inner = (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    );
    return scoped ? (
      <RequestIssuerScope issuer={scopeIssuer("demo-x")}>
        {inner}
      </RequestIssuerScope>
    ) : (
      inner
    );
  };
  return renderHook(() => useTransport(), { wrapper }).result.current;
}

describe("request issuer", () => {
  it("stamps the scope on the page transport provided inside it", async () => {
    const { transport, sent } = recording("page");
    const handed = transportUnder(transport, true);
    expect(handed).not.toBe(transport);
    expect(transportUnder(transport, true)).toBe(handed);
    await handed.fetch("/api/x", {
      headers: { [REQUEST_ISSUER_HEADER]: "page" },
    });
    expect(sent).toEqual(["scope:demo-x"]);
  });

  it("hands out a non-page transport, and the page's outside every scope, as given", () => {
    const inBrowser = recording("in-browser").transport;
    expect(transportUnder(inBrowser, true)).toBe(inBrowser);
    const page = recording("page").transport;
    expect(transportUnder(page, false)).toBe(page);
  });

  it("keeps an issuer a request already names unless told to override", () => {
    const named = { headers: { [REQUEST_ISSUER_HEADER]: "scope:a" } };
    const keep = stampIssuer("/api/x", named, "page", false);
    expect(new Headers(keep.headers).get(REQUEST_ISSUER_HEADER)).toBe(
      "scope:a",
    );
    const bare = stampIssuer(
      new Request("http://x/api/y", { headers: { a: "1" } }),
      undefined,
      "page",
      false,
    );
    expect(new Headers(bare.headers).get(REQUEST_ISSUER_HEADER)).toBe("page");
    expect(new Headers(bare.headers).get("a")).toBe("1");
  });
});
