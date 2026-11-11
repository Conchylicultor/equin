import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { trackToast, untrackToast, useLiveToastCount } from "./live-toasts";
import { useSuppressToasts, useToastsSuppressed } from "./suppress-toasts";

// A static render to HTML (react-dom/server, no DOM) runs no effect: the
// ledgers answer what they hold now.
describe("toast stores under a server render", () => {
  it("answer the live count as the ledger holds it", () => {
    function Probe() {
      return <i>{useLiveToastCount()}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>0</i>");
    trackToast("t1");
    try {
      expect(renderToStaticMarkup(<Probe />)).toBe("<i>1</i>");
    } finally {
      untrackToast("t1");
    }
  });

  it("answer not suppressed: a suppressing surface's effect never runs", () => {
    function Probe() {
      useSuppressToasts();
      return <i>{String(useToastsSuppressed())}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>false</i>");
  });
});
