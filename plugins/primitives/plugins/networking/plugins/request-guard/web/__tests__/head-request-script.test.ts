import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { headRequestScript } from "../../core";
import { installRequestGuard, requestGuardReportSink } from "../guard";

// A head request script is an inline async module: nothing orders it before
// the app entry, which installs the guard first thing. Run before the entry it
// sends its request; run after, it must issue nothing — not a raw fetch the
// guard refuses (a RawApiRequestError crash, and a rejected request parked for
// the boot task).

const PARKED = "__headRequestScriptTest";

/** Run the script's body as the browser would run the inline module. */
function runHeadScript(script: string): void {
  const body = script
    .replace(/^<script type="module" async>/, "")
    .replace(/<\/script>$/, "");
  new Function(body)();
}

const script = headRequestScript(
  `globalThis[${JSON.stringify(PARKED)}] = fetch("/api/resources/boot-snapshot");`,
);

let fetchStub: ReturnType<typeof vi.fn>;
let reportErrorStub: ReturnType<typeof vi.fn>;
let uninstall: (() => void) | null = null;

beforeEach(() => {
  fetchStub = vi.fn(() => Promise.resolve(new Response("ok")));
  reportErrorStub = vi.fn();
  vi.stubGlobal("fetch", fetchStub);
  vi.stubGlobal("reportError", reportErrorStub);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  Reflect.deleteProperty(globalThis, PARKED);
  requestGuardReportSink.register(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("is an inline async module", () => {
  expect(script.startsWith(`<script type="module" async>`)).toBe(true);
  expect(script.endsWith(`</script>`)).toBe(true);
});

it("sends its request when it runs before the app entry", () => {
  runHeadScript(script);
  expect(fetchStub).toHaveBeenCalledTimes(1);
  expect(Reflect.get(globalThis, PARKED)).toBeInstanceOf(Promise);
});

it("issues nothing once the entry has installed the guard", () => {
  uninstall = installRequestGuard();
  runHeadScript(script);
  expect(fetchStub).not.toHaveBeenCalled();
  expect(reportErrorStub).not.toHaveBeenCalled();
  expect(Reflect.get(globalThis, PARKED)).toBeUndefined();
});

it("runs again once the guard is uninstalled", () => {
  installRequestGuard()();
  runHeadScript(script);
  expect(fetchStub).toHaveBeenCalledTimes(1);
});
