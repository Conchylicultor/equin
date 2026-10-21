// The composition the Agent Manager demo's browser host serves, as plain data
// (read by codegen, never evaluated). The worker's graph is inferred from it
// (`codegen/core/browser-host-gen.ts`): every plugin of the composition whose
// server barrel is `portable: true`, the portable barrels `./browser-host.ts`
// (its seed) loads, and — from the `base-exclusions` negatives — one provider
// of each host service for a host without the computer (PGlite, bundled
// migrations, in-process jobs, in-memory blobs / logs / transcripts, the
// seeded push ledger, filed titles, the baseline model catalog). Generated
// into `./browser-host.generated.ts`.
export const hostComposition = "agent-manager";
