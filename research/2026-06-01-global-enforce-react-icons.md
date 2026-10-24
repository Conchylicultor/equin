# Enforce react-icons as the single icon library

## Context

The codebase standard is `react-icons/md` (154 imports), but 20 files import from `lucide-react` instead, and nothing prevents the split from growing. Agents — especially when running the shadcn skill — historically defaulted to `lucide-react`, so the library keeps getting reintroduced. The `components.json` already specifies `"iconLibrary": "react-icons/md"`, so even shadcn-generated code should use `react-icons`. The fix: a global ESLint rule that makes wrong imports fail loudly at lint/check time, plus migration of all existing violations.

## Plan

Three phases, shipped as a single atomic commit (rule + migrations together so CI never sees violations).

### Phase 1 — Global ESLint rule

Add a `no-lucide-react` rule following the exact pattern of `promise-safety/no-bare-catch.ts`. Global rules live in `plugins/framework/plugins/tooling/plugins/lint/core/` and apply to all `**/*.{ts,tsx}`.

**New files:**

1. `plugins/framework/plugins/tooling/plugins/lint/core/icon-safety/no-lucide-react.ts`
   - Visitor: `ImportDeclaration` — report when `node.source.value === "lucide-react"`
   - Message: names `react-icons/md` as the standard, gives example mappings, points to `web-core/CLAUDE.md`

2. `plugins/framework/plugins/tooling/plugins/lint/core/icon-safety/index.ts`
   - Barrel: `export const iconSafetyRules = { "no-lucide-react": noLucideReact }`

**Modified files:**

3. `plugins/framework/plugins/tooling/plugins/lint/core/index.ts` — add `export { iconSafetyRules } from "./icon-safety/index"`

4. `eslint.config.ts` — import `iconSafetyRules`, register as `"icon-safety"` plugin, enable `"icon-safety/no-lucide-react": "error"` in `baseConfigs[0].rules`

### Phase 2 — Migrate all 20 files

Every lucide-react import is replaced with its `react-icons/md` equivalent. All target icons verified to exist.

#### shadcn UI primitives (4 files in `plugins/framework/plugins/web-core/web/components/ui/`)

| File | Lucide | react-icons/md |
|---|---|---|
| `select.tsx` | `ChevronDownIcon`, `CheckIcon`, `ChevronUpIcon` | `MdExpandMore`, `MdCheck`, `MdExpandLess` |
| `dropdown-menu.tsx` | `ChevronRightIcon`, `CheckIcon` | `MdChevronRight`, `MdCheck` |
| `sheet.tsx` | `XIcon` | `MdClose` |
| `sidebar.tsx` | `PanelLeftIcon` | `MdMenu` |

#### Feature plugin code (16 files)

| File (abbreviated) | Lucide | react-icons/md |
|---|---|---|
| `auto-scroll/.../jump-to-bottom-button.tsx` | `ChevronDown` | `MdExpandMore` |
| `collapsible/.../collapsible.tsx` | `ChevronRight` | `MdChevronRight` |
| `voice-input/.../voice-input-button.tsx` | `Mic` | `MdMic` |
| `plugin-link/.../plugin-link-chip.tsx` | `Blocks` | `MdWidgets` |
| `notes/.../notes-toggle-button.tsx` | `StickyNote` | `MdStickyNote2` |
| `turn-summary/.../turn-summary-card.tsx` | `AlertTriangle`, `ArrowRight` | `MdWarning`, `MdArrowForward` |
| `fork-conversation/.../fork-conversation-buttons.tsx` | `GitFork` | `MdForkRight` |
| `push-profiling/.../push-profiling-button.tsx` | `Activity` | `MdTimeline` |
| `branch/.../branch-buttons.tsx` | `GitBranch` | `MdCallSplit` |
| `launch-prompts/.../launch-prompts-button.tsx` | `ListVideo` | `MdPlaylistPlay` |
| `prompt-templates/.../prompt-template-chips.tsx` | `PenLine`, `SendHorizontal` | `MdEdit`, `MdSend` |
| `dependencies/.../dependencies-button.tsx` | `Link2` | `MdLink` |
| `dependencies/.../dep-popover-content.tsx` | `X` | `MdClose` |
| `exit/.../exit-button.tsx` | `LogOut` | `MdLogout` |
| `push-and-exit/.../push-and-exit-button.tsx` | `LogOut`, `Play` | `MdLogout`, `MdPlayArrow` |
| `hold-and-exit/.../hold-and-exit-button.tsx` | `PauseCircle` | `MdPauseCircle` |

Note: `push-and-exit-button.tsx` already has a `react-icons/md` import — merge the new icons into it.

Note: `collapsible.tsx` uses `ChevronRight` with `rotate-90` via className for open/close animation — `MdChevronRight` accepts the same className prop and the rotation works identically.

### Phase 3 — Remove dead dependency

Remove `"lucide-react": "^1.7.0"` from root `package.json`. Run `bun install` to update lockfile.

## Verification

1. `./equin check --eslint` — zero errors; the rule blocks any future `lucide-react` import
2. `./equin build` — confirms the bundle resolves all icons and the dependency removal doesn't break anything
3. Visual spot-check key surfaces: sidebar toggle, sheet close, dropdown sub-menu arrows, select component, collapsible chevron rotation, conversation toolbar buttons (push-and-exit, fork, branch, notes, etc.)

## Key files

- `plugins/framework/plugins/tooling/plugins/lint/core/promise-safety/no-bare-catch.ts` — reference pattern for the new rule
- `plugins/framework/plugins/tooling/plugins/lint/core/promise-safety/index.ts` — reference barrel pattern
- `plugins/framework/plugins/tooling/plugins/lint/core/index.ts` — global rule export barrel
- `eslint.config.ts` — plugin registration and rule activation
