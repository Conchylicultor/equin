/**
 * Installs the ResizeObserver loop tracer
 * (`primitives/dom/element-size/resize-loop-trace`) — imported by `main.tsx`
 * right after the request guard, as a side effect, so the page's
 * `ResizeObserver` is the traced one before any module that keeps a reference
 * to it evaluates.
 */
import { installResizeLoopTrace } from "@plugins/primitives/plugins/dom/plugins/element-size/plugins/resize-loop-trace/web";

installResizeLoopTrace();
