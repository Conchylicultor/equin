// The categories a conversation's own task is filed under when nothing else
// owns it. `conversations` — a bare launch, an adopted session, the agent
// manager's home prompt; `system` — a system-kind conversation's task. Both
// are registered (TaskCategory) by `conversations/task-categories`, a portable
// barrel, so every host labels them; they live in `core/` because other
// plugins file tasks under them too.
export const CONVERSATIONS_CATEGORY_ID = "conversations";
export const SYSTEM_CATEGORY_ID = "system";
