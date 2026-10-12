/**
 * Tests for the `no-endpoint-read` lint rule. The rule module alone flags
 * every web file; the substrate and burndown exemptions are `exempt/index.ts`
 * manifests, checked by `exempt:manifests-valid` and the unused-exemption
 * report.
 *
 * Type-aware: whether a `fetchEndpoint` / `readNdjson` is a GET is read off
 * the endpoint's literal `route` type, so every case is type-checked. The
 * harness is the one `primitives/passthrough`'s
 * `no-unanchored-passthrough.test.ts` explains: each case is linted as a path
 * that does not exist on disk (`web/case.tsx` beside this file — under a
 * `web/` folder, the rule's scope), under an inferred project whose options
 * come from `tsconfig.case.json` (`types: []` keeps it fast). The endpoints
 * barrel does not resolve there, so `fetchEndpoint` is `any` — the rule binds
 * it by its import, not its type — while {@link PRELUDE} declares endpoint
 * definitions with literal routes.
 */

import { setDefaultTimeout } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-endpoint-read";

// The first case pays for building the inferred project's program.
setDefaultTimeout(60_000);

/** This directory — where `tsconfig.case.json` sits. */
const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/** The virtual paths cases are linted as (nothing exists there). */
const WEB_CASE = "web/case.tsx";
const SERVER_CASE = "server/case.ts";
const CORE_CASE = "core/case.ts";

/** A browser-runtime file — the rule's scope. */
const WEB = `${LINT_DIR}/${WEB_CASE}`;

/** Endpoint definitions with literal routes, as `defineEndpoint` types them. */
const PRELUDE = `
interface Def<R extends string> { readonly route: R; readonly path: string }
declare const read: Def<"GET /api/read">;
declare const readOther: Def<"GET /api/other">;
declare const save: Def<"POST /api/save">;
declare const ack: Def<"POST /api/ack">;
declare const remove: Def<"DELETE /api/remove">;
declare const loose: { readonly route: string };
declare function useEffect(fn: () => unknown, deps?: unknown[]): void;
declare function useLayoutEffect(fn: () => unknown, deps?: unknown[]): void;
declare function useCallback<T>(fn: T, deps: unknown[]): T;
declare function useEventCallback<T>(fn: T): T;
declare function useMemo<T>(fn: () => T, deps: unknown[]): T;
declare function useState<T>(init?: T): [T, (v: T) => void];
declare const queryClient: {
  invalidateQueries(o: unknown): Promise<void>;
  refetchQueries(o: unknown): Promise<void>;
};
`;

const ENDPOINTS_WEB = "@plugins/infra/plugins/endpoints/web";
const NDJSON_WEB = "@plugins/infra/plugins/ndjson-stream/web";
const LIVE_STATE_WEB = "@plugins/primitives/plugins/live-state/web";
const REACT_QUERY = "@tanstack/react-query";

const web = (code: string) => ({ filename: WEB, code: PRELUDE + code });

const hook = (name: string) => ({ messageId: "readHook", data: { name } });
const queryFnFetch = { messageId: "queryFnFetch" };
const effectFetch = (name = "fetchEndpoint") => ({
  messageId: "effectFetch",
  data: { name },
});
const refresh = (name = "invalidateQueries") => ({
  messageId: "refreshEndpointKey",
  data: { name },
});

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: true },
      projectService: {
        defaultProject: "tsconfig.case.json",
        allowDefaultProject: [WEB_CASE, SERVER_CASE, CORE_CASE],
      },
      tsconfigRootDir: LINT_DIR,
    },
  },
});

