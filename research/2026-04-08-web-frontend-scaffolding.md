# Frontend Scaffolding — `web/`

## Context

equin needs its core frontend app. Nothing exists yet under `web/`. This plan sets up a minimal, running Vite+React app with shadcn/ui, Tailwind v4, and atomic design folder structure — the foundation everything else builds on.

## Tech Stack

| Tool | Role |
|------|------|
| Vite | Bundler |
| Bun | Package manager + runtime |
| React 19 + TypeScript | UI framework |
| Tailwind CSS v4 | Styling (via `@tailwindcss/vite`, no JS config) |
| shadcn/ui (nova) | Component library (source-owned) |
| react-icons | App icons (Material set: `react-icons/md`) |
| lucide-react | shadcn internal icons (auto-installed) |

## Folder Structure

```
web/
├── index.html
├── package.json
├── components.json           # shadcn config
├── tsconfig.json             # project references
├── tsconfig.app.json
├── tsconfig.node.json
├── vite.config.ts
├── public/
└── src/
    ├── main.tsx              # ReactDOM entry
    ├── App.tsx               # Root component
    ├── app.css               # Tailwind v4 + shadcn theme vars
    ├── vite-env.d.ts
    ├── lib/
    │   └── utils.ts          # cn() helper
    ├── hooks/
    └── lib/
        └── utils.ts          # cn() helper
```

### Key decisions

- **Path alias:** `@/` → `web/src/` (in both vite.config.ts and tsconfig)
- Component folders (ui/, atoms/, molecules/, organisms/, templates/, pages/, plugins/) will be added later when needed

## Execution Steps

1. Create `web/package.json` with deps (react, react-dom, react-icons, clsx, tailwind-merge) and devDeps (vite, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite, typescript, @types/react, @types/react-dom)
2. `cd web && bun install`
3. Create config files: `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`
4. Create entry files: `index.html`, `src/main.tsx`, `src/App.tsx`, `src/vite-env.d.ts`
5. Create `src/app.css` with `@import "tailwindcss";` placeholder
6. Run `bunx --bun shadcn@latest init` — generates full CSS theme, `components.json`, `src/lib/utils.ts`, adds `lucide-react`
7. Verify: `bun run dev` serves the app

## Icon Strategy

- **shadcn internals:** `lucide-react` (Select chevrons, Dialog X, etc.)
- **App icons:** `react-icons/md` — always import from specific sub-package for tree shaking:
  ```tsx
  import { MdSearch } from "react-icons/md";
  ```

## Verification

- `bun run dev` starts without errors
- Page renders "equin" centered
- Tailwind classes work (visible styling on the h1)
- `bun run build` completes without TypeScript errors
