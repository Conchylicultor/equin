// config_v2's Demo.Resource serve hook, for a demo scope's tests that mount
// config inside a real scope (the scope's own suite lives in demo/scope, which
// already depends on config_v2 — the reverse test import would be a cycle).
export { useConfigDemoServe } from "../internal/demo-resource";
