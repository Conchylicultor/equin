/**
 * The native bridge's trust boundary, probed on the real helper
 * (research/2026-10-28-menu-bar-native-edge-pin.md, Verification): this
 * checkout's `equin-desktop` runs `probe` on this checkout's deploy — the
 * tray's own panel window, runtime capability and command gate, on WebKit,
 * with no tray icon and nothing handed to the browser. The helper evaluates
 * an attacker script in the panel's main frame and judges each row of the
 * 2026-10-24 probe matrix:
 *
 *   main frame on the pin            answered (the one caller)
 *   srcdoc / same-origin sandboxed / opaque frames → top.equinNative, the raw IPC
 *   same-origin URL frame, <object>, <embed>, another namespace's frame
 *   pushState to another route, then back
 *   window.open                      no window; handed to the browser
 *   location.assign elsewhere        the panel stays on the pin
 *
 * Every row but the first must be denied. Builds the helper first when this
 * checkout's build of it is missing or stale (`./equin deps install
 * menu-bar-helper`).
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/menu-bar/e2e/bridge-probe.ts
 */
import { namespaceUrl } from "@plugins/infra/plugins/namespace/core";
import { runHelperProbe } from "./helper-probe";

await runHelperProbe({
  title: "menu-bar: native bridge probe",
  mode: "probe",
  notes: (namespace) => [
    `panel on ${namespaceUrl(namespace, "/home/menu-bar")}`,
  ],
});
