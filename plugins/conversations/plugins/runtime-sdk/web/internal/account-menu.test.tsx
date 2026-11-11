import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  requestAccountMenu,
  settleAccountMenuRequest,
  useAccountMenuRequested,
} from "./account-menu";

function Probe() {
  return <i>{String(useAccountMenuRequested())}</i>;
}

// A static render to HTML (react-dom/server, no DOM) reads the request as it
// stands.
describe("useAccountMenuRequested under a server render", () => {
  it("answers whether a request is pending", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>false</i>");
    requestAccountMenu();
    try {
      expect(renderToStaticMarkup(<Probe />)).toBe("<i>true</i>");
    } finally {
      settleAccountMenuRequest();
    }
  });
});
