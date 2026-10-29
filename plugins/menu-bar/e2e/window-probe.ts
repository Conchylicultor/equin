/**
 * An installed app's window keeps to its namespace, probed on the real helper
 * (research/2026-10-29-menu-bar-app-window-main-frame-gate.md, Verification):
 * this checkout's `equin-desktop` runs `probe-window` on this checkout's
 * deploy — the real app window (`window::build_window`: its native main-frame
 * gate and hand-off burst gate, on WebKit), hidden, with nothing handed to the
 * browser. The helper evaluates a navigator script in the window's main frame
 * and judges each row:
 *
 *   link click / location.assign / location.replace / form POST off the namespace,
 *   the main frame sent to another namespace
 *                       refused before it loaded, handed off once, page stays
 *   a content-origin frame and a foreign frame
 *                       admitted, nothing handed off
 *   30 window.open + 30 location.assign at once
 *                       at most 3 handed off (the burst collapsed)
 *   an in-namespace route
 *                       loads in the window
 *   the whole run       no page off the namespace ever loaded
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/menu-bar/e2e/window-probe.ts
 */
import { namespaceUrl } from "@plugins/infra/plugins/namespace/core";
import { runHelperProbe } from "./helper-probe";

await runHelperProbe({
  title: "menu-bar: app window scope probe",
  mode: "probe-window",
  notes: (namespace) => [`window on ${namespaceUrl(namespace, "/home")}`],
});
