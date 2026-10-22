/**
 * Tests for the `endpoints/fetch-endpoint-binding-name` lint rule: every
 * binding of the transport-bound endpoint client is named `fetchEndpoint`, so
 * the call-name rules guarding its calls see each one.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./fetch-endpoint-binding-name";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const FILE = "/repo/plugins/x/web/components/x.tsx";
const IMPORTS = `import { useFetchEndpoint, fetchEndpointOver, type FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";\n`;
const c = (code: string) => ({ filename: FILE, code: IMPORTS + code });

ruleTester.run(
  "fetch-endpoint-binding-name",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      c(`function P() { const fetchEndpoint = useFetchEndpoint(); }`),
      c(`const fetchEndpoint = fetchEndpointOver(pageTransport);`),
      c(
        `export async function save(fetchEndpoint: FetchEndpoint, id: string) {}`,
      ),
      c(
        `function build(file: File, { fetchEndpoint }: { fetchEndpoint: FetchEndpoint }) {}`,
      ),
      c(
        `function P() { const fetchEndpoint = useFetchEndpoint(); paste(file, { fetchEndpoint }); }`,
      ),
      c(`const deps = { fetchEndpoint: fetchEndpointOver(t) };`),
      c(
        `class Store { constructor(private readonly fetchEndpoint: FetchEndpoint) {} }`,
      ),
      c(`let fetchEndpoint: FetchEndpoint | null = null;`),
    ],
    invalid: [
      {
        ...c(`function P() { const f = useFetchEndpoint(); }`),
        errors: [{ messageId: "makerBinding" }],
      },
      {
        ...c(`void fetchEndpointOver(t)(save, {});`),
        errors: [{ messageId: "makerBinding" }],
      },
      {
        ...c(`function useMine() { return useFetchEndpoint(); }`),
        errors: [{ messageId: "makerBinding" }],
      },
      {
        ...c(`export async function save(fetcher: FetchEndpoint) {}`),
        errors: [{ messageId: "typedBinding" }],
      },
      {
        ...c(`interface Deps { client: FetchEndpoint }`),
        errors: [{ messageId: "typedBinding" }],
      },
      {
        ...c(`class Store { client: FetchEndpoint | null = null; }`),
        errors: [{ messageId: "typedBinding" }],
      },
      {
        ...c(
          `function P(fetchEndpoint: FetchEndpoint) { const f = fetchEndpoint; }`,
        ),
        errors: [{ messageId: "alias" }],
      },
      {
        ...c(
          `function P({ fetchEndpoint: f }: { fetchEndpoint: FetchEndpoint }) {}`,
        ),
        errors: [{ messageId: "alias" }],
      },
      {
        ...c(
          `function P(fetchEndpoint: FetchEndpoint) { go({ fetch: fetchEndpoint }); }`,
        ),
        errors: [{ messageId: "alias" }],
      },
    ],
  },
);
