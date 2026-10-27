import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RawApiRequestError,
  allowAssetRoute,
  installRequestGuard,
  nativeFetch,
  nativeWebSocket,
  requestGuardReportSink,
} from "../guard";

/** A constructor standing in for a native (no network in jsdom). */
class FakeSocket {
  static readonly OPEN = 1;
  constructor(readonly url: string | URL) {}
}

const ORIGIN = window.location.origin;

let fetchStub: ReturnType<typeof vi.fn>;
let beaconStub: ReturnType<typeof vi.fn>;
let reportErrorStub: ReturnType<typeof vi.fn>;
let consoleError: ReturnType<typeof vi.spyOn>;
let uninstall: (() => void) | null = null;

beforeEach(() => {
  fetchStub = vi.fn(() => Promise.resolve(new Response("ok")));
  beaconStub = vi.fn(() => true);
  reportErrorStub = vi.fn();
  vi.stubGlobal("fetch", fetchStub);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("EventSource", FakeSocket);
  vi.stubGlobal("reportError", reportErrorStub);
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: beaconStub,
  });
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  requestGuardReportSink.register(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const install = () => {
  uninstall = installRequestGuard();
};

describe("fetch", () => {
  it("rejects a same-origin /api request in every input form, without sending it", async () => {
    install();
    await expect(fetch("/api/health")).rejects.toBeInstanceOf(
      RawApiRequestError,
    );
    await expect(fetch(new URL("/ws/x", ORIGIN))).rejects.toBeInstanceOf(
      RawApiRequestError,
    );
    await expect(
      fetch(new Request(`${ORIGIN}/gateway/status`, { method: "POST" })),
    ).rejects.toMatchObject({
      channel: "fetch",
      method: "POST",
      path: "/gateway/status",
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("logs every refusal and reports it, so a caller swallowing the rejection cannot hide it", async () => {
    install();
    const err = await fetch("/api/x?q=1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RawApiRequestError);
    expect((err as RawApiRequestError).path).toBe("/api/x?q=1");
    expect(consoleError).toHaveBeenCalledWith(err);
    expect(reportErrorStub).toHaveBeenCalledWith(err);
    expect((err as Error).message).toMatch(/query_db/);
  });

  it("lets every other request through to the native", async () => {
    install();
    await fetch("/artifacts/x.js");
    await fetch("/apix");
    await fetch("https://example.com/api/x");
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("nativeFetch is past the guard", async () => {
    install();
    await nativeFetch("/api/health", { method: "POST" });
    expect(fetchStub).toHaveBeenCalledWith("/api/health", { method: "POST" });
  });

  it("allows GET and HEAD of a registered asset route, and nothing else on it", async () => {
    install();
    allowAssetRoute("/api/test-assets/emoji?v=1");
    await fetch("/api/test-assets/emoji");
    await fetch("/api/test-assets/emoji/en/data.json", { method: "HEAD" });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    await expect(
      fetch("/api/test-assets/emoji/x", { method: "POST" }),
    ).rejects.toBeInstanceOf(RawApiRequestError);
    await expect(fetch("/api/test-assets/emojix")).rejects.toBeInstanceOf(
      RawApiRequestError,
    );
  });
});

describe("other channels throw", () => {
  it("XMLHttpRequest.open", () => {
    install();
    const xhr = new XMLHttpRequest();
    expect(() => xhr.open("GET", "/api/health")).toThrow(RawApiRequestError);
    expect(() => xhr.open("GET", "/artifacts/x.js")).not.toThrow();
  });

  it("navigator.sendBeacon", () => {
    install();
    expect(() => navigator.sendBeacon("/api/reports", "x")).toThrow(
      RawApiRequestError,
    );
    expect(beaconStub).not.toHaveBeenCalled();
    expect(navigator.sendBeacon("https://example.com/b", "x")).toBe(true);
  });

  it("EventSource", () => {
    install();
    expect(() => new EventSource("/api/stream")).toThrow(RawApiRequestError);
  });

  it("WebSocket, matched by host; nativeWebSocket is past the guard", () => {
    install();
    const wsOrigin = ORIGIN.replace(/^http/, "ws");
    expect(() => new WebSocket(`${wsOrigin}/ws/logs`)).toThrow(
      RawApiRequestError,
    );
    const other = new WebSocket("ws://elsewhere.test/ws/logs");
    // The guarded constructor keeps the native's identity and statics.
    expect(other).toBeInstanceOf(WebSocket);
    expect(WebSocket.OPEN).toBe(1);
    const own = nativeWebSocket(`${wsOrigin}/ws/logs`);
    expect(own).toBeInstanceOf(FakeSocket);
  });
});

describe("reporting and lifecycle", () => {
  it("holds refusals raised before the reporter registers, and replays them to it", async () => {
    install();
    await expect(fetch("/api/one")).rejects.toBeInstanceOf(RawApiRequestError);
    const reported: RawApiRequestError[] = [];
    requestGuardReportSink.register((err) => reported.push(err));
    expect(reported.map((e) => e.path)).toEqual(["/api/one"]);
    expect(() => new EventSource("/api/two")).toThrow();
    expect(reported.map((e) => e.path)).toEqual(["/api/one", "/api/two"]);
  });

  it("uninstall restores every native; installing twice throws", async () => {
    install();
    expect(() => installRequestGuard()).toThrow(/already installed/);
    uninstall?.();
    uninstall = null;
    expect(globalThis.fetch).toBe(fetchStub);
    expect(globalThis.WebSocket).toBe(FakeSocket);
    expect(navigator.sendBeacon).toBe(beaconStub);
    await fetch("/api/health");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("with no guard installed, the natives are the globals read at call time", async () => {
    await nativeFetch("/api/health");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(nativeWebSocket("ws://x.test/ws")).toBeInstanceOf(FakeSocket);
  });
});
