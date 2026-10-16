/**
 * Shared Playwright harness for the per-plugin `e2e/` scripts.
 *
 * Import from other plugins' e2e scripts as
 * `@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e`.
 *
 * The `e2e` runtime may reach other plugins' `core` and `e2e` barrels only
 * (see boundaries/core/boundary-config.ts): an end-to-end test drives the deployed app through
 * the browser, so it must never import the `web`/`server` code under test.
 */
export { arg, numArg, flag, requireArg, usage } from "./args";
// No origin is exported. `pathUrl` names a page this script chose; `pageUrl`
// names the one the caller chose. There is deliberately no way to obtain the
// bare origin — see target.ts for the collision that caused.
//
// `targetNamespace` is not a way back to one: a namespace is an IDENTITY, for
// naming the per-namespace directory a script asserts on. Rebuilding a URL from
// it with `namespaceUrl` would point back at the gateway and ignore `--url`
// entirely — use `pathUrl` for anything the app answers.
export { pathUrl, pageUrl, requirePage, targetNamespace } from "./target";
export { agentFetch } from "./app-fetch";
export { openDeployDb } from "./deploy-db";
export type { DeployDb } from "./deploy-db";
export { withBrowser, boot, DEFAULT_VIEWPORT } from "./browser";
export { waitFor, ELEMENT_TIMEOUT_MS } from "./wait";
// Playwright's own `networkidle` never fires on this app — see network-idle.ts.
export { waitForNetworkIdle } from "./network-idle";
export type { NetworkIdleOptions } from "./network-idle";
export type { Settled } from "./wait";
export type { Harness, Session, SessionOptions, BootOptions } from "./browser";
export { capture, requestFailure } from "./capture";
export type { Captured } from "./capture";
export { report, onBeforeFinish } from "./report";
export type { Report } from "./report";
export { clearToasts } from "./toasts";
export { stallRoute } from "./stall";
export type { StalledRoute, StallRouteOptions } from "./stall";
export { snap, DEFAULT_SNAP_TIMEOUT_MS } from "./shots";
export type { SnapResult } from "./shots";
export { samplePixels, colorDistance } from "./pixels";
export type { PixelGrid, Rgba, Rect } from "./pixels";
export { diffImages, heatmapText } from "./image-diff";
export type { ImageDiff, ImageDiffOptions, ImageSize } from "./image-diff";
export { colorReport, colorReportText } from "./color-report";
export type {
  ColorReport,
  ColorReportOptions,
  PaletteMatch,
  CellMean,
  Swatch,
} from "./color-report";
export { pushDiagnostic } from "./diagnostics";
export { describeRenderEnv, renderEnvLines } from "./render-env";
export type { RenderEnv } from "./render-env";
export { detectOsColorScheme } from "./color-scheme";
export type { ColorScheme } from "./color-scheme";
