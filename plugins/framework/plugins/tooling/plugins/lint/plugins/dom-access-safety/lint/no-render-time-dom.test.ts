/**
 * Tests for `no-render-time-dom`: a browser global read while a component or
 * hook renders is reported — in its body, a render-time callback, an IIFE —
 * and left alone in effects, handlers, module helpers, behind a
 * `renderMode()` test, and in a component only a live branch renders.
 */

import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-render-time-dom";

const ruleTester = createRuleTester();
const filename = "plugins/fullscreen/web/c.tsx";
const err = (count = 1) =>
  Array.from({ length: count }, () => ({
    messageId: "renderTimeDom" as const,
  }));

ruleTester.run("no-render-time-dom", rule, {
  valid: [
    // effects, handlers, module helpers: not render.
    `function C() { useEffect(() => { window.addEventListener("x", f); }, []); return null; }`,
    `function C() { const onClick = () => document.body.focus(); return <b onClick={onClick} />; }`,
    `function helper() { return window.innerWidth; }`,
    `function C() { const s = useSyncExternalStore(sub, () => window.innerWidth, () => 0); return s; }`,
    `function useX() { return useBrowserValue({ name: "w", read: () => window.innerWidth, staticValue: 0 }); }`,
    // type positions and typeof
    `function C(p: { w: typeof window }) { return typeof document === "undefined" ? null : 1; }`,
    // behind a renderMode() test
    `function C() { if (renderMode() === "static") return null; return createPortal(<b />, document.body); }`,
    `function C() { return renderMode() === "static" ? null : document.title; }`,
    `function C() { return renderMode() !== "static" ? document.title : null; }`,
    `function C() { return renderMode() === "live" && document.title; }`,
    `function useX() { const [el] = useState(() => { if (renderMode() === "static") throw new Error(); return document.createElement("div"); }); return el; }`,
    // a component only a live branch renders
    `export function P(p) { return renderMode() === "static" ? <S /> : <Live {...p} />; }
     function Live() { const [w] = useState(() => window.innerWidth); return w; }`,
    `export function P() { if (renderMode() === "static") return null; return <Live />; }
     function Live() { return <Inner />; }
     function Inner() { return document.title; }`,
    // outside web/
    {
      code: `function C() { return window.innerWidth; }`,
      filename: "plugins/fullscreen/server/c.ts",
    },
  ].map((c) => (typeof c === "string" ? { code: c, filename } : c)),
  invalid: [
    { code: `function C() { return window.innerWidth; }`, errors: err() },
    { code: `const C = () => <b>{window.location.origin}</b>;`, errors: err() },
    {
      code: `function useX() { const [w] = useState(() => window.innerWidth); return w; }`,
      errors: err(),
    },
    {
      code: `function useX() { return useMemo(() => navigator.hardwareConcurrency, []); }`,
      errors: err(),
    },
    {
      code: `function useX() { return useSyncExternalStore(s, g, () => document.title); }`,
      errors: err(),
    },
    {
      code: `function C() { const v = (() => matchMedia("q").matches)(); return v; }`,
      errors: err(),
    },
    {
      code: `function C({ el }) { return el instanceof HTMLVideoElement; }`,
      errors: err(),
    },
    {
      code: `const C = memo(function C() { return document.title; });`,
      errors: err(),
    },
    // a class the config declares as a global still is the browser's.
    {
      code: `/* global HTMLElement */ function C({ el }) { return el instanceof HTMLElement; }`,
      errors: err(),
    },
    // value-level TypeScript wrappers are still reads.
    {
      code: `function C() { return useMemo(() => document.querySelector("x") as HTMLElement, []); }`,
      errors: err(),
    },
    {
      code: `function C() { const r = document.getElementById("r")!; return r; }`,
      errors: err(),
    },
    {
      code: `function C() { return (window as unknown as { x: number }).x; }`,
      errors: err(),
    },
    // render-time iteration, and nested wrappers.
    {
      code: `function C({ items }) { return items.map((i) => <b key={i}>{window.name}</b>); }`,
      errors: err(),
    },
    {
      code: `const C = memo(forwardRef(function C() { return document.title; }));`,
      errors: err(),
    },
    // a typeof guard still reads a value that never updates.
    {
      code: `function C() { return typeof window !== "undefined" && window.innerWidth; }`,
      errors: err(),
    },
    // the wrong branch of a renderMode() test.
    {
      code: `function C() { return renderMode() === "static" ? document.title : null; }`,
      errors: err(),
    },
    // an exported component may be rendered from elsewhere, unguarded.
    {
      code: `export function P() { return renderMode() === "static" ? null : <Live />; }
             export function Live() { return document.title; }`,
      errors: err(),
    },
    // one unguarded use is enough.
    {
      code: `export function P() { return <><Live />{renderMode() === "live" && <Live />}</>; }
             function Live() { return document.title; }`,
      errors: err(),
    },
  ].map((c) => ({ ...c, filename })),
});