// `RuleTester.run` drives the test harness itself (it calls the ambient
// describe/it that bun:test provides), so it must run at module top level.
ruleTester.run(
  "no-endpoint-read",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The live read.
      {
        filename: WEB,
        code:
          PRELUDE +
          `import { useLive } from "@plugins/network/plugins/live/web";`,
      },
      // Writes stay on endpoints.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          import { fetchEndpoint } from "${ENDPOINTS_WEB}";
          import { useMutation } from "${REACT_QUERY}";
          useMutation({ mutationFn: (b) => fetchEndpoint(save, { body: b }) });
          async function onClick() { await fetchEndpoint(save, {}); }
        `,
      },
      // A name the read-hook barrels export that is not a read hook.
      {
        filename: WEB,
        code:
          PRELUDE +
          `import { useQueryClient, useMutation } from "${REACT_QUERY}";`,
      },
      // The same imports outside a web/ folder are out of scope.
      {
        filename: `${LINT_DIR}/${SERVER_CASE}`,
        code: `import { useQuery } from "${REACT_QUERY}";`,
      },
      {
        filename: `${LINT_DIR}/${CORE_CASE}`,
        code: `
          import { fetchEndpoint } from "${ENDPOINTS_WEB}";
          const o = { queryFn: () => fetchEndpoint(read, {}) };
        `,
      },
      // A hook name from a barrel that does not export it as a read hook.
      {
        filename: WEB,
        code: PRELUDE + `import { useQuery } from "./local-query";`,
      },
      // A queryFn that reads something other than an endpoint.
      {
        filename: WEB,
        code: PRELUDE + `const o = { queryFn: () => fetch("/x") };`,
      },
      // A local `fetchEndpoint` that is not the endpoints barrel's.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          function fetchEndpoint() {}
          const o = { queryFn: () => fetchEndpoint() };
        `,
      },
      // A local shadowing the imported fetchEndpoint.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          import { fetchEndpoint } from "${ENDPOINTS_WEB}";
          const o = { queryFn: (fetchEndpoint) => fetchEndpoint() };
        `,
      },
      // fetchEndpoint as a queryFn property's KEY side, or in a sibling.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          import { fetchEndpoint } from "${ENDPOINTS_WEB}";
          const o = { queryFn: read, onSuccess: () => fetchEndpoint(ack, {}) };
        `,
      },
      // A namespace read of a non-hook name; a shadowing local.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          import * as rq from "${REACT_QUERY}";
          rq.useQueryClient();
          function f(rq: { useQuery: () => void }) { rq.useQuery(); }
        `,
      },
      // A type position calls nothing.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          import type * as rq from "${REACT_QUERY}";
          type R = ReturnType<typeof rq.useQuery>;
        `,
      },
      // ── GET fetchEndpoint / readNdjson by where it runs ──
      // A write in an effect is not a read.
      web(`
        import { fetchEndpoint } from "${ENDPOINTS_WEB}";
        function Panel() {
          useEffect(() => { void fetchEndpoint(save, {}); }, []);
          return null;
        }
      `),
      // A GET in a JSX handler, a mutationFn, or an onSuccess.
      web(`
        import { fetchEndpoint } from "${ENDPOINTS_WEB}";
        import { useMutation } from "${REACT_QUERY}";
        function Panel() {
          useMutation({ mutationFn: () => fetchEndpoint(read, {}) });
          useMutation({ mutationFn: save, onSuccess: () => fetchEndpoint(read, {}) });
          return <button onClick={() => void fetchEndpoint(read, {})} />;
        }
      `),
      // A named function used only as a handler — even through useCallback,
      // a callback hook, and a deps array.
      web(`
        import { fetchEndpoint } from "${ENDPOINTS_WEB}";
        async function download() { return fetchEndpoint(read, {}); }
        function Panel() {
          const load = useCallback(async () => fetchEndpoint(read, {}), []);
          const copy = useEventCallback(async () => fetchEndpoint(readOther, {}));
          useEffect(() => {}, [load, copy]);
          return <b onClick={load} onDoubleClick={() => void copy()} onAuxClick={download} />;
        }
      `),
      // A callback an effect registers for an event runs on the event.
      web(`
        import { fetchEndpoint } from "${ENDPOINTS_WEB}";
        function Panel() {
          useEffect(() => {
            const onKey = () => void fetchEndpoint(read, {});
            window.addEventListener("keydown", () => void fetchEndpoint(read, {}));
            window.addEventListener("keyup", onKey);
          }, []);
          return null;
        }
      `),
      // A function stored in an object, passed as a non-on* prop, or
      // returned escapes the file's view.
      web(`
        import { fetchEndpoint } from "${ENDPOINTS_WEB}";
        export const api = { status: () => fetchEndpoint(read, {}) };
        function useThing() {
          const refetch = useCallback(() => fetchEndpoint(read, {}), []);
          return { refetch, more: () => fetchEndpoint(readOther, {}) };
        }
        function Panel() {
          return <Child action={() => fetchEndpoint(read, {})} />;
        }
      `),
      // A function returned from a hook (an arrow's concise body or a
      // `return`), an `on*` handler property assigned in an effect, and the
      // latest-ref `ref.current = fn` all escape — named or anonymous alike.
      web(`
        import { fetchEndpoint } from "${ENDPOINTS_WEB}";
        declare const es: { onmessage: unknown };
        declare const handlerRef: { current: unknown };
        function useOpenFile() {
          return async () => fetchEndpoint(read, {});
        }
        const useOpener = () => () => fetchEndpoint(read, {});
        function useNamedOpener() {
          const open = async () => fetchEndpoint(readOther, {});
          return open;
        }
        function Panel() {
          useEffect(() => {
            es.onmessage = () => void fetchEndpoint(read, {});
            const onMsg = () => void fetchEndpoint(readOther, {});
            es.onmessage = onMsg;
          }, []);
          handlerRef.current = () => fetchEndpoint(read, {});
          return null;
        }
      `),
      // A stream over a non-GET route is a write.
      web(`
        import { readNdjson } from "${NDJSON_WEB}";
        function Panel() {
          useEffect(() => {
            void (async () => { for await (const f of readNdjson(remove.route, "/x")) void f; })();
          }, []);
          return null;
        }
      `),
      // A refresh of a key that is not an endpoint read's.
      web(`
        import { endpointQueryKey } from "${ENDPOINTS_WEB}";
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        void queryClient.refetchQueries({ queryKey: ["other", read.route] });
        const helper = () => endpointQueryKey(read, {}, undefined);
        void queryClient.invalidateQueries({ predicate: () => helper() !== null });
      `),
    ],
    invalid: [
      {
        filename: WEB,
        code: PRELUDE + `import { useEndpoint } from "${ENDPOINTS_WEB}";`,
        errors: [hook("useEndpoint")],
      },
      {
        filename: WEB,
        code:
          PRELUDE + `import { useEndpointResource } from "${LIVE_STATE_WEB}";`,
        errors: [hook("useEndpointResource")],
      },
      {
        filename: WEB,
        code:
          PRELUDE +
          `import { useQuery, useInfiniteQuery, useSuspenseQuery, useQueries } from "${REACT_QUERY}";`,
        errors: [
          hook("useQuery"),
          hook("useInfiniteQuery"),
          hook("useSuspenseQuery"),
          hook("useQueries"),
        ],
      },
      // Aliased: flagged by its imported name.
      {
        filename: WEB,
        code: PRELUDE + `import { useQuery as read } from "${REACT_QUERY}";`,
        errors: [hook("useQuery")],
      },
      // Re-exported.
      {
        filename: WEB,
        code: PRELUDE + `export { useEndpoint } from "${ENDPOINTS_WEB}";`,
        errors: [hook("useEndpoint")],
      },
      // A namespace import, by member (dot and string).
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          import * as rq from "${REACT_QUERY}";
          rq.useQuery({});
          rq["useInfiniteQuery"]({});
        `,
        errors: [hook("useQuery"), hook("useInfiniteQuery")],
      },
      // Destructured off a namespace import / an awaited dynamic import.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          import * as endpoints from "${ENDPOINTS_WEB}";
          const { useEndpoint } = endpoints;
          const { useQuery: q } = await import("${REACT_QUERY}");
        `,
        errors: [hook("useEndpoint"), hook("useQuery")],
      },
      // A bound awaited dynamic import, read by member.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          const ls = await import("${LIVE_STATE_WEB}");
          ls.useEndpointResource(e);
        `,
        errors: [hook("useEndpointResource")],
      },
      // fetchEndpoint inside a queryFn — arrow, function, method, nested.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          import { fetchEndpoint } from "${ENDPOINTS_WEB}";
          useQueryResource({ queryKey: ["x"], queryFn: () => fetchEndpoint(read, {}) });
          const a = { queryFn: async function () { return await fetchEndpoint(read, {}); } };
          const b = { "queryFn": async ({ pageParam }) => {
            const page = await fetchEndpoint(read, { query: { cursor: pageParam } });
            return page;
          } };
        `,
        errors: [queryFnFetch, queryFnFetch, queryFnFetch],
      },
      // Aliased, off a namespace, or destructured off the module object.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          import { fetchEndpoint as get } from "${ENDPOINTS_WEB}";
          import * as endpoints from "${ENDPOINTS_WEB}";
          const { fetchEndpoint: f } = endpoints;
          const o = { queryFn: () => get(read, {}) };
          const p = { queryFn: () => endpoints.fetchEndpoint(read, {}) };
          const q = { queryFn: () => f(read, {}) };
        `,
        errors: [queryFnFetch, queryFnFetch, queryFnFetch],
      },
      // ── GET fetchEndpoint / readNdjson by where it runs ──
      // An effect, a layout effect (through a then-chain and an IIFE),
      // useMemo, a hook body, a component body, and module top level.
      {
        ...web(`
          import { fetchEndpoint } from "${ENDPOINTS_WEB}";
          void fetchEndpoint(read, {});
          function useThing() { void fetchEndpoint(read, {}); }
          function Panel() {
            useEffect(() => { void fetchEndpoint(read, {}); }, []);
            useLayoutEffect(() => {
              void (async () => { await fetchEndpoint(read, {}).then(() => fetchEndpoint(readOther, {})); })();
            }, []);
            useMemo(() => fetchEndpoint(read, {}), []);
            void fetchEndpoint(read, {});
            return null;
          }
        `),
        errors: [
          effectFetch(),
          effectFetch(),
          effectFetch(),
          effectFetch(),
          effectFetch(),
          effectFetch(),
          effectFetch(),
        ],
      },
      // A named function an effect calls — a module helper, an inner
      // function, a useCallback refresh also bound to a handler.
      {
        ...web(`
          import { fetchEndpoint } from "${ENDPOINTS_WEB}";
          async function loadOne() { return (await fetchEndpoint(read, {})); }
          function Panel() {
            const refresh = useCallback(async () => { await fetchEndpoint(readOther, {}); }, []);
            useEffect(() => {
              async function run() { await fetchEndpoint(read, {}); }
              void run();
              void loadOne();
              void refresh();
            }, [refresh]);
            return <button onClick={refresh} />;
          }
        `),
        errors: [effectFetch(), effectFetch(), effectFetch()],
      },
      // A route whose type is not a literal may be a GET.
      {
        ...web(`
          import * as endpoints from "${ENDPOINTS_WEB}";
          function Panel() {
            useEffect(() => { void endpoints.fetchEndpoint(loose, {}); }, []);
            return null;
          }
        `),
        errors: [effectFetch()],
      },
      // An NDJSON stream over a GET route, run by an effect.
      {
        ...web(`
          import { readNdjson as stream } from "${NDJSON_WEB}";
          function useFeed() {
            useEffect(() => {
              void (async () => { for await (const f of stream(read.route, "/api/read")) void f; })();
            }, []);
          }
        `),
        errors: [effectFetch("readNdjson")],
      },
      // A manual refresh of an endpoint read's key: by endpointQueryKey, the
      // raw ["endpoint", ...] spelling, or a const holding one.
      {
        ...web(`
          import { endpointQueryKey } from "${ENDPOINTS_WEB}";
          void queryClient.invalidateQueries({ queryKey: endpointQueryKey(read, {}, undefined) });
          void queryClient.refetchQueries({ queryKey: ["endpoint", read.route] });
          const key = endpointQueryKey(readOther, {}, undefined);
          void queryClient.invalidateQueries({ queryKey: key });
        `),
        errors: [refresh(), refresh("refetchQueries"), refresh()],
      },
    ],
  },
);
