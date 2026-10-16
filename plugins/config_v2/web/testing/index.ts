// config_v2's Demo.Resource backend hook, for a demo scope's tests that mount
// config inside a real scope (the scope's own suite lives in demo/scope, which
// already depends on config_v2 — the reverse test import would be a cycle).
// Takes the git layer to serve, so a test passes a fixture, not the bundle.
export { useConfigDemoBackend } from "../internal/demo-resource";
export type { GitLayer, LoadGitLayer } from "../internal/demo-resource";
