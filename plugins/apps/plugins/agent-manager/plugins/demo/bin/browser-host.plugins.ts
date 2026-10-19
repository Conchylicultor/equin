// The plugins the Agent Manager demo's browser host serves, as plain data (read
// by codegen, never evaluated): the features whose real server code answers in
// the page — task categories, with the categories of the apps whose server
// code is portable — and the providers of a host without the computer. Their
// graph is generated into `./browser-host.generated.ts`.
export const hostPlugins = [
  "tasks/plugins/task-category",
  "apps/plugins/deploy",
  "apps/plugins/home",
  "apps/plugins/prototypes",
  "database/plugins/pglite",
  "database/plugins/migrations/plugins/bundled-source",
  "infra/plugins/jobs/plugins/in-process",
  "infra/plugins/attachments/plugins/memory-blobs",
  "primitives/plugins/log-channels/plugins/memory-persistence",
  "tasks/plugins/tasks-core/plugins/seeded-push-ledger",
] as const;
