/**
 * Tests for the `no-endpoint-read` lint rule. The rule module alone flags
 * every web file; the (sanctioned-only) substrate exemptions are `exempt/index.ts`
 * manifests, checked by `exempt:manifests-valid` and the unused-exemption
 * report.
 *
 * Type-aware: a `LiveReader` is recognised by its type's name, so every case
 * is type-checked. The
 * harness is the one `primitives/passthrough`'s
 * `no-unanchored-passthrough.test.ts` explains: each case is linted as a path
 * that does not exist on disk (`web/case.tsx` beside this file — under a
 * `web/` folder, the rule's scope), under an inferred project whose options
 * come from `tsconfig.case.json` (`types: []` keeps it fast). The endpoints
 * barrel does not resolve there, so a case binds `fetchEndpoint` itself (a
 * `declare const`, a `useFetchEndpoint()` result, a parameter) — the rule
 * recognises the client by its binding NAME, not its type — while
 * {@link PRELUDE} declares endpoint definitions (their method no longer
 * matters: tsc refuses a GET write) and {@link READER} a `LiveReader`.
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
declare const transport: unknown;
type FetchEndpoint = (def: unknown, params?: unknown) => Promise<unknown>;
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
const REACT_QUERY = "@tanstack/react-query";

const web = (code: string) => ({ filename: WEB, code: PRELUDE + code });

const hook = (name: string) => ({ messageId: "readHook", data: { name } });
const queryFnFetch = { messageId: "queryFnFetch" };
const answerRead = (name = "fetchEndpoint") => ({
  messageId: "answerRead",
  data: { name },
});
const readerInRead = { messageId: "readerInRead" };

/** A `LiveReader` and a value it reads — the rule knows the reader by its type's name. */
const READER = `
interface LiveReader { (v: unknown, p?: unknown): Promise<{ status: "ready"; data: unknown }> }
declare function useLiveReader(): LiveReader;
declare const stat: { key: "host-fs.stat" };
`;

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
          declare const fetchEndpoint: FetchEndpoint;
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
          declare const fetchEndpoint: (def: unknown, params?: unknown) => Promise<unknown>;
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
      // fetchEndpoint as a queryFn property's KEY side, or in a sibling.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          declare const fetchEndpoint: FetchEndpoint;
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
      // ── A write's answer, by where it runs and whether it is used ──
      // A write an effect fires and forgets: void-ed, an awaited statement,
      // a `.then` that ignores the answer, a `.catch` chain left floating
      // under `void`, a Promise.all of writes awaited as a statement.
      web(`
        declare const fetchEndpoint: FetchEndpoint;
        declare const mutation: { mutateAsync(v: unknown): Promise<unknown> };
        declare function setDone(v: boolean): void;
        function Panel() {
          useEffect(() => {
            void fetchEndpoint(save, {});
            void (async () => {
              await fetchEndpoint(save, {});
              await Promise.all([fetchEndpoint(ack, {}), mutation.mutateAsync({})]);
              await fetchEndpoint(save, {}).then(() => setDone(true));
            })();
            void fetchEndpoint(remove, {}).catch((e) => { throw e; });
            void mutation.mutateAsync({});
          }, []);
          return null;
        }
      `),
      // A helper whose answer every caller drops; a mapped batch void-ed.
      web(`
        declare const fetchEndpoint: FetchEndpoint;
        declare const items: string[];
        async function flush() { return fetchEndpoint(save, {}); }
        function Panel() {
          const record = useCallback(async () => fetchEndpoint(ack, {}), []);
          useEffect(() => {
            void flush();
            void record();
            void Promise.all(items.map((i) => fetchEndpoint(save, { body: i })));
          }, [record]);
          return null;
        }
      `),
      // An answer used in a JSX handler, a mutationFn, an onSuccess, a
      // callback hook bound to a handler, an event registrar's callback.
      web(`
        declare const fetchEndpoint: FetchEndpoint;
        declare function show(v: unknown): void;
        import { useMutation } from "${REACT_QUERY}";
        function Panel() {
          useMutation({ mutationFn: () => fetchEndpoint(save, {}) });
          useMutation({ mutationFn: save, onSuccess: async () => show(await fetchEndpoint(ack, {})) });
          const load = useCallback(async () => show(await fetchEndpoint(save, {})), []);
          useEffect(() => {
            window.addEventListener("keydown", async () => show(await fetchEndpoint(save, {})));
          }, []);
          return <button onClick={async () => show(await fetchEndpoint(save, {}))} onAuxClick={load} />;
        }
      `),
      // A write whose answer its own flush reads, reached from a status
      // subscription registered at module load (log-channels' clientLog).
      web(`
        declare const fetchEndpoint: FetchEndpoint;
        declare function subscribeWsStatus(cb: (ev: { status: string }) => void): void;
        async function drain() {
          const result = await fetchEndpoint(save, {});
          return result;
        }
        async function flush() { if ((await drain()) === null) return; }
        subscribeWsStatus((ev) => { if (ev.status === "open") void flush(); });
      `),
      // A function stored in an object, passed as a non-on* prop, returned
      // from a hook, or assigned to a ref escapes the file's view.
      web(`
        declare const fetchEndpoint: FetchEndpoint;
        declare const handlerRef: { current: unknown };
        export const api = { status: async () => (await fetchEndpoint(save, {})) };
        function useThing() {
          const download = useCallback(async () => (await fetchEndpoint(save, {})), []);
          return { download, more: () => fetchEndpoint(ack, {}) };
        }
        function Panel() {
          handlerRef.current = async () => (await fetchEndpoint(save, {}));
          return <Child action={() => fetchEndpoint(save, {})} />;
        }
      `),
      // A local `fetchEndpoint` FUNCTION is not the client.
      web(`
        async function fetchEndpoint(..._a: unknown[]) { return 1; }
        function Panel() { const n = useMemo(() => fetchEndpoint(save), []); return n; }
      `),
      // A LiveReader in an event handler, and one a callback hook holds for one.
      web(`
        ${READER}
        declare function show(v: unknown): void;
        function Panel() {
          const read = useLiveReader();
          const check = useCallback(async () => show(await read(stat, { path: "/" })), [read]);
          return <button onClick={async () => show(await read(stat, { path: "/" }))} onAuxClick={check} />;
        }
      `),
      // A QueryClient refresh is not a read: with the endpoint read hooks
      // deleted (B10b) there is no request/response query to refresh.
      web(`
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        void queryClient.refetchQueries({ queryKey: ["endpoint", read.route] });
      `),
    ],
    invalid: [
      // The transport-bound client, recognised by its binding name: a hook's
      // `const fetchEndpoint = useFetchEndpoint()`, a parameter, a
      // destructured dependency.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          import { useFetchEndpoint } from "${ENDPOINTS_WEB}";
          function useThing() {
            const fetchEndpoint = useFetchEndpoint();
            return { queryFn: () => fetchEndpoint(read, {}) };
          }
          const o = { queryFn: (fetchEndpoint) => fetchEndpoint() };
          function make({ fetchEndpoint }) {
            return { queryFn: () => fetchEndpoint(read, {}) };
          }
        `,
        errors: [queryFnFetch, queryFnFetch, queryFnFetch],
      },
      {
        ...web(`
          import { useFetchEndpoint } from "${ENDPOINTS_WEB}";
          function Panel() {
            const fetchEndpoint = useFetchEndpoint();
            useEffect(() => { void fetchEndpoint(save, {}).then((r) => r); }, []);
            return null;
          }
        `),
        errors: [answerRead()],
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
        code: PRELUDE + `export { useQuery } from "${REACT_QUERY}";`,
        errors: [hook("useQuery")],
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
          import * as rq from "${REACT_QUERY}";
          const { useSuspenseQuery } = rq;
          const { useQuery: q } = await import("${REACT_QUERY}");
        `,
        errors: [hook("useSuspenseQuery"), hook("useQuery")],
      },
      // A bound awaited dynamic import, read by member.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          const rq = await import("${REACT_QUERY}");
          rq.useQueries({});
        `,
        errors: [hook("useQueries")],
      },
      // fetchEndpoint inside a queryFn — arrow, function, method, nested.
      {
        filename: WEB,
        code:
          PRELUDE +
          `
          declare const fetchEndpoint: FetchEndpoint;
          useQueryResource({ queryKey: ["x"], queryFn: () => fetchEndpoint(read, {}) });
          const a = { queryFn: async function () { return await fetchEndpoint(read, {}); } };
          const b = { "queryFn": async ({ pageParam }) => {
            const page = await fetchEndpoint(read, { query: { cursor: pageParam } });
            return page;
          } };
        `,
        errors: [queryFnFetch, queryFnFetch, queryFnFetch],
      },
      // ── A write's answer used where it runs as a read ──
      // Any method: an effect (bound, through a then-callback, an IIFE, a
      // Promise.all), a layout effect, useMemo, a hook body, a component
      // body, and module top level.
      {
        ...web(`
          declare const fetchEndpoint: FetchEndpoint;
          declare function setLoops(v: unknown): void;
          const boot = fetchEndpoint(read, {});
          function useThing() { return useState(fetchEndpoint(save, {})); }
          function Panel() {
            useEffect(() => {
              void (async () => {
                const loops = await fetchEndpoint(save, {});
                setLoops(loops);
                const [a] = await Promise.all([fetchEndpoint(ack, {})]);
                setLoops(a);
              })();
              void fetchEndpoint(remove, {}).then(setLoops);
              void fetchEndpoint(remove, {}).then((r) => setLoops(r));
            }, []);
            useLayoutEffect(() => { if (fetchEndpoint(save, {})) setLoops(1); }, []);
            useMemo(() => fetchEndpoint(save, {}), []);
            const p = fetchEndpoint(save, {});
            return p;
          }
        `),
        errors: [
          answerRead(),
          answerRead(),
          answerRead(),
          answerRead(),
          answerRead(),
          answerRead(),
          answerRead(),
          answerRead(),
          answerRead(),
        ],
      },
      // mutateAsync, by member and destructured; a helper an effect calls
      // whose answer the effect keeps; a callback hook an effect runs.
      {
        ...web(`
          declare const fetchEndpoint: FetchEndpoint;
          declare function setLoops(v: unknown): void;
          declare function useEndpointMutation(def: unknown): { mutateAsync(v: unknown): Promise<unknown> };
          async function find() { return await fetchEndpoint(save, {}); }
          function Panel() {
            const m = useEndpointMutation(save);
            const { mutateAsync } = useEndpointMutation(ack);
            const refresh = useCallback(async () => fetchEndpoint(ack, {}), []);
            useEffect(() => {
              void (async () => {
                setLoops(await m.mutateAsync({}));
                setLoops(await mutateAsync({}));
                setLoops(await find());
                setLoops(await refresh());
              })();
            }, [m, mutateAsync, refresh]);
            return null;
          }
        `),
        errors: [
          answerRead(),
          answerRead(),
          answerRead("mutateAsync"),
          answerRead("mutateAsync"),
        ],
      },
      // mutateAsync under an alias: a renamed destructure, a renamed
      // parameter destructure, a local assigned from the member.
      {
        ...web(`
          declare function setPool(v: unknown): void;
          declare function useEndpointMutation(def: unknown): { mutateAsync(v: unknown): Promise<unknown> };
          function useFind({ mutateAsync: ask }: { mutateAsync(v: unknown): Promise<unknown> }) {
            useEffect(() => { void ask({}).then(setPool); }, [ask]);
          }
          function Panel() {
            const { mutateAsync: findLoops } = useEndpointMutation(save);
            const m = useEndpointMutation(ack);
            const run = m.mutateAsync;
            useEffect(() => {
              void findLoops({}).then(setPool);
              void run({}).then((x) => setPool(x));
            }, [findLoops, run]);
            return null;
          }
        `),
        errors: [
          answerRead("mutateAsync"),
          answerRead("mutateAsync"),
          answerRead("mutateAsync"),
        ],
      },
      // A LiveReader reaching a component through a hook's return and a
      // destructure — recognised by its (inferred) type, not by a name
      // written where it is called.
      {
        ...web(`
          ${READER}
          function useExplorerIo() { return { read: useLiveReader() }; }
          declare function setStat(v: unknown): void;
          function Panel() {
            const { read } = useExplorerIo();
            useEffect(() => { void read(stat, { path: "/" }).then(setStat); }, [read]);
            return null;
          }
        `),
        errors: [readerInRead],
      },
      // A LiveReader in an effect, a component body, a hook body, a
      // useCallback an effect runs.
      {
        ...web(`
          ${READER}
          declare function show(v: unknown): void;
          function useStat(read: LiveReader) { void read(stat, { path: "/" }); }
          function Panel() {
            const read = useLiveReader();
            const check = useCallback(async () => show(await read(stat, { path: "/" })), [read]);
            useEffect(() => {
              void read(stat, { path: "/" }).then(show);
              void check();
            }, [read, check]);
            void read(stat, { path: "/" });
            return null;
          }
        `),
        errors: [readerInRead, readerInRead, readerInRead, readerInRead],
      },
    ],
  },
);
