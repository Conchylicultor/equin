// What `@composition-config-layer` resolves to under vitest (root
// `vitest.config.ts`): an empty committed layer, so a suite importing the demo
// serve resolves on a fresh clone. Suites that need config inject their own
// layer through `useConfigDemoServe`'s `loadGitLayer`.
export const gitLayer = {};
