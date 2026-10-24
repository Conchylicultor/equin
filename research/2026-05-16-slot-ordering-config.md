# Slot Ordering Config

## Problem

Slot contributions are dynamically registered by independent plugins. There is no single place defining the default order of contributions within a slot. This makes the initial rendering order nondeterministic and prevents a clean story for user customization.

In a marketplace model, the slot definer cannot (and should not) know about its contributors. Contributors should not need to coordinate with each other. Yet there must be a deterministic, intentional order.

## Design

A **JSONC config file per slot** serves as the single source of truth for contribution ordering. The system has two layers:

1. **Code config** (in-repo) — the developer-defined canonical order, maintained by agents
2. **User config** (`~/.singularity/`) — the user's personal customization, edited via UI drag-and-drop

### Format

```jsonc
// JSONC (jsonc-parser) — supports trailing commas, comments
{
  "slot": "TaskDetail.Section",
  "order": [
    "task-header",
    "task-description",
    "task-dependencies",
    "task-graph",
    "task-events",
    "task-attachments"
  ],
  "unsorted": [
    // Temporary holding area. Check fails if non-empty.
    // Agents MUST move entries into "order" before committing.
  ]
}
```

Future: the format can grow to support groups, per-contribution config options, etc.

### Code Config Lifecycle

1. **Codegen** (part of `./equin build`) scans all registered contributions for each slot
2. **New contribution detected** (present in code, absent from config) → appended to `"unsorted"`
3. **Removed contribution** (in config, absent from code) → removed from config automatically
4. **Check** (`./equin check`) fails if any config has a non-empty `"unsorted"` array — forces agents to explicitly place every contribution
5. Agent moves the entry from `"unsorted"` into the correct position in `"order"`, commits

This ensures order is always a conscious, explicit decision — never accidental.

### User Config Lifecycle

At startup, the server reconciles code config with user config:

1. If no user config exists → copy code config to `~/.singularity/`
2. If user config exists:
   - Compute `code_ids` = set of IDs in code config's `"order"`
   - Compute `user_ids` = set of IDs in user config's `"order"`
   - If `code_ids == user_ids` → **keep user config** (same contributions, user just reordered)
   - If `code_ids != user_ids` → **overwrite with code config** (contributions changed)

This means:
- User edits are preserved as long as the set of contributions hasn't changed
- When contributions are added/removed (set changes), user config resets to the new code default
- User can re-customize after the reset
- "Reset to default" = delete the user config file

### Properties

- **No version field needed** — set equality of contribution IDs is the implicit version
- **No merge conflicts** — code owns membership (what exists), user owns arrangement (where it goes). A set change is a clean "code wins" signal.
- **Single source of truth at runtime** — app only reads `~/.singularity/`. Code config is the seed + change detector.
- **Agent-enforced** — the check makes it impossible to commit without explicitly sorting new contributions
- **Marketplace-ready** — installing a plugin adds its contributions to `"unsorted"` in code config; agents sort them; user configs reset on next launch when the set changes
- **Code reorders ignored for existing users** — if an agent reorders code config without changing the set, user configs are unaffected (sets still match). Only fresh installs pick up the new code order.

### File Location

Code config: TBD — likely one file per slot in a centralized config directory (e.g. `config/slots/TaskDetail.Section.jsonc`)

User config: `~/.singularity/slots/TaskDetail.Section.jsonc` (mirrors the code structure)

### Relationship with Reorder Plugin

The current `reorder` plugin stores user ordering in DB. This system replaces that with file-based ordering:
- Code config replaces the "default order" that was previously implicit registration order
- User config replaces the DB-stored overrides
- The reorder plugin's drag-and-drop UI writes to user config files instead of DB

### Open Questions

- Exact location of code config files (centralized `config/` dir vs. colocated with slot-defining plugin?)
- How the UI communicates file writes back to the server (API endpoint that writes to `~/.singularity/`?)
- Whether conditional contributions (hidden but registered) should appear in the config
- Interaction with the `reorder/groups` plugin (user-created groups are also ordering metadata)
