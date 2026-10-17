import { createElement } from "react";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SlotRender } from "@plugins/primitives/plugins/slot-render/web";
import { registerOverlayFallback } from "@plugins/primitives/plugins/overlay/plugins/overlay-boundary/web";
import { ErrorBoundaryMiddleware } from "./internal/error-boundary-middleware";
import { CrashFallback } from "./components/crash-fallback";
import { ErrorBoundary } from "./slots";

export { PluginErrorBoundary } from "./components/plugin-error-boundary";
export { ErrorBoundary } from "./slots";
export { boundaryReportSink } from "./reporter";
export type { BoundaryErrorReport } from "./reporter";

export default {
  description:
    "Generic React error boundary primitive. Wraps plugin contributions so render errors are contained to one slot, with an ErrorBoundary.Action slot for domain-specific buttons (e.g. crash 'Fix') and a boundaryReportSink for opt-in crash reporting.",
  register: [
    {
      register() {
        // Inject the rich CrashFallback into the overlay-boundary leaf so a crash
        // inside transient overlay content flows through the same reporting +
        // ErrorBoundary.Action infrastructure. The leaf sits below ui-kit, so
        // ui-kit can wrap every *Content without closing the cycle. Uses
        // createElement (not JSX) so the barrel stays a `.ts` folder barrel.
        //
        // `slot` is the constant "overlay": it feeds nothing but the chip's tag
        // ("overlay crashed"). It is NOT part of the crash fingerprint (that is
        // errorType + the top stack frames), and the `componentStack` captured
        // beside it already names the real consumer chain — so a per-surface
        // kind threaded down from every *Content bought a word the stack
        // already spells out.
        registerOverlayFallback(({ error, componentStack, retry }) =>
          createElement(CrashFallback, {
            report: { error, componentStack, slot: "overlay", label: null },
            retry,
          }),
        );
      },
    },
  ],
  contributions: [
    // A companion: wherever slots render, a crashing contribution must stay
    // contained to its own box rather than take the surface down with it.
    SlotRender.ItemMiddleware({
      priority: 100,
      Component: ErrorBoundaryMiddleware,
      companion: true,
    }),
  ],
  slots: ErrorBoundary,
} satisfies PluginDefinition;
