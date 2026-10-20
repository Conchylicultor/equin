// The plugins the Agent Manager demo's browser host serves, as plain data (read
// by codegen, never evaluated): the features whose real server code answers in
// the page — the tasks, attempts and conversations of the demo's stories, their
// queue, categories (with the categories of the apps whose server code is
// portable), source pages, transcripts, tracks, short titles, notes, progress,
// sent turns, agents and the model catalog, and the DB-backed side tables the
// app reads beside them — and the providers of a host without the computer
// (PGlite, bundled migrations, in-process jobs, in-memory blobs / logs /
// transcripts, the seeded push ledger, filed titles, the baseline model
// catalog). Their graph is generated into `./browser-host.generated.ts`.
export const hostPlugins = [
  "tasks/plugins/task-category",
  "tasks/plugins/task-source-url",
  "tasks/plugins/task-track",
  "tasks/plugins/auto-start",
  "tasks/plugins/outcome-report",
  "tasks/plugins/task-title",
  "conversations/plugins/conversations-view/plugins/queue",
  "conversations/plugins/conversation-view/plugins/jsonl-viewer",
  "conversations/plugins/conversation-view/plugins/notes",
  "conversations/plugins/conversation-view/plugins/turn-summary",
  "conversations/plugins/spawn-failure",
  "conversations/plugins/turn-ledger",
  "conversations/plugins/conversation-progress",
  "conversations/plugins/conversation-preprompt",
  "conversations/plugins/conversation-category",
  "conversations/plugins/hibernation",
  "conversations/plugins/agents",
  "conversations/plugins/model-provider/plugins/catalog",
  "primitives/plugins/usage-rank",
  "primitives/plugins/data-view/plugins/custom-columns/plugins/values",
  "ui/plugins/icons/plugins/saved-sources",
  "apps/plugins/deploy",
  "apps/plugins/home",
  "apps/plugins/prototypes",
  "database/plugins/pglite",
  "database/plugins/migrations/plugins/bundled-source",
  "infra/plugins/jobs/plugins/in-process",
  "infra/plugins/attachments/plugins/memory-blobs",
  "primitives/plugins/log-channels/plugins/memory-persistence",
  "tasks/plugins/tasks-core/plugins/seeded-push-ledger",
  "tasks/plugins/task-title/plugins/filed-titles",
  "conversations/plugins/transcript-source/plugins/memory",
  "conversations/plugins/model-provider/plugins/catalog/plugins/baseline",
] as const;
